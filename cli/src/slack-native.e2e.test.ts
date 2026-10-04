import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import url from 'node:url'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { SlackDigitalTwin, sendWebhookEvent, sendSlashCommand } from 'slack-digital-twin/src'
import { buildDeterministicOpencodeConfig } from 'opencode-deterministic-provider'
import { NativeSlackBot } from './slack-bot.js'
import { setDataDir } from './config.js'
import { setChannelsConfigPath } from './channel-policy.js'
import { initDatabase, closeDatabase, getThreadSession } from './database.js'
import { startHranaServer, stopHranaServer } from './hrana-server.js'
import { cleanupTestSessions, chooseLockPort, initTestGitRepo } from './test-utils.js'
import { initializeOpencodeForDirectory, stopOpencodeServer } from './opencode.js'
import { disposeGlobalEventListener } from './session-handler/global-event-listener.js'
import { slackThreadId, parseSlackThreadId } from './chat-platform/slack-api.js'
import { warmOpencodeInstance } from './queue-advanced-e2e-setup.js'
import { addFilter } from './hooks.js'
import type { ContextRequest } from './context-provider.js'
import type { Capability } from './identity.js'

const secret = 'native-slack-test-secret'
const channelId = 'CNATIVE1'
const secondChannelId = 'CNATIVE2'
const userId = 'UNATIVE1'
const workspaceId = 'TNATIVE1'
let slack: SlackDigitalTwin
let bot: NativeSlackBot
let root: string
let project: string
let startedAt: number
const contextRequests: ContextRequest[] = []
let removeContextFilter: (() => boolean) | undefined

beforeAll(async () => {
  startedAt = Date.now()
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'roadie-native-slack-'))
  project = path.join(root, 'project')
  fs.mkdirSync(project)
  initTestGitRepo(project)
  process.env.ROADIE_LOCK_PORT = String(chooseLockPort({ key: 'native-slack-e2e' }))
  setDataDir(path.join(root, 'data'))
  const config = path.join(root, 'channels.json')
  fs.writeFileSync(
    config,
    JSON.stringify({
      projects: { shared: { directory: project, context: 'shared-brain' } },
      channels: {
        [channelId]: {
          project: 'shared',
          who: 'everyone',
          respond: 'always',
          permissions: ['bash:ask'],
        },
        [secondChannelId]: { project: 'shared', who: 'everyone', respond: 'always' },
      },
    }),
  )
  setChannelsConfigPath(config)
  removeContextFilter = addFilter('context_sections', (sections, request) => {
    contextRequests.push(request)
    return [...sections, { id: 'shared-brain', content: 'SHARED_HOST_CONTEXT' }]
  })
  fs.writeFileSync(
    path.join(project, 'opencode.json'),
    JSON.stringify(
      buildDeterministicOpencodeConfig({
        providerName: 'deterministic-provider',
        providerNpm: url
          .pathToFileURL(path.resolve('..', 'opencode-deterministic-provider/src/index.ts'))
          .toString(),
        model: 'deterministic-v2',
        smallModel: 'deterministic-v3',
        settings: {
          strict: false,
          matchers: [
            {
              id: 'native-sleep',
              priority: 110,
              when: {
                latestUserTextIncludes: 'NATIVE_SLEEP',
                lastMessageRole: 'user',
                rawPromptRegex: '^(?!.*native-sleep-call)',
              },
              then: {
                parts: [
                  { type: 'stream-start', warnings: [] },
                  {
                    type: 'tool-call',
                    toolCallId: 'native-sleep-call',
                    toolName: 'roadie_sleep',
                    input: JSON.stringify({ duration: '1s', reason: 'native wake proof' }),
                  },
                  {
                    type: 'finish',
                    finishReason: 'tool-calls',
                    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
                  },
                ],
              },
            },
            {
              id: 'native-wake',
              priority: 120,
              when: {
                latestUserTextIncludes: 'Woke after sleeping until',
                lastMessageRole: 'user',
              },
              then: {
                parts: [
                  { type: 'stream-start', warnings: [] },
                  { type: 'text-start', id: 'wake' },
                  { type: 'text-delta', id: 'wake', delta: 'native wake returned' },
                  { type: 'text-end', id: 'wake' },
                  {
                    type: 'finish',
                    finishReason: 'stop',
                    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
                  },
                ],
              },
            },
            {
              id: 'native-permission',
              priority: 110,
              when: {
                latestUserTextIncludes: 'NATIVE_PERMISSION',
                lastMessageRole: 'user',
                rawPromptRegex: '^(?!.*native-permission-call)',
              },
              then: {
                parts: [
                  { type: 'stream-start', warnings: [] },
                  {
                    type: 'tool-call',
                    toolCallId: 'native-permission-call',
                    toolName: 'bash',
                    input: JSON.stringify({
                      command:
                        'printf "%s:%s" "$ROADIE_ACTOR_PLATFORM" "$ROADIE_ACTOR_ID" > actor-proof.txt',
                      description: 'Native permission and actor proof',
                      hasSideEffect: true,
                    }),
                  },
                  {
                    type: 'finish',
                    finishReason: 'tool-calls',
                    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
                  },
                ],
              },
            },
            {
              id: 'native-permission-done',
              priority: 111,
              when: { latestUserTextIncludes: 'NATIVE_PERMISSION', lastMessageRole: 'tool' },
              then: {
                parts: [
                  { type: 'stream-start', warnings: [] },
                  { type: 'text-start', id: 'permission-done' },
                  {
                    type: 'text-delta',
                    id: 'permission-done',
                    delta: 'native permission answered',
                  },
                  { type: 'text-end', id: 'permission-done' },
                  {
                    type: 'finish',
                    finishReason: 'stop',
                    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
                  },
                ],
              },
            },
            {
              id: 'native-upload',
              priority: 110,
              when: {
                latestUserTextIncludes: 'NATIVE_UPLOAD',
                lastMessageRole: 'user',
                rawPromptRegex: '^(?!.*native-upload-call)',
              },
              then: {
                parts: [
                  { type: 'stream-start', warnings: [] },
                  {
                    type: 'tool-call',
                    toolCallId: 'native-upload-call',
                    toolName: 'roadie_file_upload',
                    input: JSON.stringify({ prompt: 'Upload the native test file', maxFiles: 1 }),
                  },
                  {
                    type: 'finish',
                    finishReason: 'tool-calls',
                    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
                  },
                ],
              },
            },
            {
              id: 'native-upload-done',
              priority: 111,
              when: { latestUserTextIncludes: 'NATIVE_UPLOAD', lastMessageRole: 'tool' },
              then: {
                parts: [
                  { type: 'stream-start', warnings: [] },
                  { type: 'text-start', id: 'upload-done' },
                  { type: 'text-delta', id: 'upload-done', delta: 'native file received' },
                  { type: 'text-end', id: 'upload-done' },
                  {
                    type: 'finish',
                    finishReason: 'stop',
                    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
                  },
                ],
              },
            },
            {
              id: 'native-question',
              priority: 110,
              when: {
                latestUserTextIncludes: 'NATIVE_QUESTION',
                lastMessageRole: 'user',
                rawPromptRegex: '^(?!.*native-question-call)',
              },
              then: {
                parts: [
                  { type: 'stream-start', warnings: [] },
                  {
                    type: 'tool-call',
                    toolCallId: 'native-question-call',
                    toolName: 'question',
                    input: JSON.stringify({
                      questions: [
                        {
                          question: 'How should we proceed?',
                          header: 'Choose',
                          options: [
                            { label: 'Alpha', description: 'First choice' },
                            { label: 'Beta', description: 'Second choice' },
                          ],
                        },
                      ],
                    }),
                  },
                  {
                    type: 'finish',
                    finishReason: 'tool-calls',
                    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
                  },
                ],
              },
            },
            {
              id: 'native-question-done',
              priority: 111,
              when: { latestUserTextIncludes: 'NATIVE_QUESTION', lastMessageRole: 'tool' },
              then: {
                parts: [
                  { type: 'stream-start', warnings: [] },
                  { type: 'text-start', id: 'question-done' },
                  { type: 'text-delta', id: 'question-done', delta: 'native question answered' },
                  { type: 'text-end', id: 'question-done' },
                  {
                    type: 'finish',
                    finishReason: 'stop',
                    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
                  },
                ],
              },
            },
            {
              id: 'native-actions',
              priority: 110,
              when: {
                latestUserTextIncludes: 'NATIVE_ACTIONS',
                lastMessageRole: 'user',
                rawPromptRegex: '^(?!.*native-actions-call)',
              },
              then: {
                parts: [
                  { type: 'stream-start', warnings: [] },
                  {
                    type: 'tool-call',
                    toolCallId: 'native-actions-call',
                    toolName: 'roadie_action_buttons',
                    input: JSON.stringify({
                      buttons: [{ label: 'NATIVE_SLACK continue', color: 'green' }],
                    }),
                  },
                  {
                    type: 'finish',
                    finishReason: 'tool-calls',
                    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
                  },
                ],
              },
            },
            {
              id: 'native-reply',
              priority: 100,
              when: {
                latestUserTextIncludes: 'NATIVE_SLACK',
                rawPromptIncludes: 'SHARED_HOST_CONTEXT',
              },
              then: {
                parts: [
                  { type: 'stream-start', warnings: [] },
                  { type: 'text-start', id: 'native' },
                  { type: 'text-delta', id: 'native', delta: 'native Slack answer' },
                  { type: 'text-end', id: 'native' },
                  {
                    type: 'finish',
                    finishReason: 'stop',
                    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
                  },
                ],
              },
            },
          ],
        },
      }),
    ),
  )
  const hrana = await startHranaServer({ dbPath: path.join(root, 'data/discord-sessions.db') })
  if (hrana instanceof Error) throw hrana
  process.env.ROADIE_DB_URL = hrana
  await initDatabase()
  slack = new SlackDigitalTwin({
    workspaceId,
    botUser: { id: 'UBOTNATIVE' },
    users: [
      { id: userId, name: 'Chris' },
      { id: 'UWORKER1', name: 'Worker', isBot: true },
    ],
    channels: [
      { id: channelId, name: 'development' },
      { id: secondChannelId, name: 'operations' },
    ],
    dbUrl: `file:${path.join(root, 'slack.db')}`,
    webhookConfig: { signingSecret: secret },
  })
  await slack.start()
  bot = new NativeSlackBot({
    token: slack.botToken,
    signingSecret: secret,
    apiUrl: slack.apiUrl,
    workspaceId,
    taskPollIntervalMs: 100,
  })
  const result = await bot.start()
  if (result instanceof Error) throw result
  slack.setWebhookUrl(`${bot.url}/slack/events`)
  const backend = await initializeOpencodeForDirectory(project)
  if (backend instanceof Error) throw backend
  await warmOpencodeInstance({ getClient: backend, directory: project })
}, 60_000)

afterAll(async () => {
  await bot?.stop()
  disposeGlobalEventListener()
  if (project) await cleanupTestSessions({ projectDirectory: project, testStartTime: startedAt })
  await stopOpencodeServer()
  await closeDatabase()
  await stopHranaServer()
  await slack?.stop()
  setChannelsConfigPath(null)
  removeContextFilter?.()
  delete process.env.ROADIE_DB_URL
})

test('native signed message streams through the shared runtime; replies and restart keep the session', async () => {
  const starter = await slack
    .user(userId)
    .sendMessage({ channel: channelId, text: 'NATIVE_SLACK first' })
  await slack
    .channel(channelId)
    .waitForMessage({
      timeout: 10_000,
      predicate: (message) => message.text?.includes('native Slack answer') ?? false,
    })
  expect(
    (await slack.channel(channelId).getMessages())
      .filter(
        (message) =>
          message.text?.includes('NATIVE_SLACK') || message.text?.includes('native Slack answer'),
      )
      .map((message) => message.text?.replace(/^>\s*/, '').trim()),
  ).toMatchInlineSnapshot(`
    [
      "NATIVE_SLACK first",
      "native Slack answer",
    ]
  `)
  const threadId = slackThreadId({ workspaceId, channelId, threadTs: starter.ts })
  const sessionId = await getThreadSession(threadId)
  expect(sessionId).toBeTruthy()
  const second = await slack
    .user(userId)
    .sendMessage({ channel: channelId, threadTs: starter.ts, text: 'NATIVE_SLACK second' })
  await slack
    .channel(channelId)
    .waitForMessage({
      timeout: 10_000,
      predicate: (message) =>
        (message.ts ?? '') > second.ts && (message.text?.includes('native Slack answer') ?? false),
    })
  expect(await getThreadSession(threadId)).toBe(sessionId)
  await bot.stop()
  bot = new NativeSlackBot({
    token: slack.botToken,
    signingSecret: secret,
    apiUrl: slack.apiUrl,
    workspaceId,
    taskPollIntervalMs: 100,
  })
  const result = await bot.start()
  if (result instanceof Error) throw result
  slack.setWebhookUrl(`${bot.url}/slack/events`)
  const third = await slack
    .user(userId)
    .sendMessage({ channel: channelId, threadTs: starter.ts, text: 'NATIVE_SLACK after restart' })
  await slack
    .channel(channelId)
    .waitForMessage({
      timeout: 10_000,
      predicate: (message) =>
        (message.ts ?? '') > third.ts && (message.text?.includes('native Slack answer') ?? false),
    })
  expect(await getThreadSession(threadId)).toBe(sessionId)
}, 30_000)

test('two channels share a project with separate sessions; signed event redelivery is deduplicated', async () => {
  const starter = await slack
    .user(userId)
    .sendMessage({ channel: secondChannelId, text: 'NATIVE_SLACK other channel' })
  await slack
    .channel(secondChannelId)
    .waitForMessage({
      timeout: 10_000,
      predicate: (message) => message.text?.includes('native Slack answer') ?? false,
    })
  await sendWebhookEvent({
    config: { signingSecret: secret, webhookUrl: `${bot.url}/slack/events`, workspaceId },
    event: {
      type: 'message',
      user: userId,
      channel: secondChannelId,
      ts: starter.ts,
      text: 'NATIVE_SLACK other channel',
    },
  })
  await new Promise((resolve) => setTimeout(resolve, 200))
  expect(
    (await slack.channel(secondChannelId).getMessages())
      .filter(
        (message) =>
          message.text?.includes('NATIVE_SLACK') || message.text?.includes('native Slack answer'),
      )
      .map((message) => message.text?.replace(/^>\s*/, '').trim()),
  ).toMatchInlineSnapshot(`
    [
      "NATIVE_SLACK other channel",
      "native Slack answer",
    ]
  `)
  expect(
    (await slack.channel(secondChannelId).getMessages()).filter((message) =>
      message.text?.includes('native Slack answer'),
    ),
  ).toHaveLength(1)
  const runtime = await bot.runtimeFor(secondChannelId, starter.ts)
  if (runtime instanceof Error) throw runtime
  expect(runtime.projectDirectory).toBe(project)
  expect(runtime.chat.platform).toBe('slack')
  expect(runtime.chat.capabilities.rename).toBe(false)
  const starts = contextRequests.filter((request) => request.event === 'session_start')
  expect(
    starts
      .filter((request) => request.channelId === channelId || request.channelId === secondChannelId)
      .every((request) => request.projectId === 'shared' && request.contextId === 'shared-brain'),
  ).toBe(true)
  expect(starts.some((request) => request.channelId === channelId)).toBe(true)
  expect(starts.some((request) => request.channelId === secondChannelId)).toBe(true)
})

test('native question selects unblock the actual agent tool', async () => {
  const starter = await slack
    .user(userId)
    .sendMessage({ channel: channelId, text: 'NATIVE_QUESTION' })
  const prompt = await slack
    .channel(channelId)
    .waitForMessage({
      timeout: 10_000,
      predicate: (message) => message.text === 'How should we proceed?',
    })
  const select = prompt.blocks
    ?.flatMap((block) => ('elements' in block ? block.elements : []))
    .find((element) => element?.type === 'static_select')
  if (!select || !('action_id' in select) || !select.action_id || !prompt.ts)
    throw new Error('Question has no native select')
  const result = await slack
    .user(userId)
    .selectOptions({
      channel: channelId,
      messageTs: prompt.ts,
      actionId: select.action_id,
      values: ['1'],
    })
  expect(result.status).toBe(200)
  await slack
    .channel(channelId)
    .waitForMessage({
      timeout: 10_000,
      predicate: (message) =>
        (message.ts ?? '') > starter.ts &&
        (message.text?.includes('native question answered') ?? false),
    })
  expect(
    (await slack.channel(channelId).getMessages())
      .filter(
        (message) =>
          message.thread_ts === starter.ts &&
          (message.text?.startsWith('Answered:') ||
            message.text?.includes('native question answered')),
      )
      .map((message) => message.text?.replace(/^>\s*/, '').trim()),
  ).toMatchInlineSnapshot(`
    [
      "Answered: Beta",
      "native question answered",
    ]
  `)
})

test('the shared IPC action tool posts native buttons and clicking continues the same session', async () => {
  const starter = await slack
    .user(userId)
    .sendMessage({ channel: secondChannelId, text: 'NATIVE_ACTIONS' })
  const prompt = await slack
    .channel(secondChannelId)
    .waitForMessage({
      timeout: 10_000,
      predicate: (message) => message.text === '*Action Required*',
    })
  const action = prompt.blocks
    ?.flatMap((block) => ('elements' in block ? block.elements : []))
    .find((element) => element?.type === 'button')
  if (!action || !('action_id' in action) || !action.action_id || !prompt.ts)
    throw new Error('Action has no native button')
  const id = slackThreadId({ workspaceId, channelId: secondChannelId, threadTs: starter.ts })
  const sessionId = await getThreadSession(id)
  await slack
    .user(userId)
    .clickButton({ channel: secondChannelId, messageTs: prompt.ts, actionId: action.action_id })
  await slack
    .channel(secondChannelId)
    .waitForMessage({
      timeout: 10_000,
      predicate: (message) =>
        message.thread_ts === starter.ts &&
        (message.text?.includes('native Slack answer') ?? false),
    })
  expect(
    (await slack.channel(secondChannelId).getMessages())
      .filter(
        (message) =>
          message.thread_ts === starter.ts &&
          (message.text?.startsWith('Selected:') || message.text?.includes('native Slack answer')),
      )
      .map((message) => message.text?.replace(/^>\s*/, '').trim()),
  ).toMatchInlineSnapshot(`
    [
      "Selected: NATIVE_SLACK continue",
      "native Slack answer",
    ]
  `)
  expect(await getThreadSession(id)).toBe(sessionId)
})

test('native permission buttons release an actual guarded bash tool', async () => {
  const starter = await slack
    .user(userId)
    .sendMessage({ channel: channelId, text: 'NATIVE_PERMISSION' })
  const prompt = await slack
    .channel(channelId)
    .waitForMessage({
      timeout: 10_000,
      predicate: (message) =>
        message.thread_ts === starter.ts &&
        (message.text?.includes('Permission Required') ?? false),
    })
  const action = prompt.blocks
    ?.flatMap((block) => ('elements' in block ? block.elements : []))
    .find(
      (element) =>
        element?.type === 'button' &&
        'action_id' in element &&
        element.action_id?.endsWith(':once'),
    )
  if (!action || !('action_id' in action) || !action.action_id || !prompt.ts)
    throw new Error('Permission has no Accept button')
  await slack
    .user(userId)
    .clickButton({ channel: channelId, messageTs: prompt.ts, actionId: action.action_id })
  await slack
    .channel(channelId)
    .waitForMessage({
      timeout: 10_000,
      predicate: (message) =>
        message.thread_ts === starter.ts &&
        (message.text?.includes('native permission answered') ?? false),
    })
  expect(
    (await slack.channel(channelId).getMessages())
      .filter(
        (message) =>
          message.thread_ts === starter.ts &&
          (message.text?.startsWith('Permission:') ||
            message.text?.includes('native permission answered')),
      )
      .map((message) => message.text?.replace(/^>\s*/, '').trim()),
  ).toMatchInlineSnapshot(`
    [
      "Permission: once",
      "> native permission answered",
    ]
  `)
  expect(fs.readFileSync(path.join(project, 'actor-proof.txt'), 'utf8')).toBe(`slack:${userId}`)
})

test('native file picker downloads real bytes and unblocks the IPC tool', async () => {
  const starter = await slack
    .user(userId)
    .sendMessage({ channel: secondChannelId, text: 'NATIVE_UPLOAD' })
  const prompt = await slack
    .channel(secondChannelId)
    .waitForMessage({
      timeout: 10_000,
      predicate: (message) =>
        message.thread_ts === starter.ts && message.text === 'Upload the native test file',
    })
  const action = prompt.blocks
    ?.flatMap((block) => ('elements' in block ? block.elements : []))
    .find((element) => element?.type === 'button')
  if (!action || !('action_id' in action) || !action.action_id || !prompt.ts)
    throw new Error('Upload has no native button')
  const filePath = path.join(root, 'native-file.txt')
  fs.writeFileSync(filePath, 'native attachment bytes')
  const uploaded = await bot.api.uploadFile({
    channel: secondChannelId,
    threadTs: starter.ts,
    filePath,
  })
  if (uploaded instanceof Error) throw uploaded
  const fileMessage = await slack
    .channel(secondChannelId)
    .waitForMessage({
      predicate: (message) => message.thread_ts === starter.ts && Boolean(message.files?.length),
    })
  const fileId = fileMessage.files?.[0]?.id
  if (!fileId) throw new Error('Twin did not preserve uploaded file')
  await slack
    .user(userId)
    .clickButton({ channel: secondChannelId, messageTs: prompt.ts, actionId: action.action_id })
  const view = await slack.waitForOpenedView()
  const hash = view.view?.private_metadata
  if (!hash) throw new Error('Modal has no interaction context')
  await slack
    .user(userId)
    .submitView({
      privateMetadata: hash,
      values: { files: { files: { files: [{ id: fileId }] } } },
    })
  await slack
    .channel(secondChannelId)
    .waitForMessage({
      timeout: 10_000,
      predicate: (message) =>
        message.thread_ts === starter.ts &&
        (message.text?.includes('native file received') ?? false),
    })
  expect(
    (await slack.channel(secondChannelId).getMessages())
      .filter(
        (message) =>
          message.thread_ts === starter.ts &&
          (message.text?.startsWith('Uploaded') || message.text?.includes('native file received')),
      )
      .map((message) => message.text?.replace(/^>\s*/, '').trim()),
  ).toMatchInlineSnapshot(`
    [
      "Uploaded 1 file(s)",
      "native file received",
    ]
  `)
  expect(
    fs.readFileSync(path.join(root, 'data', 'attachments', hash, '0-native-file.txt'), 'utf8'),
  ).toBe('native attachment bytes')
})

test('native send rejects ambiguous project targeting, delivers notifications and scheduled thread turns', async () => {
  expect(await bot.send({ project: 'shared', prompt: 'ambiguous' })).toBeInstanceOf(Error)
  const notice = await bot.send({
    channel: secondChannelId,
    prompt: 'native notification',
    notifyOnly: true,
  })
  if (notice instanceof Error) throw notice
  const visible = await slack
    .channel(secondChannelId)
    .waitForMessage({ predicate: (message) => message.text === 'native notification' })
  expect(visible.text).toMatchInlineSnapshot('"native notification"')
  expect(visible.thread_ts).toBeUndefined()
  const sent = await bot.send({ channel: secondChannelId, prompt: 'NATIVE_SLACK scheduled target' })
  if (sent instanceof Error || !sent.threadId) throw sent
  const target = sent.threadId
  await slack
    .channel(secondChannelId)
    .waitForMessage({
      timeout: 10_000,
      predicate: (message) => message.text?.includes('native Slack answer') ?? false,
    })
  const scheduled = await bot.send({
    thread: target,
    prompt: 'NATIVE_SLACK scheduled turn',
    sendAt: new Date(Date.now() + 1000).toISOString(),
  })
  if (scheduled instanceof Error) throw scheduled
  expect(scheduled.taskId).toBeGreaterThan(0)
  await slack
    .channel(secondChannelId)
    .waitForMessage({
      timeout: 10_000,
      predicate: (message) => message.text?.includes('NATIVE_SLACK scheduled turn') ?? false,
    })
  expect(
    (await slack.channel(secondChannelId).getMessages())
      .filter((message) => message.text?.includes('NATIVE_SLACK scheduled turn'))
      .map((message) => message.text),
  ).toMatchInlineSnapshot(`
    [
      "» Roadie: NATIVE_SLACK scheduled turn",
    ]
  `)
})

test('native model picker selects the backend catalog and fork creates a separate persistent session', async () => {
  const sent = await bot.send({ channel: secondChannelId, prompt: 'NATIVE_SLACK model source' })
  if (sent instanceof Error || !sent.threadId) throw sent
  const target = parseSlackThreadId(sent.threadId)!
  await slack
    .channel(secondChannelId)
    .waitForMessage({
      timeout: 10_000,
      predicate: (message) =>
        message.thread_ts === target.threadTs &&
        (message.text?.includes('native Slack answer') ?? false),
    })
  slack.clearOpenedViews()
  const command = (text: string) =>
    sendSlashCommand({
      config: { signingSecret: secret, workspaceId, webhookUrl: `${bot.url}/slack/commands` },
      command: '/roadie',
      text,
      userId,
      userName: 'Chris',
      channelId: secondChannelId,
      channelName: 'operations',
    })
  await command(`model ${target.threadTs}`)
  const view = await slack.waitForOpenedView()
  const hash = view.view?.private_metadata
  if (!hash) throw new Error('Model picker has no context')
  await slack
    .user(userId)
    .submitView({
      privateMetadata: hash,
      values: {
        choice: {
          choice: { selected_option: { value: 'deterministic-provider/deterministic-v3' } },
        },
      },
    })
  await slack
    .channel(secondChannelId)
    .waitForMessage({
      timeout: 10_000,
      predicate: (message) =>
        message.thread_ts === target.threadTs &&
        message.text === 'Model: deterministic-provider/deterministic-v3',
    })
  await command(`fork ${target.threadTs} NATIVE_SLACK forked`)
  const forkRoot = await slack
    .channel(secondChannelId)
    .waitForMessage({
      timeout: 10_000,
      predicate: (message) => message.text === 'Fork: NATIVE_SLACK forked',
    })
  if (!forkRoot.ts) throw new Error('Fork has no Slack root timestamp')
  await slack
    .channel(secondChannelId)
    .waitForMessage({
      timeout: 10_000,
      predicate: (message) =>
        message.thread_ts === forkRoot.ts &&
        (message.text?.includes('native Slack answer') ?? false),
    })
  expect(
    (await slack.channel(secondChannelId).getMessages())
      .filter(
        (message) =>
          message.text === 'Model: deterministic-provider/deterministic-v3' ||
          message.text === 'Fork: NATIVE_SLACK forked',
      )
      .map((message) => message.text),
  ).toMatchInlineSnapshot(`
    [
      "Model: deterministic-provider/deterministic-v3",
      "Fork: NATIVE_SLACK forked",
    ]
  `)
  const forkId = slackThreadId({ workspaceId, channelId: secondChannelId, threadTs: forkRoot.ts })
  expect(await getThreadSession(forkId)).not.toBe(sent.sessionId)
  expect(await getThreadSession(sent.threadId)).toBe(sent.sessionId)
})

test('the real sleep tool wakes the same native Slack session through durable ingress', async () => {
  const starter = await slack
    .user(userId)
    .sendMessage({ channel: secondChannelId, text: 'NATIVE_SLEEP' })
  await slack
    .channel(secondChannelId)
    .waitForMessage({
      timeout: 10_000,
      predicate: (message) =>
        message.thread_ts === starter.ts &&
        (message.text?.includes('native wake returned') ?? false),
    })
  expect(
    (await slack.channel(secondChannelId).getMessages())
      .filter(
        (message) =>
          message.thread_ts === starter.ts && message.text?.includes('native wake returned'),
      )
      .map((message) => message.text?.replace(/^>\s*/, '').trim()),
  ).toMatchInlineSnapshot(`
    [
      "native wake returned",
    ]
  `)
})

test('a host-vouched bot can participate using its authenticated platform identity', async () => {
  const remove = addFilter('person', (_person, { actor }) =>
    actor.id === 'UWORKER1'
      ? {
          allowed: true,
          personId: 'worker-principal',
          capabilities: new Set<Capability>(['sessions']),
          permissions: ['bash:deny'],
        }
      : null,
  )
  try {
    const { ts } = await slack
      .user('UWORKER1')
      .sendMessage({
        channel: secondChannelId,
        botId: 'BWORKER1',
        text: 'NATIVE_SLACK worker collaboration',
      })
    await slack
      .channel(secondChannelId)
      .waitForMessage({
        timeout: 10_000,
        predicate: (message) =>
          message.thread_ts === ts && (message.text?.includes('native Slack answer') ?? false),
      })
    expect(
      (await slack.channel(secondChannelId).getMessages())
        .filter(
          (message) => message.thread_ts === ts && message.text?.includes('native Slack answer'),
        )
        .map((message) => message.text?.replace(/^>\s*/, '').trim()),
    ).toMatchInlineSnapshot(`
      [
        "native Slack answer",
      ]
    `)
    expect(
      contextRequests.some(
        (request) => request.actor?.id === 'UWORKER1' && request.personId === 'worker-principal',
      ),
    ).toBe(true)
  } finally {
    remove()
  }
})
