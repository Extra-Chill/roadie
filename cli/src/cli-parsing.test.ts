// Regression tests for CLI argument parsing around Discord ID string preservation.
import { describe, expect, test } from 'vitest'
import { execAsync } from './exec-async.js'
import maintenanceCommands from './cli-commands/maintenance.js'

async function parseWithGoke(argv: string[]) {
  const script = [
    "import { goke } from 'goke'",
    'const cli = goke(\'roadie\')',
    "cli.command('send', 'Send a message').option('-c, --channel <channelId>', 'Discord channel ID').option('--thread <threadId>', 'Thread ID').option('--session <sessionId>', 'Session ID').option('--send-at <schedule>', 'Schedule')",
    "cli.command('session archive <threadId>', 'Archive a thread')",
    "cli.command('session title <title>', 'Update title').option('--session <sessionId>', 'Session ID').option('--thread <threadId>', 'Thread ID')",
    "cli.command('session search <query>', 'Search sessions').option('--channel <channelId>', 'Discord channel ID').option('--project <path>', 'Project path').option('--all', 'Search all registered projects').option('--days <n>', 'Only search recent sessions')",
    "cli.command('session export-events-jsonl', 'Export in-memory events to JSONL').option('--session <sessionId>', 'Session ID').option('--out <file>', 'Output path')",
    "cli.command('add-project', 'Add a project').option('-g, --guild <guildId>', 'Discord guild/server ID')",
    "cli.command('task delete <id>', 'Delete task')",
    "cli.command('task edit <id>', 'Edit task').option('-u, --user <user>', 'Discord user')",
    `const result = await cli.parse(${JSON.stringify(argv)}, { run: false })`,
    'process.stdout.write(JSON.stringify({ args: result.args, options: result.options }))',
  ].join(';')

  const { stdout } = await execAsync(`node --input-type=module -e ${JSON.stringify(script)}`, {
    cwd: import.meta.dirname,
    timeout: 10_000,
  })
  return JSON.parse(stdout) as {
    args: string[]
    options: Record<string, string>
  }
}

async function getHelpOutput() {
  const script = [
    "import { goke } from 'goke'",
    'const stdout = { text: \'\', write(data) { this.text += String(data) } }',
    "const cli = goke('roadie', { stdout })",
    "cli.command('send', 'Send a message')",
    'cli.help()',
    "cli.parse(['node', 'roadie', '--help'], { run: false })",
    'process.stdout.write(stdout.text)',
  ].join(';')

  const { stdout } = await execAsync(`node --input-type=module -e ${JSON.stringify(script)}`, {
    cwd: import.meta.dirname,
    timeout: 10_000,
  })
  return stdout
}

async function parseRootBotOptions(argv: string[]) {
  const script = [
    "import { goke } from 'goke'",
    'const cli = goke(\'roadie\')',
    "cli.command('', 'bot').option('--no-analytics', 'Disable analytics').option('--enable-footer-mentions', 'Mention the thread creator in final footers')",
    `const result = await cli.parse(${JSON.stringify(argv)}, { run: false })`,
    'process.stdout.write(JSON.stringify({ args: result.args, options: result.options }))',
  ].join(';')

  const { stdout } = await execAsync(`node --input-type=module -e ${JSON.stringify(script)}`, {
    cwd: import.meta.dirname,
    timeout: 10_000,
  })
  return JSON.parse(stdout) as {
    args: string[]
    options: Record<string, unknown>
  }
}

describe('goke CLI ID parsing', () => {
  test('keeps large Discord IDs as strings', async () => {
    const channelId = '1234567890123456789'
    const threadId = '9876543210987654321'
    const sessionId = '1111222233334444555'

    const channelResult = await parseWithGoke(
      ['node', 'roadie', 'send', '--channel', channelId],
    )
    expect(channelResult.options.channel).toBe(channelId)
    expect(typeof channelResult.options.channel).toBe('string')

    const threadResult = await parseWithGoke(
      ['node', 'roadie', 'send', '--thread', threadId],
    )
    expect(threadResult.options.thread).toBe(threadId)
    expect(typeof threadResult.options.thread).toBe('string')

    const sessionResult = await parseWithGoke(
      ['node', 'roadie', 'send', '--session', sessionId],
    )
    expect(sessionResult.options.session).toBe(sessionId)
    expect(typeof sessionResult.options.session).toBe('string')
  })

  test('preserves leading zeros in Discord IDs', async () => {
    const guildId = '001230045600789'

    const result = await parseWithGoke(
      ['node', 'roadie', 'add-project', '--guild', guildId],
    )

    expect(result.options.guild).toBe(guildId)
    expect(typeof result.options.guild).toBe('string')
  })

  test('keeps session title and session ID as strings', async () => {
    const sessionId = '001111222233334444'
    const title = 'Fix queue draining'

    const result = await parseWithGoke(
      [
        'node',
        'roadie',
        'session',
        'title',
        title,
        '--session',
        sessionId,
      ],
    )

    expect(result.args[0]).toBe(title)
    expect(typeof result.args[0]).toBe('string')
    expect(result.options.session).toBe(sessionId)
    expect(typeof result.options.session).toBe('string')
  })

  test('keeps session archive thread ID as string', async () => {
    const threadId = '0098765432109876543'

    const result = await parseWithGoke(
      ['node', 'roadie', 'session', 'archive', threadId],
    )

    expect(result.args[0]).toBe(threadId)
    expect(typeof result.args[0]).toBe('string')
  })

  test('keeps session search regex and channel ID as strings', async () => {
    const channelId = '0012345678901234567'
    const query = '/error\\s+42/i'

    const result = await parseWithGoke(
      ['node', 'roadie', 'session', 'search', query, '--channel', channelId],
    )

    expect(result.args[0]).toBe(query)
    expect(typeof result.args[0]).toBe('string')
    expect(result.options.channel).toBe(channelId)
    expect(typeof result.options.channel).toBe('string')
  })

  test('parses session search --all as a boolean', async () => {
    const result = await parseWithGoke(
      ['node', 'roadie', 'session', 'search', 'auth timeout', '--all'],
    )

    expect(result.args[0]).toBe('auth timeout')
    expect(result.options.all).toBe(true)
  })

  test('parses session search --days as a string', async () => {
    const result = await parseWithGoke(
      ['node', 'roadie', 'session', 'search', 'auth timeout', '--days', '0'],
    )

    expect(result.options.days).toBe('0')
  })

  test('keeps session export options as strings', async () => {
    const sessionId = '001111222233334444'
    const outPath = './tmp/session-events.jsonl'

    const result = await parseWithGoke(
      [
        'node',
        'roadie',
        'session',
        'export-events-jsonl',
        '--session',
        sessionId,
        '--out',
        outPath,
      ],
    )

    expect(result.options.session).toBe(sessionId)
    expect(typeof result.options.session).toBe('string')
    expect(result.options.out).toBe(outPath)
    expect(typeof result.options.out).toBe('string')
  })

  test('keeps --send-at cron string intact', async () => {
    const cron = '0 9 * * 1'

    const result = await parseWithGoke(['node', 'roadie', 'send', '--send-at', cron])

    expect(result.options.sendAt).toBe(cron)
    expect(typeof result.options.sendAt).toBe('string')
  })

  test('keeps task delete ID as string before validation', async () => {
    const taskId = '0012345'

    const result = await parseWithGoke(['node', 'roadie', 'task', 'delete', taskId])

    expect(result.args[0]).toBe(taskId)
    expect(typeof result.args[0]).toBe('string')
  })

  test('parses empty --user on task edit so the stored user can be cleared', async () => {
    const result = await parseWithGoke([
      'node',
      'roadie',
      'task',
      'edit',
      '11',
      '--user',
      '',
    ])

    expect(result.args[0]).toBe('11')
    expect(result.options.user).toBe('')
  })

  test('parses root bot boolean flags', async () => {
    const result = await parseRootBotOptions([
      'node',
      'roadie',
      '--no-analytics',
      '--enable-footer-mentions',
    ])

    expect(result.options).toMatchInlineSnapshot(`
      {
        "--": [],
        "enableFooterMentions": true,
        "noAnalytics": true,
      }
    `)
  })
})
