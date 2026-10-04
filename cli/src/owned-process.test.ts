import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { expect, test } from 'vitest'
import { stopOwnedChild } from './owned-process.js'

test('shutdown waits for the real writer to finish before its directory is removed', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'roadie-owned-writer-'))
  const target = path.join(dir, 'written')
  const child = spawn(
    process.execPath,
    [
      '-e',
      `const fs=require('node:fs'); const file=process.argv[1]; const timer=setInterval(()=>fs.writeFileSync(file,'writing'),5); process.on('SIGTERM',()=>setTimeout(()=>{clearInterval(timer); fs.writeFileSync(file,'finished'); process.exit(0)},150)); process.stdout.write('ready');`,
      target,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  )
  await new Promise((resolve) => child.stdout.once('data', resolve))
  const result = await stopOwnedChild({ child })
  if (result instanceof Error) throw result
  expect(child.exitCode).toBe(0)
  expect(fs.readFileSync(target, 'utf8')).toBe('finished')
  fs.rmSync(dir, { recursive: true })
})

test('a real child that ignores SIGTERM is killed and awaited within the shutdown budget', async () => {
  const child = spawn(
    process.execPath,
    ['-e', `process.on('SIGTERM',()=>{}); setInterval(()=>{},100); process.stdout.write('ready');`],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  )
  await new Promise((resolve) => child.stdout.once('data', resolve))
  const result = await stopOwnedChild({ child, graceMs: 50, killWaitMs: 1000 })
  if (result instanceof Error) throw result
  expect(child.signalCode).toBe('SIGKILL')
})
