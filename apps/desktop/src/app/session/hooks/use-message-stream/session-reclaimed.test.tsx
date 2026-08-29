import { QueryClient } from '@tanstack/react-query'
import { act, cleanup } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ClientSessionState } from '@/app/types'
import { createClientSessionState } from '@/lib/chat-runtime'
import {
  $activeSessionId,
  $selectedStoredSessionId,
  $sessionResumeRequest,
  _resetSessionOwnerHintsForTests,
  setSessionOwnerHint,
  setSessions
} from '@/store/session'
import {
  $sessionStates,
  $sessionTiles,
  _resetSessionOwnerHoldsForTests,
  publishSessionState,
  recordSessionEventScope
} from '@/store/session-states'
import type { RpcEvent } from '@/types/hermes'

import { type MessageStreamHarness, renderMessageStream } from './test-harness'

// `session.reclaimed`: the backend tore down a live session we're still
// holding (idle TTL, LRU cap, WS-orphan reap). Before this event the runtime id
// stayed cached until something failed against it, which read to the user as
// the session vanishing rather than being reclaimed.

const ACTIVE_SID = 'session-active'
const ACTIVE_PROFILE = 'compass'
const STORED_SID = 'stored-1'
let stream: MessageStreamHarness
let queryClient: QueryClient
let wiringCache: Map<string, ClientSessionState>

function mountStream() {
  stream = renderMessageStream(ACTIVE_SID, { activeGatewayProfile: ACTIVE_PROFILE, queryClient })
  wiringCache = stream.states
}

const reclaim = (sessionId: string, reason = 'ws_orphan_reap') =>
  act(() =>
    stream.handleEvent({
      payload: { reason, session_id: sessionId, stored_session_id: 'stored-1' },
      session_id: '',
      type: 'session.reclaimed'
    } as RpcEvent)
  )

beforeEach(() => {
  queryClient = new QueryClient()
  $sessionStates.set({})
  $sessionTiles.set([])
  $activeSessionId.set(null)
  $selectedStoredSessionId.set(null)
  $sessionResumeRequest.set(null)
  setSessions([])
  _resetSessionOwnerHintsForTests({ storage: true })
  _resetSessionOwnerHoldsForTests()
})

afterEach(() => {
  cleanup()
  $sessionStates.set({})
  $sessionTiles.set([])
  $activeSessionId.set(null)
  $selectedStoredSessionId.set(null)
  $sessionResumeRequest.set(null)
  setSessions([])
  _resetSessionOwnerHintsForTests({ storage: true })
  _resetSessionOwnerHoldsForTests()
  vi.restoreAllMocks()
})

describe('session.reclaimed', () => {
  it('drops the cached state for the reclaimed runtime', () => {
    mountStream()
    publishSessionState('live-gone', createClientSessionState())
    expect($sessionStates.get()['live-gone']).toBeDefined()

    reclaim('live-gone')

    expect($sessionStates.get()['live-gone']).toBeUndefined()
  })

  it('leaves every other live session alone', () => {
    mountStream()
    publishSessionState('live-gone', createClientSessionState())
    publishSessionState('live-kept', createClientSessionState())

    reclaim('live-gone')

    // Both halves matter: the target went, the bystander stayed. Asserting
    // only the survivor would pass with no handler at all.
    expect($sessionStates.get()['live-gone']).toBeUndefined()
    expect($sessionStates.get()['live-kept']).toBeDefined()
  })

  it('ignores a payload with no runtime id instead of clearing everything', () => {
    mountStream()
    publishSessionState('live-a', createClientSessionState())
    publishSessionState('live-b', createClientSessionState())

    reclaim('')

    // A malformed/empty id must be a no-op, never a blanket wipe.
    expect(Object.keys($sessionStates.get()).sort()).toEqual(['live-a', 'live-b'])
  })

  it('drops the runtime regardless of which reclaim reason fired', () => {
    for (const reason of ['idle_timeout', 'lru_evict', 'ws_orphan_reap']) {
      $sessionStates.set({})
      cleanup()
      mountStream()
      publishSessionState('live-gone', createClientSessionState())

      reclaim('live-gone', reason)

      expect($sessionStates.get()['live-gone'], reason).toBeUndefined()
    }
  })

  // A TILE bound to the reclaimed runtime is the #82620 blank-pane case: the
  // state drop above empties the tile's view, but with `runtimeId` still set
  // the tile's resume effect (gated on !runtimeId) never refires — an empty
  // transcript under live chrome, unrecoverable without closing the tab.
  it('unbinds a tile holding the reclaimed runtime so its resume can refire', () => {
    mountStream()
    publishSessionState('live-gone', createClientSessionState('stored-1'))
    $sessionTiles.set([
      { runtimeId: 'live-gone', storedSessionId: 'stored-1' },
      { runtimeId: 'live-kept', storedSessionId: 'stored-2' }
    ])

    reclaim('live-gone')

    const tiles = $sessionTiles.get()
    // The reclaimed tile survives as a pane (its stored session is intact) but
    // sheds the dead runtime; the bystander tile keeps its live binding.
    expect(tiles.find(t => t.storedSessionId === 'stored-1')?.runtimeId).toBeUndefined()
    expect(tiles.find(t => t.storedSessionId === 'stored-2')?.runtimeId).toBe('live-kept')
  })

  // The wiring cache is resumeTile's warm path: a leftover entry for the dead
  // runtime would be handed straight back on the re-resume, rebinding the tile
  // to the same reclaimed id the backend just forgot.
  it('purges the wiring cache entry for the reclaimed runtime', () => {
    mountStream()
    wiringCache.set('live-gone', createClientSessionState('stored-1'))
    wiringCache.set('live-kept', createClientSessionState('stored-2'))

    reclaim('live-gone')

    expect(wiringCache.has('live-gone')).toBe(false)
    expect(wiringCache.has('live-kept')).toBe(true)
  })

  it('re-arms the active main chat from its durable id and exact owner after a WS orphan reap', () => {
    const runtimeBindings = new Map([[STORED_SID, ACTIVE_SID]])
    stream = renderMessageStream(ACTIVE_SID, {
      activeGatewayProfile: 'youtube',
      queryClient,
      runtimeBindings
    })
    wiringCache = stream.states
    wiringCache.set(ACTIVE_SID, createClientSessionState(STORED_SID))
    publishSessionState(ACTIVE_SID, createClientSessionState(STORED_SID))
    $activeSessionId.set(ACTIVE_SID)
    $selectedStoredSessionId.set(STORED_SID)

    // The same stored id can exist on two sources. The old runtime's recorded
    // source is authoritative; the global reclaim broadcast's arrival socket
    // must not make recovery pick the cloud twin or a bare ambient profile.
    setSessionOwnerHint(STORED_SID, {
      connectionId: 'local',
      mode: 'local',
      profile: 'youtube',
      targetProfile: 'youtube'
    })
    setSessionOwnerHint(STORED_SID, {
      connectionId: 'cloud-a',
      mode: 'remote',
      profile: 'youtube',
      targetProfile: 'yt-remote'
    })
    recordSessionEventScope({ connectionId: 'local', profile: 'youtube', session_id: ACTIVE_SID })
    const previousSequence = $sessionResumeRequest.get()?.sequence ?? 0

    act(() =>
      stream.handleEvent({
        connectionId: 'local',
        payload: {
          reason: 'ws_orphan_reap',
          session_id: ACTIVE_SID,
          stored_session_id: STORED_SID
        },
        profile: 'bystander-profile',
        session_id: '',
        type: 'session.reclaimed'
      } as RpcEvent)
    )

    expect($sessionStates.get()[ACTIVE_SID]).toBeUndefined()
    expect(wiringCache.has(ACTIVE_SID)).toBe(false)
    expect(runtimeBindings.has(STORED_SID)).toBe(false)
    expect($sessionResumeRequest.get()).toEqual({
      ownerRoute: {
        connectionId: 'local',
        mode: 'local',
        profile: 'youtube',
        targetProfile: 'youtube'
      },
      sequence: expect.any(Number),
      sessionId: STORED_SID
    })
    expect($sessionResumeRequest.get()!.sequence).toBeGreaterThan(previousSequence)

    const firstRecoverySequence = $sessionResumeRequest.get()!.sequence

    // The backend global-broadcasts once per socket. A duplicate delivered by
    // the bystander after the first handler dropped the runtime scope must not
    // replace the local recovery with the cloud twin or restart the resume.
    act(() =>
      stream.handleEvent({
        connectionId: 'local',
        payload: {
          reason: 'ws_orphan_reap',
          session_id: ACTIVE_SID,
          stored_session_id: STORED_SID
        },
        profile: 'bystander-profile',
        session_id: '',
        type: 'session.reclaimed'
      } as RpcEvent)
    )

    expect($sessionResumeRequest.get()!.sequence).toBe(firstRecoverySequence)
    expect($sessionResumeRequest.get()!.ownerRoute?.connectionId).toBe('local')
  })

  it.each(['idle_timeout', 'lru_evict'])(
    'does not auto-resume an intentionally reclaimed active chat (%s)',
    reason => {
      mountStream()
      wiringCache.set(ACTIVE_SID, createClientSessionState(STORED_SID))
      $activeSessionId.set(ACTIVE_SID)
      $selectedStoredSessionId.set(STORED_SID)

      reclaim(ACTIVE_SID, reason)

      // Cache cleanup still happens, but resuming an idle/LRU reclaim would
      // immediately recreate the resource the backend deliberately evicted.
      expect(wiringCache.has(ACTIVE_SID)).toBe(false)
      expect($sessionResumeRequest.get()).toBeNull()
    }
  )

  it('resumes the currently routed lineage root when reclaim reports a rotated compression tip', () => {
    mountStream()
    setSessions([{ _lineage_root_id: 'lineage-root', id: 'lineage-tip', profile: ACTIVE_PROFILE } as never])
    wiringCache.set(ACTIVE_SID, createClientSessionState('lineage-root'))
    stream.runtimeBindings.set('lineage-root', ACTIVE_SID)
    $activeSessionId.set(ACTIVE_SID)
    $selectedStoredSessionId.set('lineage-root')
    setSessionOwnerHint('lineage-root', {
      connectionId: 'local',
      profile: ACTIVE_PROFILE
    })
    recordSessionEventScope({ connectionId: 'local', profile: ACTIVE_PROFILE, session_id: ACTIVE_SID })

    act(() =>
      stream.handleEvent({
        payload: {
          reason: 'ws_orphan_reap',
          session_id: ACTIVE_SID,
          stored_session_id: 'lineage-tip'
        },
        session_id: '',
        type: 'session.reclaimed'
      } as RpcEvent)
    )

    expect($sessionResumeRequest.get()).toMatchObject({
      ownerRoute: { connectionId: 'local', profile: ACTIVE_PROFILE },
      sessionId: 'lineage-root'
    })
    expect(stream.runtimeBindings.has('lineage-root')).toBe(false)
  })

  it('fails closed when an untagged reclaim has two possible exact owners', () => {
    mountStream()
    wiringCache.set(ACTIVE_SID, createClientSessionState(STORED_SID))
    $activeSessionId.set(ACTIVE_SID)
    $selectedStoredSessionId.set(STORED_SID)
    setSessionOwnerHint(STORED_SID, { connectionId: 'local', profile: ACTIVE_PROFILE })
    setSessionOwnerHint(STORED_SID, { connectionId: 'cloud-a', profile: ACTIVE_PROFILE })

    reclaim(ACTIVE_SID)

    expect($sessionResumeRequest.get()).toBeNull()
  })

  it('fails closed when a stale unique hint conflicts with the current tagged row owner', () => {
    mountStream()
    setSessions([{ connection_id: 'local', id: STORED_SID, profile: ACTIVE_PROFILE } as never])
    wiringCache.set(ACTIVE_SID, createClientSessionState(STORED_SID))
    $activeSessionId.set(ACTIVE_SID)
    $selectedStoredSessionId.set(STORED_SID)
    setSessionOwnerHint(STORED_SID, { connectionId: 'cloud-a', profile: ACTIVE_PROFILE })

    reclaim(ACTIVE_SID)

    expect($sessionResumeRequest.get()).toBeNull()
  })

  it('fails closed when two untagged profile rows share the reclaimed durable id', () => {
    mountStream()
    setSessions([
      { id: STORED_SID, profile: 'youtube' } as never,
      { id: STORED_SID, profile: 'research' } as never
    ])
    wiringCache.set(ACTIVE_SID, createClientSessionState(STORED_SID))
    $activeSessionId.set(ACTIVE_SID)
    $selectedStoredSessionId.set(STORED_SID)

    reclaim(ACTIVE_SID)

    expect($sessionResumeRequest.get()).toBeNull()
  })

  it('does not collapse a known scoped runtime to ambient when its complete owner hint is missing', () => {
    mountStream()
    wiringCache.set(ACTIVE_SID, createClientSessionState(STORED_SID))
    $activeSessionId.set(ACTIVE_SID)
    $selectedStoredSessionId.set(STORED_SID)
    recordSessionEventScope({ connectionId: 'cloud-a', profile: ACTIVE_PROFILE, session_id: ACTIVE_SID })

    reclaim(ACTIVE_SID)

    expect($sessionResumeRequest.get()).toBeNull()
  })

  it('does not let a late background reclaim rebind the active main chat', () => {
    mountStream()
    $activeSessionId.set(ACTIVE_SID)
    $selectedStoredSessionId.set(STORED_SID)

    reclaim('runtime-from-previous-chat')

    expect($sessionResumeRequest.get()).toBeNull()
  })
})
