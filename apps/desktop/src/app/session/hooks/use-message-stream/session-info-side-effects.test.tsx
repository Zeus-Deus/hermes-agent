import { QueryClient } from '@tanstack/react-query'
import { act, cleanup } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { setApiRequestConnection } from '@/api/client'
import { isTargetSessionBusy } from '@/app/session/hooks/use-prompt-actions/utils'
import type { ClientSessionState } from '@/app/types'
import { createClientSessionState } from '@/lib/chat-runtime'
import { modelOptionsQueryKey } from '@/lib/model-options'
import { setCurrentModel, setCurrentProvider, setSessionOwnerHint } from '@/store/session'
import { $sessionTiles, sessionEventOwnerRoute } from '@/store/session-states'

import { type MessageStreamHarness, renderMessageStream } from './test-harness'
import { PRE_TURN_LIVE_SETTLE_GRACE_MS } from './utils'

// Per-turn REST amplification guards: session.info must not refetch config for
// background sessions nor invalidate the model-options catalog when the model
// string is merely PRESENT (the backend stamps it on every event) rather than
// actually changed. message.complete must coalesce sidebar refreshes.

const ACTIVE_SID = 'session-active'
const ACTIVE_PROFILE = 'compass'
let stream: MessageStreamHarness
let refreshHermesConfig: ReturnType<typeof vi.fn<() => Promise<void>>>
let refreshSessions: ReturnType<typeof vi.fn<() => Promise<void>>>
let hydrateFromStoredSession: ReturnType<typeof vi.fn<() => Promise<void>>>
let queryClient: QueryClient
let sessionStates: Map<string, ClientSessionState> | null = null

function mountStream() {
  stream = renderMessageStream(ACTIVE_SID, {
    activeGatewayProfile: ACTIVE_PROFILE,
    hydrateFromStoredSession,
    queryClient,
    refreshHermesConfig,
    refreshSessions
  })
  sessionStates = stream.states
}

const sessionInfo = (sessionId: string, payload: Record<string, unknown>) =>
  act(() => stream.handleEvent({ payload, session_id: sessionId, type: 'session.info' }))

beforeEach(() => {
  sessionStates = null
  refreshHermesConfig = vi.fn<() => Promise<void>>(async () => undefined)
  refreshSessions = vi.fn<() => Promise<void>>(async () => undefined)
  hydrateFromStoredSession = vi.fn<() => Promise<void>>(async () => undefined)
  queryClient = new QueryClient()
  $sessionTiles.set([])
  setCurrentModel('')
  setCurrentProvider('')
})

afterEach(() => {
  cleanup()
  $sessionTiles.set([])
  setCurrentModel('')
  setCurrentProvider('')
  vi.useRealTimers()
  vi.restoreAllMocks()
  setApiRequestConnection(null)
})

describe('session.info config refetch gating', () => {
  it('coalesces active-session bursts into one trailing config fetch', async () => {
    // Mount under real timers (waitFor), then freeze time for the debounce.
    mountStream()
    vi.useFakeTimers()

    sessionInfo(ACTIVE_SID, { model: 'm1', running: true })
    sessionInfo(ACTIVE_SID, { model: 'm1', running: false })
    sessionInfo(ACTIVE_SID, { model: 'm1', title: 't' })

    expect(refreshHermesConfig).not.toHaveBeenCalled()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(400)
    })

    expect(refreshHermesConfig).toHaveBeenCalledTimes(1)
  })

  it('never fetches config for a background session heartbeat', async () => {
    mountStream()
    vi.useFakeTimers()

    sessionInfo('session-background', { model: 'm1', running: true })
    sessionInfo('session-background', { model: 'm1', running: false })

    await act(async () => {
      await vi.advanceTimersByTimeAsync(400)
    })

    expect(refreshHermesConfig).not.toHaveBeenCalled()
  })
})

describe('session.info model-options invalidation gating', () => {
  it('skips invalidation when model/provider merely restate the known values', () => {
    mountStream()
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries')

    // Seed the session's cached runtime state.
    sessionInfo(ACTIVE_SID, { model: 'm1', provider: 'p1', running: true })
    invalidate.mockClear()

    // Turn-end heartbeat restating the same model/provider — the pre-fix path
    // invalidated (and refetched the provider catalog) on every one of these.
    sessionInfo(ACTIVE_SID, { model: 'm1', provider: 'p1', running: false })

    expect(invalidate).not.toHaveBeenCalled()
  })

  it('invalidates when the session model actually changes', () => {
    mountStream()
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries')

    sessionInfo(ACTIVE_SID, { model: 'm1', provider: 'p1', running: true })
    invalidate.mockClear()

    sessionInfo(ACTIVE_SID, { model: 'm2', provider: 'p1', running: true })

    expect(invalidate).toHaveBeenCalledWith({ queryKey: modelOptionsQueryKey(ACTIVE_PROFILE, ACTIVE_SID) })
  })

  it('invalidates the exact event owner without touching the ambient connection', () => {
    setApiRequestConnection('ambient-remote')
    mountStream()
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries')
    const ownerScope = { connectionId: 'remote-owner', profile: 'bot' }
    const ownerKey = modelOptionsQueryKey(ownerScope, ACTIVE_SID)
    const ambientKey = modelOptionsQueryKey(ACTIVE_PROFILE, ACTIVE_SID)

    sessionInfo(ACTIVE_SID, { model: 'm1', provider: 'p1', running: true })
    invalidate.mockClear()

    act(() =>
      stream.handleEvent({
        connectionId: ownerScope.connectionId,
        payload: { model: 'm2', provider: 'p1', running: true },
        profile: ownerScope.profile,
        session_id: ACTIVE_SID,
        type: 'session.info'
      })
    )

    expect(invalidate).toHaveBeenCalledWith({ queryKey: ownerKey })
    expect(invalidate).not.toHaveBeenCalledWith({ queryKey: ambientKey })
  })

  it('invalidates an alias route’s backend target catalog without touching socket or ambient keys', () => {
    setApiRequestConnection('ambient-remote')
    mountStream()
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries')

    const ownerRoute = {
      connectionId: 'remote-owner',
      mode: 'remote' as const,
      profile: 'bot-alias',
      targetProfile: 'backend-bot'
    }

    const targetKey = modelOptionsQueryKey(
      { connectionId: ownerRoute.connectionId, profile: ownerRoute.targetProfile },
      ACTIVE_SID
    )

    const socketKey = modelOptionsQueryKey(
      { connectionId: ownerRoute.connectionId, profile: ownerRoute.profile },
      ACTIVE_SID
    )

    const ambientKey = modelOptionsQueryKey(ACTIVE_PROFILE, ACTIVE_SID)

    $sessionTiles.set([{ ownerRoute, runtimeId: ACTIVE_SID, storedSessionId: 'stored-bot-chat' }])
    sessionInfo(ACTIVE_SID, { model: 'm1', provider: 'p1', running: true })
    invalidate.mockClear()

    act(() =>
      stream.handleEvent({
        connectionId: ownerRoute.connectionId,
        payload: {
          model: 'm2',
          provider: 'p1',
          running: true,
          stored_session_id: 'stored-bot-chat'
        },
        profile: ownerRoute.profile,
        session_id: ACTIVE_SID,
        type: 'session.info'
      })
    )

    expect(invalidate).toHaveBeenCalledWith({ queryKey: targetKey })
    expect(invalidate).not.toHaveBeenCalledWith({ queryKey: socketKey })
    expect(invalidate).not.toHaveBeenCalledWith({ queryKey: ambientKey })
  })

  it('keeps the exact runtime-bound alias authoritative after the stored id rotates', () => {
    mountStream()
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries')

    const ownerRoute = {
      connectionId: 'remote-owner',
      mode: 'remote' as const,
      profile: 'bot-alias',
      targetProfile: 'backend-bot'
    }

    const targetKey = modelOptionsQueryKey(
      { connectionId: ownerRoute.connectionId, profile: ownerRoute.targetProfile },
      ACTIVE_SID
    )

    const socketKey = modelOptionsQueryKey(
      { connectionId: ownerRoute.connectionId, profile: ownerRoute.profile },
      ACTIVE_SID
    )

    $sessionTiles.set([{ ownerRoute, runtimeId: ACTIVE_SID, storedSessionId: 'stored-lineage-root' }])
    sessionInfo(ACTIVE_SID, { model: 'm1', provider: 'p1', running: true })
    invalidate.mockClear()

    act(() =>
      stream.handleEvent({
        connectionId: ownerRoute.connectionId,
        payload: {
          model: 'm2',
          provider: 'p1',
          running: true,
          stored_session_id: 'stored-rotated-tip'
        },
        profile: ownerRoute.profile,
        session_id: ACTIVE_SID,
        type: 'session.info'
      })
    )

    expect(invalidate).toHaveBeenCalledWith({ queryKey: targetKey })
    expect(invalidate).not.toHaveBeenCalledWith({ queryKey: socketKey })
  })

  it('keeps an unbound tile eligible for durable-id fallback', () => {
    mountStream()
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries')

    const ownerRoute = {
      connectionId: 'remote-owner',
      mode: 'remote' as const,
      profile: 'bot-alias',
      targetProfile: 'backend-bot'
    }

    const targetKey = modelOptionsQueryKey(
      { connectionId: ownerRoute.connectionId, profile: ownerRoute.targetProfile },
      ACTIVE_SID
    )

    $sessionTiles.set([{ ownerRoute, storedSessionId: 'stored-unbound-bot' }])
    sessionInfo(ACTIVE_SID, { model: 'm1', provider: 'p1', running: true })
    invalidate.mockClear()

    act(() =>
      stream.handleEvent({
        connectionId: ownerRoute.connectionId,
        payload: { model: 'm2', provider: 'p1', running: true, stored_session_id: 'stored-unbound-bot' },
        profile: ownerRoute.profile,
        session_id: ACTIVE_SID,
        type: 'session.info'
      })
    )

    expect(invalidate).toHaveBeenCalledWith({ queryKey: targetKey })
  })

  it('prefers an unambiguous exact runtime route over contradictory durable evidence', () => {
    const source = { connectionId: 'remote-owner', profile: 'bot-alias' }
    const exactRoute = { ...source, mode: 'remote' as const, targetProfile: 'backend-exact' }
    const staleRoute = { ...source, mode: 'remote' as const, targetProfile: 'backend-stale' }

    $sessionTiles.set([
      { ownerRoute: exactRoute, runtimeId: ACTIVE_SID, storedSessionId: 'stored-lineage-root' },
      { ownerRoute: staleRoute, runtimeId: 'different-runtime', storedSessionId: 'stored-rotated-tip' }
    ])

    expect(sessionEventOwnerRoute(ACTIVE_SID, 'stored-rotated-tip', source)).toEqual({
      kind: 'known',
      route: exactRoute
    })
  })

  it('fails closed when both explicit runtime ids differ despite a matching stored id', () => {
    mountStream()
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries')

    const ownerRoute = {
      connectionId: 'remote-owner',
      mode: 'remote' as const,
      profile: 'bot-alias',
      targetProfile: 'stale-backend-bot'
    }

    $sessionTiles.set([{ ownerRoute, runtimeId: 'stale-runtime', storedSessionId: 'stored-shared' }])
    sessionInfo(ACTIVE_SID, { model: 'm1', provider: 'p1', running: true })
    invalidate.mockClear()

    act(() =>
      stream.handleEvent({
        connectionId: ownerRoute.connectionId,
        payload: { model: 'm2', provider: 'p1', running: true, stored_session_id: 'stored-shared' },
        profile: ownerRoute.profile,
        session_id: ACTIVE_SID,
        type: 'session.info'
      })
    )

    expect(invalidate).not.toHaveBeenCalled()
  })

  it('fails closed when a stale stored-id hint contradicts an explicit tile runtime', () => {
    setApiRequestConnection('ambient-remote')
    mountStream()
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries')
    const storedSessionId = 'stored-stale-hint-conflict'

    const ownerRoute = {
      connectionId: 'remote-owner',
      mode: 'remote' as const,
      profile: 'bot-alias',
      targetProfile: 'stale-backend-bot'
    }

    $sessionTiles.set([{ ownerRoute, runtimeId: 'different-runtime', storedSessionId }])
    setSessionOwnerHint(storedSessionId, ownerRoute)

    expect(sessionEventOwnerRoute(ACTIVE_SID, storedSessionId, ownerRoute)).toEqual({ kind: 'ambiguous' })

    sessionInfo(ACTIVE_SID, { model: 'm1', provider: 'p1', running: true })
    invalidate.mockClear()

    act(() =>
      stream.handleEvent({
        connectionId: ownerRoute.connectionId,
        payload: { model: 'm2', provider: 'p1', running: true, stored_session_id: storedSessionId },
        profile: ownerRoute.profile,
        session_id: ACTIVE_SID,
        type: 'session.info'
      })
    )

    expect(invalidate).not.toHaveBeenCalled()
  })

  it('fails closed instead of invalidating a guessed catalog when exact owner routes conflict', () => {
    mountStream()
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries')
    const source = { connectionId: 'remote-owner', profile: 'bot-alias' }

    $sessionTiles.set([
      {
        ownerRoute: { ...source, mode: 'remote', targetProfile: 'backend-bot-a' },
        runtimeId: ACTIVE_SID,
        storedSessionId: 'stored-bot-chat'
      },
      {
        ownerRoute: { ...source, mode: 'remote', targetProfile: 'backend-bot-b' },
        runtimeId: ACTIVE_SID,
        storedSessionId: 'stored-bot-chat'
      }
    ])
    sessionInfo(ACTIVE_SID, { model: 'm1', provider: 'p1', running: true })
    invalidate.mockClear()

    act(() =>
      stream.handleEvent({
        ...source,
        payload: {
          model: 'm2',
          provider: 'p1',
          running: true,
          stored_session_id: 'stored-bot-chat'
        },
        session_id: ACTIVE_SID,
        type: 'session.info'
      })
    )

    expect(invalidate).not.toHaveBeenCalled()
  })
})

describe('session.info settles a turn that produced no assistant payload', () => {
  // #46517: a turn that ends without ever emitting an assistant payload (gateway
  // crash mid-stream, provider error before the first delta, agent-build
  // failure) never reaches message.complete, so session.info running=false is
  // the only event that can release it. It used to return state unchanged,
  // latching awaitingResponse/busy until app restart — and because
  // isTargetSessionBusy reads the per-session busy flag as authoritative,
  // submitPrompt and the slash dispatcher then silently refused every send.
  const busyFor = (sessionId: string) => isTargetSessionBusy(Object.fromEntries(sessionStates!), sessionId, false)

  const startTurn = (sessionId: string) =>
    act(() => stream.handleEvent({ payload: {}, session_id: sessionId, type: 'message.start' }))

  it('leaves the session sendable after a started turn ends with no payload', async () => {
    mountStream()

    startTurn(ACTIVE_SID)
    expect(busyFor(ACTIVE_SID)).toBe(true)

    sessionInfo(ACTIVE_SID, { running: false })

    const state = sessionStates!.get(ACTIVE_SID)!
    expect(state.awaitingResponse).toBe(false)
    expect(state.busy).toBe(false)
    expect(state.streamId).toBeNull()
    expect(state.turnStartedAt).toBeNull()
    // The predicate submit.ts and slash.ts actually gate on.
    expect(busyFor(ACTIVE_SID)).toBe(false)
  })

  it('keeps waiting when running=false lands before the turn ever started', async () => {
    mountStream()

    // submit arms busy/awaitingResponse optimistically — and seeds the visible
    // turn clock (turnStartedAt) at Enter — so this heartbeat is the pre-start
    // report, not a finished turn: the spinner must stay up and the send guard
    // must stay closed. turnLive (backend-confirmed) is the discriminator.
    act(() => {
      sessionStates!.set(ACTIVE_SID, {
        ...createClientSessionState(),
        awaitingResponse: true,
        busy: true,
        sawAssistantPayload: false,
        turnStartedAt: Date.now(),
        turnLive: false
      })
    })

    sessionInfo(ACTIVE_SID, { running: false })

    const state = sessionStates!.get(ACTIVE_SID)!
    expect(state.awaitingResponse).toBe(true)
    expect(busyFor(ACTIVE_SID)).toBe(true)
    expect(hydrateFromStoredSession).not.toHaveBeenCalled()
  })

  // #86795: the pre-start hold above must be BOUNDED. A restore/edit/submit
  // that armed busy optimistically but whose turn never went live backend-side
  // (rewind refused after the arm, gateway bounce, dropped submit response)
  // otherwise ignores every running=false heartbeat forever: busy latches,
  // isTargetSessionBusy refuses every send, the composer queues each message
  // ("moves to the send area") and the queue drain — gated on busy→false —
  // never fires. Only an app restart cleared it. Past the grace window the
  // gateway's running=false is authoritative and must settle the session.
  it('settles an armed-but-never-live turn once the pre-start grace expires (#86795)', async () => {
    mountStream()

    act(() => {
      sessionStates!.set(ACTIVE_SID, {
        ...createClientSessionState(),
        awaitingResponse: true,
        busy: true,
        sawAssistantPayload: false,
        turnStartedAt: Date.now() - PRE_TURN_LIVE_SETTLE_GRACE_MS - 1,
        turnLive: false
      })
    })

    sessionInfo(ACTIVE_SID, { running: false })

    const state = sessionStates!.get(ACTIVE_SID)!
    expect(state.awaitingResponse).toBe(false)
    expect(state.busy).toBe(false)
    expect(state.turnStartedAt).toBeNull()
    // The predicate submit.ts / slash.ts / the composer queue drain gate on.
    expect(busyFor(ACTIVE_SID)).toBe(false)
  })

  // An armed-busy state that carries NO clock at all (no path today creates
  // one — submit and the rewind optimistic transforms both seed the clock —
  // but a regression that forgets the seed must fail open, not latch).
  it('settles an armed turn with no clock instead of latching busy (#86795)', async () => {
    mountStream()

    act(() => {
      sessionStates!.set(ACTIVE_SID, {
        ...createClientSessionState(),
        awaitingResponse: true,
        busy: true,
        sawAssistantPayload: false,
        turnStartedAt: null,
        turnLive: false
      })
    })

    sessionInfo(ACTIVE_SID, { running: false })

    expect(busyFor(ACTIVE_SID)).toBe(false)
  })

  it('un-latches a background session but does not hydrate its transcript', () => {
    mountStream()

    startTurn('session-background')
    sessionInfo('session-background', { running: false })

    // The settle is unscoped — a background session's sidebar dot must clear
    // without the user opening it.
    expect(busyFor('session-background')).toBe(false)
    // The transcript refetch is scoped to the session on screen, so an idle
    // background session does not cost a REST fan-out.
    expect(hydrateFromStoredSession).not.toHaveBeenCalled()
  })

  it('hydrates the foreground transcript once and coalesces the sidebar refresh', async () => {
    mountStream()

    startTurn(ACTIVE_SID)
    vi.useFakeTimers()

    sessionInfo(ACTIVE_SID, { running: false })
    // Later heartbeats hit the unchanged-state guard, so recovery is edge-only.
    sessionInfo(ACTIVE_SID, { running: false })
    sessionInfo(ACTIVE_SID, { running: false })

    await act(async () => {
      await vi.advanceTimersByTimeAsync(400)
    })

    expect(hydrateFromStoredSession).toHaveBeenCalledTimes(1)
    expect(refreshSessions).toHaveBeenCalledTimes(1)
  })
})

describe('message.complete sidebar refresh coalescing', () => {
  it('collapses near-simultaneous completions into one refresh', async () => {
    mountStream()
    vi.useFakeTimers()

    act(() => stream.handleEvent({ payload: { text: 'a' }, session_id: 's1', type: 'message.complete' }))
    act(() => stream.handleEvent({ payload: { text: 'b' }, session_id: 's2', type: 'message.complete' }))

    expect(refreshSessions).not.toHaveBeenCalled()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(400)
    })

    expect(refreshSessions).toHaveBeenCalledTimes(1)
  })
})
