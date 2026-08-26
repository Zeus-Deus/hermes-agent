import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  $selectedStoredSessionId,
  _resetSessionOwnerHintsForTests,
  setSessionOwnerHint,
  setSessions
} from '@/store/session'
import type { SessionInfo } from '@/types/hermes'

import {
  $sessionOwnerHoldRevision,
  $sessionTiles,
  _resetSessionOwnerHoldsForTests,
  foregroundSessionScopes,
  holdSessionOwnerUntilForeground,
  recordTileOwner,
  releaseSessionOwnerHold
} from './session-states'

// #93892: the gateway keep-set only carried busy / needs-input work, so an
// idle tile's owner socket was pruned out from under its resumed runtime —
// backend reap → `session.reclaimed` → tile unbound → resume → prune → … a
// spinner loop with no terminal state. foregroundSessionScopes() is the
// foreground half of the keep-set: every mounted tile's owner plus the
// primary thread's owner, expressed in the pruner's own key language.

const row = (over: Partial<SessionInfo>): SessionInfo =>
  ({
    ended_at: null,
    id: 'stored',
    input_tokens: 0,
    is_active: false,
    last_active: 0,
    message_count: 1,
    model: null,
    output_tokens: 0,
    preview: null,
    profile: 'default',
    source: null,
    started_at: 0,
    title: null,
    ...over
  }) as SessionInfo

afterEach(() => {
  $sessionTiles.set([])
  $selectedStoredSessionId.set(null)
  setSessions([])
  _resetSessionOwnerHoldsForTests()
  _resetSessionOwnerHintsForTests({ storage: true })
  vi.useRealTimers()
})

describe('foregroundSessionScopes: connection-tagged rows', () => {
  it('pins the selected primary thread by its EXACT scope when only the row (no hint, no tile) names the owner', () => {
    // The transient hint is gone (evicted / relaunch); the sidebar row still
    // carries the connection the create stamped (or a refresh carried).
    setSessions([row({ connection_id: 'local', id: 'stored-omar', profile: 'omar' })])
    $selectedStoredSessionId.set('stored-omar')

    expect(foregroundSessionScopes()).toEqual(new Set(['conn:local::omar']))
  })
})

describe('foregroundSessionScopes: owner hold across the create → foreground gap', () => {
  const omar = { connectionId: 'local', mode: 'local' as const, profile: 'omar' }

  it('names the owner from the moment a routed create returns, before anything is selected or tiled', () => {
    holdSessionOwnerUntilForeground('stored-fresh', omar)

    expect(foregroundSessionScopes()).toEqual(new Set(['conn:local::omar']))
  })

  it('retires once the foreground publication covers it (selected primary thread / mounted tile)', () => {
    holdSessionOwnerUntilForeground('stored-fresh', omar)
    setSessionOwnerHint('stored-fresh', omar)

    $selectedStoredSessionId.set('stored-fresh')
    // Covered by the selected-thread rung now; the hold itself is gone.
    expect(foregroundSessionScopes()).toEqual(new Set(['conn:local::omar']))
    $selectedStoredSessionId.set(null)
    _resetSessionOwnerHintsForTests()
    expect(foregroundSessionScopes()).toEqual(new Set())

    holdSessionOwnerUntilForeground('stored-tile', { connectionId: 'homelab', profile: 'bot' })
    $sessionTiles.set([{ ownerRoute: { connectionId: 'homelab', profile: 'bot' }, storedSessionId: 'stored-tile' }])
    expect(foregroundSessionScopes()).toEqual(new Set(['conn:homelab::bot']))
    $sessionTiles.set([])
    expect(foregroundSessionScopes()).toEqual(new Set())
  })

  it('is released explicitly by the caller (failed create / drift close) and expires on its own', () => {
    vi.useFakeTimers()

    const release = holdSessionOwnerUntilForeground('stored-a', omar)
    holdSessionOwnerUntilForeground('stored-b', { connectionId: 'homelab', profile: 'worker' })

    release()
    expect(foregroundSessionScopes()).toEqual(new Set(['conn:homelab::worker']))

    releaseSessionOwnerHold('stored-b')
    expect(foregroundSessionScopes()).toEqual(new Set())

    holdSessionOwnerUntilForeground('stored-c', omar)
    vi.advanceTimersByTime(60_000 + 1)
    expect(foregroundSessionScopes()).toEqual(new Set())
  })

  it('publishes hold release and TTL expiry so pending gateway redials can drain without unrelated UI state', () => {
    vi.useFakeTimers()
    const revisions: number[] = []
    const off = $sessionOwnerHoldRevision.subscribe(value => revisions.push(value))

    const release = holdSessionOwnerUntilForeground('stored-release', omar)
    const afterHold = revisions.at(-1)!
    release()
    expect(revisions.at(-1)).toBeGreaterThan(afterHold)

    holdSessionOwnerUntilForeground('stored-expiry', omar)
    const beforeExpiry = revisions.at(-1)!
    vi.advanceTimersByTime(60_000 + 1)
    expect(revisions.at(-1)).toBeGreaterThan(beforeExpiry)
    expect(foregroundSessionScopes()).toEqual(new Set())

    off()
  })

  it('ignores blank ids, null owners and profile-only owners map to the legacy pool key', () => {
    holdSessionOwnerUntilForeground('  ', omar)
    holdSessionOwnerUntilForeground('stored-null', null)
    holdSessionOwnerUntilForeground('stored-legacy', 'research')

    expect(foregroundSessionScopes()).toEqual(new Set(['research']))
  })
})

describe('foregroundSessionScopes', () => {
  it('is empty with nothing mounted', () => {
    expect(foregroundSessionScopes()).toEqual(new Set())
  })

  it('pins a route-owned tile by its composite (connectionId, profile) scope — bound or still resuming', () => {
    $sessionTiles.set([
      {
        ownerRoute: { connectionId: 'local', mode: 'local', profile: 'bot' },
        runtimeId: 'rt-bot',
        storedSessionId: 'stored-bot'
      },
      {
        ownerRoute: { connectionId: 'homelab', mode: 'remote', profile: 'research' },
        storedSessionId: 'stored-remote'
      }
    ])

    expect(foregroundSessionScopes()).toEqual(new Set(['conn:local::bot', 'conn:homelab::research']))
  })

  it('pins a profile-owned tile (no route) by the bare profile key the local pool matches on', () => {
    setSessions([row({ id: 'stored-legacy', profile: ' Research ' })])
    $sessionTiles.set([{ storedSessionId: 'stored-legacy' }])

    expect(foregroundSessionScopes()).toEqual(new Set(['Research']))
  })

  it('contributes nothing for a tile whose owner is unknown, and ignores a blank connection id', () => {
    $sessionTiles.set([
      { storedSessionId: 'stored-unknown' },
      { ownerRoute: { connectionId: '   ', profile: 'bot' }, storedSessionId: 'stored-blank' }
    ])

    expect(foregroundSessionScopes()).toEqual(new Set())
  })

  it('pins the primary thread’s owner too (all-profiles mode dials it without activating)', () => {
    // Keyed by the SELECTED STORED id: the runtime id is re-minted on every
    // resume and never resolves to an owner.
    setSessions([row({ id: 'stored-primary', profile: 'ai-engineer' })])
    $selectedStoredSessionId.set('stored-primary')

    expect(foregroundSessionScopes()).toEqual(new Set(['ai-engineer']))
  })

  it('names a route-less tile through its open-time owner hint', () => {
    // A hidden Bot Chat has no sidebar row and (here) no persisted route —
    // the hint host.openSession recorded is the only owner record.
    setSessionOwnerHint('stored-hinted', { connectionId: 'local', mode: 'local', profile: 'bot' })
    $sessionTiles.set([{ storedSessionId: 'stored-hinted' }])

    expect(foregroundSessionScopes()).toEqual(new Set(['conn:local::bot']))
  })

  it('names a route-less, hint-less tile through the owner its resume resolved', () => {
    // Legacy roster row opened while the primary is active: no route, no
    // hint, hidden session. resumeTile resolves the owning profile and
    // records it — that profile's bare socket is the one carrying the runtime.
    $sessionTiles.set([{ storedSessionId: 'stored-resolved' }])
    expect(foregroundSessionScopes()).toEqual(new Set())

    recordTileOwner('stored-resolved', 'bot')

    expect(foregroundSessionScopes()).toEqual(new Set(['bot']))
  })

  it('pins only the persisted tile route when owner candidates disagree', () => {
    setSessionOwnerHint('stored-disagree', {
      connectionId: 'stale-hint',
      mode: 'remote',
      profile: 'bot'
    })
    recordTileOwner('stored-disagree', { connectionId: 'stale-resolved', profile: 'bot' })
    $sessionTiles.set([
      {
        ownerRoute: { connectionId: 'authoritative-route', mode: 'remote', profile: 'bot' },
        storedSessionId: 'stored-disagree'
      }
    ])

    expect(foregroundSessionScopes()).toEqual(new Set(['conn:authoritative-route::bot']))
  })

  it('pins only the first valid recovery owner when route data is unavailable', () => {
    setSessionOwnerHint('stored-fallback-disagree', {
      connectionId: 'authoritative-hint',
      mode: 'remote',
      profile: 'bot'
    })
    recordTileOwner('stored-fallback-disagree', { connectionId: 'stale-resolved', profile: 'bot' })
    setSessions([row({ id: 'stored-fallback-disagree', profile: 'stale-row' })])
    $sessionTiles.set([{ storedSessionId: 'stored-fallback-disagree' }])

    expect(foregroundSessionScopes()).toEqual(new Set(['conn:authoritative-hint::bot']))
  })

  it('follows the tile set: closing the tile releases its scope', () => {
    $sessionTiles.set([
      { ownerRoute: { connectionId: 'local', mode: 'local', profile: 'bot' }, storedSessionId: 'stored-bot' }
    ])
    expect(foregroundSessionScopes().has('conn:local::bot')).toBe(true)

    $sessionTiles.set([])
    expect(foregroundSessionScopes().has('conn:local::bot')).toBe(false)
  })

  it('forgets a resolved owner when its tile closes instead of reviving stale ownership', () => {
    $sessionTiles.set([{ storedSessionId: 'stored-resolved' }])
    recordTileOwner('stored-resolved', 'bot')
    expect(foregroundSessionScopes()).toEqual(new Set(['bot']))

    $sessionTiles.set([])
    $sessionTiles.set([{ storedSessionId: 'stored-resolved' }])

    expect(foregroundSessionScopes()).toEqual(new Set())
  })
})
