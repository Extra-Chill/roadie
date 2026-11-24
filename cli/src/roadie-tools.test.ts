import { describe, expect, test, vi } from 'vitest'
import { lookupThreadGuildUsers, roadieToolSchemas, type UserLookupDeps } from './roadie-tools.js'

function deps(overrides: Partial<UserLookupDeps> = {}): UserLookupDeps {
  return {
    getThreadId: vi.fn(async () => 'thread-1'),
    getGuildId: vi.fn(async () => 'guild-1'),
    searchMembers: vi.fn(async () => []),
    ...overrides,
  }
}

describe('roadie_user_lookup', () => {
  test('is registered with a required query arg', () => {
    const schema = roadieToolSchemas().find((tool) => tool.name === 'roadie_user_lookup')
    expect(schema?.parameters).toMatchObject({ required: ['query'] })
  })

  test('resolves the guild from the session thread and formats matches', async () => {
    const d = deps({
      searchMembers: vi.fn(async () => [
        { user: { id: '532385681268408341', username: 'chubes' } },
        { user: { id: '2', username: 'other', global_name: 'Global' }, nick: 'Nick' },
        { user: { id: '3', username: 'g', global_name: 'Global Only' } },
        { bogus: true },
      ]),
    })
    const output = await lookupThreadGuildUsers({ query: ' chubes ', sessionId: 'ses-1', deps: d })
    expect(d.getThreadId).toHaveBeenCalledWith('ses-1')
    expect(d.getGuildId).toHaveBeenCalledWith('thread-1')
    expect(d.searchMembers).toHaveBeenCalledWith({ guildId: 'guild-1', query: 'chubes', limit: 20 })
    expect(output).toMatchInlineSnapshot(`
      "Found 3 users matching "chubes":
      chubes (ID: 532385681268408341) - mention: <@532385681268408341>
      Nick (ID: 2) - mention: <@2>
      Global Only (ID: 3) - mention: <@3>"
    `)
  })

  test('caps output at 20 users', async () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ user: { id: String(i), username: `u${i}` } }))
    const output = await lookupThreadGuildUsers({ query: 'u', sessionId: 's', deps: deps({ searchMembers: async () => many }) })
    expect(output.split('\n').length).toBe(21)
  })

  test('reports a missing thread', async () => {
    const d = deps({ getThreadId: async () => undefined })
    const output = await lookupThreadGuildUsers({ query: 'x', sessionId: 's', deps: d })
    expect(output).toContain('Could not find thread for current session')
    expect(d.searchMembers).not.toHaveBeenCalled()
  })

  test('reports a thread outside a guild', async () => {
    const output = await lookupThreadGuildUsers({ query: 'x', sessionId: 's', deps: deps({ getGuildId: async () => undefined }) })
    expect(output).toContain('not in a Discord server')
  })

  test('reports member lookup unavailable', async () => {
    const forbidden = Object.assign(new Error('Missing Access'), { status: 403 })
    const output = await lookupThreadGuildUsers({
      query: 'x',
      sessionId: 's',
      deps: deps({ searchMembers: async () => new Error('Discord member search failed', { cause: forbidden }) }),
    })
    expect(output).toContain('Discord member search is unavailable for this bot.')
  })

  test('reports other search failures', async () => {
    const output = await lookupThreadGuildUsers({ query: 'x', sessionId: 's', deps: deps({ searchMembers: async () => new Error('boom') }) })
    expect(output).toBe('User lookup failed: boom')
  })

  test('reports no matches', async () => {
    const output = await lookupThreadGuildUsers({ query: 'nobody', sessionId: 's', deps: deps() })
    expect(output).toBe('No users found matching "nobody"')
  })
})
