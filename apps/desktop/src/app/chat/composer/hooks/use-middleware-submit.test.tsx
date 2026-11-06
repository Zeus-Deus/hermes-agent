import { renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { registry } from '@/contrib/registry'

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
})
