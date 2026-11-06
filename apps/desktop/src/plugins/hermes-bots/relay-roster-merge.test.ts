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
