import { afterEach, describe, expect, it, vi } from 'vitest'

import { createClientSessionState } from '@/lib/chat-runtime'
import {
  $selectedStoredSessionId,
  _resetSessionOwnerHintsForTests,
  setActiveSessionId,
  setSessionOwnerHint,
  setSessions
} from '@/store/session'

import {
  $sessionOwnerHoldRevision,
  $sessionTiles,
  _resetSessionOwnerHoldsForTests,
  clearAllSessionStates,
  foregroundSessionScopes,
  holdSessionOwnerUntilForeground,
  publishSessionState,
  recordSessionEventScope,
  releaseSessionOwnerHold
} from './session-states'

// A routed session.create returns a stored id on the owner's socket, but the
// surface that will pin that socket (the selected primary thread, or a tile)
// is published later and asynchronously. The hold names the owner in
// foregroundSessionScopes — the gateway keep-set — from the moment the create
// returns until the foreground publication takes over, the caller releases
// it, or a bounded TTL expires. Nothing latches.

afterEach(() => {
  $sessionTiles.set([])
  clearAllSessionStates()
  setActiveSessionId(null)
  $selectedStoredSessionId.set(null)
  _resetSessionOwnerHoldsForTests()
  _resetSessionOwnerHintsForTests({ storage: true })
  setSessions([])
  vi.useRealTimers()
})

describe('foregroundSessionScopes: owner hold across the create → foreground gap', () => {
  const omar = { connectionId: 'local', mode: 'local' as const, profile: 'omar' }

  it('names the owner from the moment a routed create returns, before anything is selected or tiled', () => {
    holdSessionOwnerUntilForeground('stored-fresh', omar)

    expect(foregroundSessionScopes()).toEqual(new Set(['conn:local::omar']))
  })

  it('pins an existing selected main chat by its exact owner before the first routed event', () => {
    const route = {
      connectionId: 'local',
      mode: 'local' as const,
      profile: 'youtube'
    }

    setSessionOwnerHint('stored-youtube', route)
    $selectedStoredSessionId.set('stored-youtube')
    publishSessionState('rt-youtube', createClientSessionState('stored-youtube'))
    setActiveSessionId('rt-youtube')

    // Deliberately no recordSessionEventScope(): this is the prompt-ACK /
    // reconnect window before the first owner-tagged stream frame. The exact
    // registry socket still owns the selected main chat and every dispose path
    // must see that composite scope rather than an unrelated bare profile.
    expect(foregroundSessionScopes()).toEqual(new Set(['conn:local::youtube']))
  })

  it('accepts a complete exact hint alongside a compatible untagged row', () => {
    setSessions([{ id: 'stored-youtube', profile: 'youtube' } as never])
    setSessionOwnerHint('stored-youtube', { connectionId: 'local', profile: 'youtube' })
    $selectedStoredSessionId.set('stored-youtube')
    publishSessionState('rt-youtube', createClientSessionState('stored-youtube'))
    setActiveSessionId('rt-youtube')

    expect(foregroundSessionScopes()).toEqual(new Set(['conn:local::youtube']))
  })

  it('does not guess between same-id twins before the runtime source is known', () => {
    setSessions([
      { connection_id: 'local', id: 'stored-twin', profile: 'youtube' } as never,
      { connection_id: 'cloud-a', id: 'stored-twin', profile: 'youtube' } as never
    ])
    setSessionOwnerHint('stored-twin', { connectionId: 'local', profile: 'youtube' })
    setSessionOwnerHint('stored-twin', { connectionId: 'cloud-a', profile: 'youtube' })
    $selectedStoredSessionId.set('stored-twin')
    publishSessionState('rt-twin', createClientSessionState('stored-twin'))
    setActiveSessionId('rt-twin')

    expect(foregroundSessionScopes()).toEqual(new Set())
  })

  it('fails closed when a persisted hint conflicts with a current connection-tagged row', () => {
    setSessions([{ connection_id: 'local', id: 'stored-conflict', profile: 'youtube' } as never])
    setSessionOwnerHint('stored-conflict', { connectionId: 'cloud-a', profile: 'youtube' })
    $selectedStoredSessionId.set('stored-conflict')
    publishSessionState('rt-conflict', createClientSessionState('stored-conflict'))
    setActiveSessionId('rt-conflict')

    expect(foregroundSessionScopes()).toEqual(new Set())
  })

  it('does not indefinitely pin a stale selection with no matching active runtime', () => {
    setSessionOwnerHint('stored-stale', { connectionId: 'local', profile: 'youtube' })
    $selectedStoredSessionId.set('stored-stale')

    expect(foregroundSessionScopes()).toEqual(new Set())
  })

  it('retires once the foreground publication covers it (selected primary thread / mounted tile)', () => {
    holdSessionOwnerUntilForeground('stored-fresh', omar)
    setSessionOwnerHint('stored-fresh', omar)

    // Selected, but the runtime's event scope is not known yet: the hold is
    // still the only thing naming the owner socket, so it stays.
    $selectedStoredSessionId.set('stored-fresh')
    expect(foregroundSessionScopes()).toEqual(new Set(['conn:local::omar']))

    // The first event from the owner socket records the runtime's scope; the
    // selected-thread rung now covers it and the hold retires for good.
    recordSessionEventScope({ connectionId: 'local', profile: 'omar', session_id: 'rt-fresh' })
    publishSessionState('rt-fresh', createClientSessionState('stored-fresh'))
    setActiveSessionId('rt-fresh')
    expect(foregroundSessionScopes()).toEqual(new Set(['conn:local::omar']))
    setActiveSessionId(null)
    $selectedStoredSessionId.set(null)
    _resetSessionOwnerHintsForTests()
    expect(foregroundSessionScopes()).toEqual(new Set())

    holdSessionOwnerUntilForeground('stored-tile', { connectionId: 'homelab', profile: 'bot' })
    $sessionTiles.set([{ ownerRoute: { connectionId: 'homelab', profile: 'bot' }, storedSessionId: 'stored-tile' }])
    // Covered by the tile's own route rung now; the hold retired.
    expect(foregroundSessionScopes()).toEqual(new Set(['conn:homelab::bot']))
    $sessionTiles.set([])
    expect(foregroundSessionScopes()).toEqual(new Set())
  })

  it('does not retire one session hold just because another foreground session shares its socket', () => {
    setSessionOwnerHint('stored-y', omar)
    $selectedStoredSessionId.set('stored-y')
    publishSessionState('rt-y', createClientSessionState('stored-y'))
    recordSessionEventScope({ connectionId: 'local', profile: 'omar', session_id: 'rt-y' })
    setActiveSessionId('rt-y')
    holdSessionOwnerUntilForeground('stored-x', omar)

    expect(foregroundSessionScopes()).toEqual(new Set(['conn:local::omar']))

    // Y leaves before X has published. X's own hold must keep the shared
    // socket alive rather than having been retired by Y's unrelated scope.
    setActiveSessionId(null)
    $selectedStoredSessionId.set(null)
    clearAllSessionStates()
    expect(foregroundSessionScopes()).toEqual(new Set(['conn:local::omar']))
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
