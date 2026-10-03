// E2e files run in parallel, and each derives its lock port (and Hrana DB
// server) from its channel id. Two files sharing a channel id bind the same
// port, and one evicts the other mid-run, which shows up as a flaky
// "Port … still in use after eviction" failure.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'
import { chooseLockPort } from './queue-advanced-e2e-setup.js'

const srcDir = path.dirname(fileURLToPath(import.meta.url))

test('every e2e file uses its own channel ids and lock ports', () => {
  const owners = new Map<string, string>()
  const ports = new Map<number, string>()
  const clashes: string[] = []
  for (const file of fs.readdirSync(srcDir).filter((f) => f.endsWith('.e2e.test.ts')).sort()) {
    const source = fs.readFileSync(path.join(srcDir, file), 'utf8')
    const ids = new Set([...source.matchAll(/^const [A-Z_]*CHANNEL_ID = '(\d+)'/gm)].map((m) => m[1]!))
    for (const id of ids) {
      const owner = owners.get(id)
      if (owner) clashes.push(`channel ${id}: ${owner} and ${file}`)
      owners.set(id, file)
      const port = chooseLockPort({ channelId: id })
      const portOwner = ports.get(port)
      if (portOwner && portOwner !== file) clashes.push(`lock port ${port}: ${portOwner} and ${file}`)
      ports.set(port, file)
    }
  }
  expect(owners.size).toBeGreaterThan(10)
  expect(clashes).toEqual([])
  // Ports in the Linux ephemeral range can be handed to any outbound connection.
  expect([...ports.keys()].filter((port) => port >= 32_768)).toEqual([])
})
