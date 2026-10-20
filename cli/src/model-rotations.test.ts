import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, test, vi } from 'vitest'
import { getSystemMessage, renderModelRotations, sessionPoolCatalog } from './system-message.js'
import { store } from './store.js'
import { setPromptConfigPath } from './prompt-config.js'
import { setDataDir } from './config.js'
import { setPoolRotation, SHARED_POOL_ID } from './credentials/store.js'
import { startMessagesProxy } from './credentials/messages-proxy.js'
import { addPoolClient } from './credentials/pool-clients.js'

const enabled = store.getState().credentialPoolsEnabled
const catalog = { rotations: {
  routine: { entries: ['a/fast', 'b/fallback'], description: 'Routine coding' },
  empty: { entries: [], description: 'Not served' },
  heavy: { entries: ['a/best'], description: 'Hard tasks' },
}, adaptiveRotations: [] }

afterEach(() => {
  store.setState({ credentialPoolsEnabled: enabled })
  setPromptConfigPath(undefined)
  vi.unstubAllEnvs()
})

test('renders deterministic sorted tiers, descriptions and fallback order; skips empty records', () => {
  expect(renderModelRotations(catalog)).toBe('\n## Model rotations\n\n- roadie/heavy: a/best — Hard tasks\n- roadie/routine: a/fast → b/fallback — Routine coding\nPick a tier with --model roadie/<name>.\n')
  expect(renderModelRotations()).toBe('')
  expect(renderModelRotations({ rotations: {}, adaptiveRotations: [] })).toBe('')
})

test.each(['discord', 'slack'])('%s includes the section and honors disable and replace', (platform) => {
  store.setState({ credentialPoolsEnabled: true })
  setPromptConfigPath(null)
  const prompt = () => getSystemMessage({ platform, sessionId: 's', modelCatalog: catalog })
  expect(prompt()).toContain(renderModelRotations(catalog))
  expect(getSystemMessage({ platform, sessionId: 's', modelCatalog: { rotations: {}, adaptiveRotations: [] } })).not.toContain('## Model rotations')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rotation-prompt-'))
  try {
    const disabled = path.join(dir, 'disabled.json')
    fs.writeFileSync(disabled, JSON.stringify({ disable: ['model-rotations'] }))
    setPromptConfigPath(disabled)
    expect(prompt()).not.toContain('roadie/heavy')
    const replaced = path.join(dir, 'replaced.json')
    fs.writeFileSync(replaced, JSON.stringify({ replace: { 'model-rotations': 'Host model menu' } }))
    setPromptConfigPath(replaced)
    expect(prompt()).toContain('Host model menu')
    expect(prompt()).not.toContain('roadie/heavy')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('new session catalog fetches live remote metadata', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rotation-remote-'))
  await setPoolRotation({ dataDir: dir, poolId: SHARED_POOL_ID, name: 'remote', entries: ['a/fast'], description: 'Remote tier' })
  const client = addPoolClient({ dataDir: dir, name: 'bot' })
  if (client instanceof Error) throw client
  const keyFile = path.join(dir, 'client.key')
  fs.writeFileSync(keyFile, client.key)
  const host = await startMessagesProxy({ dataDir: dir, resolvePools: async () => SHARED_POOL_ID })
  vi.stubEnv('ROADIE_POOL_URL', host.baseUrl)
  vi.stubEnv('ROADIE_POOL_KEY_FILE', keyFile)
  store.setState({ credentialPoolsEnabled: true })
  setPromptConfigPath(null)
  try {
    const modelCatalog = await sessionPoolCatalog()
    expect(modelCatalog?.rotations).toEqual({ remote: { entries: ['a/fast'], description: 'Remote tier' } })
    expect(getSystemMessage({ sessionId: 's', modelCatalog })).toContain('roadie/remote: a/fast — Remote tier')
  } finally {
    await host.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('new session catalog reads live local metadata and is absent with pools disabled', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rotation-catalog-'))
  setDataDir(dir)
  store.setState({ credentialPoolsEnabled: true })
  setPromptConfigPath(null)
  try {
    await setPoolRotation({ dataDir: dir, poolId: SHARED_POOL_ID, name: 'routine', entries: ['a/fast'], description: 'Small tasks' })
    expect(await sessionPoolCatalog()).toEqual({ rotations: { routine: { entries: ['a/fast'], description: 'Small tasks' } }, adaptiveRotations: [] })
    expect(getSystemMessage({ sessionId: 's', modelCatalog: await sessionPoolCatalog() })).toContain('roadie/routine: a/fast — Small tasks')
    store.setState({ credentialPoolsEnabled: false })
    expect(await sessionPoolCatalog()).toBeUndefined()
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
