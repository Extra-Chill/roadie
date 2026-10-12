// Measure the Pi backend's process cost (#51): RSS and CPU of the `pi`
// children for N concurrent sessions, after one tool turn each and while idle.
// Uses the scripted fake model, so it measures harness overhead, not the model.
//
//   ROADIE_PI_BIN=/path/to/pi pnpm tsx scripts/pi-measure.ts [sessions...]

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { PiBackendProvider } from '../src/agent-backend/pi/backend.js'
import { fakeModelsJson, startFakeModelServer } from '../src/agent-backend/pi/fake-model-server.js'

const clockTicks = Number(execFileSync('getconf', ['CLK_TCK']).toString())

function stat(pid: number): { rssMb: number; pssMb: number; cpuS: number } {
  const fields = fs.readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1]!.split(' ')
  const rssKb = Number(/VmRSS:\s+(\d+)/.exec(fs.readFileSync(`/proc/${pid}/status`, 'utf8'))![1])
  // PSS splits shared pages between the processes sharing them, so it sums honestly.
  const pssKb = Number(/^Pss:\s+(\d+)/m.exec(fs.readFileSync(`/proc/${pid}/smaps_rollup`, 'utf8'))![1])
  return { rssMb: rssKb / 1024, pssMb: pssKb / 1024, cpuS: (Number(fields[11]) + Number(fields[12])) / clockTicks }
}

/** A pid and all its descendants (pi may spawn helpers). */
function tree(pid: number): number[] {
  const children = fs.readFileSync(`/proc/${pid}/task/${pid}/children`, 'utf8').trim().split(/\s+/).filter(Boolean).map(Number)
  return [pid, ...children.flatMap(tree)]
}

const counts = process.argv.slice(2).map(Number).filter(Boolean)
const server = await startFakeModelServer()
const root = fs.mkdtempSync(path.join(process.env['TMPDIR'] || os.tmpdir(), 'pi-measure-'))
fs.mkdirSync(path.join(root, 'agent'))
fs.mkdirSync(path.join(root, 'project'))
fs.writeFileSync(path.join(root, 'agent', 'models.json'), fakeModelsJson(server.baseUrl))

const results = []
for (const count of counts.length ? counts : [1, 5]) {
  const provider = new PiBackendProvider({
    bin: process.env['ROADIE_PI_BIN'] || 'pi',
    sessionDir: path.join(root, `sessions-${count}`),
    model: 'fake/fake-1',
    idleTimeoutMs: 0,
    env: { PI_CODING_AGENT_DIR: path.join(root, 'agent'), PI_OFFLINE: '1' },
  })
  const controller = new AbortController()
  const idle = new Set<string>()
  const stream = await provider.subscribeEvents({ signal: controller.signal })
  void (async () => {
    for await (const item of stream) for (const event of item.events) if (event.type === 'idle') idle.add(event.sessionId)
  })()
  const started = Date.now()
  const sessions = await Promise.all(Array.from({ length: count }, () => provider.getBackend().sessions.create({ directory: path.join(root, 'project') })))
  const spawnMs = Date.now() - started
  for (const session of sessions) {
    if (session instanceof Error) throw session
    await provider.getBackend().sessions.prompt({ sessionId: session.id, directory: path.join(root, 'project'), parts: [{ kind: 'text', text: 'RUN_TOOL echo measured' }] })
  }
  while (idle.size < count) await new Promise((r) => setTimeout(r, 50))
  const turnMs = Date.now() - started - spawnMs
  const pids = (provider as unknown as { sessions: Map<string, { process: { pid: number } }> }).sessions
  const allPids = [...pids.values()].flatMap((s) => tree(s.process.pid))
  const afterTurn = allPids.map(stat)
  await new Promise((r) => setTimeout(r, 30_000))
  const afterIdle = allPids.map(stat)
  const sum = (list: Array<{ rssMb: number; pssMb: number; cpuS: number }>, key: 'rssMb' | 'pssMb' | 'cpuS') => list.reduce((total, s) => total + s[key], 0)
  results.push({
    sessions: count,
    processes: allPids.length,
    spawnMs,
    turnMs,
    rssMbTotal: Math.round(sum(afterIdle, 'rssMb')),
    rssMbPerSession: Math.round(sum(afterIdle, 'rssMb') / count),
    pssMbTotal: Math.round(sum(afterIdle, 'pssMb')),
    pssMbPerSession: Math.round(sum(afterIdle, 'pssMb') / count),
    idleCpuPercentOfOneCore: Number((((sum(afterIdle, 'cpuS') - sum(afterTurn, 'cpuS')) / 30) * 100).toFixed(2)),
  })
  controller.abort()
  provider.dispose()
  await new Promise((r) => setTimeout(r, 500))
}
await server.close()
fs.rmSync(root, { recursive: true, force: true })
console.log(JSON.stringify(results, null, 2))
