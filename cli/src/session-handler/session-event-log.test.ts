// The opt-in session event log: raw backend records are written tagged with
// the backend id under the agent event's session, and persisted Roadie agent
// event rows yield their project directory.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import {
  appendSessionEventLog,
  buildSessionEventLogLine,
  persistedEventProjectDirectory,
  type SessionEventLogEntry,
} from './session-event-log.js'

const logDir = fs.mkdtempSync(path.join(process.env['TMPDIR'] || os.tmpdir(), 'session-event-log-'))

beforeAll(() => {
  process.env['ROADIE_LOG_SESSION_EVENTS'] = '1'
  process.env['ROADIE_SESSION_EVENTS_DIR'] = logDir
})

afterAll(() => {
  delete process.env['ROADIE_LOG_SESSION_EVENTS']
  delete process.env['ROADIE_SESSION_EVENTS_DIR']
})

function readLog(sessionId: string): SessionEventLogEntry[] {
  return fs.readFileSync(path.join(logDir, `${sessionId}.jsonl`), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as SessionEventLogEntry)
}

describe('persistedEventProjectDirectory', () => {
  test('reads the directory from Roadie agent event rows', () => {
    expect(persistedEventProjectDirectory({ type: 'session.updated', session: { id: 's1', directory: '/project' } })).toBe('/project')
    expect(persistedEventProjectDirectory({ type: 'session.created', session: { id: 's1', directory: '/project' } })).toBe('/project')
  })

  test('is undefined for rows with no directory', () => {
    expect(persistedEventProjectDirectory({ type: 'session.updated', session: { id: 's1' } })).toBeUndefined()
    expect(persistedEventProjectDirectory({ type: 'status', sessionId: 's1', status: { state: 'busy' } })).toBeUndefined()
    expect(persistedEventProjectDirectory({ type: 'part', part: { id: 'p1', sessionId: 's1', messageId: 'm1', kind: 'text', text: '' } })).toBeUndefined()
    expect(persistedEventProjectDirectory('not an event')).toBeUndefined()
    expect(persistedEventProjectDirectory(undefined)).toBeUndefined()
  })
})

describe('appendSessionEventLog', () => {
  test('writes raw Pi records tagged with the backend id under the agent event session', async () => {
    const result = await appendSessionEventLog({
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

  test('a raw record with no backend tag or no session id is dropped', async () => {
    const result = await appendSessionEventLog({
      threadId: 'thread-1',
      projectDirectory: '/project',
      event: { type: 'agent_start' },
    })
    expect(result).toBeNull()
    expect(fs.existsSync(path.join(logDir, 'ses-pi-1.jsonl'))).toBe(true) // untouched by this call
    await appendSessionEventLog({
      threadId: 'thread-1',
      projectDirectory: '/project',
      backend: 'pi',
      event: { type: 'agent_start' },
    })
    expect(readLog('ses-pi-1')).toHaveLength(1)
  })
})

describe('buildSessionEventLogLine', () => {
  test('carries the backend tag when given', () => {
    expect(buildSessionEventLogLine({ timestamp: 1, threadId: 't', projectDirectory: '/p', backend: 'pi', event: { type: 'agent_end' } })).toEqual({
      timestamp: 1,
      threadId: 't',
      projectDirectory: '/p',
      backend: 'pi',
      event: { type: 'agent_end' },
    })
    expect('backend' in buildSessionEventLogLine({ timestamp: 1, threadId: 't', projectDirectory: '/p', event: { type: 'agent_end' } })).toBe(false)
  })
})
