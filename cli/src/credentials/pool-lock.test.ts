// Two processes refreshing one OAuth account at once: the cross-process pool
// lock lets exactly one refresh run; the other reads the rotated tokens.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { AddressInfo } from 'node:net'
import { expect, test } from 'vitest'
import { addPoolOAuthAccount, readPoolAccounts, SHARED_POOL_ID } from './store.js'

const run = promisify(execFile)

test('concurrent refresh from two processes refreshes once', async () => {
  const dataDir = fs.mkdtempSync(path.join(process.env['TMPDIR'] || os.tmpdir(), 'pool-lock-'))
  await addPoolOAuthAccount({ dataDir, poolId: SHARED_POOL_ID, provider: 'anthropic', refresh: 'r0', access: 'a0', expires: Date.now() - 1000 })
  let refreshes = 0
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      refreshes++
      const n = refreshes
      // Slow enough that an unlocked second process would also arrive here.
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ access_token: `a${n}`, refresh_token: `r${n}`, expires_in: 3600 }))
      }, 400)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const tokenUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/token`
  const child = path.join(import.meta.dirname, 'pool-lock-child.ts')
  const env = { ...process.env, START_AT: String(Date.now() + 1500) }
  const outputs = await Promise.all([0, 1].map(() =>
    run(process.execPath, ['--import', 'tsx', child, dataDir, SHARED_POOL_ID, tokenUrl], { env, cwd: path.join(import.meta.dirname, '..', '..') }),
  ))
  server.close()
  expect(refreshes).toBe(1)
  expect(outputs.map((o) => JSON.parse(o.stdout).access)).toEqual(['a1', 'a1'])
  const accounts = readPoolAccounts({ dataDir, poolId: SHARED_POOL_ID })
  expect(accounts instanceof Error ? accounts : accounts[0]?.type === 'oauth' && accounts[0].refresh).toBe('r1')
  fs.rmSync(dataDir, { recursive: true, force: true })
}, 30_000)
