import { describe, expect, test } from 'vitest'
import {
  MAX_TOOL_NAME_LENGTH,
  displayServerName,
  isPersonMcpServerName,
  mcpToolLabel,
  mcpToolName,
  personMcpScope,
  personMcpServerName,
} from './person-mcp-name.js'

describe('person MCP naming', () => {
  test('scope is fixed-length and short', () => {
    const a = personMcpScope('wordpress:/var/www/example.com:38')
    const b = personMcpScope('discord:123')
    expect(a).toMatch(/^rpm_[0-9a-f]{12}$/)
    expect(b).toHaveLength(a.length)
    expect(isPersonMcpServerName(`${a}_extrachill`)).toBe(true)
    expect(isPersonMcpServerName('extrachill')).toBe(false)
  })

  test('typical server + tool names fit the provider limit without a hash suffix', () => {
    const server = personMcpServerName({ personKey: 'wordpress:/var/www/extrachill.com:1', name: 'extrachill' })
    const search = mcpToolName(server, 'extrachill-ability-search')
    const call = mcpToolName(server, 'extrachill-ability-call')
    expect(search).toBe(`mcp__${server}__extrachill_ability_search`)
    expect(search.length).toBeLessThanOrEqual(MAX_TOOL_NAME_LENGTH)
    expect(call).toBe(`mcp__${server}__extrachill_ability_call`)
  })

  test('names past the limit are shortened with a stable hash suffix', () => {
    const name = mcpToolName('rpm_abc123def456_server', 'a'.repeat(80))
    expect(name).toHaveLength(MAX_TOOL_NAME_LENGTH)
    expect(name).toMatch(/_[0-9a-f]{8}$/)
    expect(mcpToolName('rpm_abc123def456_server', 'a'.repeat(80))).toBe(name)
  })

  test('display server name drops the person scope', () => {
    expect(displayServerName('rpm_abc123def456_wordpress')).toBe('wordpress')
    expect(displayServerName('wordpress')).toBe('wordpress')
  })

  test('tool labels read as server › tool', () => {
    expect(mcpToolLabel('mcp__rpm_abc123def456_extrachill__extrachill_ability_search')).toBe('extrachill › ability-search')
    expect(mcpToolLabel('mcp__rpm_abc123def456_jira__search_issues')).toBe('jira › search-issues')
    expect(mcpToolLabel('mcp__docs__lookup')).toBe('docs › lookup')
    expect(mcpToolLabel('bash')).toBe('bash')
  })
})
