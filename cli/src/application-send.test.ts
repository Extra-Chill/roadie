import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, test } from 'vitest'
import { execAsync } from './exec-async.js'

const temporaryDirectories: string[] = []
afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true })
})

test('real CLI fails before database or Discord mutations instead of creating a project for caller cwd', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'roadie-application-send-'))
  temporaryDirectories.push(root)
  const caller = path.join(root, 'developer-repo')
  const data = path.join(root, 'data')
  fs.mkdirSync(caller)
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('ROADIE_') && !key.startsWith('KIMAKI_')))
  const run = (flags: string[], config?: string) => execAsync({
    command: process.execPath,
    args: ['--import', createRequire(import.meta.url).resolve('tsx'), fileURLToPath(new URL('./bin.ts', import.meta.url)), 'send', '--prompt', 'test', ...flags],
  }, { cwd: caller, env: { ...env, ROADIE_DATA_DIR: data, ...(config ? { ROADIE_CHANNELS_CONFIG: config } : {}) } })

  await expect(run([])).rejects.toMatchObject({ stderr: expect.stringContaining('configure application.channel') })
  await expect(run(['--project', caller])).rejects.toMatchObject({ stderr: expect.stringContaining('--project no longer selects channels') })
  const config = path.join(root, 'channels.json')
  fs.writeFileSync(config, JSON.stringify({ application: { channel: '123', directory: root }, channels: { '123': {} } }))
  await expect(run(['--channel', '456'], config)).rejects.toMatchObject({ stderr: expect.stringContaining('not explicitly configured') })
  await expect(run(['--cwd', caller], config)).rejects.toMatchObject({ stderr: expect.stringContaining('Session directory is fixed') })
  expect(fs.existsSync(path.join(data, 'discord-sessions.db'))).toBe(false)
}, 30_000)
