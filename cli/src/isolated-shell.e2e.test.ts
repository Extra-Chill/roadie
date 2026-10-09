// Root-only e2e for --isolate-shells (credential pools phase 3, step 2):
// with the OpenCode server started with SHELL pointing at the generated
// setpriv wrapper, a bash tool call must run as the unprivileged agent user
// and must not be able to read the server's /proc/<pid>/environ.
//
// Skipped unless running as root on Linux with setpriv available and the
// `nobody` account present; unit tests in isolated-shell.test.ts cover
// everything that does not need root.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, test } from 'vitest'
import type { DeterministicMatcher } from 'opencode-deterministic-provider'
import {
  setupQueueAdvancedSuite,
  TEST_USER_ID,
} from './queue-advanced-e2e-setup.js'
import { waitForBotMessageContaining, waitForFooterMessage } from './test-utils.js'

const CHANNEL_ID = '200000000000001074'
const DIR_NAME = 'isolated-shell-e2e'
const AGENT_USER = 'nobody'
// The probe must live somewhere the agent user can traverse to. The repo
// checkout itself is often inside a 0700 home (e.g. /root), which the agent
// user can never reach — that is the isolation working as intended — and some
// environments point TMPDIR inside that home, so fall back to /tmp when the
// temp base is not world-traversable.
const PROBE_BASES = [os.tmpdir(), '/tmp']
function probeDirectory(): string {
  const name = `roadie-isolated-shell-probe-${CHANNEL_ID}`
  for (const base of PROBE_BASES) {
    // Every existing component of the base must be traversable by "others"
    // (the probe directory itself is created afterwards, mode 0777).
    const parts = base.split(path.sep).filter(Boolean)
    let traversable = true
    for (let depth = 1; depth <= parts.length; depth++) {
      try {
        if (!(fs.statSync(path.join(path.sep, ...parts.slice(0, depth))).mode & 0o005)) {
          traversable = false
          break
        }
      } catch {
        traversable = false
        break
      }
    }
    if (traversable) return path.join(base, name)
  }
  return path.join(os.tmpdir(), name)
}
const PROBE_DIR = probeDirectory()

const canRunRootE2e =
  process.platform === 'linux' &&
  typeof process.getuid === 'function' &&
  process.getuid() === 0 &&
  fs.existsSync('/usr/bin/setpriv')

// The probe writes its findings to files because Discord shows the bash tool
// line, not its output. $PPID inside the tool shell is the OpenCode server
// process, which is exactly the /proc/<server pid>/environ read #145 asserts
// on.
const PROBE_COMMAND = [
  `id -un > ${PROBE_DIR}/uid.txt 2>&1`,
  `cat /proc/$PPID/environ > ${PROBE_DIR}/environ.txt 2>&1`,
  'echo isolated-probe-done',
].join('; ')

function createIsolationMatchers(): DeterministicMatcher[] {
  return [
    {
      id: 'isolated-shell-probe',
      priority: 150,
      when: {
        lastMessageRole: 'user',
        latestUserTextIncludes: 'ISOLATED_SHELL_PROBE_MARKER',
      },
      then: {
        parts: [
          { type: 'stream-start', warnings: [] },
          { type: 'text-start', id: 'isolated-shell-probe-text' },
          {
            type: 'text-delta',
            id: 'isolated-shell-probe-text',
            delta: 'checking which user runs tool shells',
          },
          { type: 'text-end', id: 'isolated-shell-probe-text' },
          {
            type: 'tool-call',
            toolCallId: 'isolated-shell-probe-call',
            toolName: 'bash',
            input: JSON.stringify({
              command: PROBE_COMMAND,
              description: 'Check shell user and server env access',
              hasSideEffect: true,
            }),
          },
          {
            type: 'finish',
            finishReason: 'tool-calls',
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          },
        ],
      },
    },
    {
      id: 'isolated-shell-probe-followup',
      priority: 149,
      when: {
        latestUserTextIncludes: 'ISOLATED_SHELL_PROBE_MARKER',
        rawPromptIncludes: 'isolated-probe-done',
      },
      then: {
        parts: [
          { type: 'stream-start', warnings: [] },
          { type: 'text-start', id: 'isolated-shell-probe-followup' },
          { type: 'text-delta', id: 'isolated-shell-probe-followup', delta: 'isolation-probe-complete' },
          { type: 'text-end', id: 'isolated-shell-probe-followup' },
          {
            type: 'finish',
            finishReason: 'stop',
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          },
        ],
      },
    },
  ]
}

describe.skipIf(!canRunRootE2e)('isolated shells (--isolate-shells)', () => {
  const ctx = setupQueueAdvancedSuite({
    channelId: CHANNEL_ID,
    channelName: 'isolated-shell-e2e',
    dirName: DIR_NAME,
    username: 'isolation-tester',
    extraMatchers: createIsolationMatchers(),
    isolateShellsUser: AGENT_USER,
  })

  test('a bash tool call runs as the agent user and cannot read the server environ', async () => {
    fs.rmSync(PROBE_DIR, { recursive: true, force: true })
    fs.mkdirSync(PROBE_DIR, { recursive: true })
    // The agent user must be able to write the probe results here.
    fs.chmodSync(PROBE_DIR, 0o777)

    await ctx.discord.channel(CHANNEL_ID).user(TEST_USER_ID).sendMessage({
      content: 'ISOLATED_SHELL_PROBE_MARKER check the shell user',
    })

    const thread = await ctx.discord.channel(CHANNEL_ID).waitForThread({
      timeout: 4_000,
      predicate: (candidate) => (candidate.name ?? '').startsWith('ISOLATED_SHELL_PROBE_MARKER'),
    })
    const th = ctx.discord.thread(thread.id)

    await waitForBotMessageContaining({
      discord: ctx.discord,
      threadId: thread.id,
      text: 'isolation-probe-complete',
      timeout: 8_000,
    })

    // Let the run finish emitting its footer before reading the thread,
    // otherwise the snapshot races the footer message.
    await waitForFooterMessage({
      discord: ctx.discord,
      threadId: thread.id,
      timeout: 4_000,
      afterMessageIncludes: 'isolation-probe-complete',
      afterAuthorId: ctx.discord.botUserId,
    })

    const uid = fs.readFileSync(path.join(PROBE_DIR, 'uid.txt'), 'utf8').trim()
    expect(uid).toMatchInlineSnapshot(`"nobody"`)

    // Reading the OpenCode server's environment must fail for the agent user:
    // that is the OS boundary #145 adds on top of #144's scoped endpoints.
    const environ = fs.readFileSync(path.join(PROBE_DIR, 'environ.txt'), 'utf8')
    expect(environ).toContain('Permission denied')
    expect(environ).not.toContain('ROADIE')

    expect(await th.text()).toMatchInlineSnapshot(`
      "--- from: user (isolation-tester)
      ISOLATED_SHELL_PROBE_MARKER check the shell user
      --- from: assistant (TestBot)
      -# *using deterministic-provider/deterministic-v2*
      > checking which user runs tool shells

      -# ┣ bash _Check shell user and server env access_

      isolation-probe-complete
      -# *project ⋅ main ⋅ Ns ⋅ N% ⋅ deterministic-v2*"
    `)
  }, 30_000)
})
