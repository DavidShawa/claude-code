import { mock, describe, expect, test } from 'bun:test'

// Mock heavy deps
const getAgentModelMock = mock(
  (
    agentModel: string | undefined,
    parentModel: string,
    toolSpecifiedModel?: string,
  ) => {
    if (toolSpecifiedModel) return `resolved:${toolSpecifiedModel}`
    if (agentModel === 'inherit' || agentModel === undefined) return parentModel
    return `resolved:${agentModel}`
  },
)

mock.module('src/utils/model/agent.js', () => ({
  getDefaultSubagentModel: () => 'inherit',
  getAgentModel: getAgentModelMock,
}))

mock.module('src/utils/settings/constants.js', () => ({
  getSourceDisplayName: (source: string) => source,
  getSourceDisplayNameLowercase: (source: string) => source,
  getSourceDisplayNameCapitalized: (source: string) => source,
  getSettingSourceName: (source: string) => source,
  getSettingSourceDisplayNameLowercase: (source: string) => source,
  getSettingSourceDisplayNameCapitalized: (source: string) => source,
  parseSettingSourcesFlag: () => [],
  getEnabledSettingSources: () => [],
  isSettingSourceEnabled: () => true,
  SETTING_SOURCES: ['localSettings', 'userSettings', 'projectSettings'],
  SOURCES: ['localSettings', 'userSettings', 'projectSettings'],
  CLAUDE_CODE_SETTINGS_SCHEMA_URL:
    'https://json.schemastore.org/claude-code-settings.json',
}))

// generalPurposeAgent pulls loadAgentsDir; stub the agent type only path we need
mock.module('../built-in/generalPurposeAgent.js', () => ({
  GENERAL_PURPOSE_AGENT: {
    agentType: 'general-purpose',
    source: 'built-in',
  },
}))

const {
  resolveAgentOverrides,
  compareAgentsByName,
  AGENT_SOURCE_GROUPS,
  resolveAgentToolModelForDisplay,
} = await import('../agentDisplay')

function makeAgent(agentType: string, source: string): any {
  return { agentType, source, name: agentType }
}

describe('resolveAgentOverrides', () => {
  test('marks no overrides when all agents active', () => {
    const agents = [makeAgent('builder', 'userSettings')]
    const result = resolveAgentOverrides(agents, agents)
    expect(result).toHaveLength(1)
    expect(result[0].overriddenBy).toBeUndefined()
  })

  test('marks inactive agent as overridden', () => {
    const allAgents = [
      makeAgent('builder', 'projectSettings'),
      makeAgent('builder', 'userSettings'),
    ]
    const activeAgents = [makeAgent('builder', 'userSettings')]
    const result = resolveAgentOverrides(allAgents, activeAgents)
    const projectAgent = result.find((a: any) => a.source === 'projectSettings')
    expect(projectAgent?.overriddenBy).toBe('userSettings')
  })

  test('overriddenBy shows the overriding agent source', () => {
    const allAgents = [makeAgent('tester', 'localSettings')]
    const activeAgents = [makeAgent('tester', 'policySettings')]
    const result = resolveAgentOverrides(allAgents, activeAgents)
    expect(result[0].overriddenBy).toBe('policySettings')
  })

  test('deduplicates agents by (agentType, source)', () => {
    const agents = [
      makeAgent('builder', 'userSettings'),
      makeAgent('builder', 'userSettings'), // duplicate
    ]
    const result = resolveAgentOverrides(agents, agents.slice(0, 1))
    expect(result).toHaveLength(1)
  })

  test('preserves agent definition properties', () => {
    const agents = [
      { agentType: 'a', source: 'userSettings', name: 'Agent A' },
    ] as any[]
    const result = resolveAgentOverrides(agents, agents)
    expect((result[0] as any).name).toBe('Agent A')
    expect(result[0].agentType).toBe('a')
  })

  test('handles empty arrays', () => {
    expect(resolveAgentOverrides([], [])).toEqual([])
  })

  test('handles agent from git worktree (duplicate detection)', () => {
    const agents = [
      makeAgent('builder', 'projectSettings'),
      makeAgent('builder', 'projectSettings'),
      makeAgent('builder', 'localSettings'),
    ]
    const result = resolveAgentOverrides(agents, agents.slice(0, 1))
    // Deduped: projectSettings appears once, localSettings once
    expect(result).toHaveLength(2)
  })
})

describe('compareAgentsByName', () => {
  test('sorts alphabetically ascending', () => {
    const a = makeAgent('alpha', 'userSettings')
    const b = makeAgent('beta', 'userSettings')
    expect(compareAgentsByName(a, b)).toBeLessThan(0)
  })

  test('returns negative when a.name < b.name', () => {
    const a = makeAgent('a', 's')
    const b = makeAgent('b', 's')
    expect(compareAgentsByName(a, b)).toBeLessThan(0)
  })

  test('returns positive when a.name > b.name', () => {
    const a = makeAgent('z', 's')
    const b = makeAgent('a', 's')
    expect(compareAgentsByName(a, b)).toBeGreaterThan(0)
  })

  test('returns 0 for same name', () => {
    const a = makeAgent('same', 's')
    const b = makeAgent('same', 's')
    expect(compareAgentsByName(a, b)).toBe(0)
  })

  test('is case-insensitive (sensitivity: base)', () => {
    const a = makeAgent('Alpha', 's')
    const b = makeAgent('alpha', 's')
    expect(compareAgentsByName(a, b)).toBe(0)
  })
})

describe('AGENT_SOURCE_GROUPS', () => {
  test('contains expected source groups in order', () => {
    expect(AGENT_SOURCE_GROUPS).toHaveLength(7)
    expect(AGENT_SOURCE_GROUPS[0]).toEqual({
      label: 'User agents',
      source: 'userSettings',
    })
    expect(AGENT_SOURCE_GROUPS[6]).toEqual({
      label: 'Built-in agents',
      source: 'built-in',
    })
  })

  test('has unique labels', () => {
    const labels = AGENT_SOURCE_GROUPS.map(g => g.label)
    expect(new Set(labels).size).toBe(labels.length)
  })

  test('has unique sources', () => {
    const sources = AGENT_SOURCE_GROUPS.map(g => g.source)
    expect(new Set(sources).size).toBe(sources.length)
  })
})

describe('resolveAgentToolModelForDisplay', () => {
  test('uses agent definition model when tool omits model (e.g. Explore → haiku)', () => {
    const agents = [
      { agentType: 'Explore', source: 'built-in', model: 'haiku' },
    ] as any[]
    const result = resolveAgentToolModelForDisplay(
      { subagent_type: 'Explore' },
      { parentModel: 'claude-sonnet-4-6', agents },
    )
    expect(result).toBe('resolved:haiku')
  })

  test('tool-specified model takes precedence over agent definition', () => {
    const agents = [
      { agentType: 'Explore', source: 'built-in', model: 'haiku' },
    ] as any[]
    const result = resolveAgentToolModelForDisplay(
      { subagent_type: 'Explore', model: 'opus' },
      { parentModel: 'claude-sonnet-4-6', agents },
    )
    expect(result).toBe('resolved:opus')
  })

  test('defaults to general-purpose (inherit → parent) when subagent_type omitted', () => {
    const agents = [
      { agentType: 'general-purpose', source: 'built-in' },
    ] as any[]
    const result = resolveAgentToolModelForDisplay(
      {},
      { parentModel: 'claude-opus-4-6', agents },
    )
    // no agent.model → getAgentModel(undefined, parent) → parent
    expect(result).toBe('claude-opus-4-6')
  })

  test('unknown agent type falls back to inherit parent model', () => {
    const result = resolveAgentToolModelForDisplay(
      { subagent_type: 'custom-missing' },
      { parentModel: 'claude-sonnet-4-6', agents: [] },
    )
    expect(result).toBe('claude-sonnet-4-6')
  })

  test('always returns a model even when it matches the parent', () => {
    const agents = [
      { agentType: 'Plan', source: 'built-in', model: 'inherit' },
    ] as any[]
    const result = resolveAgentToolModelForDisplay(
      { subagent_type: 'Plan' },
      { parentModel: 'claude-sonnet-4-6', agents },
    )
    expect(result).toBe('claude-sonnet-4-6')
  })
})
