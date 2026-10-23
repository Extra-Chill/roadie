// Unit tests for the manual-rename-aware rename decision in thread-name.ts —
// resolveAutoThreadRename and wasThreadManuallyRenamed. Pure and deterministic;
// no Discord mocks. lastSyncedName mirrors thread_sessions.last_synced_name:
// the thread name Roadie last applied, undefined when it never named the thread.

import { describe, test, expect } from 'vitest'
import {
  resolveAutoThreadRename,
  wasThreadManuallyRenamed,
} from './thread-name.js'

describe('resolveAutoThreadRename', () => {
  test('skips the rename after a person manually renamed the thread', () => {
    // Roadie applied "Fix auth bug", a person renamed the thread by hand, and
    // a new session title arrives: leave the manual name alone.
    expect(
      resolveAutoThreadRename({
        sessionTitle: 'Refactor queue',
        currentName: 'Chris renamed this',
        lastSyncedName: 'Fix auth bug',
      }),
    ).toMatchInlineSnapshot(`undefined`)
  })

  test('an unnamed thread takes the first session title', () => {
    expect(
      resolveAutoThreadRename({
        sessionTitle: 'Fix auth bug',
        currentName: 'roadie',
        lastSyncedName: undefined,
      }),
    ).toMatchInlineSnapshot(`"Fix auth bug"`)
  })

  test('the same title after a restart does not rename again', () => {
    expect(
      resolveAutoThreadRename({
        sessionTitle: 'Fix auth bug',
        currentName: 'Fix auth bug',
        lastSyncedName: 'Fix auth bug',
      }),
    ).toMatchInlineSnapshot(`undefined`)
  })

  test('the same title after a restart does not rename with a preserved prefix', () => {
    expect(
      resolveAutoThreadRename({
        sessionTitle: 'Fix auth bug',
        currentName: '⬦ Fix auth bug',
        lastSyncedName: '⬦ Fix auth bug',
      }),
    ).toMatchInlineSnapshot(`undefined`)
  })

  test('a status-prefix change alone still allows renaming for a new title', () => {
    // Roadie applied "Fix auth bug" without a prefix; the thread now carries
    // Roadie's status prefix. Not a manual rename, so the next title applies,
    // preserving the prefix.
    expect(
      wasThreadManuallyRenamed({
        currentName: '⬦ Fix auth bug',
        lastSyncedName: 'Fix auth bug',
      }),
    ).toBe(false)
    expect(
      resolveAutoThreadRename({
        sessionTitle: 'Refactor queue',
        currentName: '⬦ Fix auth bug',
        lastSyncedName: 'Fix auth bug',
      }),
    ).toMatchInlineSnapshot(`"⬦ Refactor queue"`)
  })

  test('a removed status prefix alone is not a manual rename either', () => {
    expect(
      wasThreadManuallyRenamed({
        currentName: 'Fix auth bug',
        lastSyncedName: '⬦ Fix auth bug',
      }),
    ).toBe(false)
  })

  test('manual detection ignores the legacy btw: prefix', () => {
    expect(
      wasThreadManuallyRenamed({
        currentName: 'btw: Chris renamed this',
        lastSyncedName: 'btw: Fix auth bug',
      }),
    ).toBe(true)
    expect(
      wasThreadManuallyRenamed({
        currentName: 'btw: Fix auth bug',
        lastSyncedName: 'Fix auth bug',
      }),
    ).toBe(false)
  })

  test('a thread whose stored name was restored resumes auto-renaming', () => {
    // The person renamed by hand, then set the name back to what Roadie last
    // applied: no mismatch, so the next title renames as usual.
    expect(
      resolveAutoThreadRename({
        sessionTitle: 'Refactor queue',
        currentName: 'Fix auth bug',
        lastSyncedName: 'Fix auth bug',
      }),
    ).toMatchInlineSnapshot(`"Refactor queue"`)
  })
})
