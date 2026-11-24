import { describe, expect, test, vi } from 'vitest'
import { lookupThreadGuildChannels, lookupThreadGuildUsers, roadieToolSchemas, type ThreadLookupDeps, type UserLookupDeps } from './roadie-tools.js'

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

function threadDeps(overrides: Partial<ThreadLookupDeps> = {}): ThreadLookupDeps {
  return {
    getThreadId: vi.fn(async () => 'thread-1'),
    getGuildId: vi.fn(async () => 'guild-1'),
    listChannels: vi.fn(async () => [
      { id: '1559669284437758042', name: 'the-kitchen', type: 0 },
      { id: '1561101964430024887', name: 'ideas', type: 0 },
      { id: 'cat-1', name: 'kitchen stuff', type: 4 },
    ]),
    listActiveThreads: vi.fn(async () => ({
      threads: [
        { id: '1565430848654680075', name: 'Roadie Builds Fully Loaded Gavin Hamilton Artist Profile', type: 11, parent_id: '1559669284437758042' },
        { id: 'private-1', name: 'Fully loaded secret plans', type: 12, parent_id: '1559669284437758042' },
        { id: 'orphan', name: 'fully LOADED orphan', type: 11 },
        { bogus: true },
      ],
    })),
    ...overrides,
  }
}

describe('roadie_thread_lookup', () => {
  test('is registered with a required query arg', () => {
    const schema = roadieToolSchemas().find((tool) => tool.name === 'roadie_thread_lookup')
    expect(schema?.parameters).toMatchObject({ required: ['query'] })
  })

  test('finds active public threads by every query word, scoped to the session guild', async () => {
    const d = threadDeps()
    const output = await lookupThreadGuildChannels({ query: ' Fully  loaded ', sessionId: 'ses-1', deps: d })
    expect(d.getThreadId).toHaveBeenCalledWith('ses-1')
    expect(d.getGuildId).toHaveBeenCalledWith('thread-1')
    expect(d.listChannels).toHaveBeenCalledWith('guild-1')
    expect(d.listActiveThreads).toHaveBeenCalledWith('guild-1')
    expect(output).toMatchInlineSnapshot(`
      "Found 2 matching "Fully  loaded":
      Roadie Builds Fully Loaded Gavin Hamilton Artist Profile (thread in #the-kitchen, ID: 1565430848654680075, channel ID: 1559669284437758042) - link: <#1565430848654680075>
      fully LOADED orphan (thread, ID: orphan) - link: <#orphan>"
    `)
    expect(output).not.toContain('secret')
  })

  test('finds channels but not categories', async () => {
    const output = await lookupThreadGuildChannels({ query: 'kitchen', sessionId: 's', deps: threadDeps() })
    expect(output).toContain('#the-kitchen (text channel, ID: 1559669284437758042) - link: <#1559669284437758042>')
    expect(output).not.toContain('kitchen stuff')
  })

  test('caps output at 25 matches', async () => {
    const threads = Array.from({ length: 30 }, (_, i) => ({ id: String(i), name: `show ${i}`, type: 11 }))
    const output = await lookupThreadGuildChannels({ query: 'show', sessionId: 's', deps: threadDeps({ listActiveThreads: async () => ({ threads }) }) })
    expect(output.split('\n')).toHaveLength(27)
    expect(output).toContain('(5 more; narrow the query)')
  })

  test('still reports channels when active threads cannot be listed', async () => {
    const output = await lookupThreadGuildChannels({ query: 'ideas', sessionId: 's', deps: threadDeps({ listActiveThreads: async () => new Error('Missing Access') }) })
    expect(output).toContain('#ideas')
    expect(output).toContain('(Active threads could not be listed: Missing Access)')
  })

  test('reports a missing thread, a non-guild thread, and channel failures', async () => {
    expect(await lookupThreadGuildChannels({ query: 'x', sessionId: 's', deps: threadDeps({ getThreadId: async () => undefined }) })).toContain('Could not find thread for current session')
    expect(await lookupThreadGuildChannels({ query: 'x', sessionId: 's', deps: threadDeps({ getGuildId: async () => undefined }) })).toContain('not in a Discord server')
    expect(await lookupThreadGuildChannels({ query: 'x', sessionId: 's', deps: threadDeps({ listChannels: async () => new Error('boom') }) })).toBe('Thread lookup failed: boom')
  })

  test('reports no matches and empty queries', async () => {
    expect(await lookupThreadGuildChannels({ query: 'nothing here', sessionId: 's', deps: threadDeps() })).toBe('No channels or active threads found matching "nothing here". Archived threads are not searched.')
    expect(await lookupThreadGuildChannels({ query: '   ', sessionId: 's', deps: threadDeps() })).toBe('Provide a non-empty name fragment to search for')
  })
})
