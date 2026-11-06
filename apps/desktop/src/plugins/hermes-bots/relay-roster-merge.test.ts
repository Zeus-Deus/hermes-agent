/**
 * The relay's roster as one slice per publishing window (#139219), and the drain leaving an
 * envelope to the Desktop that relays its target. Two Desktops (or two windows of one) relaying
 * for one gateway used to replace each other's whole roster every push, so a bare name resolved
 * to whichever pushed last. Same harness as relay.test.ts: only the SDK `host` is mocked.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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
describe('each Desktop pushes its roster as its own slice (#139219)', () => {
  // Two Desktops relaying for one gateway used to overwrite each other's whole roster every
  // push, so a bare name resolved to whichever machine pushed last. Each push now names its
  // publisher and the gateway replaces only that Desktop's slice.
  const INSTALL = '0123456789abcdef0123456789abcdef'

  beforeEach(() => {
    hostMock.profileRoutes = vi.fn(async () => [route('local', { mode: 'local' }), route('srv')])
  })

  // What an older gateway's strict door answers for the unknown key: the canonical door a typed
  // invalid_params, the tui_gateway door a bare 4000 naming the field.
  const REFUSALS = {
    canonical: () => Object.assign(new Error('invalid_params'), { code: 4001, data: { fields: ['publisher'], reason: 'invalid_params' } }),
    tui: () =>
      Object.assign(new Error('invalid params for bot_relay.roster.sync: publisher: Extra inputs are not permitted'), {
        code: 4000
      })
  }

  function serve(options: { install?: string; strictSync?: keyof typeof REFUSALS } = {}) {
    return respondWith(call => {
      if (call.method === 'profiles.list') {
        return call.connectionId === 'local'
          ? { install_id: options.install, profiles: [{ name: 'ops' }] }
          : { install_id: 'f'.repeat(32), profiles: [{ name: 'scout' }] }
      }

      if (call.method === 'bot_relay.roster.sync' && options.strictSync && 'publisher' in call.params) {
        throw REFUSALS[options.strictSync]()
      }

      return {}
    })
  }

  const syncs = (calls: RelayCall[]) => calls.filter(call => call.method === 'bot_relay.roster.sync')

  const PUBLISHER = 'desktop-0123456789ab'

  beforeEach(() => {
    window.sessionStorage.setItem('hermes.botRelay.publisher', PUBLISHER)
  })

  afterEach(() => {
    window.sessionStorage.removeItem('hermes.botRelay.publisher')
  })

  it('names this window’s publisher id on every push, the sole-connection clear included', async () => {
    const calls = serve({ install: INSTALL })
    const { startBotRelay, stopBotRelay } = await loadRelay()

    startBotRelay()
    await vi.advanceTimersByTimeAsync(0)

    expect(syncs(calls).map(call => [call.connectionId, call.params.publisher])).toEqual([
      ['local', PUBLISHER],
      ['srv', PUBLISHER]
    ])

    // the sole-connection clear empties only this window's slice
    hostMock.profileRoutes = vi.fn(async () => [route('srv')])
    await vi.advanceTimersByTimeAsync(60_000)

    expect(syncs(calls).slice(2)).toEqual([
      expect.objectContaining({ connectionId: 'srv', params: { agents: [], publisher: PUBLISHER } })
    ])

    stopBotRelay()
  })

  it('keeps its id across a reload, and another window of the same install gets its own', async () => {
    // Two windows of one Desktop run separate relays with separate reads: under one publisher
    // key, a window whose fetch blipped would replace the healthy window's slice.
    window.sessionStorage.removeItem('hermes.botRelay.publisher')

    const publisherOf = async () => {
      const calls = serve({ install: INSTALL })
      const { startBotRelay, stopBotRelay } = await loadRelay()

      startBotRelay()
      await vi.advanceTimersByTimeAsync(0)
      stopBotRelay()

      return [...new Set(syncs(calls).map(call => call.params.publisher))]
    }

    const first = await publisherOf()

    expect(first).toEqual([expect.stringMatching(/^desktop-[0-9a-f]{12}$/)])
    expect(await publisherOf()).toEqual(first) // reload: same window storage

    window.sessionStorage.removeItem('hermes.botRelay.publisher') // another window
    const other = await publisherOf()

    expect(other).toEqual([expect.stringMatching(/^desktop-[0-9a-f]{12}$/)])
    expect(other).not.toEqual(first)
  })

  it.each(['canonical', 'tui'] as const)(
    'pushes the legacy way to a gateway whose %s door predates the publisher, clears included',
    async door => {
      const calls = serve({ install: INSTALL, strictSync: door })
      const { startBotRelay, stopBotRelay } = await loadRelay()

      startBotRelay()
      await vi.advanceTimersByTimeAsync(0)

      const pushedTo = (id: string) => syncs(calls).filter(call => call.connectionId === id).map(call => call.params)

      expect(pushedTo('srv')).toEqual([
        { agents: [expect.objectContaining({ profile: 'ops' })], publisher: PUBLISHER },
        { agents: [expect.objectContaining({ profile: 'ops' })] }
      ])

      hostMock.profileRoutes = vi.fn(async () => [route('srv')])
      await vi.advanceTimersByTimeAsync(60_000)
      await vi.advanceTimersByTimeAsync(60_000)

      // the clear lands (legacy form) and is spent: no third attempt on the next tick
      expect(pushedTo('srv').slice(2)).toEqual([{ agents: [], publisher: PUBLISHER }, { agents: [] }])

      stopBotRelay()
    }
  )

  it.each([undefined, 'canonical', 'tui'] as const)(
    'drains as this window (gateway door predating it: %s), so the gateway offers only its mail',
    async door => {
      const envelope = { from_handle: 'ops', from_profile: 'ops', id: 'env-d', message: 'hi', target_connection: 'srv', target_profile: 'scout' }

      const calls = respondWith(call => {
        if (call.method === 'profiles.list') {
          return call.connectionId === 'local'
            ? { install_id: INSTALL, profiles: [{ name: 'ops' }] }
            : { install_id: 'f'.repeat(32), profiles: [{ name: 'scout' }] }
        }

        if (call.method === 'bot_relay.outbox.drain') {
          if (door && 'publisher' in call.params) {
            throw REFUSALS[door]()
          }

          return { envelopes: call.connectionId === 'local' ? [envelope] : [] }
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
      stopBotRelay()

      const drains = calls.filter(call => call.method === 'bot_relay.outbox.drain' && call.connectionId === 'local')

      expect(drains.map(call => call.params)).toEqual(door ? [{ publisher: PUBLISHER }, {}] : [{ publisher: PUBLISHER }])
      expect(calls.filter(call => call.method === 'bot_relay.deliver').map(call => call.connectionId)).toEqual(['srv'])
    }
  )

  it('drains a gateway again once this window’s slice lands there, if a drain ran before it', async () => {
    // A restarted window has a new publisher id. Mail signalled before its first slice reaches
    // the sender's gateway is withheld (the gateway offers it to the Desktops relaying its
    // machine) and that drain spent the work signal; the gateway does not signal again.
    let publishSlice: () => void = () => {}
    let published = false

    const calls = respondWith(call => {
      if (call.method === 'profiles.list') {
        return call.connectionId === 'local'
          ? { install_id: INSTALL, profiles: [{ name: 'ops' }] }
          : { install_id: 'f'.repeat(32), profiles: [{ name: 'scout' }] }
      }

      if (call.method === 'bot_relay.roster.sync' && call.connectionId === 'local') {
        return new Promise(resolve => {
          publishSlice = () => {
            published = true
            resolve({ count: 1 })
          }
        })
      }

      if (call.method === 'bot_relay.outbox.drain') {
        // What the gateway hands this window once its slice lists the target machine.
        const envelope = {
          canonical_delivery_v1: true, from_handle: 'ops', from_profile: 'ops', id: 'env-r', message: 'hi',
          target_connection: 'srv', target_profile: 'scout', target_publishers: ['desktop-aaaaaaaaaaaa', PUBLISHER]
        }

        return { envelopes: call.connectionId === 'local' && published ? [envelope] : [] }
      }

      if (call.method === 'bot_relay.deliver') {
        return { status: 'settled', delivery_id: call.params.id, admission_id: 'admission', reply: 'done' }
      }

      return {}
    })

    const { startBotRelay, stopBotRelay } = await loadRelay()
    const drainsOfLocal = () => calls.filter(call => call.method === 'bot_relay.outbox.drain' && call.connectionId === 'local')

    startBotRelay()
    await vi.advanceTimersByTimeAsync(0)
    await pushAndSettle(1, { connectionId: 'local' })

    expect(drainsOfLocal()).toHaveLength(1)

    publishSlice()
    await vi.advanceTimersByTimeAsync(RELAY_PUSH_DEBOUNCE_MS + 10)

    expect(drainsOfLocal()).toHaveLength(2)
    expect(calls.filter(call => call.method === 'bot_relay.deliver').map(call => call.connectionId)).toEqual(['srv'])

    // the next tick pushes the same slice: no further drain without new work
    await vi.advanceTimersByTimeAsync(60_000)
    publishSlice()
    await vi.advanceTimersByTimeAsync(RELAY_PUSH_DEBOUNCE_MS + 10)

    expect(drainsOfLocal()).toHaveLength(2)

    stopBotRelay()
  })

  it('a slice that lands while a drain is out still drains that gateway again', async () => {
    // The gateway answered the drain from the slices it held when it read the outbox; this
    // window's slice landed after that read but before the empty answer came back.
    let publishSlice: () => void = () => {}

    let answerFirstDrain: () => void = () => {}
    let published = false
    let localDrains = 0

    const envelope = {
      canonical_delivery_v1: true,
      from_handle: 'ops',
      from_profile: 'ops',
      id: 'env-o2',
      message: 'hi',
      target_connection: 'srv',
      target_profile: 'scout',
      target_publishers: ['desktop-aaaaaaaaaaaa', PUBLISHER]
    }

    const calls = respondWith(call => {
      if (call.method === 'profiles.list') {
        return call.connectionId === 'local'
          ? { install_id: INSTALL, profiles: [{ name: 'ops' }] }
          : { install_id: 'f'.repeat(32), profiles: [{ name: 'scout' }] }
      }

      if (call.method === 'bot_relay.roster.sync' && call.connectionId === 'local') {
        return new Promise(resolve => {
          publishSlice = () => {
            published = true
            resolve({ count: 1 })
          }
        })
      }

      if (call.method === 'bot_relay.outbox.drain' && call.connectionId === 'local') {
        localDrains += 1

        if (localDrains === 1) {
          return new Promise(resolve => {
            answerFirstDrain = () => resolve({ envelopes: [] })
          })
        }

        return { envelopes: published ? [envelope] : [] }
      }

      if (call.method === 'bot_relay.deliver') {
        return { status: 'settled', delivery_id: call.params.id, admission_id: 'admission', reply: 'done' }
      }

      return { envelopes: [] }
    })

    const { startBotRelay, stopBotRelay } = await loadRelay()

    startBotRelay()
    await vi.advanceTimersByTimeAsync(0)
    await pushAndSettle(1, { connectionId: 'local' }) // the drain is out
    publishSlice()
    await vi.advanceTimersByTimeAsync(0)
    answerFirstDrain() // empty: read before the slice landed
    await vi.advanceTimersByTimeAsync(RELAY_PUSH_DEBOUNCE_MS + 10)
    await vi.advanceTimersByTimeAsync(RELAY_PUSH_DEBOUNCE_MS + 10)
    stopBotRelay()

    expect(localDrains).toBe(2)
    expect(calls.filter(call => call.method === 'bot_relay.deliver').map(call => call.connectionId)).toEqual(['srv'])
  })

  it('a sole-connection clear counts as a slice change: republishing the rows drains again', async () => {
    // Rows R pushed, then the peer leaves and the window clears its slice; the peer comes back,
    // a signal drains while the gateway still holds the cleared slice, and the next tick pushes
    // R again — the same rows as before the clear, but a change on the gateway.
    let localSlice: unknown[] = []

    const envelope = {
      canonical_delivery_v1: true,
      from_handle: 'ops',
      from_profile: 'ops',
      id: 'env-c',
      message: 'hi',
      target_connection: 'srv',
      target_profile: 'scout',
      target_publishers: ['desktop-aaaaaaaaaaaa', PUBLISHER]
    }

    const calls = respondWith(call => {
      if (call.method === 'profiles.list') {
        return call.connectionId === 'local'
          ? { install_id: INSTALL, profiles: [{ name: 'ops' }] }
          : { install_id: 'f'.repeat(32), profiles: [{ name: 'scout' }] }
      }

      if (call.method === 'bot_relay.roster.sync' && call.connectionId === 'local') {
        localSlice = call.params.agents as unknown[]

        return { count: localSlice.length }
      }

      if (call.method === 'bot_relay.outbox.drain' && call.connectionId === 'local') {
        return { envelopes: localSlice.length ? [envelope] : [] }
      }

      if (call.method === 'bot_relay.deliver') {
        return { status: 'settled', delivery_id: call.params.id, admission_id: 'admission', reply: 'done' }
      }

      return { envelopes: [] }
    })

    const { startBotRelay, stopBotRelay } = await loadRelay()

    startBotRelay()
    await vi.advanceTimersByTimeAsync(0)
    expect(localSlice).toHaveLength(1)

    hostMock.profileRoutes = vi.fn(async () => [route('local', { mode: 'local' })])
    await vi.advanceTimersByTimeAsync(60_000)
    expect(localSlice).toEqual([])

    hostMock.profileRoutes = vi.fn(async () => [route('local', { mode: 'local' }), route('srv')])
    await pushAndSettle(1, { connectionId: 'local' }) // the gateway still holds the cleared slice

    expect(calls.filter(call => call.method === 'bot_relay.deliver')).toEqual([])

    await vi.advanceTimersByTimeAsync(60_000) // R again
    await vi.advanceTimersByTimeAsync(RELAY_PUSH_DEBOUNCE_MS + 10)
    stopBotRelay()

    expect(localSlice).toHaveLength(1)
    expect(calls.filter(call => call.method === 'bot_relay.deliver').map(call => call.connectionId)).toEqual(['srv'])
  })

  it('after a failed push, the next push of the same rows counts as a change', async () => {
    // Pushes that fail let this window's slice age out on the gateway (here: at once); a drain
    // meanwhile gets nothing, and the push that lands again must drain it again.
    let localSlice: unknown[] = []
    let failPush = false

    const envelope = {
      canonical_delivery_v1: true,
      from_handle: 'ops',
      from_profile: 'ops',
      id: 'env-f',
      message: 'hi',
      target_connection: 'srv',
      target_profile: 'scout',
      target_publishers: ['desktop-aaaaaaaaaaaa', PUBLISHER]
    }

    const calls = respondWith(call => {
      if (call.method === 'profiles.list') {
        return call.connectionId === 'local'
          ? { install_id: INSTALL, profiles: [{ name: 'ops' }] }
          : { install_id: 'f'.repeat(32), profiles: [{ name: 'scout' }] }
      }

      if (call.method === 'bot_relay.roster.sync' && call.connectionId === 'local') {
        if (failPush) {
          localSlice = []

          throw new Error('socket closed')
        }

        localSlice = call.params.agents as unknown[]

        return { count: localSlice.length }
      }

      if (call.method === 'bot_relay.outbox.drain' && call.connectionId === 'local') {
        return { envelopes: localSlice.length ? [envelope] : [] }
      }

      if (call.method === 'bot_relay.deliver') {
        return { status: 'settled', delivery_id: call.params.id, admission_id: 'admission', reply: 'done' }
      }

      return { envelopes: [] }
    })

    const { startBotRelay, stopBotRelay } = await loadRelay()

    startBotRelay()
    await vi.advanceTimersByTimeAsync(0)
    failPush = true
    await vi.advanceTimersByTimeAsync(60_000)
    await pushAndSettle(1, { connectionId: 'local' })

    expect(calls.filter(call => call.method === 'bot_relay.deliver')).toEqual([])

    failPush = false
    await vi.advanceTimersByTimeAsync(60_000)
    await vi.advanceTimersByTimeAsync(RELAY_PUSH_DEBOUNCE_MS + 10)
    stopBotRelay()

    expect(calls.filter(call => call.method === 'bot_relay.deliver').map(call => call.connectionId)).toEqual(['srv'])
  })

  describe('an envelope only another Desktop relays is left to it', () => {
    function drainOne(envelope: Record<string, unknown>) {
      return respondWith(call => {
        if (call.method === 'profiles.list') {
          return call.connectionId === 'local'
            ? { install_id: INSTALL, profiles: [{ name: 'ops' }] }
            : { install_id: 'f'.repeat(32), profiles: [{ name: 'scout' }] }
        }

        if (call.method === 'bot_relay.outbox.drain') {
          return { envelopes: call.connectionId === 'local' ? [envelope] : [] }
        }

        if (call.method === 'bot_relay.deliver') {
          return { status: 'settled', delivery_id: call.params.id, admission_id: 'admission', reply: 'done' }
        }

        return {}
      })
    }

    const base = { from_handle: 'ops', from_profile: 'ops', id: 'env-o', message: 'hi', target_profile: 'scout' }

    async function run(envelope: Record<string, unknown>) {
      const calls = drainOne(envelope)
      const { startBotRelay, stopBotRelay } = await loadRelay()

      startBotRelay()
      await vi.advanceTimersByTimeAsync(0)
      await pushAndSettle()
      stopBotRelay()

      return calls.filter(call => call.method === 'bot_relay.deliver' || call.method === 'bot_relay.reply')
    }

    it('a connection this Desktop lacks, listed only by another Desktop: no "not connected" reply', async () => {
      expect(await run({ ...base, target_connection: 'nas', target_publishers: ['desktop-bbbbbbbbbbbb'] })).toEqual([])
    })

    it('a connection this Desktop lacks but only its own roster listed: answers as before', async () => {
      const out = await run({ ...base, target_connection: 'nas', target_publishers: [PUBLISHER] })

      expect(out).toEqual([
        expect.objectContaining({ method: 'bot_relay.reply', params: expect.objectContaining({ error: expect.stringMatching(/'nas' is not connected/) }) })
      ])
    })

    it('a connection this Desktop dropped while another listed Desktop still relays it: no reply', async () => {
      expect(
        await run({ ...base, target_connection: 'nas', target_publishers: [PUBLISHER, 'desktop-bbbbbbbbbbbb'] })
      ).toEqual([])
    })

    it('checks the install the connection answers from at delivery, not the one the roster saw', async () => {
      let srvInstall = 'f'.repeat(32)

      const calls = respondWith(call => {
        if (call.method === 'profiles.list') {
          return call.connectionId === 'local'
            ? { install_id: INSTALL, profiles: [{ name: 'ops' }] }
            : { install_id: srvInstall, profiles: [{ name: 'scout' }] }
        }

        if (call.method === 'bot_relay.outbox.drain') {
          return { envelopes: call.connectionId === 'local' ? [{ ...base, target_connection: 'srv', target_install: 'f'.repeat(32) }] : [] }
        }

        return {}
      })

      const { startBotRelay, stopBotRelay } = await loadRelay()

      startBotRelay()
      await vi.advanceTimersByTimeAsync(0)
      srvInstall = 'e'.repeat(32) // 'srv' repointed at another machine since the roster fetch
      await pushAndSettle()
      stopBotRelay()

      expect(calls.filter(call => call.method === 'bot_relay.deliver' || call.method === 'bot_relay.reply')).toEqual([])
    })

    it('an envelope naming an install waits when the connection cannot be asked, then delivers', async () => {
      let srvDown = false

      const calls = respondWith(call => {
        if (call.method === 'profiles.list') {
          if (call.connectionId === 'srv' && srvDown) {
            throw new Error('socket closed')
          }

          return call.connectionId === 'local'
            ? { install_id: INSTALL, profiles: [{ name: 'ops' }] }
            : { install_id: 'e'.repeat(32), profiles: [{ name: 'scout' }] }
        }

        if (call.method === 'bot_relay.outbox.drain') {
          return { envelopes: call.connectionId === 'local' ? [{ ...base, target_connection: 'srv', target_install: 'e'.repeat(32) }] : [] }
        }

        if (call.method === 'bot_relay.deliver') {
          return { status: 'settled', delivery_id: call.params.id, admission_id: 'admission', reply: 'done' }
        }

        return {}
      })

      const { startBotRelay, stopBotRelay } = await loadRelay()
      const acted = () => calls.filter(call => call.method === 'bot_relay.deliver' || call.method === 'bot_relay.reply')

      startBotRelay()
      await vi.advanceTimersByTimeAsync(0)
      srvDown = true
      await pushAndSettle()

      expect(acted()).toEqual([]) // not delivered on a guess, not answered either

      srvDown = false
      await pushAndSettle()

      expect(acted().map(call => [call.method, call.connectionId])).toEqual([
        ['bot_relay.deliver', 'srv'],
        ['bot_relay.reply', 'local']
      ])

      stopBotRelay()
    })

    it('checks the install on the delivery route itself, pinned through the delivery', async () => {
      const pins: { released: boolean; route: ProfileRoute }[] = []

      ;(hostMock.retainProfileSocket as ReturnType<typeof vi.fn>).mockImplementation((pinned: ProfileRoute) => {
        const pin = { released: false, route: structuredClone(pinned) }

        pins.push(pin)

        return () => {
          pin.released = true
        }
      })

      const calls = drainOne({ ...base, target_connection: 'srv', target_install: 'f'.repeat(32) })
      const { startBotRelay, stopBotRelay } = await loadRelay()

      startBotRelay()
      await vi.advanceTimersByTimeAsync(0)
      const before = calls.length
      await pushAndSettle()

      const deliveryRoute = { ...route('srv'), profile: 'scout', targetProfile: 'scout' }
      const after = calls.slice(before).filter(call => call.connectionId === 'srv' && call.method !== 'bot_relay.outbox.drain')

      expect(after.map(call => [call.method, call.route])).toEqual([
        ['profiles.list', deliveryRoute],
        ['bot_relay.deliver', deliveryRoute]
      ])
      expect(pins.filter(pin => pin.route.profile === 'scout')).toEqual([{ released: true, route: deliveryRoute }])

      stopBotRelay()
    })

    it('an envelope left to another install is re-checked by the backstop drain, no new event needed', async () => {
      let srvInstall = 'e'.repeat(32)

      const calls = respondWith(call => {
        if (call.method === 'profiles.list') {
          return call.connectionId === 'local'
            ? { install_id: INSTALL, profiles: [{ name: 'ops' }] }
            : { install_id: srvInstall, profiles: [{ name: 'scout' }] }
        }

        if (call.method === 'bot_relay.outbox.drain') {
          return { envelopes: call.connectionId === 'local' ? [{ ...base, target_connection: 'srv', target_install: 'f'.repeat(32) }] : [] }
        }

        if (call.method === 'bot_relay.deliver') {
          return { status: 'settled', delivery_id: call.params.id, admission_id: 'admission', reply: 'done' }
        }

        return {}
      })

      const { startBotRelay, stopBotRelay } = await loadRelay()
      const delivered = () => calls.filter(call => call.method === 'bot_relay.deliver')

      startBotRelay()
      await vi.advanceTimersByTimeAsync(0)
      await pushAndSettle()

      expect(delivered()).toEqual([])

      srvInstall = 'f'.repeat(32) // the connection is pointed back at the target's machine
      await vi.advanceTimersByTimeAsync(30_000)

      expect(delivered().map(call => call.connectionId)).toEqual(['srv'])

      stopBotRelay()
    })

    it('a connection of the name, no install to check, listed only for another Desktop: left to it', async () => {
      expect(await run({ ...base, target_connection: 'srv', target_publishers: ['desktop-bbbbbbbbbbbb'] })).toEqual([])
      expect(
        (await run({ ...base, target_connection: 'srv', target_publishers: [PUBLISHER, 'desktop-bbbbbbbbbbbb'] })).map(
          call => call.method
        )
      ).toEqual(['bot_relay.deliver', 'bot_relay.reply'])
    })

    it('a deferred envelope the gateway stopped offering (answered or timed out) is never delivered later', async () => {
      let srvInstall = 'e'.repeat(32)
      let offered = true

      const calls = respondWith(call => {
        if (call.method === 'profiles.list') {
          return call.connectionId === 'local'
            ? { install_id: INSTALL, profiles: [{ name: 'ops' }] }
            : { install_id: srvInstall, profiles: [{ name: 'scout' }] }
        }

        if (call.method === 'bot_relay.outbox.drain') {
          return {
            envelopes:
              call.connectionId === 'local' && offered
                ? [{ ...base, canonical_delivery_v1: true, target_connection: 'srv', target_install: 'f'.repeat(32) }]
                : []
          }
        }

        return {}
      })

      const { startBotRelay, stopBotRelay } = await loadRelay()

      startBotRelay()
      await vi.advanceTimersByTimeAsync(0)
      await pushAndSettle() // deferred: 'srv' answers from another install
      offered = false // the gateway timed it out
      await vi.advanceTimersByTimeAsync(30_000)
      srvInstall = 'f'.repeat(32)
      await vi.advanceTimersByTimeAsync(60_000)
      stopBotRelay()

      expect(calls.filter(call => call.method === 'bot_relay.deliver')).toEqual([])
    })

    it('an envelope the gateway stops offering while its install check runs is not delivered', async () => {
      let offered = true

      let answerCheck: (value: unknown) => void = () => {}

      const calls = respondWith(call => {
        if (call.method === 'profiles.list') {
          if (call.connectionId === 'srv' && call.route.profile === 'scout') {
            return new Promise(resolve => {
              answerCheck = resolve
            })
          }

          return call.connectionId === 'local'
            ? { install_id: INSTALL, profiles: [{ name: 'ops' }] }
            : { install_id: 'f'.repeat(32), profiles: [{ name: 'scout' }] }
        }

        if (call.method === 'bot_relay.outbox.drain') {
          return {
            envelopes:
              call.connectionId === 'local' && offered
                ? [{ ...base, canonical_delivery_v1: true, target_connection: 'srv', target_install: 'f'.repeat(32) }]
                : []
          }
        }

        return {}
      })

      const { startBotRelay, stopBotRelay } = await loadRelay()

      startBotRelay()
      await vi.advanceTimersByTimeAsync(0)
      await pushAndSettle() // the install check is now waiting on 'srv'
      offered = false // answered elsewhere / timed out meanwhile
      await pushAndSettle()
      answerCheck({ install_id: 'f'.repeat(32), profiles: [{ name: 'scout' }] })
      await vi.advanceTimersByTimeAsync(0)
      stopBotRelay()

      expect(calls.filter(call => call.method === 'bot_relay.deliver')).toEqual([])
    })

    describe('a relay lifecycle change while the install check runs stops that delivery', () => {
      const envelope = { ...base, canonical_delivery_v1: true, target_connection: 'srv', target_install: 'f'.repeat(32) }
      const SRV_LIST = { install_id: 'f'.repeat(32), profiles: [{ name: 'scout' }] }

      function holdChecks() {
        const checks: Array<(value: unknown) => void> = []

        const calls = respondWith(call => {
          if (call.method === 'profiles.list') {
            if (call.connectionId === 'srv' && call.route.profile === 'scout') {
              return new Promise(resolve => checks.push(resolve))
            }

            return call.connectionId === 'local' ? { install_id: INSTALL, profiles: [{ name: 'ops' }] } : SRV_LIST
          }

          if (call.method === 'bot_relay.outbox.drain') {
            return { envelopes: call.connectionId === 'local' ? [envelope] : [] }
          }

          if (call.method === 'bot_relay.deliver') {
            return { status: 'settled', delivery_id: call.params.id, admission_id: 'admission', reply: 'done' }
          }

          return {}
        })

        return { calls, checks }
      }

      it('stopBotRelay() during the check: no delivery', async () => {
        const { calls, checks } = holdChecks()
        const { startBotRelay, stopBotRelay } = await loadRelay()

        startBotRelay()
        await vi.advanceTimersByTimeAsync(0)
        await pushAndSettle() // the install check is now waiting on 'srv'
        expect(checks).toHaveLength(1)
        stopBotRelay()
        checks[0](SRV_LIST)
        await vi.advanceTimersByTimeAsync(0)

        expect(calls.filter(call => call.method === 'bot_relay.deliver')).toEqual([])
      })

      it('stop and restart during the check: the old check delivers nothing', async () => {
        const { calls, checks } = holdChecks()
        const { startBotRelay, stopBotRelay } = await loadRelay()

        startBotRelay()
        await vi.advanceTimersByTimeAsync(0)
        await pushAndSettle()
        expect(checks).toHaveLength(1)
        stopBotRelay()
        startBotRelay()
        await vi.advanceTimersByTimeAsync(0)
        checks[0](SRV_LIST)
        await vi.advanceTimersByTimeAsync(0)

        expect(calls.filter(call => call.method === 'bot_relay.deliver')).toEqual([])

        // Not lost: the restarted relay's backstop drain checks it again and delivers it once.
        await vi.advanceTimersByTimeAsync(30_000)
        expect(checks).toHaveLength(2)
        checks[1](SRV_LIST)
        await vi.advanceTimersByTimeAsync(0)
        stopBotRelay()

        expect(calls.filter(call => call.method === 'bot_relay.deliver').map(call => call.connectionId)).toEqual(['srv'])
      })

      it('Bot Mode turned off during the check: no delivery', async () => {
        const { calls, checks } = holdChecks()
        const { startBotRelay, stopBotRelay } = await loadRelay()

        startBotRelay()
        await vi.advanceTimersByTimeAsync(0)
        await pushAndSettle()
        expect(checks).toHaveLength(1)
        window.localStorage.setItem(PLUGIN_DECISIONS_KEY, JSON.stringify({ 'hermes-bots': false }))
        checks[0](SRV_LIST)
        await vi.advanceTimersByTimeAsync(30_000)

        expect(calls.filter(call => call.method === 'bot_relay.deliver')).toEqual([])

        // Bot Mode back on: the backstop drain picks the envelope up again, no new event needed.
        window.localStorage.setItem(PLUGIN_DECISIONS_KEY, JSON.stringify({ 'hermes-bots': true }))
        await vi.advanceTimersByTimeAsync(30_000)
        expect(checks).toHaveLength(2)
        checks[1](SRV_LIST)
        await vi.advanceTimersByTimeAsync(0)
        stopBotRelay()

        expect(calls.filter(call => call.method === 'bot_relay.deliver').map(call => call.connectionId)).toEqual(['srv'])
      })

      it('nothing changes during the check: delivered once it answers', async () => {
        const { calls, checks } = holdChecks()
        const { startBotRelay, stopBotRelay } = await loadRelay()

        startBotRelay()
        await vi.advanceTimersByTimeAsync(0)
        await pushAndSettle()
        checks[0](SRV_LIST)
        await vi.advanceTimersByTimeAsync(0)
        stopBotRelay()

        expect(calls.filter(call => call.method === 'bot_relay.deliver').map(call => call.connectionId)).toEqual(['srv'])
      })
    })

    it('a same-named connection answering from another install is not the target', async () => {
      expect(await run({ ...base, target_connection: 'srv', target_install: 'e'.repeat(32) })).toEqual([])

      const ours = await run({ ...base, target_connection: 'srv', target_install: 'f'.repeat(32) })

      expect(ours.map(call => [call.method, call.connectionId])).toEqual([
        ['bot_relay.deliver', 'srv'],
        ['bot_relay.reply', 'local']
      ])
    })
  })

  it('stamps each row with the install its gateway reported', async () => {
    const calls = serve({ install: INSTALL })
    const { startBotRelay, stopBotRelay } = await loadRelay()

    startBotRelay()
    await vi.advanceTimersByTimeAsync(0)

    expect(syncs(calls).find(call => call.connectionId === 'local')?.params.agents).toEqual([
      expect.objectContaining({ connection_id: 'srv', install_id: 'f'.repeat(32), profile: 'scout' })
    ])
    expect(syncs(calls).find(call => call.connectionId === 'srv')?.params.agents).toEqual([
      expect.objectContaining({ connection_id: 'local-0123456789ab', install_id: INSTALL, profile: 'ops' })
    ])

    stopBotRelay()
  })
})
