// /model picker menu filtering (#343): pool rotations flagged `hidden` leave
// the menu but stay routable, and a session or channel currently using one
// still shows it as its current model. The picker filter is the pure seam the
// command renders from; the hidden list is recorded from the pool catalog at
// startup (the remote host case is covered in credentials/remote-pool.test.ts).

import { describe, expect, test } from 'vitest'
import { filterHiddenRotationsFromPicker } from './model.js'
import { pickerHiddenRotations, setPickerHiddenRotations } from '../agent-backend/pi/pool.js'
import { resolveDisplayedModelId } from '../session-handler/model-utils.js'
import type { AgentProviderInfo } from '../agent-backend/types.js'

const PROVIDERS: AgentProviderInfo[] = [
  {
    id: 'roadie',
    name: 'roadie',
    models: {
      subagent: { id: 'subagent', name: 'subagent — Homeboy cook plumbing', variants: [] },
      'cook-heavy': { id: 'cook-heavy', name: 'cook-heavy — Heavy coding tasks', variants: [] },
      'claude-best': { id: 'claude-best', name: 'claude-best — Best overall', variants: ['low', 'high'] },
    },
  },
  {
    id: 'anthropic',
    name: 'anthropic',
    models: {
      'claude-opus-5-5': { id: 'claude-opus-5-5', name: 'Claude Opus 5.5', variants: ['low', 'high'] },
    },
  },
]

const rotationNames = (providers: AgentProviderInfo[]) => Object.keys(providers[0]!.models)

describe('filterHiddenRotationsFromPicker', () => {
  test('drops hidden pool rotations from the menu and leaves every other provider alone', () => {
    const menu = filterHiddenRotationsFromPicker({ providers: PROVIDERS, hidden: ['subagent', 'cook-heavy'] })
    expect(rotationNames(menu)).toEqual(['claude-best'])
    // The input is untouched and the non-pool provider is passed through.
    expect(rotationNames(PROVIDERS)).toEqual(['subagent', 'cook-heavy', 'claude-best'])
    expect(menu[1]).toBe(PROVIDERS[1])
  })

  test('nothing hidden means the menu is unchanged', () => {
    expect(filterHiddenRotationsFromPicker({ providers: PROVIDERS, hidden: [] })).toBe(PROVIDERS)
  })

  test('unknown hidden names are ignored', () => {
    const menu = filterHiddenRotationsFromPicker({ providers: PROVIDERS, hidden: ['retired-rotation'] })
    expect(rotationNames(menu)).toEqual(['subagent', 'cook-heavy', 'claude-best'])
  })

  test('when every rotation is hidden, the menu falls back to all of them', () => {
    const menu = filterHiddenRotationsFromPicker({
      providers: PROVIDERS,
      hidden: ['subagent', 'cook-heavy', 'claude-best'],
    })
    expect(menu).toBe(PROVIDERS)
  })

  test('a pool provider without models is passed through', () => {
    const empty: AgentProviderInfo[] = [{ id: 'roadie', name: 'roadie', models: {} }]
    expect(filterHiddenRotationsFromPicker({ providers: empty, hidden: ['subagent'] })).toBe(empty)
  })

  test('a session or channel currently using a hidden rotation still shows it as its current model', () => {
    // The menu drops the hidden rotation...
    const menu = filterHiddenRotationsFromPicker({ providers: PROVIDERS, hidden: ['cook-heavy'] })
    expect(menu[0]!.models['cook-heavy']).toBeUndefined()
    expect(menu[0]!.models['claude-best']).toBeDefined()
    // ...while the "Current:" header renders from the unfiltered providers,
    // exactly as handleModelCommand does, so the hidden rotation still resolves.
    // (displayedModelLabel keeps the rotation name itself.)
    const displayed = resolveDisplayedModelId({
      providers: PROVIDERS,
      providerID: 'roadie',
      modelID: 'cook-heavy',
    })
    return expect(displayed).resolves.toBe('roadie/cook-heavy')
  })
})

describe('pickerHiddenRotations', () => {
  test('records hidden rotations from the startup catalog; visible rotations stay unfiltered', () => {
    setPickerHiddenRotations({ subagent: { entries: ['zai-coding-plan/glm-5.3-flash'], hidden: true }, 'cook-heavy': { entries: ['anthropic/claude-opus-5-5'] } })
    expect(pickerHiddenRotations()).toEqual(['subagent'])
    setPickerHiddenRotations({})
    expect(pickerHiddenRotations()).toEqual([])
  })
})
