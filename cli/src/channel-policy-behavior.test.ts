import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, expect, test } from 'vitest'
import { applyChannelBehavior, channelBehavior, channelBehaviors, resolveChannelPolicy, setApplicationChannelBinding, setChannelsConfigPath } from './channel-policy.js'

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'behavior-'))
afterEach(() => setChannelsConfigPath(null))
afterAll(() => fs.rmSync(directory, { recursive: true, force: true }))

test('presets map to canonical policy fields and are detected independently of other settings', () => {
  const expected = [
    { respond: 'always', threads: 'per-message' },
    { respond: 'mention', threads: 'per-message' },
    { respond: 'mention', threads: 'none', intake: { start: 'mention', continue: 'mention', other: 'context' } },
    { respond: 'never' },
  ]
  channelBehaviors.forEach((behavior, index) => {
    const policy = applyChannelBehavior({ context: 'brain', model: 'provider/model', intake: { join: 'never' } }, behavior)
    expect(policy).toEqual({ context: 'brain', model: 'provider/model', ...expected[index] })
    expect(channelBehavior(policy)).toBe(behavior)
  })
  expect(channelBehavior({ respond: 'always', threads: 'none' })).toBe('custom')
  expect(channelBehavior({ respond: 'mention', threads: 'per-message', intake: { continue: 'mention' } })).toBe('custom')
  expect(channelBehavior(undefined)).toBe('custom')
})

test('presets replace inherited intake from wildcard and project policies', () => {
  const file = path.join(directory, 'inherited.json')
  fs.writeFileSync(file, JSON.stringify({
    projects: { shared: { intake: { start: 'command', join: 'never' } } },
    channels: {
      '*': { intake: { continue: 'mention' } },
      work: { project: 'shared', ...applyChannelBehavior({}, 'mention') },
      listening: { project: 'shared', ...applyChannelBehavior({}, 'listen') },
    },
  }))
  setChannelsConfigPath(file)
  expect(resolveChannelPolicy('work')?.intake).toBeUndefined()
  expect(resolveChannelPolicy('listening')?.intake).toEqual({ start: 'mention', continue: 'mention', other: 'context' })
})

test('serialized behavior changes preserve non-behavior settings and bind new destinations', async () => {
  const file = path.join(directory, 'channels.json')
  const application = { channel: 'default', directory }
  const settings = { context: 'private', who: ['user:42'], model: 'a/b', agent: 'build', permissions: ['bash:deny'] }
  fs.writeFileSync(file, JSON.stringify({ application, channels: { default: { respond: 'always' }, work: { ...settings, respond: 'never', intake: { join: 'never' } } } }))
  setChannelsConfigPath(file)
  expect(await setApplicationChannelBinding({ channelId: 'work', bound: true, application, behavior: 'listen' })).toEqual({ changed: true })
  expect(resolveChannelPolicy('work')).toMatchObject({ ...settings, ...applyChannelBehavior({}, 'listen') })
  expect(await setApplicationChannelBinding({ channelId: 'work', bound: true, application, behavior: 'mention' })).toEqual({ changed: true })
  expect(resolveChannelPolicy('work')?.intake).toBeUndefined()
  expect(resolveChannelPolicy('work')).toMatchObject(settings)
  expect(await setApplicationChannelBinding({ channelId: 'new', bound: true, application, behavior: 'always' })).toEqual({ changed: true })
  expect(channelBehavior(resolveChannelPolicy('new'))).toBe('always')
  expect(await setApplicationChannelBinding({ channelId: 'work', bound: false, application, behavior: 'off' })).toEqual({ changed: true })
  expect(resolveChannelPolicy('work')).toMatchObject({ ...settings, respond: 'never' })
})
