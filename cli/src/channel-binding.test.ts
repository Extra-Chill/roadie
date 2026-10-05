import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { applicationBinding, parseChannelsConfig, resolveChannelPolicy, resolveSendChannel, setApplicationChannelBinding, setChannelsConfigPath } from './channel-policy.js'

const directories: string[] = []
afterEach(() => {
  setChannelsConfigPath(null)
  for (const directory of directories.splice(0)) {
    fs.chmodSync(directory, 0o700)
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

function fixture(json = false) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'roadie-channel-bind-'))
  directories.push(directory)
  const file = path.join(directory, json ? 'channels.json' : 'channels.yaml')
  const application = { channel: 'default', directory: '/srv/context' }
  const config = { application, projects: { shared: { context: 'brain' } }, channels: {
    default: { project: 'shared', respond: 'always', who: ['owner'], permissions: ['bash:ask'] },
    unrelated: { respond: 'mention', model: 'provider/model' },
  } }
  fs.writeFileSync(file, json ? JSON.stringify(config) : `# operator configuration\napplication: { channel: default, directory: /srv/context }\nprojects:\n  shared: { context: brain }\nchannels:\n  default: { project: shared, respond: always, who: [owner], permissions: ['bash:ask'] }\n  # keep this policy\n  unrelated: { respond: mention, model: provider/model }\n`, { mode: 0o640 })
  setChannelsConfigPath(file)
  return { file, application, config }
}

for (const json of [false, true]) {
  test(`durable ${json ? 'JSON' : 'YAML'} bindings reload immediately and preserve unrelated settings`, async () => {
    const { file, application, config } = fixture(json)
    expect(applicationBinding()).toEqual(application)
    expect(resolveSendChannel('new')).toBeInstanceOf(Error)
    expect(await setApplicationChannelBinding({ channelId: 'new', bound: true, application })).toEqual({ changed: true })
    expect(resolveSendChannel('new')).toBe('new')
    expect(resolveChannelPolicy('new')).toMatchObject({ directory: application.directory, context: 'brain', who: ['owner'] })
    const written = fs.readFileSync(file, 'utf8')
    expect(await setApplicationChannelBinding({ channelId: 'new', bound: true, application })).toEqual({ changed: false })
    expect(fs.readFileSync(file, 'utf8')).toBe(written)
    expect(await setApplicationChannelBinding({ channelId: 'new', bound: false, application })).toEqual({ changed: true })
    expect(resolveSendChannel('new')).toBeInstanceOf(Error)
    expect(resolveChannelPolicy('new')?.respond).toBe('never')
    expect(await setApplicationChannelBinding({ channelId: 'new', bound: false, application })).toEqual({ changed: false })
    expect(await setApplicationChannelBinding({ channelId: 'new', bound: true, application })).toEqual({ changed: true })
    setChannelsConfigPath(file)
    expect(resolveSendChannel('new')).toBe('new')
    const after = parseChannelsConfig(fs.readFileSync(file, 'utf8'))
    if (after instanceof Error) throw after
    expect(after.application).toEqual(config.application)
    expect(after.projects).toEqual(config.projects)
    expect(after.channels.unrelated).toEqual(config.channels.unrelated)
    expect(fs.statSync(file).mode & 0o777).toBe(0o640)
    if (!json) expect(fs.readFileSync(file, 'utf8')).toContain('# keep this policy')
  })
}

test('concurrent commands read fresh content and retain both channels', async () => {
  const { file, application } = fixture()
  const results = await Promise.all(['one', 'two'].map((channelId) => setApplicationChannelBinding({ channelId, bound: true, application })))
  expect(results).toEqual([{ changed: true }, { changed: true }])
  setChannelsConfigPath(file)
  expect(resolveSendChannel('one')).toBe('one')
  expect(resolveSendChannel('two')).toBe('two')
})

test('default, stale application, invalid input, and persistence failures leave the policy unchanged', async () => {
  const { file, application } = fixture()
  const before = fs.readFileSync(file, 'utf8')
  expect(await setApplicationChannelBinding({ channelId: 'default', bound: false, application })).toBeInstanceOf(Error)
  expect(await setApplicationChannelBinding({ channelId: 'new', bound: true, application: { ...application, directory: '/other' } })).toBeInstanceOf(Error)
  fs.chmodSync(file, 0o440)
  try {
    expect(await setApplicationChannelBinding({ channelId: 'new', bound: true, application })).toBeInstanceOf(Error)
    expect(fs.readFileSync(file, 'utf8')).toBe(before)
    expect(resolveSendChannel('new')).toBeInstanceOf(Error)
  } finally { fs.chmodSync(file, 0o640) }
  fs.writeFileSync(file, 'channels: invalid')
  expect(await setApplicationChannelBinding({ channelId: 'new', bound: true, application })).toBeInstanceOf(Error)
  expect(fs.readFileSync(file, 'utf8')).toBe('channels: invalid')
  setChannelsConfigPath(null)
  expect(await setApplicationChannelBinding({ channelId: 'new', bound: true, application })).toBeInstanceOf(Error)
})
