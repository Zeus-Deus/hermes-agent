import type { GatewayEvent } from '@hermes/shared'
import { act, cleanup, render } from '@testing-library/react'
import { useEffect, useRef } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createSessionRpcDispatcher } from '@/app/contrib/session-rpc-dispatcher'
import type { ClientSessionState } from '@/app/types'
import { createClientSessionState } from '@/lib/chat-runtime'
import {
  closeSecondaryGateways,
  configureGatewayRegistry,
  setPrimaryGateway
} from '@/store/gateway'
import {
  _resetSessionOwnerHintsForTests,
  setAwaitingResponse,
  setBusy,
  setMessages,
  setSessionOwnerHint
} from '@/store/session'

import { clearSingleFlightSessionResumeState } from './single-flight-resume'

import { usePromptActions } from '.'

const RUNTIME_ID = 'rt-youtube'
const STORED_ID = 'stored-youtube'

interface FakeGateway {
  close: ReturnType<typeof vi.fn>
  connectionState: string
  emit: (event: GatewayEvent) => void
  request: ReturnType<typeof vi.fn>
}

const sockets: FakeGateway[] = []

vi.mock('@/hermes', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  HermesGateway: class {
    connectionState = 'closed'
    eventHandler: null | ((event: GatewayEvent) => void) = null
    stateHandler: null | ((state: string) => void) = null
    connect = vi.fn(async () => {
      this.connectionState = 'open'
    })
    request = vi.fn(async (method: string) => {
      if (this.connectionState !== 'open') {
        throw new Error('gateway is not connected')
      }

      return method === 'prompt.submit' ? { status: 'streaming' } : {}
    })
    close = vi.fn(() => {
      this.connectionState = 'closed'
    })
    emit = (event: GatewayEvent) => this.eventHandler?.(event)
    onEvent = vi.fn((handler: (event: GatewayEvent) => void) => {
      this.eventHandler = handler

      return () => {
        this.eventHandler = null
      }
    })
    onState = vi.fn((handler: (state: string) => void) => {
      this.stateHandler = handler

      return () => {
        this.stateHandler = null
      }
    })

    constructor() {
      sockets.push(this as unknown as FakeGateway)
    }
  },
  getSession: vi.fn(async () => {
    throw new Error('the exact owner hint should avoid a REST owner probe')
  }),
  setApiRequestConnection: vi.fn(),
  setApiRequestProfile: vi.fn()
}))

interface HarnessHandle {
  submitText: (text: string) => Promise<boolean>
}

function Harness({
  onReady,
  requestGateway
}: {
  onReady: (handle: HarnessHandle) => void
  requestGateway: ReturnType<typeof createSessionRpcDispatcher>
}) {
  const activeSessionIdRef = useRef<string | null>(RUNTIME_ID)
  const busyRef = useRef(false)
  const selectedStoredSessionIdRef = useRef<string | null>(STORED_ID)
  const runtimeIdByStoredSessionIdRef = useRef(new Map([[STORED_ID, RUNTIME_ID]]))
  const stateRef = useRef<ClientSessionState>(createClientSessionState(STORED_ID))

  const actions = usePromptActions({
    activeSessionId: RUNTIME_ID,
    activeSessionIdRef,
    branchCurrentSession: async () => true,
    busyRef,
    createBackendSessionForSend: async () => RUNTIME_ID,
    getRoutedStoredSessionId: () => STORED_ID,
    getRuntimeIdForStoredSession: storedId => (storedId === STORED_ID ? RUNTIME_ID : null),
    getRouteToken: () => 'stable-route',
    handleSkinCommand: () => '',
    openMemoryGraph: () => undefined,
    refreshSessions: async () => undefined,
    requestGateway,
    resumeStoredSession: async () => undefined,
    runtimeIdByStoredSessionIdRef,
    selectedStoredSessionIdRef,
    startFreshSessionDraft: () => undefined,
    sttEnabled: false,
    updateSessionState: (_sessionId, updater) => {
      stateRef.current = updater(stateRef.current)

      return stateRef.current
    }
  })

  const { submitText } = actions

  useEffect(() => {
    onReady({
      submitText: (...args) => act(async () => submitText(...args)) as Promise<boolean>
    })
  }, [onReady, submitText])

  return null
}

describe('usePromptActions routed turn lease', () => {
  beforeEach(() => {
    sockets.length = 0
    clearSingleFlightSessionResumeState()
    closeSecondaryGateways()
    configureGatewayRegistry({
      // Isolate the whole-turn lease. A foreground pin is a separate safety
      // net and must not make this transport-lifetime regression pass.
      foregroundScopes: () => new Set(),
      onEvent: vi.fn()
    })
    setPrimaryGateway(
      {
        connectionState: 'open',
        request: vi.fn(async () => ({}))
      } as never,
      'default'
    )
    ;(window as unknown as { hermesDesktop: unknown }).hermesDesktop = {
      getConnectionFor: vi.fn(async ({ connectionId, profile }) => ({
        port: 5151,
        profile,
        token: `${connectionId}-${profile}-token`
      })),
      touchBackend: vi.fn(async () => undefined)
    }
    setSessionOwnerHint(STORED_ID, {
      connectionId: 'local',
      mode: 'local',
      profile: 'youtube'
    })
    setMessages([])
    setBusy(false)
    setAwaitingResponse(false)
  })

  afterEach(() => {
    cleanup()
    closeSecondaryGateways()
    _resetSessionOwnerHintsForTests({ storage: true })
    setMessages([])
    setBusy(false)
    setAwaitingResponse(false)
    vi.useRealTimers()
    vi.clearAllMocks()
    delete (window as unknown as { hermesDesktop?: unknown }).hermesDesktop
  })

  it('keeps the exact owner socket after prompt ACK until the turn terminal event', async () => {
    vi.useFakeTimers()
    const ambientRequest = vi.fn(async () => ({ ambient: true }))
    const runtimeIdByStoredSessionIdRef = { current: new Map([[STORED_ID, RUNTIME_ID]]) }
    const selectedStoredSessionIdRef = { current: STORED_ID as null | string }

    const sessionStateByRuntimeIdRef = {
      current: new Map([[RUNTIME_ID, createClientSessionState(STORED_ID)]])
    }

    const requestGateway = createSessionRpcDispatcher({
      ambientRequest: ambientRequest as never,
      runtimeIdByStoredSessionIdRef,
      selectedStoredSessionIdRef,
      sessionStateByRuntimeIdRef
    })

    let handle: HarnessHandle | null = null

    await act(async () => {
      render(<Harness onReady={next => (handle = next)} requestGateway={requestGateway} />)
    })

    expect(await handle!.submitText('long turn')).toBe(true)
    expect(ambientRequest).not.toHaveBeenCalled()
    expect(sockets).toHaveLength(1)
    expect(sockets[0].request).toHaveBeenCalledWith(
      'prompt.submit',
      { session_id: RUNTIME_ID, text: 'long turn' },
      1_800_000,
      undefined
    )

    // prompt.submit ACKs while the model is still running. A request-scoped
    // lease alone drops to zero here and closes the socket, arming the backend's
    // 20-second client-gone reaper.
    expect(sockets[0].close).not.toHaveBeenCalled()
    expect(sockets[0].connectionState).toBe('open')

    sockets[0].emit({
      payload: { running: false },
      session_id: RUNTIME_ID,
      type: 'session.info'
    } as GatewayEvent)
    await vi.advanceTimersByTimeAsync(500)

    expect(sockets[0].close).toHaveBeenCalledOnce()
    expect(sockets[0].connectionState).toBe('closed')
  })
})
