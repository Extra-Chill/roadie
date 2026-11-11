// Tests for session-stable system prompt generation and per-turn prompt context.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import {
  copySessionSystemPrompt,
  deleteSessionSystemPrompt,
  isSystemPromptForSession,
  systemPromptNamesOtherSession,
  resolveSessionSystemPrompt,
  systemPromptHasParentSession,
  getPromptContext,
  getSystemMessage,
  getSessionSystemPromptPath,
  ROADIE_SYSTEM_PROMPT_MARKER,
  readSessionSystemPrompt,
  writeSessionSystemPrompt,
} from './system-message.js'

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => {
      return fs.promises.rm(dir, { recursive: true, force: true })
    }),
  )
})

describe('system-message', () => {
  test('requires roadie upload for Discord images, not markdown', () => {
    const message = getSystemMessage({
      sessionId: 'ses_123',
    })
    expect(message).toContain('Local Markdown image paths do not render; upload images instead.')
    expect(message).toContain('roadie upload-to-discord')
  })

  test('points bug reports at the debugging guide, not upstream', () => {
    const message = getSystemMessage({
      sessionId: 'ses_123',
    })
    expect(message).toContain('docs/debugging-roadie.md')
    for (const obsolete of ['kimaki', 'OpenCode', 'hasSideEffect', 'ses_xxx', 'opencode.json', 'BashToolInput']) {
      expect(message).not.toContain(obsolete)
    }
  })

  test('includes callout guidance for important content', () => {
    const message = getSystemMessage({
      sessionId: 'ses_123',
    })
    expect(message).toContain(ROADIE_SYSTEM_PROMPT_MARKER)
    expect(message).toContain('## Callouts in Roadie Discord')
    expect(message).toContain('Do **not** use GitHub callout syntax')
    expect(message).toContain('> [!WARNING]')
    expect(message).toContain('You MUST use `<callout>` when reporting')
    expect(message).toContain('- failing tests')
    expect(message).toContain('- failed commands')
    expect(message).toContain('<callout accent="#f59e0b">')
  })

  test('tells the model the sleep tool result is not a wake', () => {
    const message = getSystemMessage({
      sessionId: 'ses_123',
    })
    expect(message).toContain('The tool result is not a wake')
    expect(message).toContain('Woke after sleeping until')
    expect(message).toContain(
      'If you still need to wake later after answering, call `roadie_sleep` again',
    )
    expect(message).not.toContain('After wake, continue the wait reason')
  })

  test('tells the model to stay quiet between tool calls', () => {
    const message = getSystemMessage({
      sessionId: 'ses_123',
    })
    expect(message).toContain('## Discord output')
    expect(message).toContain('Be concise')
    expect(message).toContain('Do not narrate between tool calls')
    expect(message).toContain(
      'Do not output text until you are ready to give the user the final answer for this turn',
    )
  })

  test('requires interactive tools after all text, using exact tool names', () => {
    const message = getSystemMessage({
      sessionId: 'ses_123',
    })
    expect(message).toContain('You MUST write ALL user-visible text FIRST')
    expect(message).toContain('You MUST call `question` LAST')
    expect(message).toContain('NEVER call `question` before your text')
    expect(message).toContain('`roadie_action_buttons`')
    expect(message).toContain('`roadie_file_upload`')
    expect(message).toContain('`roadie_sleep`')
  })

  test('persists and reads session system prompt for command path', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'roadie-system-'))
    tempDirs.push(dataDir)
    const sessionId = 'ses_command_system'
    const system = getSystemMessage({ sessionId })

    await writeSessionSystemPrompt({ sessionId, system, dataDir })

    const filePath = getSessionSystemPromptPath({ sessionId, dataDir })
    expect(filePath).toBe(
      path.join(dataDir, 'session-system-pinned', `${sessionId}.txt`),
    )
    await expect(
      readSessionSystemPrompt({ sessionId, dataDir }),
    ).resolves.toBe(system)
    expect(system).toContain(ROADIE_SYSTEM_PROMPT_MARKER)
    expect(system).toContain('roadie upload-to-chat <file>')

    const fileMode = (await fs.promises.stat(filePath)).mode & 0o777
    const dirMode = (await fs.promises.stat(path.dirname(filePath))).mode & 0o777
    expect(fileMode).toBe(0o600)
    expect(dirMode).toBe(0o700)

    await deleteSessionSystemPrompt({ sessionId, dataDir })
    await expect(
      readSessionSystemPrompt({ sessionId, dataDir }),
    ).resolves.toBeNull()
  })

  // Regression: a btw fork regenerated the system prompt with its own session
  // and thread IDs, so the 150k-token history prefix missed the prompt cache.
  test('pins system prompt per session and forks reuse the source prompt', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'roadie-system-'))
    tempDirs.push(dataDir)
    const sourceSessionId = 'ses_source'
    const forkSessionId = 'ses_fork'
    // Old command path rewrote this legacy file on every command; never trust it as pinned.
    const legacyPath = path.join(dataDir, 'session-system', `${sourceSessionId}.txt`)
    await fs.promises.mkdir(path.dirname(legacyPath), { recursive: true })
    await fs.promises.writeFile(legacyPath, 'legacy command-path prompt')

    const firstTurn = await resolveSessionSystemPrompt({
      sessionId: sourceSessionId,
      dataDir,
      generate: () => getSystemMessage({ sessionId: sourceSessionId, threadId: 'thread_source', channelTopic: 'old topic' }),
    })
    const laterTurn = await resolveSessionSystemPrompt({
      sessionId: sourceSessionId,
      dataDir,
      generate: () => getSystemMessage({ sessionId: sourceSessionId, threadId: 'thread_source', channelTopic: 'new topic' }),
    })
    expect(laterTurn).toBe(firstTurn)
    expect(firstTurn).not.toBe('legacy command-path prompt')
    expect(firstTurn).toContain('<channel-topic>\nold topic')

    const copied = await copySessionSystemPrompt({ sourceSessionId, targetSessionId: forkSessionId, dataDir })
    const forkSystem = await resolveSessionSystemPrompt({
      sessionId: forkSessionId,
      dataDir,
      generate: () => getSystemMessage({ sessionId: forkSessionId, threadId: 'thread_fork' }),
    })
    if (forkSystem instanceof Error) throw forkSystem
    expect(copied).toBe(true)
    expect(forkSystem).toBe(firstTurn)
    expect(isSystemPromptForSession({ system: forkSystem, sessionId: sourceSessionId })).toBe(true)
    expect(isSystemPromptForSession({ system: forkSystem, sessionId: forkSessionId })).toBe(false)
    expect(systemPromptNamesOtherSession({ system: forkSystem, sessionId: forkSessionId })).toBe(true)
    expect(systemPromptNamesOtherSession({ system: forkSystem, sessionId: sourceSessionId })).toBe(false)
    // A parent set after the first turn is missing from the pinned prompt.
    expect(systemPromptHasParentSession({ system: forkSystem, parentSessionId: 'ses_parent_added_later' })).toBe(false)
    expect(
      systemPromptHasParentSession({
        system: getSystemMessage({ sessionId: 'ses_child', parentSessionId: 'ses_parent' }),
        parentSessionId: 'ses_parent',
      }),
    ).toBe(true)
    expect(
      getPromptContext({
        sessionId: forkSessionId,
        threadId: 'thread_fork',
        systemPromptFromSourceSession: true,
        forkOrigin: { sourceSessionId, sourceThreadId: 'thread_source' },
        parentSessionId: 'ses_parent_added_later',
      }),
    ).toMatchInlineSnapshot(`
      "<system-reminder>
      Your current session ID is: ses_fork
      Your current Discord thread ID is: thread_fork
      This session was forked from thread thread_source (session ses_source); earlier history came from that thread, which continues independently. Message or act on the source session only when the user asks.
      The session ID and thread ID in the system prompt belong to the source session. Use the IDs above instead in every roadie command (--session, --parent-session, --thread, session archive).
      Your parent session ID is: ses_parent_added_later
      You can send a message back to the parent session with:
      roadie send --session ses_parent_added_later --prompt 'your update here' --agent <current_agent>
      Do NOT message the parent session unless the user explicitly asks you to.
      </system-reminder>
      "
    `)

    await expect(
      copySessionSystemPrompt({ sourceSessionId: 'ses_unpinned', targetSessionId: 'ses_other', dataDir }),
    ).resolves.toBe(false)
  })

  // Regression: managed prompt configs omit the session ID line, so every
  // session looked forked.
  test('does not call a session forked when the prompt has no session ID line', () => {
    const managedSystem = 'You are a managed agent.\nNo identity lines here.'
    expect(systemPromptNamesOtherSession({ system: managedSystem, sessionId: 'ses_any' })).toBe(false)
    const context = getPromptContext({
      sessionId: 'ses_any',
      threadId: 'thread_any',
      systemPromptFromSourceSession: systemPromptNamesOtherSession({ system: managedSystem, sessionId: 'ses_any' }),
    })
    expect(context).not.toContain('forked')
    expect(context).toContain('Your current session ID is: ses_any')
  })

  test('names the agent backend running the session in the turn reminder', () => {
    const context = getPromptContext({ sessionId: 'ses_pi', backend: 'Pi', threadId: 'thread_pi' })
    expect(context).toContain('Your current session ID is: ses_pi\nYour agent backend is: Pi\n')
    expect(context).not.toContain('OpenCode')
  })

  test('a late message carries its send time and how long it waited', () => {
    const sentAt = '2026-10-30T13:57:02.000Z'
    const sent = Date.parse(sentAt)
    for (const [waitedMs, expected] of [
      [20_000, ` sent-at="${sentAt}" thread-id`],
      [105 * 60_000, ` sent-at="${sentAt}" queued-for="1h45m" thread-id`],
    ] as const) {
      const context = getPromptContext({
        username: 'roadie-cli', sourceMessageId: 'msg_1', sourceThreadId: 'thread_1',
        sourceMessageTimestamp: sentAt, now: sent + waitedMs,
      })
      expect(context).toContain(`message-id="msg_1"${expected}`)
    }
  })

  test('persisted fork origin adds a fork notice without a stale system prompt', () => {
    const context = getPromptContext({
      sessionId: 'ses_fork',
      threadId: 'thread_fork',
      systemPromptFromSourceSession: false,
      forkOrigin: { sourceSessionId: 'ses_source', sourceThreadId: 'thread_source' },
    })
    expect(context).toContain('This session was forked from thread thread_source (session ses_source); earlier history came from that thread, which continues independently.')
    expect(context).toContain('Message or act on the source session only when the user asks.')
    expect(context).not.toContain('belong to the source session')
  })

  test('readSessionSystemPrompt returns null when missing', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'roadie-system-'))
    tempDirs.push(dataDir)
    await expect(
      readSessionSystemPrompt({ sessionId: 'ses_missing', dataDir }),
    ).resolves.toBeNull()
  })

  test('readSessionSystemPrompt rethrows non-ENOENT errors', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'roadie-system-'))
    tempDirs.push(dataDir)
    const sessionId = 'ses_blocked'
    const filePath = getSessionSystemPromptPath({ sessionId, dataDir })
    await fs.promises.mkdir(path.dirname(filePath), { recursive: true })
    // Path exists as a directory so readFile fails with EISDIR, not ENOENT.
    await fs.promises.mkdir(filePath)
    await expect(
      readSessionSystemPrompt({ sessionId, dataDir }),
    ).rejects.toMatchObject({ code: 'EISDIR' })
  })

  test('tells agents to read compressed session transcripts under 100 KB', () => {
    const message = getSystemMessage({
      sessionId: 'ses_123',
      channelId: 'chan_123',
      threadId: 'thread_123',
    })
    expect(message).toContain('roadie session read <session_id> > ./session.md')
    expect(message).toContain('If a transcript is under 100 KB, read the whole file; do not grep first.')
    expect(message).not.toContain('rg ')
  })

  test('includes session title update guidance when scope or goal changed', () => {
    const message = getSystemMessage({
      sessionId: 'ses_123',
      threadId: 'thread_123',
    })
    expect(message).toContain('## updating the session title')
    expect(message).toContain(
      "roadie session title 'Short title'",
    )
    expect(message).toContain(
      'Skip the first turn. Pi already auto-generates the title from the first message.',
    )
    expect(message).toContain('thread-name="..."')
    expect(message).toContain('Do not retitle every turn')
  })

  test('includes parent session context when parentSessionId is set', () => {
    const message = getSystemMessage({
      sessionId: 'ses_child',
      channelId: 'chan_123',
      parentSessionId: 'ses_parent',
    })
    expect(message).toContain('Your parent session ID is: ses_parent')
    expect(message).toContain(
      "roadie send --session ses_parent --prompt 'your update here' --agent <current_agent>",
    )
    expect(message).toContain(
      'Do NOT message the parent session unless the user explicitly asks you to.',
    )
    expect(message).toContain('--parent-session "$ROADIE_SESSION_ID"')
  })

  test('scheduled cron task section shows task id, cron and no-sleep rule', () => {
    const message = getSystemMessage({
      sessionId: 'ses_task',
      channelId: 'chan_123',
      threadId: 'thread_123',
      scheduledTask: {
        taskId: 23,
        scheduleKind: 'cron',
        cronExpr: '0 6,14 * * *',
        timezone: 'Europe/Rome',
      },
    })
    expect(message).toContain('## scheduled task session')
    expect(message).toContain('roadie scheduled task #23')
    expect(message).toContain('Schedule: cron `0 6,14 * * *` in Europe/Rome.')
    expect(message).toContain('Do NOT use `roadie_sleep` to wait for the next run')
    expect(message).toContain('starts a fresh session automatically')
    const section = message.slice(
      message.indexOf('## scheduled task session'),
      message.indexOf('## archiving the current thread'),
    )
    expect(section).not.toContain('archive')
  })

  test('cron task without timezone says UTC', () => {
    const message = getSystemMessage({
      sessionId: 'ses_task_utc',
      scheduledTask: { taskId: 7, scheduleKind: 'cron', cronExpr: '0 9 * * 1' },
    })
    expect(message).toContain('Schedule: cron `0 9 * * 1` in UTC.')
  })

  test('one-shot at task says it does not repeat and skips sleep', () => {
    const message = getSystemMessage({
      sessionId: 'ses_oneshot',
      scheduledTask: { scheduleKind: 'at' },
    })
    expect(message).toContain('## scheduled task session')
    expect(message).toContain('a one-time roadie scheduled task')
    expect(message).toContain('This task runs once and does not repeat.')
    expect(message).toContain('Do NOT use `roadie_sleep` to wait for the next run')
    expect(message).not.toContain('Schedule: cron')
  })

  test('no scheduled task section by default (normal sessions)', () => {
    const message = getSystemMessage({
      sessionId: 'ses_normal',
      channelId: 'chan_123',
      threadId: 'thread_123',
    })
    expect(message).not.toContain('## scheduled task session')
  })

  test('omits parent session system block by default (btw/task/fork cache)', () => {
    // /btw, task subagents, and normal sessions must not get a parent block in
    // the system message. That block is opt-in via --parent-session only.
    const message = getSystemMessage({
      sessionId: 'ses_btw_or_task',
      channelId: 'chan_123',
      threadId: 'thread_123',
      guildId: 'guild_123',
    })
    expect(message).not.toContain('Your parent session ID is:')
    expect(message).not.toContain(
      'Do NOT message the parent session unless the user explicitly asks you to.',
    )
    // Spawn examples still mention --parent-session for agents that start
    // children via roadie send; that is not the same as injecting a parent.
    expect(message).toContain('--parent-session "$ROADIE_SESSION_ID"')
  })

  test('keeps the system prompt session-scoped', () => {
    const message = getSystemMessage({
      sessionId: 'ses_123',
      channelId: 'chan_123',
      guildId: 'guild_123',
      threadId: 'thread_123',
      username: 'Tommy',
      channelTopic: 'Investigate prompt cache behavior',
      agents: [
        { name: 'plan', description: 'planning only' },
        { name: 'build', description: 'edits files' },
      ],
    }).replace(/`[^`]*\/roadie\.log`/, '`<data-dir>/roadie.log`')

    expect(message).toMatchInlineSnapshot(`
      "
      The user is reading your messages from inside Discord, via Roadie

      ## Discord output

      Be concise. Do not narrate between tool calls. Discord posts every text part, so commentary like "I'll read the file" or "now I'll run tests" is noise.
      Do not output text until you are ready to give the user the final answer for this turn. Tool calls can run with no preceding text.
      Exceptions: when a tool requires user-visible text first (\`question\`, \`roadie_file_upload\`, \`roadie_sleep\`), write that required text, then call the tool. For \`roadie_action_buttons\`, put the explanation in its message argument.
      Write times for the user as chat timestamps: \`<t:UNIX_SECONDS:f>\` (date and time), \`<t:UNIX_SECONDS:t>\` (time) or \`<t:UNIX_SECONDS:R>\` (relative). Chat renders them in each reader's own timezone. Keep UTC ISO for tool arguments.

      ## Roadie command reference

      Agent shells supply the current session and platform through the environment. Replace angle-bracket placeholders with actual arguments; keep shell variables as written.
      - \`roadie upload-to-chat <file> [files...]\` (alias: \`roadie upload-to-discord\`): share artifacts in the current thread. Local Markdown image paths do not render; upload images instead.
      - \`roadie session archive\`: archive the current thread only when the user asks, after your final message.
      - \`roadie session title 'Short title'\`: rename the current session when its scope changes.
      - \`roadie send --thread "$ROADIE_THREAD_ID" --prompt 'Message'\`: continue this thread; substitute another thread ID to contact it. Add \`--wait\` to collect the result.
      - \`roadie send --channel "$ROADIE_CHANNEL_ID" --prompt 'Task'\`: start a new thread in this channel; substitute another channel ID for another project. Optional \`--agent <name>\`, \`--parent-session "$ROADIE_SESSION_ID"\`, \`--cwd <directory>\`, and repeatable \`--file <path>\`.
      - \`roadie send --channel "$ROADIE_CHANNEL_ID" --prompt 'Notice' --notify-only\`: post a notification without starting an agent.
      - \`roadie send --thread "$ROADIE_THREAD_ID" --prompt 'Reminder' --send-at '<UTC ISO time or cron>'\`: schedule a follow-up; use \`--channel\` instead for new threads (optionally \`--notify-only\`).
      - \`roadie session search 'query' [--all] [--days 0]\`: find past sessions (text or /regex/flags); defaults to this project and recent history.
      - \`roadie session read <session_id> > ./session.md\`: read a session transcript; \`--thinking\` / \`--verbose\` include full details.
      - \`roadie session fork --prompt 'Task' [--channel <channel_id>] [--json]\`: copy this conversation into a new thread; omit the channel for the same project.
      - \`roadie session wait <session_id>\`: wait for a session's result and print its transcript (agent tokens can wait only on their own session; use send's --wait for delegated work).
      - \`roadie task list\`: discover scheduled task IDs and settings.
      - \`roadie task edit <id> --prompt 'Task' [--send-at '<UTC ISO time or cron>']\`: update an existing task; \`--agent\`, \`--model\`, \`--pre-run\`, \`--allow-concurrency\`, and \`--user\` change its settings.
      - \`roadie task delete <id>\`: remove a scheduled task.
      - \`roadie project list [--all] [--json]\`: discover project directories and channel IDs, including remote channels with \`--all\`.
      - \`roadie session list [--all] [--active] [--json]\`: discover local session IDs and status.
      - \`roadie session abort <session_id>\`: stop a mistakenly started session without hiding its thread.
      - \`roadie thread list --channel <channel_id> --json\`: discover remote thread IDs.
      - \`roadie user list --guild <guild_id> --query 'name'\`: best-effort Discord user lookup; prefer IDs from chat metadata.
      - \`roadie upgrade [--skip-restart]\`: update Roadie only when explicitly asked; isolated shells require operator approval.
      - Debug log: \`<data-dir>/roadie.log\` (current bot run); see \`docs/debugging-roadie.md\` for bug-report evidence.

      ## session

      Your current session ID is: ses_123
      Your current Discord channel ID is: chan_123
      Your current Discord thread ID is: thread_123
      Your current Discord guild ID is: guild_123

      Per-turn Discord metadata like the current user, current agent, and Discord thread title is delivered in synthetic user message parts.

      ## permissions

      Who may talk to the bot is decided by the bot's configuration: Discord roles by default (server owner, Administrator, Manage Server, or the "Roadie" role), or the host's identity layer and per-channel policy when configured. Do not tell users which role to request; if someone lacks access, say they should ask an admin.

      Other Discord bots are ignored by default. To allow another bot to trigger sessions (for multi-agent orchestration), it needs access the same way a user does.

      ## upgrading roadie

      Upgrade or restart only when explicitly asked. Isolated-shell upgrades and allowlisted credential operations require a Roadie operator's approval in this thread.

      ## debugging roadie issues

      To report a Roadie bug, export the session event jsonl and the relevant log lines (see \`docs/debugging-roadie.md\` in the Roadie repository) and file an issue there with that evidence.
      For internal errors or unresponsive sessions, inspect the debug log. It resets when the bot restarts.

      ## sharing artifacts

      Share screenshots, generated images and visual steps as attachments. Upload long files rather than cluttering the chat.

      ## requesting files from the user

      To ask the user to upload files from their device, use \`roadie_file_upload\`. This shows a native file picker dialog in Discord. The files are downloaded to the project's \`uploads/\` directory and the tool returns the local file paths.
      You MUST call \`roadie_file_upload\` LAST, after ALL text.

      ## sleeping the session

      Use \`roadie_sleep\` to pause this session for hours or days, then continue when the time is reached. The sleep is stored in SQLite and survives bot restarts.
      Pass either \`duration\` (\`30s\`, \`2h\`, \`1d\`) or \`until\` (UTC ISO ending with \`Z\`, example \`2026-08-20T09:00:00Z\`).
      You MUST call \`roadie_sleep\` LAST, after ALL text. Do not call more tools after it.
      A new user message cancels the sleep. If you still need to wake later after answering, call \`roadie_sleep\` again with \`until\` set to the original UTC time.
      The tool result is not a wake. After it succeeds, write one short line that you are waiting, then stop. Do not continue the wait reason and do not pretend time has passed.
      Wake is a later Discord message that starts with \`Woke after sleeping until\`. Only then continue the wait reason.

      ## archiving the current thread

      Archiving hides a thread without stopping the session. Only archive when explicitly asked, after your final message.

      ## aborting a session

      Abort mistakenly started sessions immediately (wrong prompt or destination). Aborting stops processing but keeps the thread visible.

      ## updating the session title

      Skip the first turn. Pi already auto-generates the title from the first message.
      On later turns, update the title if the scope or goal changed.

      Current Discord title is in \`<discord-user thread-name="..." />\`. Discord follows the session title.
      Do not retitle every turn. Discord rate-limits thread renames.
      Keep titles short. No emoji. No ⬦ or Fork: prefixes.

      ## discord user mentions

      Prefer Discord user IDs for mentions. Discord bots cannot ping by @name; use \`<@userId>\` in message text or pass the ID to \`--user\`.
      The current user's ID is available in the per-turn \`<discord-user ... user-id="..." />\` metadata.

      User lookup can fail when Server Members Intent is disabled, so prefer IDs from existing Discord metadata or raw mentions.

      ## delegating work

      Start helper sessions with focused prompts and all relevant context: new sessions have no memory of this conversation. Keep the current agent unless intentionally switching, and identify this session as the parent. Quote literal shell arguments to prevent backtick expansion.
      Default to the current channel unless the user names another destination. Messages to busy threads are picked up at the next step boundary, not as interrupts. For handoffs, include a summary of the task and current state.


      Available agents:
      - \`plan\`: planning only
      - \`build\`: edits files

      ## scheduling guidance

      All scheduling uses UTC. Ask for the user's timezone or UTC equivalent when unspecified; never guess. Keep scheduled prompts short; put complex task specifications in project task files.
      Edit existing tasks rather than duplicating them to increase frequency. Autonomous tasks should not add or mention users unless results need attention; reserve automatic user additions for reminders. Avoid raw username mentions in opening prompts.
      Scheduled sends cannot wait synchronously. Notifications without an agent are supported for new threads, not existing threads.

      ## working directories

      Reuse an existing project subfolder or git worktree for isolated work. Roadie does not create worktrees; create the checkout with project tooling first. The directory must be within the project or one of its git worktrees.

      ## reading other sessions

      Session transcripts are compressed by default (no thinking, truncated tool inputs). If a transcript is under 100 KB, read the whole file; do not grep first. Use full details only when needed. When finding a session for the user, show a clickable thread link rather than raw IDs.
      Forks copy the conversation while the source keeps running. Agent shells may fork only their own token-scoped session. Local session IDs work only on the machine that created them; use thread IDs across machines.

      ## cross-project guidance

      Resolve project names to directories and channel IDs before accessing other projects. A missing project may be remote or unbound; ask the host to bind an unconfigured channel. Remote projects have no local directory: address them by channel ID, not local session ID.
      Send work to another project only when the user explicitly asks, targeting the destination they named.

      ## waiting for results

      Collect delegated results synchronously when needed, and continue from the transcript rather than telling the user to run a command. Allow a long bash timeout in seconds (for example 1500). Waiting returns when the model finishes or pauses for a user question. Exclude the current session when polling active sessions so it does not wait for itself.

      ## submodules

      When pulling submodules advances their commits, commit those pointer updates separately from unrelated changes.

      ## markdown formatting

      Format responses in **Claude-style markdown** - structured, scannable, never walls of text. Use:

      - **Headings with numbered steps** - this is the preferred way to format markdown. Use many level 1 and level 2 headings to structure content. Rarely use level 3 headings. Combine headings with numbered steps for procedures and explanations
      - **Bold** for keywords, important terms, and emphasis
      - **Lists** (bulleted or numbered) for multiple items, steps, or options
      - **Code blocks** with language hints for code snippets
      - **Inline code** for paths, commands, variable names
      - **Quotes** for context, notes, or highlighting key info

      Keep paragraphs short. Break up long explanations into digestible chunks with clear visual hierarchy.

      Discord supports: headings, bold, italic, strikethrough, code blocks, inline code, quotes, lists, and links.

      NEVER wrap URLs in inline code or code blocks - this breaks clickability in Discord. URLs must remain as plain text or use markdown link formatting like [label](url) so users can click them.

      ## Callouts in Roadie Discord

      Use \`<callout>\` HTML blocks for important notices in Discord. Do **not** use GitHub callout syntax like \`> [!WARNING]\`, because Roadie renders \`<callout>\` natively.

      You MUST use \`<callout>\` when reporting:
      - failing tests
      - failed commands
      - incomplete work
      - warnings or caveats
      - action required from the user

      Example:

      \`\`\`md
      <callout accent="#f59e0b">
      ## Tests not fully green

      - \`bun test src/cli.test.ts\` failed in \`CLI Node.js Debugger\`
      - Targeted tests for my change passed
      - I will keep debugging unless you ask me to stop
      </callout>
      \`\`\`

      Roadie renders this as a Discord Container with an accent color. The content inside the callout can include normal markdown, tables, and HTML buttons.

      Use callouts sparingly, only when the content is important enough to skim separately from the rest of the message. Pick the accent by purpose:
      - warnings when implementation is incomplete, use **amber/orange** like \`#f59e0b\`
      - TODOs or follow-up work left in the code, use **yellow** like \`#eab308\`
      - tool execution errors that need user attention, use **red** like \`#ef4444\`
      - the gist of a long message so the user can skim the key point first, use **blue** like \`#3b82f6\`
      - action-required notes, breaking caveats, or important limitations, use **purple** like \`#8b5cf6\`

      Do not wrap the whole response in callouts. Use them to highlight the most important part of the message, not routine updates.

      ## URLs in search results

      When performing web searches, code searches, or any lookup that returns URLs (GitHub repos, docs, Stack Overflow, npm packages, etc.), ALWAYS include the URLs in your response so the user can click them. The user is on Discord and cannot see tool outputs directly - they only see your text. If you found a relevant link, show it. Format as plain text URLs or markdown links like [repo name](url), never inside code blocks.

      ## diagrams

      Make heavy use of diagrams to explain architecture, flows, and relationships. Create diagrams using ASCII art inside code blocks. Prefer diagrams over lengthy text explanations whenever possible. Keep diagram lines at most 100 columns wide so they render correctly on Discord.

      ## ending conversations with options

      You MUST write ALL user-visible text FIRST.
      You MUST call \`question\` LAST, after ALL text parts.
      NEVER call \`question\` before your text. Discord will hide the message.

      For \`roadie_action_buttons\`, put the explanation in its message argument. The same rule applies to \`roadie_file_upload\` and \`roadie_sleep\`.
      You MUST call them LAST, after ALL text.

      ALWAYS use \`question\` when you ask the user a question. Do not write a numbered list in plain text.

      Examples:
      - After completing edits: offer "Commit changes?"
      - If a plan has multiple strategy of implementation show these as options
      - After a genuinely ambiguous request where you cannot infer intent: offer the different approaches





      <channel-topic>
      Investigate prompt cache behavior
      </channel-topic>
      "
    `)
  })

  test('moves per-turn discord metadata into synthetic prompt context', () => {
    expect(
      getPromptContext({
        sessionId: 'ses_123',
        threadId: 'thread_123',
        username: 'Tommy',
        userId: 'user_123',
        sourceMessageId: 'msg_123',
        sourceThreadId: 'thread_123',
        threadName: 'Fix auth bug',
        repliedMessage: {
          authorUsername: 'alice',
          text: 'Original replied message',
        },
        currentAgent: 'build',
        workingDirectoryChanged: true,
        workingDirectory: {
          workingDirectory: '/repo/.worktrees/prompt-cache',
          label: 'prompt-cache',
          projectDirectory: '/repo',
          kind: 'git-worktree',
        },
      }),
    ).toMatchInlineSnapshot(`
      "<discord-user name="Tommy" user-id="user_123" message-id="msg_123" thread-id="thread_123" thread-name="Fix auth bug" />

      <system-reminder>
      Your current session ID is: ses_123
      Your current Discord thread ID is: thread_123
      </system-reminder>

      This message was a reply to message

      <replied-message author="alice">
      Original replied message
      </replied-message>

      <system-reminder>
      Current agent: build
      </system-reminder>

      <system-reminder>
      This thread works in /repo/.worktrees/prompt-cache, not the project root. The working directory (cwd / pwd) has changed; read, write, edit, and run checks (tests, builds, lint) there from now on.
      - It is a separate git checkout of the project (branch: prompt-cache). The project root /repo is a different checkout that the user or another agent may be working in. Do not read, write, or edit files there.
      </system-reminder>
      "
    `)
  })

  test('subfolder working directory reminder does not claim a separate checkout', () => {
    const context = getPromptContext({
      workingDirectoryChanged: true,
      workingDirectory: {
        workingDirectory: '/repo/packages/app',
        label: 'app',
        projectDirectory: '/repo',
        kind: 'directory',
      },
    })
    expect(context).toContain('This thread works in /repo/packages/app')
    expect(context).toContain('a folder inside the project root /repo')
    expect(context).not.toContain('git checkout')
  })

  test('no reminder when the working directory did not change', () => {
    expect(
      getPromptContext({
        workingDirectory: { workingDirectory: '/w', label: 'b', projectDirectory: '/repo', kind: 'git-worktree' },
      }),
    ).not.toContain('This thread works in')
  })
})
