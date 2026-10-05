// One response/admission decision for every native chat adapter. Eligibility
// is established by the platform/host first; intake can never grant authority.
import * as orm from 'drizzle-orm'
import { applyFiltersAsync } from './hooks.js'
import { resolveChannelPolicy, type ChannelPolicy } from './channel-policy.js'
import { getDb } from './database.js'
import * as schema from './schema.js'
import type { IdentityActor } from './identity.js'

export type IntakeOutcome = 'respond' | 'context' | 'ignore'
export type IntakeDecision = { outcome: IntakeOutcome; admit: boolean }
export type ConversationScope = { platform: string; spaceId: string; threadId: string }
export type ConversationAdmission = { starterActorId: string | null; participants: string[] }
export type ConversationIntakeRequest = {
  actor: IdentityActor
  personId?: string
  messageId?: string
  text: string
  spaceId: string
  channelId: string
  threadId?: string
  /** True only after platform/host capability and audience checks. */
  eligible: boolean
  isNewConversation: boolean
  createsThread: boolean
  hasSession: boolean
  mentionsBot: boolean
  isCommand: boolean
  directedElsewhere?: boolean
  /** Existing adapter behavior when no explicit intake policy is selected. */
  legacyOutcome: IntakeOutcome
}

const ignored: IntakeDecision = Object.freeze({ outcome: 'ignore', admit: false })

/** Pure rules shared by adapters, with durable admission supplied as evidence. */
export function decideConversationIntake({
  policy,
  request,
  admission,
}: {
  policy: ChannelPolicy | null | undefined
  request: ConversationIntakeRequest
  admission: ConversationAdmission | null
}): IntakeDecision {
  if (!request.eligible || policy === null || policy?.respond === 'never') return ignored
  if (request.createsThread && policy?.threads === 'existing-only') return ignored
  if (!policy?.intake)
    return { outcome: request.legacyOutcome, admit: request.legacyOutcome === 'respond' }

  const explicit = request.mentionsBot || request.isCommand
  const otherwise = (): IntakeDecision => ({
    outcome: request.hasSession && policy.intake?.other === 'context' ? 'context' : 'ignore',
    admit: false,
  })
  if (request.directedElsewhere && !explicit) return otherwise()
  if (request.isNewConversation) {
    const start = policy.intake.start ?? (policy.respond === 'mention' ? 'mention' : 'message')
    const answer =
      start === 'message' ||
      (start === 'mention' && explicit) ||
      (start === 'command' && request.isCommand)
    return answer ? { outcome: 'respond', admit: true } : ignored
  }
  const continuation = policy.intake.continue ?? 'eligible'
  const continues =
    continuation === 'eligible' ||
    (continuation === 'starter' && admission?.starterActorId === request.actor.id) ||
    (continuation === 'participants' && Boolean(admission?.participants.includes(request.actor.id)))
  if (continues) return { outcome: 'respond', admit: true }
  const join = policy.intake.join ?? 'mention'
  if (join === 'message' || (join === 'mention' && explicit))
    return { outcome: 'respond', admit: true }
  return otherwise()
}

export async function readConversationAdmission(
  scope: ConversationScope,
): Promise<ConversationAdmission | null> {
  const db = await getDb()
  const where = { platform: scope.platform, space_id: scope.spaceId, thread_id: scope.threadId }
  const conversation = await db.query.conversation_admissions.findFirst({ where })
  if (!conversation) return null
  const participants = await db.query.conversation_participants.findMany({ where })
  return {
    starterActorId: conversation.starter_actor_id,
    participants: participants.map((row) => row.actor_id),
  }
}

/** Hooks may refine response/admission for already eligible actors only. */
export async function resolveConversationIntake(
  request: ConversationIntakeRequest,
): Promise<IntakeDecision> {
  const policy = resolveChannelPolicy(request.threadId ?? request.channelId)
  const admission = request.threadId
    ? await readConversationAdmission({
        platform: request.actor.platform,
        spaceId: request.spaceId,
        threadId: request.threadId,
      })
    : null
  const base = decideConversationIntake({ policy, request, admission })
  if (
    !request.eligible ||
    policy === null ||
    policy?.respond === 'never' ||
    (request.createsThread && policy?.threads === 'existing-only')
  )
    return ignored
  const result = await applyFiltersAsync('conversation_intake', base, {
    request,
    admission,
    policy,
  })
  if (
    !result ||
    !['respond', 'context', 'ignore'].includes(result.outcome) ||
    typeof result.admit !== 'boolean'
  )
    return ignored
  // Context-only messages neither establish a session nor admit a participant.
  if (result.outcome === 'context' && !request.hasSession) return ignored
  return { outcome: result.outcome, admit: result.outcome === 'respond' && result.admit }
}

/** Record platform-authenticated admission. Local/CLI actor assertions never
 * establish the starter or participants. Reserve the session binding before
 * backend creation so rapid follow-ups observe the original starter. */
export async function recordConversationAdmission({
  scope,
  actor,
  starter,
  decision,
  actorVia = 'chat',
}: {
  scope: ConversationScope
  actor: IdentityActor
  starter: boolean
  decision: IntakeDecision
  actorVia?: 'chat' | 'cli'
}): Promise<void> {
  if (
    actorVia !== 'chat' ||
    !decision.admit ||
    decision.outcome !== 'respond' ||
    actor.platform !== scope.platform
  )
    return
  const db = await getDb()
  await db.batch([
    db
      .insert(schema.thread_sessions)
      .values({ thread_id: scope.threadId, session_id: '' })
      .onConflictDoNothing(),
    db
      .insert(schema.conversation_admissions)
      .values({
        platform: scope.platform,
        space_id: scope.spaceId,
        thread_id: scope.threadId,
        starter_actor_id: starter ? actor.id : null,
      })
      .onConflictDoNothing(),
    db
      .insert(schema.conversation_participants)
      .values({
        platform: scope.platform,
        space_id: scope.spaceId,
        thread_id: scope.threadId,
        actor_id: actor.id,
      })
      .onConflictDoNothing(),
  ])
  // An earlier explicit join to a user-created thread may have reserved an
  // unknown starter. Only a trusted start event can fill it, never a reply.
  if (starter)
    await db
      .update(schema.conversation_admissions)
      .set({ starter_actor_id: actor.id })
      .where(
        orm.and(
          orm.eq(schema.conversation_admissions.platform, scope.platform),
          orm.eq(schema.conversation_admissions.space_id, scope.spaceId),
          orm.eq(schema.conversation_admissions.thread_id, scope.threadId),
          orm.isNull(schema.conversation_admissions.starter_actor_id),
        ),
      )
}
