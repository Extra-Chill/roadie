// Per-turn attribution for tool processes.
//
// The bot records who is speaking before every prompt/command dispatch
// (`setSessionTurnAttribution`). The OpenCode plugin's shell.env hook reads
// that row and exports it to every shell the agent runs, so tools can see the
// current speaker and conversation without parsing the prompt.
//
// Contract (all optional; unset when unknown, never stale):
//   ROADIE_THREAD_ID       chat thread bound to the session
//   ROADIE_CHANNEL_ID      parent channel of that thread
//   ROADIE_ACTOR_PLATFORM  chat platform of the current speaker, e.g. "discord"
//   ROADIE_ACTOR_ID        opaque platform user id of the current speaker
//   ROADIE_ACTOR_NAME      display name, for display only
//   ROADIE_ACTOR_VIA       "chat" = authenticated by the chat platform;
//                          "cli" = asserted by a local `roadie send --user`
//   ROADIE_PERSON_ID       opaque host person id from the identity hook
// Each is also exported under its KIMAKI_* name for existing consumers.
//
// Attribution only. The actor is not authority: hosts that grant permissions
// per person must map it through their own identity hook.

import {
  getSessionTurnAttribution,
  getThreadIdBySessionId,
  type SessionTurnAttribution,
} from './database.js'

export const TURN_ATTRIBUTION_ENV_NAMES = [
  'THREAD_ID',
  'CHANNEL_ID',
  'ACTOR_PLATFORM',
  'ACTOR_ID',
  'ACTOR_NAME',
  'ACTOR_VIA',
  'PERSON_ID',
] as const

/**
 * Write attribution into `env` under ROADIE_* and KIMAKI_* names. Every
 * attribution variable is first removed, so a value from a previous turn (or
 * inherited from the parent process) can never leak into this one.
 */
export function applyTurnAttributionEnv({
  env,
  attribution,
}: {
  env: Record<string, string>
  attribution: SessionTurnAttribution | undefined
}) {
  for (const name of TURN_ATTRIBUTION_ENV_NAMES) {
    delete env[`ROADIE_${name}`]
    delete env[`KIMAKI_${name}`]
  }
  if (!attribution) return

  const values: Partial<Record<(typeof TURN_ATTRIBUTION_ENV_NAMES)[number], string>> = {
    THREAD_ID: attribution.threadId,
    CHANNEL_ID: attribution.channelId,
    ACTOR_PLATFORM: attribution.actor?.platform,
    ACTOR_ID: attribution.actor?.id,
    ACTOR_NAME: attribution.actor?.name,
    ACTOR_VIA: attribution.actor?.via,
    PERSON_ID: attribution.personId,
  }
  for (const [name, value] of Object.entries(values)) {
    if (!value) continue
    env[`ROADIE_${name}`] = value
    env[`KIMAKI_${name}`] = value
  }
}

/**
 * Resolve the current turn's attribution for a session. Falls back to the
 * thread binding for sessions that have not dispatched a turn since this
 * feature shipped (thread id only, no actor).
 */
export async function resolveTurnAttribution(
  sessionId: string,
): Promise<SessionTurnAttribution | undefined> {
  const recorded = await getSessionTurnAttribution(sessionId)
  if (recorded) return recorded
  const threadId = await getThreadIdBySessionId(sessionId)
  return threadId ? { sessionId, threadId } : undefined
}
