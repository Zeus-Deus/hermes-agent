/**
 * The cross-connection bot relay — the Desktop-as-router loops that let a bot
 * on one gateway reach a bot on another (Aug 2026 ruling: connections ARE the
 * peer set).
 *
 * Three incidents are pinned here:
 *
 *  - #93091 — the drain was poll-only, so a DM waited out the interval before
 *    it moved (#92760 "slow replies"). The gateway now broadcasts
 *    `bot_relay.outbox.pending`; a burst of signals collapses to ONE drain,
 *    a push landing mid-drain re-schedules instead of being swallowed, and
 *    the interval survives as a BACKSTOP only. Item 2 of the same issue: a
 *    transient `profiles.list` blip must not be pushed as "that machine is
 *    empty" — the gateway reads absence from a fresh roster as offline.
 *  - #93594 — each registered connection's pooled socket is pinned open while
 *    the relay runs, so the drain reuses one persistent WebSocket instead of
 *    dialing and tearing one down per tick.
 *  - the waiter contract — a missing target connection must still post a reply,
 *    or the sending agent hangs until its own timeout.
 *
 * Everything is driven through the two real lifecycle doors, `startBotRelay` /
 * `stopBotRelay`; only the SDK `host` and the attention hooks are mocked.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { RELAY_DELIVER_TIMEOUT_MS } from './relay-budget'
import type { ProfileRoute } from './types'

const { clearBotAttentionMock, hostMock, noteBotAttentionMock, UnboundedCache } = vi.hoisted(() => ({
  clearBotAttentionMock: vi.fn(),
  hostMock: {
    onEvent: vi.fn(),
    pluginDecisions: {
      get: () => {
        try {
          const raw = window.localStorage.getItem('hermes.desktop.pluginDecisions.v2')

          return raw ? (JSON.parse(raw) as Record<string, boolean>) : {}
        } catch {
          return {}
        }
      }
    },
    profileRoutes: vi.fn(),
    requestProfile: vi.fn(),
    retainProfileSocket: vi.fn()
  } as Record<string, unknown>,
  noteBotAttentionMock: vi.fn(),
  // Stand-in for the SDK's LruCache. Its ceiling has its own unit test and no
  // fixture here approaches it, so the double just drops the bound.
  UnboundedCache: class extends Map {
    constructor(_max: number) {
      super()
    }
  }
}))

// relay.ts imports ./shared, which holds the $pendingBotOpen atom.
vi.mock('@hermes/plugin-sdk', async () => {
  const { atom } = await import('nanostores')

  return { atom, host: hostMock, LruCache: UnboundedCache }
})

vi.mock('./data', () => ({
  botHandle: (name: string) => (name === 'default' ? 'hermes' : name),
  clearBotAttention: clearBotAttentionMock,
  noteBotAttention: noteBotAttentionMock
}))

const RELAY_PUSH_DEBOUNCE_MS = 250
const RELAY_DRAIN_INTERVAL_MS = 30_000

const route = (
  id: string,
  options: { mode?: ProfileRoute['mode']; primary?: true; profile?: string } = {}
): ProfileRoute => ({
  connectionId: id,
  mode: options.mode ?? 'remote',
  ...(options.primary === true ? { primary: true } : {}),
  profile: options.profile ?? 'default',
  targetProfile: options.profile ?? 'default'
})

/** Every RPC through one table, recording what each connection was asked. */
interface RelayCall {
  connectionId: string
  method: string
  params: Record<string, unknown>
  route: ProfileRoute
}

function respondWith(handler: (call: RelayCall) => unknown) {
  const calls: RelayCall[] = []

  ;(hostMock.requestProfile as ReturnType<typeof vi.fn>).mockImplementation(
    async (target: ProfileRoute, method: string, params: Record<string, unknown>) => {
      const call = { connectionId: target.connectionId, method, params: structuredClone(params ?? {}), route: structuredClone(target) }

      calls.push(call)

      return handler(call)
    }
  )

  return calls
}

/** Pins handed out by the mocked retention door, in grant order. */
interface Pin {
  released: boolean
  route: ProfileRoute
}

function trackRetention() {
  const pins: Pin[] = []

  ;(hostMock.retainProfileSocket as ReturnType<typeof vi.fn>).mockImplementation((pinned: ProfileRoute) => {
    const pin: Pin = { released: false, route: pinned }

    pins.push(pin)

    return () => {
      pin.released = true
    }
  })

  return pins
}

async function loadRelay() {
  vi.resetModules()

  return import('./relay')
}

/** Fire the gateway's pending-envelope broadcast and let the debounced drain
 *  run to completion. */
async function pushAndSettle(times = 1, event?: { connectionId?: string }) {
  const listener = (hostMock.onEvent as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[1] as (payload?: {
    connectionId?: string
  }) => void

  for (let i = 0; i < times; i += 1) {
    listener(event)
  }

  await vi.advanceTimersByTimeAsync(RELAY_PUSH_DEBOUNCE_MS + 10)
}

const PLUGIN_DECISIONS_KEY = 'hermes.desktop.pluginDecisions.v2'

beforeEach(() => {
  vi.useFakeTimers()
  vi.clearAllMocks()
  window.localStorage.removeItem(PLUGIN_DECISIONS_KEY)
  hostMock.onEvent = vi.fn(() => vi.fn())
  hostMock.profileRoutes = vi.fn(async () => [route('a'), route('b')])
  hostMock.requestProfile = vi.fn(async () => ({}))
  hostMock.retainProfileSocket = vi.fn(() => vi.fn())
  delete hostMock.connections
})

afterEach(() => {
  vi.useRealTimers()
})

describe('push-notified drain (#93091)', () => {
  it('collapses a burst of pending signals into ONE drain', async () => {
    const calls = respondWith(() => ({ envelopes: [] }))
    const { startBotRelay, stopBotRelay } = await loadRelay()

    startBotRelay()
    await vi.advanceTimersByTimeAsync(0)
    calls.length = 0

    await pushAndSettle(6)

    // One drain visits each connection's outbox exactly once.
    expect(calls.filter(call => call.method === 'bot_relay.outbox.drain')).toHaveLength(2)

    stopBotRelay()
  })

  it('drains again for a signal that lands after the window closed', async () => {
    const calls = respondWith(() => ({ envelopes: [] }))
    const { startBotRelay, stopBotRelay } = await loadRelay()

    startBotRelay()
    await vi.advanceTimersByTimeAsync(0)
    calls.length = 0

    await pushAndSettle()
    await pushAndSettle(2)

    expect(calls.filter(call => call.method === 'bot_relay.outbox.drain')).toHaveLength(4)

    stopBotRelay()
  })

  it('keeps the interval poll as a BACKSTOP only when the shell cannot signal work', async () => {
    // The poll was 4s back when it WAS the delivery path — which (before
    // route retention) meant a fresh WebSocket dial + teardown per connection
    // every 4s. With the push door, an idle tick must not open a socket.
    // Shells that cannot broadcast pending mail still poll.
    const calls = respondWith(() => ({ envelopes: [] }))
    const { startBotRelay, stopBotRelay } = await loadRelay()

    startBotRelay()
    await vi.advanceTimersByTimeAsync(0)
    calls.length = 0

    await vi.advanceTimersByTimeAsync(RELAY_DRAIN_INTERVAL_MS - 1000)

    expect(calls.filter(call => call.method === 'bot_relay.outbox.drain')).toHaveLength(0)

    await vi.advanceTimersByTimeAsync(2000)

    expect(calls.filter(call => call.method === 'bot_relay.outbox.drain')).toHaveLength(0)

    stopBotRelay()

    hostMock.onEvent = undefined
    calls.length = 0
    const legacy = await loadRelay()

    legacy.startBotRelay()
    await vi.advanceTimersByTimeAsync(0)
    calls.length = 0
    await vi.advanceTimersByTimeAsync(RELAY_DRAIN_INTERVAL_MS)

    expect(calls.filter(call => call.method === 'bot_relay.outbox.drain')).toHaveLength(2)

    legacy.stopBotRelay()
  })

  it('re-schedules a push that raced an in-flight drain instead of dropping it', async () => {
    // The gateway signature is monotone — one event per new envelope, never
    // re-broadcast — so a push swallowed by the busy guard would strand its
    // envelope until the poll.
    let release!: () => void

    const firstDrain = new Promise<void>(resolve => {
      release = resolve
    })

    let drains = 0

    const calls = respondWith(async call => {
      if (call.method === 'bot_relay.outbox.drain') {
        drains += 1

        if (drains === 1) {
          await firstDrain
        }
      }

      return { envelopes: [] }
    })

    const { startBotRelay, stopBotRelay } = await loadRelay()

    startBotRelay()
    await vi.advanceTimersByTimeAsync(0)
    calls.length = 0

    await pushAndSettle()
    const midFlight = drains

    // A second push while the first drain is still awaiting its RPC.
    await pushAndSettle()
    expect(drains).toBe(midFlight)

    release()
    await vi.advanceTimersByTimeAsync(RELAY_PUSH_DEBOUNCE_MS + 10)

    expect(drains).toBeGreaterThan(midFlight)

    stopBotRelay()
  })

  it('never schedules a drain once the relay is stopped', async () => {
    const calls = respondWith(() => ({ envelopes: [] }))
    const { startBotRelay, stopBotRelay } = await loadRelay()

    startBotRelay()
    await vi.advanceTimersByTimeAsync(0)
    stopBotRelay()
    calls.length = 0

    await pushAndSettle(3)
    await vi.advanceTimersByTimeAsync(RELAY_DRAIN_INTERVAL_MS * 2)

    expect(calls).toHaveLength(0)
  })

  it('feature-detects the event door and disposes its subscription', async () => {
    const unsubscribe = vi.fn()

    hostMock.onEvent = vi.fn(() => unsubscribe)

    const { startBotRelay, stopBotRelay } = await loadRelay()

    startBotRelay()
    expect(hostMock.onEvent).toHaveBeenCalledWith('bot_relay.outbox.pending', expect.any(Function))

    stopBotRelay()
    expect(unsubscribe).toHaveBeenCalledTimes(1)

    // An older shell has no event door at all; the relay still starts.
    hostMock.onEvent = undefined
    const legacy = await loadRelay()

    expect(() => legacy.startBotRelay()).not.toThrow()
    legacy.stopBotRelay()
  })
})

describe('the 30s drain does not open a gateway socket with nothing to deliver (#118856)', () => {
  it('does not dial when the push door is present and no route has outbox work', async () => {
    const calls = respondWith(() => ({ envelopes: [] }))
    const { startBotRelay, stopBotRelay } = await loadRelay()

    startBotRelay()
    await vi.advanceTimersByTimeAsync(0)
    calls.length = 0

    await vi.advanceTimersByTimeAsync(RELAY_DRAIN_INTERVAL_MS)

    expect(calls.filter(call => call.method === 'bot_relay.outbox.drain')).toHaveLength(0)

    stopBotRelay()
  })

  it('does not dial a route that did not signal outbox work', async () => {
    const calls = respondWith(() => ({ envelopes: [] }))
    const { startBotRelay, stopBotRelay } = await loadRelay()

    startBotRelay()
    await vi.advanceTimersByTimeAsync(0)
    calls.length = 0

    await pushAndSettle(1, { connectionId: 'a' })

    expect(calls.filter(call => call.method === 'bot_relay.outbox.drain').map(call => call.connectionId)).toEqual(['a'])

    stopBotRelay()
  })

  it('does not dial when Bot Mode is off, even if an outbox event arrives', async () => {
    window.localStorage.setItem(PLUGIN_DECISIONS_KEY, JSON.stringify({ 'hermes-bots': false }))

    const calls = respondWith(() => ({ envelopes: [{ id: 'env-1', target_connection: 'b' }] }))
    const { startBotRelay, stopBotRelay } = await loadRelay()

    startBotRelay()
    await pushAndSettle(1, { connectionId: 'a' })
    await vi.advanceTimersByTimeAsync(RELAY_DRAIN_INTERVAL_MS)

    expect(calls.filter(call => call.method === 'bot_relay.outbox.drain')).toHaveLength(0)

    stopBotRelay()
  })
})

describe('relay-route socket retention (#93594)', () => {
  it('does not poll or retain the non-primary local source of a remote-primary Desktop', async () => {
    hostMock.profileRoutes = vi.fn(async () => [
      route('remote-primary', { primary: true }),
      route('remote-primary', { primary: true, profile: 'research' }),
      route('local', { mode: 'local' }),
      route('local', { mode: 'local', profile: 'research' })
    ])
    const pins = trackRetention()
    const calls = respondWith(() => ({ envelopes: [] }))
    const { startBotRelay, stopBotRelay } = await loadRelay()

    startBotRelay()
    await vi.advanceTimersByTimeAsync(0)
    await pushAndSettle()

    // Only the sole remaining connection's one-time roster clear goes out — once per profile
    // route, since each profile home holds its own roster; the local source is never polled.
    // Two profiles of one connection are not peers: no profiles.list, nothing pinned.
    expect(calls).toEqual([
      { connectionId: 'remote-primary', method: 'bot_relay.roster.sync', params: { agents: [], publisher: expect.any(String) }, route: route('remote-primary', { primary: true }) },
      {
        connectionId: 'remote-primary',
        method: 'bot_relay.roster.sync',
        params: { agents: [], publisher: expect.any(String) },
        route: route('remote-primary', { primary: true, profile: 'research' })
      }
    ])
    expect(pins).toHaveLength(0)

    stopBotRelay()
  })

  it('preserves local-primary, multi-remote, and fail-open peer sets', async () => {
    for (const routes of [
      [route('local', { mode: 'local', primary: true }), route('remote-peer')],
      [route('remote-primary', { primary: true }), route('remote-peer')],
      [route('remote-primary'), route('local', { mode: 'local' })],
      [route('remote-primary', { primary: true }), route('local', { mode: 'local', primary: true })],
      [
        route('remote-primary', { primary: true }),
        route('remote-primary', { profile: 'research' }),
        route('local', { mode: 'local' })
      ],
      [
        route('remote-primary', { primary: true }),
        route('local', { mode: 'local' }),
        route('unexpected-local', { mode: 'local' })
      ],
      [
        route('remote-primary', { primary: true }),
        { ...route('remote-peer'), primary: false } as unknown as ProfileRoute,
        route('local', { mode: 'local' })
      ]
    ]) {
      hostMock.profileRoutes = vi.fn(async () => routes)
      const pins = trackRetention()
      const calls = respondWith(() => ({ envelopes: [] }))
      const { startBotRelay, stopBotRelay } = await loadRelay()

      startBotRelay()
      await vi.advanceTimersByTimeAsync(0)
      await pushAndSettle()

      expect(new Set(calls.map(call => call.connectionId))).toEqual(new Set(routes.map(item => item.connectionId)))
      // One profiles.list per connection, however many of its profiles are routed.
      const lists = calls.filter(call => call.method === 'profiles.list').map(call => call.connectionId)
      expect(lists.sort()).toEqual([...new Set(routes.map(item => item.connectionId))].sort())
      // Every eligible profile route (its own socket scope and outbox) is pinned exactly once.
      expect(pins.map(pin => pin.route)).toEqual(routes)

      stopBotRelay()
    }
  })

  it('pins each connection ONCE across many drain ticks', async () => {
    const pins = trackRetention()

    respondWith(() => ({ envelopes: [] }))

    const { startBotRelay, stopBotRelay } = await loadRelay()

    startBotRelay()

    for (let tick = 0; tick < 4; tick += 1) {
      await pushAndSettle()
    }

    expect(pins.map(pin => pin.route.connectionId)).toEqual(['a', 'b'])
    expect(pins.every(pin => !pin.released)).toBe(true)

    stopBotRelay()
  })

  it('releases exactly the pin of a connection that left the registry', async () => {
    const pins = trackRetention()

    respondWith(() => ({ envelopes: [] }))

    const { startBotRelay, stopBotRelay } = await loadRelay()

    startBotRelay()
    await pushAndSettle()

    hostMock.profileRoutes = vi.fn(async () => [route('a'), route('c')])
    await pushAndSettle()

    expect(pins.filter(pin => pin.released).map(pin => pin.route.connectionId)).toEqual(['b'])
    expect(pins.map(pin => pin.route.connectionId)).toEqual(['a', 'b', 'c'])

    stopBotRelay()
  })

  it('drops every pin on stop, and stays idempotent', async () => {
    const pins = trackRetention()

    respondWith(() => ({ envelopes: [] }))

    const { startBotRelay, stopBotRelay } = await loadRelay()

    startBotRelay()
    await pushAndSettle()
    stopBotRelay()

    expect(pins.every(pin => pin.released)).toBe(true)

    // A second stop releases nothing new — the pins are already gone.
    const releasedCount = pins.filter(pin => pin.released).length

    stopBotRelay()
    expect(pins.filter(pin => pin.released)).toHaveLength(releasedCount)
  })

  it('unpins everything when the peer set drops below two connections', async () => {
    // Retention follows the relay-ELIGIBLE set: with nothing to relay,
    // nothing stays pinned.
    const pins = trackRetention()

    respondWith(() => ({ envelopes: [] }))

    const { startBotRelay, stopBotRelay } = await loadRelay()

    startBotRelay()
    await pushAndSettle()
    expect(pins).toHaveLength(2)

    hostMock.profileRoutes = vi.fn(async () => [route('a')])
    await pushAndSettle()

    expect(pins.every(pin => pin.released)).toBe(true)

    stopBotRelay()
  })

  it('is feature-detected: an older shell without the door is a no-op', async () => {
    hostMock.retainProfileSocket = undefined

    respondWith(() => ({ envelopes: [] }))

    const { startBotRelay, stopBotRelay } = await loadRelay()

    startBotRelay()
    await expect(pushAndSettle()).resolves.toBeUndefined()

    stopBotRelay()
  })
})

describe('the roster loop pushes the OTHER connections’ agents', () => {
  it.each([false, true])('discards a stopped roster fetch (restart=%s)', async restart => {
    let release!: () => void

    const held = new Promise<void>(resolve => {
      release = resolve
    })

    let first = true
    let failB = false

    const calls = respondWith(async call => {
      if (call.method === 'profiles.list') {
        if (call.connectionId === 'b' && failB) {
          throw new Error('temporary profile lookup failure')
        }

        if (call.connectionId === 'b' && first) {
          first = false
          await held

          return { profiles: [{ name: 'stale' }] }
        }

        return { profiles: [{ name: 'current' }] }
      }

      return {}
    })

    const { startBotRelay, stopBotRelay } = await loadRelay()
    startBotRelay()
    await vi.advanceTimersByTimeAsync(0)
    expect(calls.filter(call => call.method === 'profiles.list')).toHaveLength(2)
    stopBotRelay()

    if (restart) {
      startBotRelay()
      await vi.advanceTimersByTimeAsync(0)
      expect(calls.filter(call => call.method === 'bot_relay.roster.sync')).toHaveLength(2)
    }

    release()
    await vi.advanceTimersByTimeAsync(0)
    const syncs = calls.filter(call => call.method === 'bot_relay.roster.sync')
    expect(syncs).toHaveLength(restart ? 2 : 0)
    expect(
      syncs.every(call => (call.params.agents as Array<{ profile: string }>).every(row => row.profile === 'current'))
    ).toBe(true)

    if (restart) {
      // A late old response must not poison the new run's fallback cache.
      failB = true
      await vi.advanceTimersByTimeAsync(60_000)
      const later = calls.filter(call => call.method === 'bot_relay.roster.sync').slice(2)
      expect(later).toHaveLength(2)
      expect(
        later.every(call => (call.params.agents as Array<{ profile: string }>).every(row => row.profile === 'current'))
      ).toBe(true)
    }

    stopBotRelay()
  })

  it('a stale run finishing does not free the restarted run’s busy flag', async () => {
    const holds: Record<string, { release: () => void; promise: Promise<void> }> = {}

    for (const id of ['stale', 'current']) {
      let release!: () => void

      const promise = new Promise<void>(resolve => {
        release = resolve
      })

      holds[id] = { promise, release }
    }

    const seen: Record<string, number> = { a: 0, b: 0 }

    const calls = respondWith(async call => {
      if (call.method === 'profiles.list') {
        seen[call.connectionId] += 1

        // Run 1 parks on b, the restarted run parks on a.
        if (call.connectionId === 'b' && seen.b === 1) {
          await holds.stale.promise
        } else if (call.connectionId === 'a' && seen.a === 2) {
          await holds.current.promise
        }

        return { profiles: [{ name: call.connectionId }] }
      }

      return {}
    })

    const { startBotRelay, stopBotRelay } = await loadRelay()
    const listCount = () => calls.filter(call => call.method === 'profiles.list').length

    startBotRelay()
    await vi.advanceTimersByTimeAsync(0)
    stopBotRelay()
    startBotRelay()
    await vi.advanceTimersByTimeAsync(0)
    expect(listCount()).toBe(4)

    // The stale run lands while the restarted run is still in flight; the
    // next tick must still see that run's busy flag, not start a third.
    holds.stale.release()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(listCount()).toBe(4)

    holds.current.release()
    await vi.advanceTimersByTimeAsync(0)
    stopBotRelay()
  })

  it('does not clear a sole gateway after stopping during label lookup', async () => {
    let release!: () => void

    const held = new Promise<void>(resolve => {
      release = resolve
    })

    hostMock.profileRoutes = vi.fn(async () => [route('a')])
    hostMock.connections = vi.fn(async () => {
      await held

      return []
    })
    const calls = respondWith(() => ({}))
    const { startBotRelay, stopBotRelay } = await loadRelay()
    startBotRelay()
    await vi.advanceTimersByTimeAsync(0)
    expect(hostMock.connections).toHaveBeenCalled()
    stopBotRelay()
    release()
    await vi.advanceTimersByTimeAsync(0)
    expect(calls.filter(call => call.method === 'bot_relay.roster.sync')).toEqual([])
    delete hostMock.connections
  })

  it('gives each gateway a union roster that excludes its own agents', async () => {
    const calls = respondWith(call => {
      if (call.method === 'profiles.list') {
        return { profiles: [{ name: call.connectionId === 'a' ? 'default' : 'ops' }] }
      }

      return {}
    })

    const { startBotRelay, stopBotRelay } = await loadRelay()

    startBotRelay()
    await vi.advanceTimersByTimeAsync(0)

    const syncs = calls.filter(call => call.method === 'bot_relay.roster.sync')

    expect(syncs.map(call => call.connectionId)).toEqual(['a', 'b'])
    expect(syncs[0].params.agents).toEqual([
      expect.objectContaining({ connection_id: 'b', handle: 'ops', profile: 'ops' })
    ])
    // The primary profile is published by its callable alias, never "default".
    expect(syncs[1].params.agents).toEqual([
      expect.objectContaining({ connection_id: 'a', handle: 'hermes', profile: 'default' })
    ])

    stopBotRelay()
  })

  it('never conflates a transient fetch failure with an empty connection', async () => {
    // A live machine whose profiles.list blips must not be pushed as absent:
    // the gateway-side liveness check reads "absent from a fresh roster" as
    // definitively offline and refuses enqueues with a false runtime_offline
    // (#93091 item 2).
    let failB = false

    const calls = respondWith(call => {
      if (call.method === 'profiles.list') {
        if (call.connectionId === 'b' && failB) {
          throw new Error('socket blip')
        }

        return { profiles: [{ name: call.connectionId === 'a' ? 'default' : 'ops' }] }
      }

      return {}
    })

    const { startBotRelay, stopBotRelay } = await loadRelay()

    startBotRelay()
    await vi.advanceTimersByTimeAsync(0)
    calls.length = 0

    failB = true
    await vi.advanceTimersByTimeAsync(60_000)

    const pushedToA = calls.find(call => call.method === 'bot_relay.roster.sync' && call.connectionId === 'a')

    expect(pushedToA?.params.agents).toEqual([expect.objectContaining({ profile: 'ops' })])

    stopBotRelay()
  })

  it.each([
    [{ registry: true }, 'This Mac'],
    [{ registry: false }, 'a']
  ])('names the machine by its registry label (%o -> %s)', async ({ registry }, expected) => {
    // tools/bot_mode_probe.py injects "@handle on <connection_label or connection_id>" into every
    // bot's roster, and tools/bot_relay.py names the machine the same way when it refuses a target
    // as offline. The route carries identity only, so the label has to come from the registry —
    // without it every peer bot addresses its teammates by raw connection id. A Desktop build with
    // no registry rejects the call, and the id stays.
    if (registry) {
      hostMock.connections = vi.fn(async () => [
        { id: 'a', label: 'This Mac' },
        { id: 'b', label: 'Noir (cto)' }
      ])
    } else {
      delete hostMock.connections
    }

    const calls = respondWith(call =>
      call.method === 'profiles.list' ? { profiles: [{ name: call.connectionId }] } : {}
    )

    const { startBotRelay, stopBotRelay } = await loadRelay()

    startBotRelay()
    await vi.advanceTimersByTimeAsync(0)

    const pushedToB = calls.find(call => call.method === 'bot_relay.roster.sync' && call.connectionId === 'b')

    expect(pushedToB?.params.agents).toEqual([
      expect.objectContaining({ connection_id: 'a', connection_label: expected, profile: 'a' })
    ])

    stopBotRelay()
  })

  it('drops the cached rows of a connection that genuinely disconnected', async () => {
    const calls = respondWith(call =>
      call.method === 'profiles.list' ? { profiles: [{ name: call.connectionId }] } : {}
    )

    const { startBotRelay, stopBotRelay } = await loadRelay()

    startBotRelay()
    await vi.advanceTimersByTimeAsync(0)

    // 'b' leaves the registry and 'c' arrives: b's agents must not linger.
    hostMock.profileRoutes = vi.fn(async () => [route('a'), route('c')])
    calls.length = 0
    await vi.advanceTimersByTimeAsync(60_000)

    const pushedToA = calls.find(call => call.method === 'bot_relay.roster.sync' && call.connectionId === 'a')

    expect(pushedToA?.params.agents).toEqual([expect.objectContaining({ profile: 'c' })])

    stopBotRelay()
  })

  it('with a single connection it only clears that gateway’s remote roster — there is no peer to relay to', async () => {
    // The one call is the clear: the gateway may still hold a roster pushed
    // while a second machine was registered (see 'forgets a machine that left').
    hostMock.profileRoutes = vi.fn(async () => [route('a')])

    const calls = respondWith(() => ({}))
    const { startBotRelay, stopBotRelay } = await loadRelay()

    startBotRelay()
    await vi.advanceTimersByTimeAsync(0)

    expect(calls).toEqual([
      expect.objectContaining({ connectionId: 'a', method: 'bot_relay.roster.sync', params: { agents: [], publisher: expect.any(String) } })
    ])

    await vi.advanceTimersByTimeAsync(60_000)
    expect(calls).toHaveLength(1)

    stopBotRelay()
  })

  it('an empty route list before the registry loads does not spend the one roster clear', async () => {
    hostMock.profileRoutes = vi.fn(async () => [])

    const calls = respondWith(() => ({}))
    const { startBotRelay, stopBotRelay } = await loadRelay()

    startBotRelay()
    await vi.advanceTimersByTimeAsync(0)
    expect(calls).toHaveLength(0)

    // The registry arrives with a single connection: it still gets its clear.
    hostMock.profileRoutes = vi.fn(async () => [route('a')])
    await vi.advanceTimersByTimeAsync(60_000)
    expect(calls).toEqual([
      expect.objectContaining({ connectionId: 'a', method: 'bot_relay.roster.sync', params: { agents: [], publisher: expect.any(String) } })
    ])

    stopBotRelay()
  })
})

describe('the drain loop wires drain → deliver → reply', () => {
  const envelope = {
    id: 'env-1',
    message: 'status?',
    target_connection: 'b',
    target_profile: 'ops'
  }

  it('delivers on the target’s own socket and posts the reply to the sender', async () => {
    const calls = respondWith(call => {
      if (call.method === 'bot_relay.outbox.drain') {
        return { envelopes: call.connectionId === 'a' ? [envelope] : [] }
      }

      if (call.method === 'bot_relay.deliver') {
        return { status: 'settled', delivery_id: envelope.id, admission_id: 'admission-1', reply: 'all green' }
      }

      return {}
    })

    const { startBotRelay, stopBotRelay } = await loadRelay()

    startBotRelay()
    await pushAndSettle()

    expect(calls.find(call => call.method === 'bot_relay.deliver')).toMatchObject({
      connectionId: 'b',
      params: { id: envelope.id, message: 'status?', profile: 'ops' }
    })

    // #93911: the deliver deadline must outlive the backend's own turn bound.
    const deliverCall = (hostMock.requestProfile as ReturnType<typeof vi.fn>).mock.calls.find(
      ([, method]) => method === 'bot_relay.deliver'
    )

    expect(deliverCall?.[3]).toBe(RELAY_DELIVER_TIMEOUT_MS)
    expect(calls.find(call => call.method === 'bot_relay.reply')).toMatchObject({
      connectionId: 'a',
      params: { id: 'env-1', reply: 'all green' }
    })
    // A delivered background DM is this bot's "good turn".
    expect(clearBotAttentionMock).toHaveBeenCalledWith('b::ops')

    stopBotRelay()
  })

  it('drains every sender profile and delivers on the exact target profile', async () => {
    const ops = { ...route('a'), profile: 'ops', targetProfile: 'ops' }
    hostMock.profileRoutes = vi.fn(async () => [route('a'), ops, route('b')])

    const calls = respondWith(call => {
      if (call.method === 'bot_relay.outbox.drain') {return { envelopes: call.route.profile === 'ops' ? [envelope] : [] }}

      if (call.method === 'bot_relay.deliver') {return {status: 'settled', delivery_id: envelope.id, admission_id: 'admission', reply: 'isolated'}}

      return {}
    })

    const {startBotRelay, stopBotRelay} = await loadRelay()
    startBotRelay()
    await pushAndSettle()
    expect(calls.find(call => call.method === 'bot_relay.deliver')?.route).toEqual({...route('b'), profile: 'ops', targetProfile: 'ops'})
    expect(calls.find(call => call.method === 'bot_relay.reply')?.route).toEqual(ops)
    stopBotRelay()
  })

  it('retries the same envelope after pending or lost ACK without replying early', async () => {
    let attempts = 0
    let drained = false

    const calls = respondWith(call => {
      if (call.method === 'bot_relay.outbox.drain') {
        if (call.connectionId !== 'a' || drained) {return { envelopes: [] }}
        drained = true

        return { envelopes: [envelope] }
      }

      if (call.method === 'bot_relay.deliver') {
        attempts += 1

        if (attempts === 1) {throw new Error('socket lost after commit')}

        return { status: attempts === 2 ? 'queued' : 'settled', delivery_id: envelope.id,
          admission_id: 'exact-admission', reply: attempts === 2 ? '' : 'exact reply' }
      }

      return {}
    })

    const { startBotRelay, stopBotRelay } = await loadRelay()
    startBotRelay()
    await pushAndSettle()
    expect(calls.filter(call => call.method === 'bot_relay.reply')).toHaveLength(0)
    await pushAndSettle()
    expect(calls.filter(call => call.method === 'bot_relay.reply')).toHaveLength(0)
    await pushAndSettle()
    const deliveries = calls.filter(call => call.method === 'bot_relay.deliver')
    expect(deliveries).toHaveLength(3)
    expect(deliveries.every(call => call.params.id === envelope.id)).toBe(true)
    expect(calls.find(call => call.method === 'bot_relay.reply')?.params).toEqual({id: envelope.id, reply: 'exact reply'})
    stopBotRelay()
  })

  it('posts a refused receipt back as the sender’s terminal answer, without an admission', async () => {
    // A same-id resend after the FIFO refused the delivery (nothing committed) answers the
    // declared refused result: terminal, so the refusal reaches the sender instead of staying retained.
    const calls = respondWith(call => {
      if (call.method === 'bot_relay.outbox.drain') {return { envelopes: call.connectionId === 'a' ? [envelope] : [] }}

      if (call.method === 'bot_relay.deliver') {
        return { status: 'failed', refused: true, delivery_id: envelope.id, error: 'Bot Chat delivery refused',
          reason: 'agent_blocked', reply: '' }
      }

      return {}
    })

    const { startBotRelay, stopBotRelay } = await loadRelay()
    startBotRelay()
    await pushAndSettle()
    expect(calls.find(call => call.method === 'bot_relay.reply')?.params).toEqual({
      id: envelope.id, error: 'Bot Chat delivery refused', reason: 'agent_blocked'
    })
    stopBotRelay()
  })

  it('retains an answer with neither an admission nor a refusal', async () => {
    const calls = respondWith(call => {
      if (call.method === 'bot_relay.outbox.drain') {return { envelopes: call.connectionId === 'a' ? [envelope] : [] }}

      if (call.method === 'bot_relay.deliver') {return { status: 'failed', delivery_id: envelope.id, error: 'lost' }}

      return {}
    })

    const { startBotRelay, stopBotRelay } = await loadRelay()
    startBotRelay()
    await pushAndSettle()
    expect(calls.filter(call => call.method === 'bot_relay.reply')).toHaveLength(0)
    stopBotRelay()
  })

  it('tells the target which connection the sender is on, so its author id names the machine', async () => {
    const calls = respondWith(call => {
      if (call.method === 'bot_relay.outbox.drain') {
        return {
          envelopes: call.connectionId === 'a' ? [{ ...envelope, from_handle: 'scout', from_profile: 'scout' }] : []
        }
      }

      return { reply: 'ok' }
    })

    const { startBotRelay, stopBotRelay } = await loadRelay()

    startBotRelay()
    await pushAndSettle()

    expect(calls.find(call => call.method === 'bot_relay.deliver')?.params).toMatchObject({
      from_connection: 'a',
      from_handle: 'scout',
      from_profile: 'scout'
    })

    stopBotRelay()
  })

  it('still posts a reply when the target connection is gone — the waiter must never dangle', async () => {
    const calls = respondWith(call =>
      call.method === 'bot_relay.outbox.drain'
        ? { envelopes: call.connectionId === 'a' ? [{ ...envelope, target_connection: 'ghost' }] : [] }
        : {}
    )

    const { startBotRelay, stopBotRelay } = await loadRelay()

    startBotRelay()
    await pushAndSettle()

    expect(calls.some(call => call.method === 'bot_relay.deliver')).toBe(false)
    expect(calls.find(call => call.method === 'bot_relay.reply')?.params.error).toMatch(
      /'ghost' is not connected to this Desktop right now/
    )

    stopBotRelay()
  })

  it('forwards the gateway’s typed failure reason to both the reply and the badge', async () => {
    // #93091: bot_relay.deliver classifies the failed turn and ships the code
    // in `data.reason`; a classified code beats re-parsing free text.
    const failure = Object.assign(new Error('401 invalid x-api-key'), {
      data: { reason: 'provider_auth_or_access' }
    })

    const calls = respondWith(call => {
      if (call.method === 'bot_relay.outbox.drain') {
        return { envelopes: call.connectionId === 'a' ? [envelope] : [] }
      }

      if (call.method === 'bot_relay.deliver') {
        throw failure
      }

      return {}
    })

    const { startBotRelay, stopBotRelay } = await loadRelay()

    startBotRelay()
    await pushAndSettle()

    expect(calls.find(call => call.method === 'bot_relay.reply')?.params).toMatchObject({
      error: '401 invalid x-api-key',
      id: 'env-1',
      reason: 'provider_auth_or_access'
    })
    expect(noteBotAttentionMock).toHaveBeenCalledWith('b::ops', 'provider_auth_or_access')

    stopBotRelay()
  })

  it('skips an older backend that rejects the drain RPC, and keeps going', async () => {
    const calls = respondWith(call => {
      if (call.method === 'bot_relay.outbox.drain') {
        if (call.connectionId === 'a') {
          throw new Error('unknown method')
        }

        return { envelopes: [] }
      }

      return {}
    })

    const { startBotRelay, stopBotRelay } = await loadRelay()

    startBotRelay()
    await pushAndSettle()

    expect(calls.filter(call => call.method === 'bot_relay.outbox.drain').map(call => call.connectionId)).toEqual([
      'a',
      'b'
    ])

    stopBotRelay()
  })
})

describe('stop halts both loops', () => {
  it('leaves no timer able to reach the gateway after teardown', async () => {
    const calls = respondWith(() => ({ envelopes: [] }))
    const { startBotRelay, stopBotRelay } = await loadRelay()

    startBotRelay()
    await vi.advanceTimersByTimeAsync(0)
    stopBotRelay()
    calls.length = 0

    await vi.advanceTimersByTimeAsync(5 * 60_000)

    expect(calls).toHaveLength(0)
  })

  it('does not leak a mid-drain rerun into the next start', async () => {
    let release!: () => void

    const held = new Promise<void>(resolve => {
      release = resolve
    })

    let drains = 0

    respondWith(async call => {
      if (call.method === 'bot_relay.outbox.drain') {
        drains += 1

        if (drains === 1) {
          await held
        }
      }

      return { envelopes: [] }
    })

    const { startBotRelay, stopBotRelay } = await loadRelay()

    startBotRelay()
    await pushAndSettle()
    await pushAndSettle()
    stopBotRelay()
    release()
    await vi.advanceTimersByTimeAsync(RELAY_PUSH_DEBOUNCE_MS + 10)

    const afterStop = drains

    startBotRelay()
    await vi.advanceTimersByTimeAsync(RELAY_PUSH_DEBOUNCE_MS + 10)

    expect(drains).toBe(afterStop)

    stopBotRelay()
  })
})

describe('the roster loop forgets a machine that left', () => {
  it('clears each remaining gateway’s remote roster once when the peer set drops below two', async () => {
    const calls = respondWith(call => {
      if (call.method === 'profiles.list') {
        return { profiles: [{ name: call.connectionId === 'a' ? 'default' : 'ops' }] }
      }

      return {}
    })

    const { startBotRelay, stopBotRelay } = await loadRelay()

    startBotRelay()
    await vi.advanceTimersByTimeAsync(0)
    expect(calls.filter(call => call.method === 'bot_relay.roster.sync')).toHaveLength(2)
    calls.length = 0

    // b leaves the registry. Without a push, a's gateway keeps ops in its
    // roster (and as a message_agent target) until a second peer shows up.
    hostMock.profileRoutes = vi.fn(async () => [route('a')])
    await vi.advanceTimersByTimeAsync(60_000)

    const syncs = calls.filter(call => call.method === 'bot_relay.roster.sync')
    expect(syncs).toEqual([expect.objectContaining({ connectionId: 'a', params: { agents: [], publisher: expect.any(String) } })])

    // Once, not on every tick.
    calls.length = 0
    await vi.advanceTimersByTimeAsync(60_000)
    expect(calls.filter(call => call.method === 'bot_relay.roster.sync')).toEqual([])

    // A returning peer starts the union pushes again.
    hostMock.profileRoutes = vi.fn(async () => [route('a'), route('b')])
    await vi.advanceTimersByTimeAsync(60_000)
    expect(calls.filter(call => call.method === 'bot_relay.roster.sync').map(call => call.connectionId)).toEqual([
      'a',
      'b'
    ])

    stopBotRelay()
  })

  it('retries the clear on the next tick when the push fails, instead of spending it', async () => {
    // The clear is one-shot per sole connection, so spending it before the push lands means a
    // failure is never retried: the surviving gateway keeps the departed machine's agents in every
    // bot's prompt, and as message_agent targets, for the life of the Desktop. requestProfile
    // throws on a socket that is not up yet, not only on a backend too old to have the RPC.
    let clearFails = true

    const calls = respondWith(call => {
      if (call.method === 'profiles.list') {
        return { profiles: [{ name: call.connectionId === 'a' ? 'default' : 'ops' }] }
      }

      if (call.method === 'bot_relay.roster.sync' && clearFails && !(call.params.agents as unknown[]).length) {
        throw new Error('Hermes gateway is not connected')
      }

      return {}
    })

    const { startBotRelay, stopBotRelay } = await loadRelay()

    startBotRelay()
    await vi.advanceTimersByTimeAsync(0)
    calls.length = 0
    hostMock.profileRoutes = vi.fn(async () => [route('a')])

    // b leaves; the clear is attempted and fails.
    await vi.advanceTimersByTimeAsync(60_000)
    expect(calls.filter(call => call.method === 'bot_relay.roster.sync')).toHaveLength(1)
    calls.length = 0

    // Next tick must try again rather than treat the roster as already forgotten.
    clearFails = false
    await vi.advanceTimersByTimeAsync(60_000)
    expect(calls.filter(call => call.method === 'bot_relay.roster.sync')).toEqual([
      expect.objectContaining({ connectionId: 'a', params: { agents: [], publisher: expect.any(String) } })
    ])

    // And once it lands it is spent, exactly as before.
    calls.length = 0
    await vi.advanceTimersByTimeAsync(60_000)
    expect(calls.filter(call => call.method === 'bot_relay.roster.sync')).toEqual([])

    stopBotRelay()
  })

  it('clears the roster of a sole connection that replaced the previous sole one', async () => {
    const calls = respondWith(call => {
      if (call.method === 'profiles.list') {
        return { profiles: [{ name: call.connectionId === 'a' ? 'default' : 'ops' }] }
      }

      return {}
    })

    const { startBotRelay, stopBotRelay } = await loadRelay()

    startBotRelay()
    await vi.advanceTimersByTimeAsync(0)
    hostMock.profileRoutes = vi.fn(async () => [route('a')])
    await vi.advanceTimersByTimeAsync(60_000)
    calls.length = 0

    // a is swapped for c between ticks — still one connection, but c's
    // gateway has never been told the roster is empty.
    hostMock.profileRoutes = vi.fn(async () => [route('c')])
    await vi.advanceTimersByTimeAsync(60_000)

    expect(calls.filter(call => call.method === 'bot_relay.roster.sync').map(call => call.connectionId)).toEqual(['c'])

    stopBotRelay()
  })
})

describe('the drain loop does not let one delivery hold every other gateway’s mail', () => {
  // A long turn on b (up to RELAY_DELIVER_TIMEOUT_MS) must not stop b's own
  // outbox from being claimed, nor a's delivery from running: the gateway
  // checks envelope age against bot_mode.envelope_ttl_seconds at the claim,
  // and the sender's waiter is finite.
  type RelayEnvelopeFixture = { id: string; message: string; target_connection: string; target_profile: string }
  const toB: RelayEnvelopeFixture = { id: 'env-1', message: 'long job', target_connection: 'b', target_profile: 'ops' }
  const toA: RelayEnvelopeFixture = { id: 'env-2', message: 'quick one', target_connection: 'a', target_profile: 'default' }
  // Canonical `bot_relay.deliver` answers carry the exact delivery identity;
  // a reply without it is retained for recovery, never ACKed to the sender.
  const settled = (id: string, reply: string) => ({ status: 'settled', delivery_id: id, admission_id: `adm-${id}`, reply })

  it('claims every outbox first and delivers to different targets concurrently', async () => {
    let releaseB!: (value: { reply: string }) => void

    const pendingB = new Promise<{ reply: string }>(resolve => {
      releaseB = resolve
    }).then(res => settled(toB.id, res.reply))

    const calls = respondWith(call => {
      if (call.method === 'bot_relay.outbox.drain') {
        return { envelopes: call.connectionId === 'a' ? [toB] : [toA] }
      }

      if (call.method === 'bot_relay.deliver') {
        return call.connectionId === 'b' ? pendingB : settled(toA.id, 'done')
      }

      return {}
    })

    const { startBotRelay, stopBotRelay } = await loadRelay()

    startBotRelay()
    await pushAndSettle()

    // b's turn is still running — yet b's outbox was claimed and its envelope delivered on a.
    expect(calls.filter(call => call.method === 'bot_relay.outbox.drain').map(call => call.connectionId)).toEqual([
      'a',
      'b'
    ])
    expect(calls.filter(call => call.method === 'bot_relay.deliver').map(call => call.connectionId)).toEqual(['b', 'a'])
    expect(calls.find(call => call.method === 'bot_relay.reply')).toMatchObject({
      connectionId: 'b',
      params: { id: 'env-2', reply: 'done' }
    })

    releaseB({ reply: 'finally' })
    await vi.advanceTimersByTimeAsync(10)

    expect(calls.filter(call => call.method === 'bot_relay.reply').map(call => call.params.id)).toEqual([
      'env-2',
      'env-1'
    ])

    stopBotRelay()
  })

  it('claims an envelope that lands DURING a long turn and delivers it now; the same target still queues behind', async () => {
    // Issue step 3: the push arrives while b's turn is running. The claim
    // must not wait for that turn (the TTL clock is running on the gateway),
    // a different target is delivered immediately, and a second envelope for
    // the SAME target profile waits for the running turn, in order.
    let releaseB!: (value: { reply: string }) => void

    const pendingB = new Promise<{ reply: string }>(resolve => {
      releaseB = resolve
    }).then(res => settled(toB.id, res.reply))

    const outbox: Record<string, RelayEnvelopeFixture[]> = { a: [toB], b: [] }

    const calls = respondWith(call => {
      if (call.method === 'bot_relay.outbox.drain') {
        return { envelopes: outbox[call.connectionId].splice(0) }
      }

      if (call.method === 'bot_relay.deliver') {
        return call.params.message === 'long job'
          ? pendingB
          : settled(String(call.params.id), `${call.params.message} done`)
      }

      return {}
    })

    const { startBotRelay, stopBotRelay } = await loadRelay()

    startBotRelay()
    await pushAndSettle()
    expect(calls.filter(call => call.method === 'bot_relay.deliver').map(call => call.params.message)).toEqual([
      'long job'
    ])

    // b's turn is running; gateway b now queues one envelope for a and one more for b/ops.
    outbox.b.push(toA, { ...toB, id: 'env-3', message: 'second' })
    await pushAndSettle()

    expect(calls.filter(call => call.method === 'bot_relay.outbox.drain' && call.connectionId === 'b')).toHaveLength(2)
    expect(calls.filter(call => call.method === 'bot_relay.deliver').map(call => call.params.message)).toEqual([
      'long job',
      'quick one'
    ])

    releaseB({ reply: 'long job done' })
    await vi.advanceTimersByTimeAsync(10)

    expect(calls.filter(call => call.method === 'bot_relay.deliver').map(call => call.params.message)).toEqual([
      'long job',
      'quick one',
      'second'
    ])
    expect(calls.filter(call => call.method === 'bot_relay.reply').map(call => call.params.id)).toEqual([
      'env-2',
      'env-1',
      'env-3'
    ])

    stopBotRelay()
  })
})

describe("the Desktop's own machine goes out under its install id, never the shared 'local' (#142128)", () => {
  // Every Desktop calls its own machine 'local'. A server holding two Desktops' pushes
  // resolved `default@local` against whichever roster landed last, and whichever Desktop
  // drained the envelope delivered it to ITS OWN default.
  const INSTALL = '0123456789abcdef0123456789abcdef'
  const OWN = 'local-0123456789ab'
  const envelope = { id: 'env-l', message: 'status?', target_connection: OWN, target_profile: 'ops' }

  beforeEach(() => {
    hostMock.profileRoutes = vi.fn(async () => [route('local', { mode: 'local' }), route('srv')])
  })

  function serve(options: { envelopes?: Record<string, unknown[]>; install?: () => string | undefined } = {}) {
    return respondWith(call => {
      if (call.method === 'profiles.list') {
        return call.connectionId === 'local'
          ? { install_id: options.install ? options.install() : INSTALL, profiles: [{ name: 'ops' }] }
          : { install_id: 'f'.repeat(32), profiles: [{ name: 'scout' }] }
      }

      if (call.method === 'bot_relay.outbox.drain') {
        return { envelopes: options.envelopes?.[call.connectionId] ?? [] }
      }

      if (call.method === 'bot_relay.deliver') {
        return { status: 'settled', delivery_id: call.params.id, admission_id: 'admission', reply: 'done' }
      }

      return {}
    })
  }

  it('stamps this machine’s rows with local-<install> in the roster another gateway gets', async () => {
    const calls = serve()
    const { startBotRelay, stopBotRelay } = await loadRelay()

    startBotRelay()
    await vi.advanceTimersByTimeAsync(0)

    const pushed = (id: string) =>
      calls.find(call => call.method === 'bot_relay.roster.sync' && call.connectionId === id)

    expect(pushed('srv')?.params.agents).toEqual([expect.objectContaining({ connection_id: OWN, profile: 'ops' })])
    // A remote connection keeps its registry id: the drain maps it to that socket.
    expect(pushed('local')?.params.agents).toEqual([
      expect.objectContaining({ connection_id: 'srv', profile: 'scout' })
    ])

    stopBotRelay()
  })

  it("keeps the legacy 'local' when the local gateway reports no install id", async () => {
    const calls = serve({ install: () => undefined })
    const { startBotRelay, stopBotRelay } = await loadRelay()

    startBotRelay()
    await vi.advanceTimersByTimeAsync(0)

    expect(
      calls.find(call => call.method === 'bot_relay.roster.sync' && call.connectionId === 'srv')?.params.agents
    ).toEqual([expect.objectContaining({ connection_id: 'local', profile: 'ops' })])

    stopBotRelay()
  })

  it('delivers its own local-<install> target on the local socket, and names a local sender the same way', async () => {
    const calls = serve({
      envelopes: {
        local: [
          { from_handle: 'ops', from_profile: 'ops', id: 'env-out', target_connection: 'srv', target_profile: 'scout' }
        ],
        srv: [envelope]
      }
    })

    const { startBotRelay, stopBotRelay } = await loadRelay()

    startBotRelay()
    await vi.advanceTimersByTimeAsync(0)
    await pushAndSettle()

    const deliveries = calls.filter(call => call.method === 'bot_relay.deliver')

    expect(deliveries.find(call => call.params.id === 'env-l')).toMatchObject({
      connectionId: 'local',
      params: { profile: 'ops' }
    })
    // The recipient stamps "Message from … (@ops@<this>)": it must be a form its roster resolves.
    expect(deliveries.find(call => call.params.id === 'env-out')).toMatchObject({
      connectionId: 'srv',
      params: { from_connection: OWN }
    })
    expect(calls.find(call => call.method === 'bot_relay.reply' && call.params.id === 'env-l')).toMatchObject({
      connectionId: 'srv',
      params: { reply: 'done' }
    })

    stopBotRelay()
  })

  it.each([
    ["another Desktop's local-<install>", 'local-ffffffffffff'],
    ["an older Desktop's bare 'local'", 'local']
  ])('leaves %s alone: no delivery to this machine, and no reply that would beat the owner’s', async (_label, id) => {
    const calls = serve({ envelopes: { srv: [{ ...envelope, id: 'env-x', target_connection: id }] } })
    const { startBotRelay, stopBotRelay } = await loadRelay()

    startBotRelay()
    await vi.advanceTimersByTimeAsync(0)
    await pushAndSettle()

    expect(calls.filter(call => call.method === 'bot_relay.deliver')).toEqual([])
    expect(calls.filter(call => call.method === 'bot_relay.reply')).toEqual([])

    stopBotRelay()
  })

  it('learns its own id in the drain when the roster loop has not heard it yet', async () => {
    let lists = 0

    const calls = serve({
      envelopes: { srv: [envelope] },
      install: () => {
        lists += 1

        // The roster loop's fetch blips; the drain's own lookup answers.
        if (lists === 1) {
          throw new Error('socket blip')
        }

        return INSTALL
      }
    })

    const { startBotRelay, stopBotRelay } = await loadRelay()

    startBotRelay()
    await vi.advanceTimersByTimeAsync(0)
    await pushAndSettle()

    expect(calls.find(call => call.method === 'bot_relay.deliver')).toMatchObject({
      connectionId: 'local',
      params: { id: 'env-l' }
    })

    stopBotRelay()
  })

  it('holds what depends on its own id while the local gateway has not answered, then delivers it', async () => {
    let localUp = false

    const calls = serve({
      envelopes: {
        local: [
          { from_handle: 'ops', from_profile: 'ops', id: 'env-out', target_connection: 'srv', target_profile: 'scout' }
        ],
        srv: [envelope, { ...envelope, id: 'env-bare', target_connection: 'local' }]
      },
      install: () => {
        if (!localUp) {
          throw new Error('local gateway not up yet')
        }

        return INSTALL
      }
    })

    const { startBotRelay, stopBotRelay } = await loadRelay()

    startBotRelay()
    await vi.advanceTimersByTimeAsync(0)
    await pushAndSettle()

    // Unknown identity: neither form is guessed, a local sender gets no ambiguous name, nothing replies.
    expect(calls.filter(call => call.method === 'bot_relay.deliver')).toEqual([])
    expect(calls.filter(call => call.method === 'bot_relay.reply')).toEqual([])

    // The local gateway answers; no new push arrives — the backstop drain retries what waited.
    localUp = true
    await vi.advanceTimersByTimeAsync(RELAY_DRAIN_INTERVAL_MS)

    const deliveries = calls.filter(call => call.method === 'bot_relay.deliver')

    expect(deliveries.find(call => call.params.id === 'env-l')?.connectionId).toBe('local')
    expect(deliveries.find(call => call.params.id === 'env-out')).toMatchObject({
      connectionId: 'srv',
      params: { from_connection: OWN }
    })
    // Now known: the bare 'local' is an older Desktop's machine, never this one.
    expect(deliveries.find(call => call.params.id === 'env-bare')).toBeUndefined()

    stopBotRelay()
  })

  it("still delivers a bare 'local' to a local gateway that reports no install id (legacy)", async () => {
    const calls = serve({
      envelopes: { srv: [{ ...envelope, id: 'env-bare', target_connection: 'local' }] },
      install: () => undefined
    })

    const { startBotRelay, stopBotRelay } = await loadRelay()

    startBotRelay()
    await vi.advanceTimersByTimeAsync(0)
    await pushAndSettle()

    expect(calls.find(call => call.method === 'bot_relay.deliver')?.connectionId).toBe('local')

    stopBotRelay()
  })

  it('leaves every local-machine target alone, and stops retrying, on a Desktop that does not relay its own machine', async () => {
    // E.g. a remote-primary Desktop: no local route, so no own id will ever be learned.
    hostMock.profileRoutes = vi.fn(async () => [route('srv'), route('nas')])

    const calls = serve({
      envelopes: { srv: [envelope, { ...envelope, id: 'env-bare', target_connection: 'local' }] }
    })

    const { startBotRelay, stopBotRelay } = await loadRelay()

    startBotRelay()
    await vi.advanceTimersByTimeAsync(0)
    await pushAndSettle()
    calls.length = 0
    await vi.advanceTimersByTimeAsync(RELAY_DRAIN_INTERVAL_MS * 2)

    expect(calls.filter(call => call.method !== 'profiles.list' && call.method !== 'bot_relay.roster.sync')).toEqual([])

    stopBotRelay()
  })

  it('waits for its own id without holding anyone else’s mail', async () => {
    hostMock.profileRoutes = vi.fn(async () => [route('local', { mode: 'local' }), route('srv'), route('nas')])

    let answer!: (value: unknown) => void
    let drained = false
    let lists = 0

    const calls = respondWith(call => {
      if (call.method === 'profiles.list') {
        if (call.connectionId !== 'local') {
          return { profiles: [{ name: 'scout' }] }
        }

        lists += 1

        // The roster loop's read fails; the drain's own lookup stalls until released.
        if (lists === 1) {
          throw new Error('local gateway not up yet')
        }

        return new Promise(resolve => {
          answer = resolve
        })
      }

      if (call.method === 'bot_relay.outbox.drain') {
        const first = call.connectionId === 'srv' && !drained

        drained ||= first

        return {
          envelopes: first
            ? [envelope, { ...envelope, id: 'env-nas', target_connection: 'nas', target_profile: 'scout' }]
            : []
        }
      }

      if (call.method === 'bot_relay.deliver') {
        return { status: 'settled', delivery_id: call.params.id, admission_id: 'admission', reply: 'done' }
      }

      return {}
    })

    const { startBotRelay, stopBotRelay } = await loadRelay()

    startBotRelay()
    await vi.advanceTimersByTimeAsync(0)
    await pushAndSettle()

    const delivered = () => calls.filter(call => call.method === 'bot_relay.deliver').map(call => call.params.id)

    expect(delivered()).toEqual(['env-nas'])

    // The id arrives: the held envelope goes out now, not at the 30s backstop.
    answer({ install_id: INSTALL, profiles: [{ name: 'ops' }] })
    await vi.advanceTimersByTimeAsync(RELAY_PUSH_DEBOUNCE_MS + 10)

    expect(delivered()).toEqual(['env-nas', 'env-l'])
    expect(calls.find(call => call.params.id === 'env-l' && call.method === 'bot_relay.deliver')?.connectionId).toBe(
      'local'
    )

    stopBotRelay()
  })

  it('never relays a registry connection whose id falls in the local-<hex> namespace', async () => {
    // Its label slugged into the name every Desktop gives its own machine: on this Desktop it
    // would shadow this machine, on another it would capture that Desktop's machine.
    hostMock.profileRoutes = vi.fn(async () => [
      route('local', { mode: 'local' }),
      route('srv'),
      route(OWN),
      route('local-aaaaaaaaaaaa')
    ])

    const calls = serve({
      envelopes: {
        [OWN]: [{ ...envelope, id: 'env-shadow', target_connection: 'srv', target_profile: 'scout' }],
        srv: [envelope, { ...envelope, id: 'env-other', target_connection: 'local-aaaaaaaaaaaa' }]
      }
    })

    const { startBotRelay, stopBotRelay } = await loadRelay()

    startBotRelay()
    await vi.advanceTimersByTimeAsync(0)
    await pushAndSettle()

    const reserved = new Set([OWN, 'local-aaaaaaaaaaaa'])

    expect(calls.filter(call => reserved.has(call.connectionId))).toEqual([])
    expect(
      calls.filter(call => call.method === 'bot_relay.deliver').map(call => [call.params.id, call.connectionId])
    ).toEqual([['env-l', 'local']])
    expect(calls.filter(call => call.method === 'bot_relay.reply').map(call => call.params.id)).toEqual(['env-l'])

    stopBotRelay()
  })

  it('leaves its own id to whoever relays this machine once its local route drops out', async () => {
    const calls = serve({ envelopes: { srv: [] } })
    const { startBotRelay, stopBotRelay } = await loadRelay()

    startBotRelay()
    await vi.advanceTimersByTimeAsync(0)

    // Identity learned; then the Desktop switches to a remote primary and stops relaying 'local'.
    hostMock.profileRoutes = vi.fn(async () => [route('srv'), route('nas')])
    calls.length = 0
    ;(hostMock.requestProfile as ReturnType<typeof vi.fn>).mockImplementation(
      async (target: ProfileRoute, method: string) => {
        calls.push({ connectionId: target.connectionId, method, params: {}, route: target })

        return method === 'bot_relay.outbox.drain' && target.connectionId === 'srv' ? { envelopes: [envelope] } : {}
      }
    )
    await pushAndSettle()

    expect(calls.filter(call => call.method === 'bot_relay.deliver' || call.method === 'bot_relay.reply')).toEqual([])

    stopBotRelay()
  })
})

describe('each Desktop pushes its roster as its own slice (#139219)', () => {
  // Two Desktops relaying for one gateway used to overwrite each other's whole roster every
  // push, so a bare name resolved to whichever machine pushed last. Each push now names its
  // publisher and the gateway replaces only that Desktop's slice.
  const INSTALL = '0123456789abcdef0123456789abcdef'

  beforeEach(() => {
    hostMock.profileRoutes = vi.fn(async () => [route('local', { mode: 'local' }), route('srv')])
  })

  function serve(options: { install?: string; strictSync?: boolean } = {}) {
    return respondWith(call => {
      if (call.method === 'profiles.list') {
        return call.connectionId === 'local'
          ? { install_id: options.install, profiles: [{ name: 'ops' }] }
          : { install_id: 'f'.repeat(32), profiles: [{ name: 'scout' }] }
      }

      if (call.method === 'bot_relay.roster.sync' && options.strictSync && 'publisher' in call.params) {
        throw Object.assign(new Error('invalid_params'), { data: { fields: ['publisher'], reason: 'invalid_params' } })
      }

      return {}
    })
  }

  const syncs = (calls: RelayCall[]) => calls.filter(call => call.method === 'bot_relay.roster.sync')

  it('names this machine’s relay id as the publisher of every push', async () => {
    const calls = serve({ install: INSTALL })
    const { startBotRelay, stopBotRelay } = await loadRelay()

    startBotRelay()
    await vi.advanceTimersByTimeAsync(0)

    expect(syncs(calls).map(call => [call.connectionId, call.params.publisher])).toEqual([
      ['local', 'local-0123456789ab'],
      ['srv', 'local-0123456789ab']
    ])

    // the sole-connection clear empties only this Desktop's slice
    hostMock.profileRoutes = vi.fn(async () => [route('srv')])
    await vi.advanceTimersByTimeAsync(60_000)

    expect(syncs(calls).slice(2)).toEqual([
      expect.objectContaining({ connectionId: 'srv', params: { agents: [], publisher: 'local-0123456789ab' } })
    ])

    stopBotRelay()
  })

  it('keeps one stable stand-in publisher while its machine id is unknown', async () => {
    const calls = serve()
    const { startBotRelay, stopBotRelay } = await loadRelay()

    startBotRelay()
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(60_000)

    const publishers = new Set(syncs(calls).map(call => call.params.publisher))

    expect(syncs(calls).length).toBeGreaterThanOrEqual(4)
    expect([...publishers]).toEqual([expect.stringMatching(/^desktop-[0-9a-f]{12}$/)])

    stopBotRelay()
  })

  it('pushes the legacy way to a gateway whose strict door predates the publisher', async () => {
    const calls = serve({ install: INSTALL, strictSync: true })
    const { startBotRelay, stopBotRelay } = await loadRelay()

    startBotRelay()
    await vi.advanceTimersByTimeAsync(0)

    const pushedTo = (id: string) => syncs(calls).filter(call => call.connectionId === id).map(call => call.params)

    expect(pushedTo('srv')).toEqual([
      { agents: [expect.objectContaining({ profile: 'ops' })], publisher: 'local-0123456789ab' },
      { agents: [expect.objectContaining({ profile: 'ops' })] }
    ])

    stopBotRelay()
  })
})
