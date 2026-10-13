// The opt-in session event log: raw records of any backend are written tagged
// with the backend id, and the persisted-row helpers stay backend-neutral
// (Roadie agent event rows and legacy raw OpenCode rows both parse).

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import {
  appendOpencodeSessionEventLog,
  buildOpencodeEventLogLine,
  persistedEventProjectDirectory,
  type OpencodeEventLogEntry,
} from './opencode-session-event-log.js'

const logDir = fs.mkdtempSync(path.join(process.env['TMPDIR'] || os.tmpdir(), 'opencode-event-log-'))

beforeAll(() => {
  process.env['ROADIE_LOG_OPENCODE_SESSION_EVENTS'] = '1'
  process.env['ROADIE_OPENCODE_SESSION_EVENTS_DIR'] = logDir
})

afterAll(() => {
  delete process.env['ROADIE_LOG_OPENCODE_SESSION_EVENTS']
  delete process.env['ROADIE_OPENCODE_SESSION_EVENTS_DIR']
})

function readLog(sessionId: string): OpencodeEventLogEntry[] {
  return fs.readFileSync(path.join(logDir, `${sessionId}.jsonl`), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as OpencodeEventLogEntry)
}

describe('persistedEventProjectDirectory', () => {
  test('reads the directory from Roadie agent event rows', () => {
    expect(persistedEventProjectDirectory({ type: 'session.updated', session: { id: 's1', directory: '/project' } })).toBe('/project')
    expect(persistedEventProjectDirectory({ type: 'session.created', session: { id: 's1', directory: '/project' } })).toBe('/project')
  })

  test('reads the directory from legacy raw OpenCode rows', () => {
    expect(persistedEventProjectDirectory({ type: 'session.updated', properties: { info: { id: 's1', directory: '/legacy' } } })).toBe('/legacy')
  })

  test('never throws on rows of the other shape or with no directory', () => {
    // An agent event row has no `properties`; reading properties.info.directory used to throw here.
    expect(persistedEventProjectDirectory({ type: 'session.updated', session: { id: 's1' } })).toBeUndefined()
    expect(persistedEventProjectDirectory({ type: 'status', sessionId: 's1', status: { state: 'busy' } })).toBeUndefined()
    expect(persistedEventProjectDirectory({ type: 'part', part: { id: 'p1', sessionId: 's1', messageId: 'm1', kind: 'text', text: '' } })).toBeUndefined()
    expect(persistedEventProjectDirectory('not an event')).toBeUndefined()
    expect(persistedEventProjectDirectory(undefined)).toBeUndefined()
  })
})

describe('appendOpencodeSessionEventLog', () => {
  test('writes raw Pi records tagged with the backend id under the agent event session', async () => {
    const result = await appendOpencodeSessionEventLog({
      threadId: 'thread-1',
      projectDirectory: '/project',
      backend: 'pi',
      sessionId: 'ses-pi-1',
      event: { type: 'agent_start' },
    })
    expect(result).toBeNull()
    const line = readLog('ses-pi-1').at(-1)
    expect(line).toMatchObject({ threadId: 'thread-1', backend: 'pi', event: { type: 'agent_start' } })
  })

  test('a raw record with no backend tag is dropped rather than misfiled as OpenCode', async () => {
    const result = await appendOpencodeSessionEventLog({
      threadId: 'thread-1',
      projectDirectory: '/project',
      event: { type: 'agent_start' },
    })
    expect(result).toBeNull()
    expect(fs.existsSync(path.join(logDir, 'ses-pi-1.jsonl'))).toBe(true) // untouched by this call
    expect(readLog('ses-pi-1')).toHaveLength(1)
  })

  test('OpenCode events still file by their own sessionID, tagged opencode', async () => {
    const result = await appendOpencodeSessionEventLog({
      threadId: 'thread-2',
      projectDirectory: '/project',
      event: { type: 'session.idle', properties: { sessionID: 'ses-oc-1' } },
    })
    expect(result).toBeNull()
    expect(readLog('ses-oc-1').at(-1)).toMatchObject({
      backend: 'opencode',
      event: { type: 'session.idle', properties: { sessionID: 'ses-oc-1' } },
    })
  })

  test('an OpenCode event without a session id is still dropped', async () => {
    const before = fs.readdirSync(logDir).sort()
    await appendOpencodeSessionEventLog({
      threadId: 'thread-3',
      projectDirectory: '/project',
      event: { type: 'server.instance.disposed', properties: {} },
    })
    expect(fs.readdirSync(logDir).sort()).toEqual(before)
  })
})

describe('buildOpencodeEventLogLine', () => {
  test('carries the backend tag when given', () => {
    expect(buildOpencodeEventLogLine({ timestamp: 1, threadId: 't', projectDirectory: '/p', backend: 'pi', event: { type: 'agent_end' } })).toEqual({
      timestamp: 1,
      threadId: 't',
      projectDirectory: '/p',
      backend: 'pi',
      event: { type: 'agent_end' },
    })
    expect('backend' in buildOpencodeEventLogLine({ timestamp: 1, threadId: 't', projectDirectory: '/p', event: { type: 'agent_end' } })).toBe(false)
  })
})
