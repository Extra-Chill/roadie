import { afterEach, describe, expect, test } from 'vitest'
import {
  clearDiscordParticipantsForTests,
  createMentionResolver,
  discordMentionResolver,
  recordDiscordParticipant,
  rewriteDiscordMentions,
  rewritePlainMentions,
} from './discord-mentions.js'

const CHUBES = '532385681268408341'
const resolve = createMentionResolver([
  [
    { id: CHUBES, names: ['chubes', 'Chris Huber'] },
    { id: '111', names: ['alex'] },
    { id: '222', names: ['alex'] },
    { id: '333', names: ['everyone', 'here'] },
  ],
])

describe('rewritePlainMentions', () => {
  test('rewrites a known participant', () => {
    expect(rewritePlainMentions('hey @chubes can you look?', resolve)).toBe(
      `hey <@${CHUBES}> can you look?`,
    )
    expect(rewritePlainMentions('@Chubes first', resolve)).toBe(`<@${CHUBES}> first`)
  })

  test('leaves an unknown name alone', () => {
    expect(rewritePlainMentions('ask @nobody about it', resolve)).toBe('ask @nobody about it')
  })

  test('leaves an ambiguous name alone', () => {
    expect(rewritePlainMentions('ping @alex', resolve)).toBe('ping @alex')
  })

  test('keeps trailing punctuation outside the mention', () => {
    expect(rewritePlainMentions('@chubes, thoughts? (@chubes) @chubes. @chubes!', resolve)).toBe(
      `<@${CHUBES}>, thoughts? (<@${CHUBES}>) <@${CHUBES}>. <@${CHUBES}>!`,
    )
  })

  test('skips inline code spans', () => {
    expect(rewritePlainMentions('run `notify @chubes` then ``@chubes`` and @chubes', resolve)).toBe(
      `run \`notify @chubes\` then \`\`@chubes\`\` and <@${CHUBES}>`,
    )
  })

  test('skips fenced code blocks', () => {
    const input = [
      'before @chubes',
      '```ts',
      'const who = "@chubes"',
      '```',
      '~~~',
      '@chubes',
      '~~~',
      'after @chubes',
    ].join('\n')
    expect(rewritePlainMentions(input, resolve)).toBe(
      [
        `before <@${CHUBES}>`,
        '```ts',
        'const who = "@chubes"',
        '```',
        '~~~',
        '@chubes',
        '~~~',
        `after <@${CHUBES}>`,
      ].join('\n'),
    )
  })

  test('skips URLs', () => {
    const input = 'see https://medium.com/@chubes/post and <https://x.com/@chubes> and www.site.com/@chubes'
    expect(rewritePlainMentions(input, resolve)).toBe(input)
  })

  test('skips email addresses', () => {
    expect(rewritePlainMentions('mail chris@chubes.com or chubes@example.org', resolve)).toBe(
      'mail chris@chubes.com or chubes@example.org',
    )
  })

  test('leaves existing Discord mentions untouched', () => {
    const input = `<@${CHUBES}> <@!${CHUBES}> <@&123> <#456>`
    expect(rewritePlainMentions(input, resolve)).toBe(input)
  })

  test('never rewrites @everyone or @here', () => {
    expect(rewritePlainMentions('@everyone and @here', resolve)).toBe('@everyone and @here')
  })

  test('returns text without @ unchanged', () => {
    expect(rewritePlainMentions('no mentions here', () => CHUBES)).toBe('no mentions here')
  })
})

describe('createMentionResolver', () => {
  test('earlier groups win over later ones', () => {
    const resolver = createMentionResolver([
      [{ id: '1', names: ['sam'] }],
      [{ id: '2', names: ['sam'] }, { id: '3', names: ['kim'] }],
    ])
    expect(resolver('SAM')).toBe('1')
    expect(resolver('kim')).toBe('3')
  })

  test('the same user under several names is not ambiguous', () => {
    const resolver = createMentionResolver([[{ id: '1', names: ['sam', 'Sam'] }]])
    expect(resolver('sam')).toBe('1')
  })
})

describe('discord channel resolution', () => {
  afterEach(() => clearDiscordParticipantsForTests())

  const member = (id: string, username: string, nickname?: string) => ({
    id,
    nickname,
    displayName: nickname ?? username,
    user: { id, username, globalName: null },
  })

  test('uses recorded thread participants, then the guild member cache, never the bot', () => {
    recordDiscordParticipant('thread-1', { id: CHUBES, names: ['chubes', 'Chris'] })
    const channel = {
      id: 'thread-1',
      client: { user: { id: '999' } },
      guild: {
        members: {
          cache: new Map([
            ['444', member('444', 'chris2', 'Chris')],
            ['555', member('555', 'dana')],
            ['999', member('999', 'roadie')],
          ]),
        },
      },
    }
    const resolver = discordMentionResolver(channel)
    // "Chris" is ambiguous guild-wide but unique among thread participants.
    expect(resolver('chris')).toBe(CHUBES)
    expect(resolver('dana')).toBe('555')
    expect(resolver('roadie')).toBeUndefined()
    expect(rewriteDiscordMentions('@chubes and @dana, meet @roadie', channel)).toBe(
      `<@${CHUBES}> and <@555>, meet @roadie`,
    )
  })

  test('resolves a DM recipient without a guild', () => {
    const channel = { id: 'dm-1', recipient: { id: CHUBES, username: 'chubes', globalName: 'Chris Huber' } }
    expect(rewriteDiscordMentions('thanks @chubes', channel)).toBe(`thanks <@${CHUBES}>`)
  })
})
