import { afterEach, describe, expect, it } from 'vitest'

import { registry } from '@/contrib/registry'

import { COMPOSER_AREAS, type ComposerMiddleware, runComposerMiddleware } from './contrib'

const disposers: Array<() => void> = []

function addMiddleware(id: string, handler: ComposerMiddleware['handler'], order?: number) {
  disposers.push(
    registry.register({ id, area: COMPOSER_AREAS.middleware, order, data: { handler } satisfies ComposerMiddleware })
  )
}

afterEach(() => {
  disposers.splice(0).forEach(d => d())
})

describe('runComposerMiddleware', () => {
  it('passes the draft through untouched when nothing is registered', async () => {
    const draft = { text: 'hello' }

    expect(await runComposerMiddleware(draft)).toBe(draft)
  })

  it('chains rewrites in registry order', async () => {
    addMiddleware('b', d => ({ ...d, text: `${d.text}b` }), 20)
    addMiddleware('a', d => ({ ...d, text: `${d.text}a` }), 10)

    expect(await runComposerMiddleware({ text: 'x' })).toEqual({ text: 'xab' })
  })

  it('cancels the send when a handler returns null', async () => {
    addMiddleware('gate', () => null)
    addMiddleware('later', d => ({ ...d, text: 'never' }), 99)

    expect(await runComposerMiddleware({ text: 'x' })).toBeNull()
  })

  it('treats a throwing handler as pass-through', async () => {
    addMiddleware('boom', () => {
      throw new Error('broken plugin')
    })
    addMiddleware('after', d => ({ ...d, text: `${d.text}!` }), 99)

    expect(await runComposerMiddleware({ text: 'x' })).toEqual({ text: 'x!' })
  })

  it('supports async handlers', async () => {
    addMiddleware('async', async d => ({ ...d, text: d.text.toUpperCase() }))

    expect(await runComposerMiddleware({ text: 'quiet' })).toEqual({ text: 'QUIET' })
  })

  it('hands every handler the same destination chat, whatever an earlier one returns', async () => {
    const seen: unknown[] = []

    addMiddleware('a', (d, context) => {
      seen.push(context)

      return { text: `${d.text}a` }
    }, 10)
    addMiddleware('b', (d, context) => {
      seen.push(context)

      return d
    }, 20)

    await runComposerMiddleware({ text: 'x' }, { sessionId: 'rt-a', storedSessionId: 'stored-a' })

    expect(seen).toEqual([
      { sessionId: 'rt-a', storedSessionId: 'stored-a' },
      { sessionId: 'rt-a', storedSessionId: 'stored-a' }
    ])
    expect(Object.isFrozen(seen[0])).toBe(true)
  })

  it('omits the context for callers that pass none', async () => {
    let context: unknown = 'unset'

    addMiddleware('a', (d, ctx) => {
      context = ctx

      return d
    })

    await runComposerMiddleware({ text: 'x' })

    expect(context).toBeUndefined()
  })
})
