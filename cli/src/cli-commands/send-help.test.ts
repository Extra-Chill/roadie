import { describe, expect, test, vi } from 'vitest'
import { goke } from 'goke'

// Help and argument validation must not reach database or network operations.
vi.mock('../discord-bot.js', () => ({ initDatabase: vi.fn(), getChannelDirectory: vi.fn() }))

const sendCommands = (await import('./send.js')).default

// CI terminals may colorize goke output; compare the plain text.
const plain = (text: string) => text.replace(/\u001b\[[0-9;]*m/g, '')

function makeCli() {
  const stdout = { text: '', write(data: string) { this.text += String(data) } }
  const stderr = { text: '', write(data: string) { this.text += String(data) } }
  const cli = goke('roadie', { stdout, stderr })
  cli.use(sendCommands)
  cli.help()
  return { cli, stdout, stderr }
}

describe('send help and removed options', () => {
  test('help describes cross-thread messaging, not delegation', async () => {
    const { cli, stdout } = makeCli()
    await cli.parse(['node', 'roadie', 'send', '--help'])
    const help = plain(stdout.text)
    expect(help).not.toContain('Removed:')
    expect(help).not.toMatch(/--project|--worktree|child sessions/)
    expect(help).toContain('subagent tool')
    expect(help).toContain('this is not in-thread delegation')
    expect(help).toMatchSnapshot()
  })

  test.each([
    ['--worktree', 'feature', '--worktree was removed: create the checkout with your host tooling, then pass it with --cwd'],
    ['--worktree', undefined, '--worktree was removed: create the checkout with your host tooling, then pass it with --cwd'],
    ['--worktree=feature', undefined, '--worktree was removed: create the checkout with your host tooling, then pass it with --cwd'],
    ['--project', '/repo', '--project was removed: channels are application configuration; use --channel'],
    ['-d', '/repo', '--project was removed: channels are application configuration; use --channel'],
  ])('%s fails with a migration hint', async (flag, value, hint) => {
    const { cli, stderr } = makeCli()
    const argv = ['node', 'roadie', 'send', flag]
    if (value !== undefined) argv.push(value)
    await expect(cli.parse(argv)).rejects.toThrow()
    expect(plain(stderr.text).trim()).toBe(`error: ${hint}\n\nRun "roadie send --help" for usage information.`)
  })

  test('unrelated unknown options still fail validation', async () => {
    const { cli, stderr } = makeCli()
    await expect(cli.parse(['node', 'roadie', 'send', '--typo'])).rejects.toThrow()
    expect(plain(stderr.text)).toContain('Unknown option `--typo`')
  })
})
