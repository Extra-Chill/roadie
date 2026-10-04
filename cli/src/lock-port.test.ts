import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, expect, test } from 'vitest'
import { CUSTOM_LOCK_PORT_BASE, getDataDir, getLockPort, setDataDir } from './config.js'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'roadie-lock-port-'))
afterAll(() => fs.rmSync(root, { recursive: true, force: true }))
const originalDir = getDataDir()
const originalEnv = process.env.ROADIE_LOCK_PORT
afterEach(() => {
  setDataDir(originalDir)
  if (originalEnv === undefined) delete process.env.ROADIE_LOCK_PORT
  else process.env.ROADIE_LOCK_PORT = originalEnv
})

test('custom data dirs get stable lock ports below the OS ephemeral range', () => {
  delete process.env.ROADIE_LOCK_PORT
  const seen = new Set<number>()
  for (let i = 0; i < 500; i++) {
    setDataDir(path.join(root, `d${i}`))
    const port = getLockPort()
    expect(port).toBeGreaterThanOrEqual(CUSTOM_LOCK_PORT_BASE)
    expect(port).toBeLessThan(22_000)
    seen.add(port)
  }
  setDataDir(path.join(root, 'd7'))
  const first = getLockPort()
  expect(getLockPort()).toBe(first)
  expect(seen.size).toBeGreaterThan(400)
})

test('ROADIE_LOCK_PORT wins over the derived port', () => {
  setDataDir(path.join(root, 'x'))
  process.env.ROADIE_LOCK_PORT = '23456'
  expect(getLockPort()).toBe(23456)
})
