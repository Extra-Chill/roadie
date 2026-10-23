import { beforeEach, expect, test, vi } from 'vitest'
import type { AgentBackend } from '../agent-backend/types.js'
import { registerSpeakerMcpServers, personMcpServerName } from '../person-mcp.js'
import { getCachedPerson, isIdentityConfigured } from '../identity.js'

vi.mock('../identity.js', () => ({ getCachedPerson: vi.fn(), isIdentityConfigured: vi.fn() }))
vi.mock('../config.js', () => ({ getDataDir: () => '/data' }))
vi.mock('../credentials/person-mcp-store.js', () => ({
  MCP_NAME_PATTERN: /^[a-z]+$/,
  isAllowedMcpUrl: () => true,
  getPersonMcpAccessToken: async () => 'token',
}))

const servers = [{ name: 'tools', url: 'https://example.com/mcp', credential: 'tools' }]
const person = { allowed: true, personId: 'person', capabilities: new Set(['sessions'] as const), permissions: [], mcpServers: servers }

beforeEach(() => {
  vi.mocked(isIdentityConfigured).mockReturnValue(true)
  vi.mocked(getCachedPerson).mockReturnValue(person)
})

test.each([
  { input: {}, configured: true, cached: person },
  { input: { userId: 'speaker', actorVia: 'cli' as const }, configured: true, cached: person },
  { input: { userId: 'speaker' }, configured: false, cached: person },
  { input: { userId: 'speaker' }, configured: true, cached: undefined },
  { input: { userId: 'speaker' }, configured: true, cached: { ...person, allowed: false } },
  { input: { userId: 'speaker' }, configured: true, cached: { ...person, mcpServers: [] } },
])('skips speakers without eligible cached chat identity: %j', async ({ input, configured, cached }) => {
  vi.mocked(isIdentityConfigured).mockReturnValue(configured)
  vi.mocked(getCachedPerson).mockReturnValue(cached)
  const addRemote = vi.fn()
  await registerSpeakerMcpServers({ mcp: { addRemote } } as unknown as AgentBackend, 'slack', '/checkout', input)
  expect(addRemote).not.toHaveBeenCalled()
})

test('uses the cached platform identity and checkout, not the ingress person hint', async () => {
  const addRemote = vi.fn(async () => undefined)
  const client = { mcp: { addRemote } } as unknown as AgentBackend
  await registerSpeakerMcpServers(client, 'slack', '/checkout', { userId: 'speaker', personId: 'untrusted' })
  expect(getCachedPerson).toHaveBeenCalledWith({ platform: 'slack', id: 'speaker' })
  expect(addRemote).toHaveBeenCalledWith({
    directory: '/checkout', name: personMcpServerName({ personKey: 'person', name: 'tools' }),
    url: servers[0]!.url, headers: { Authorization: 'Bearer token' }, owner: 'person',
  })
})

test('registration failures do not stop the turn', async () => {
  const addRemote = vi.fn(async () => { throw new Error('unavailable') })
  await expect(registerSpeakerMcpServers(
    { mcp: { addRemote } } as unknown as AgentBackend, 'discord', '/checkout', { userId: 'speaker' },
  )).resolves.toBeUndefined()
})
