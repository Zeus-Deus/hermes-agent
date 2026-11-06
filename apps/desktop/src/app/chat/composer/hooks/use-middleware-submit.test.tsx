import { renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { registry } from '@/contrib/registry'
import { createClientSessionState } from '@/lib/chat-runtime'
import { host } from '@/sdk'
import { $sessions } from '@/store/session'
import { $sessionStates } from '@/store/session-states'

import { COMPOSER_AREAS, type ComposerMiddleware, type ComposerSubmitContext } from '../contrib'

import { useMiddlewareSubmit } from './use-middleware-submit'

const disposers: Array<() => void> = []

function captureContexts() {
  const seen: Array<ComposerSubmitContext | undefined> = []

  disposers.push(
    registry.register({
      id: 'capture',
      area: COMPOSER_AREAS.middleware,
      data: {
        handler: (draft, context) => {
          seen.push(context)

          return draft
        }
      } satisfies ComposerMiddleware
    })
  )

  return seen
}

afterEach(() => {
  disposers.splice(0).forEach(d => d())
  $sessionStates.set({})
  $sessions.set([])
})

// Middleware must know which chat a send goes to: a queued prompt drains in
// its own tile, which need not be the focused one.
describe('useMiddlewareSubmit hands middleware the destination chat', () => {
  it('names the chat a queue drain submits into, not the composer it was typed in', async () => {
    const seen = captureContexts()
    const onSubmit = vi.fn(async () => true)

    const { result } = renderHook(() =>
      useMiddlewareSubmit(onSubmit, { sessionId: 'rt-focused', storedSessionId: 'focused-chat' })
    )

    await result.current.onSubmit('queued', { fromQueue: true, sessionId: 'rt-other', storedSessionId: 'other-chat' })

    expect(seen).toEqual([{ sessionId: 'rt-other', storedSessionId: 'other-chat' }])
    expect(onSubmit).toHaveBeenCalledWith('queued', expect.objectContaining({ storedSessionId: 'other-chat' }))
  })

  it("falls back to the composer's own chat for a typed send", async () => {
    const seen = captureContexts()

    const { result } = renderHook(() =>
      useMiddlewareSubmit(vi.fn(async () => true), { sessionId: 'rt-a', storedSessionId: 'chat-a' })
    )

    await result.current.onSubmit('typed', { composerScope: 'chat-a' })

    expect(seen).toEqual([{ sessionId: 'rt-a', storedSessionId: 'chat-a' }])
  })

  it('reports a fresh draft as no stored chat yet', async () => {
    const seen = captureContexts()

    const { result } = renderHook(() =>
      useMiddlewareSubmit(vi.fn(async () => true), { sessionId: null, storedSessionId: '__new__:draft-1' })
    )

    await result.current.onSubmit('first', {})
    await result.current.onSubmit('queued', { fromQueue: true, sessionId: null, storedSessionId: '__new__:draft-1' })

    expect(seen).toEqual([
      { sessionId: null, storedSessionId: null },
      { sessionId: null, storedSessionId: null }
    ])
  })

  it("drops a queued runtime id bound to another chat — the destination's owner wins", async () => {
    // Mid-switch: the drain pairs writer's queue with the focused ops chat's runtime.
    $sessionStates.set({ 'rt-ops': createClientSessionState('ops-chat') })
    $sessions.set([
      { connection_id: 'server', id: 'ops-chat', profile: 'ops' } as never,
      { connection_id: 'local', id: 'writer-chat', profile: 'writer' } as never
    ])

    const owners: unknown[] = []

    disposers.push(
      registry.register({
        id: 'owner',
        area: COMPOSER_AREAS.middleware,
        data: {
          handler: (draft, context) => {
            owners.push(host.sessionOwner(context?.sessionId) ?? host.sessionOwner(context?.storedSessionId))

            return draft
          }
        } satisfies ComposerMiddleware
      })
    )

    const seen = captureContexts()

    const { result } = renderHook(() => useMiddlewareSubmit(vi.fn(async () => true), {}))

    await result.current.onSubmit('queued', { fromQueue: true, sessionId: 'rt-ops', storedSessionId: 'writer-chat' })

    expect(seen).toEqual([{ sessionId: null, storedSessionId: 'writer-chat' }])
    expect(owners).toEqual([{ connectionId: 'local', profile: 'writer' }])
  })

  it("keeps a runtime bound to the queue scope's own lineage tip", async () => {
    $sessionStates.set({ 'rt-writer': createClientSessionState('writer-tip') })
    $sessions.set([{ _lineage_root_id: 'writer-root', connection_id: 'local', id: 'writer-tip', profile: 'writer' } as never])

    const seen = captureContexts()

    const { result } = renderHook(() => useMiddlewareSubmit(vi.fn(async () => true), {}))

    await result.current.onSubmit('queued', { fromQueue: true, sessionId: 'rt-writer', storedSessionId: 'writer-root' })

    expect(seen).toEqual([{ sessionId: 'rt-writer', storedSessionId: 'writer-root' }])
  })
})
