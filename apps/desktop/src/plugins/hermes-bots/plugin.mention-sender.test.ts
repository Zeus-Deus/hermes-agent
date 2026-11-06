/**
 * Mention targets are written for the bot that SENDS them (#130260).
 *
 * A Bot Chat opened on one connection leaves the Desktop's active connection
 * wherever it was. The mention note is read by the focused chat's bot, on its
 * own gateway: that gateway resolves a bare name to its own bots, and its
 * relay roster lists only the OTHER connections. So locality — and the
 * "a bot never @s itself" filter — must follow the focused chat's owner, not
 * the active connection or the roster row's remote flag.
 *
 * Topology in every case: two connections, `local` (this device) and
 * `server`, each with a `default`; the roster entry is whichever the window
 * last built.
 */

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

interface MentionCompletionItem {
  display: string
  insert: string
  meta: string
}

interface Contribution {
  data: {
    handler?: (
      draft: { text: string },
      context?: { sessionId: null | string; storedSessionId: null | string }
    ) => Promise<{ text: string }>
    provide?: (query: string) => MentionCompletionItem[]
  }
  id: string
}

type Owner = { connectionId: string; profile: string } | null

const { cache, hostMock, live, paneQuery } = vi.hoisted(() => {
  // `socket`: where host.request answers when it differs from the published `active` (mid-apply).
  const live = {
    active: 'local' as null | string,
    focused: 'ops',
    focusedRuntime: null as null | string,
    focusedStored: null as null | string,
    owner: null as Owner,
    // Owners `host.sessionOwner` resolves, by runtime or stored session id.
    owners: {} as Record<string, Owner>,
    profile: 'default',
    socket: null as null | string
  }

  return {
    cache: new Map<string, { key: unknown[]; value: unknown }>(),
    paneQuery: { current: null as null | { queryFn: () => Promise<unknown>; queryKey: unknown[] } },
    hostMock: {
      activeConnectionId: () => live.socket ?? live.active,
      notify: vi.fn(),
      request: vi.fn(async (): Promise<unknown> => ({})),
      requestProfile: vi.fn(async () => ({})),
      // The focused chat resolves to the focused owner unless a test names it.
      sessionOwner: (id: null | string | undefined) =>
        (id && (id in live.owners ? live.owners[id] : id === live.focusedStored ? live.owner : null)) || null,
      agents: vi.fn(async () => ({ agents: [], sources: [] })),
      state: {
        connectionId: { get: () => live.active, listen: () => () => undefined },
        focusedSessionId: { get: () => live.focusedRuntime, listen: () => () => undefined },
        focusedSessionOwner: { get: () => live.owner, listen: () => () => undefined },
        focusedSessionProfile: { get: () => live.focused, listen: () => () => undefined },
        focusedStoredSessionId: { get: () => live.focusedStored, listen: () => () => undefined },
        gateway: { get: () => null, listen: () => () => undefined },
        profile: { get: () => live.profile, listen: () => () => undefined }
      }
    },
    live
  }
})

vi.mock('@hermes/plugin-sdk', async () => {
  const { atom } = await import('nanostores')

  const stub: unknown = new Proxy(function stubbed() {}, {
    apply: () => stub,
    get: (_target, key) => (key === 'then' ? undefined : stub)
  })

  const keyOf = (key: unknown[]) => JSON.stringify(key)

  const queryClient = {
    getQueriesData: ({ queryKey }: { queryKey: unknown[] }) =>
      [...cache.values()]
        .filter(entry => queryKey.every((part, index) => entry.key[index] === part))
        .map(entry => [entry.key, entry.value]),
    fetchQuery: async ({ queryFn, queryKey }: { queryFn: () => Promise<unknown>; queryKey: unknown[] }) => {
      const value = await queryFn()
      cache.set(keyOf(queryKey), { key: queryKey, value })

      return value
    },
    getQueryData: (key: unknown[]) => cache.get(keyOf(key))?.value,
    invalidateQueries: () => undefined,
    setQueryData: (key: unknown[], value: unknown) => cache.set(keyOf(key), { key, value })
  }

  const known: Record<string, unknown> = {
    atom,
    COMPOSER_AREAS: { atCompletions: 'composer.atCompletions', middleware: 'composer.middleware' },
    host: hostMock,
    PALETTE_AREA: 'palette',
    queryClient,
    // The Bots pane's roster query, captured so a test can run it with the pane's own key.
    useQuery: (options: unknown) => {
      paneQuery.current = options as typeof paneQuery.current

      return {}
    },
    useValue: (store: { get: () => unknown }) => store.get()
  }

  return new Proxy(known, {
    get: (target, key) =>
      typeof key === 'symbol' || key in target ? target[key as string] : key === 'then' ? undefined : stub,
    has: () => true
  })
})

/** The roster as built while `local` was active: its rows annotate the rich
 *  list, the server's are appended as remote rows. */
const BUILT_ON_LOCAL = [
  {
    connectionId: 'local',
    connectionLabel: 'This device',
    handle: 'default-this-device',
    name: 'default',
    sourceScoped: true
  },
  { connectionId: 'local', connectionLabel: 'This device', name: 'writer', sourceScoped: true },
  {
    connectionId: 'server',
    connectionLabel: 'Server',
    handle: 'default-server',
    name: 'default',
    remoteSource: true,
    sourceScoped: true
  },
  { connectionId: 'server', connectionLabel: 'Server', name: 'ops', remoteSource: true, sourceScoped: true }
]

/** The same machines as built while `server` was active: the flags flip. */
const BUILT_ON_SERVER = [
  { connectionId: 'server', connectionLabel: 'Server', handle: 'default-server', name: 'default', sourceScoped: true },
  { connectionId: 'server', connectionLabel: 'Server', name: 'ops', sourceScoped: true },
  {
    connectionId: 'local',
    connectionLabel: 'This device',
    handle: 'default-this-device',
    name: 'default',
    remoteSource: true,
    sourceScoped: true
  },
  { connectionId: 'local', connectionLabel: 'This device', name: 'writer', remoteSource: true, sourceScoped: true }
]

async function contributions({
  cacheKey = 'local',
  profiles,
  sources
}: {
  cacheKey?: string
  profiles: Array<Record<string, unknown>> | null
  sources?: Array<Record<string, unknown>>
}) {
  vi.resetModules()
  cache.clear()

  if (profiles) {
    cache.set(JSON.stringify(['hermes-bots', 'roster', cacheKey]), {
      key: ['hermes-bots', 'roster', cacheKey],
      value: { profiles, ...(sources ? { sources } : {}) }
    })
  }

  const plugin = (await import('./plugin')).default
  const registered: Contribution[] = []

  try {
    plugin.register({
      i18n: { register: () => () => undefined },
      onDispose: () => undefined,
      register: (contribution: Contribution) => registered.push(contribution),
      storage: { get: async () => undefined, remove: async () => undefined, set: async () => undefined }
    } as never)
  } catch {
    // Only the composer contributions registered before any throw matter here.
  }

  const middleware = registered.find(entry => entry.id === 'mention-middleware')
  const completions = registered.find(entry => entry.id === 'mention-completions')

  return { handler: middleware!.data.handler!, provide: completions!.data.provide! }
}

beforeAll(async () => {
  await import('./plugin')
}, 120_000)

beforeEach(() => {
  vi.clearAllMocks()
  hostMock.request.mockReset().mockResolvedValue({})
  hostMock.agents.mockReset().mockResolvedValue({ agents: [], sources: [] })
  live.active = 'local'
  live.focused = 'ops'
  live.focusedRuntime = 'rt-ops'
  live.focusedStored = 'ops-chat'
  live.owner = { connectionId: 'server', profile: 'ops' }
  live.owners = {}
  live.profile = 'default'
  live.socket = null
})

describe('mention targets follow the focused chat owner, not the active connection', () => {
  it("gives a bot on the sender's own gateway its bare local handle (the reported case)", async () => {
    const { handler } = await contributions({ profiles: BUILT_ON_LOCAL })

    const { text } = await handler({ text: 'send it to @default-server' })

    expect(text).toContain('@default-server = agent profile "default" (message_agent target: "hermes")')
    expect(text).not.toContain('default@server')
  })

  it("keeps 'default' when the sender's gateway has a real hermes profile", async () => {
    const { handler } = await contributions({
      profiles: [
        { ...BUILT_ON_LOCAL[2], hermesHandleTaken: true },
        { connectionId: 'server', name: 'hermes', remoteSource: true, sourceScoped: true },
        BUILT_ON_LOCAL[3]
      ]
    })

    const { text } = await handler({ text: 'send it to @default-server' })

    expect(text).toContain('(message_agent target: "default")')
    expect(text).not.toContain('"hermes"')
  })

  it('qualifies a bot on the active connection when the sender is elsewhere (the inverse)', async () => {
    // Bare 'writer' would reach the server's own namesake, or nothing.
    const { handler } = await contributions({ profiles: BUILT_ON_LOCAL })

    const { text } = await handler({ text: 'ask @writer and @default-this-device' })

    expect(text).toContain('@writer = agent profile "writer" — on This device (message_agent target: "writer@local")')
    expect(text).toContain('— on This device (message_agent target: "default@local")')
  })

  it('reads a snapshot built on another connection by row connection, not by its remote flag', async () => {
    // Only the server-built entry is cached; the sender is on this device.
    live.owner = { connectionId: 'local', profile: 'writer' }
    live.focused = 'writer'

    const { handler } = await contributions({ cacheKey: 'server', profiles: BUILT_ON_SERVER })

    const { text } = await handler({ text: 'ask @default-server and @default-this-device' })

    // 'hermes' here would deliver to THIS device's default: the wrong bot.
    expect(text).toContain('(message_agent target: "default@server")')
    expect(text).toContain('@default-this-device = agent profile "default" (message_agent target: "hermes")')
    expect(text).not.toContain('default@local')
  })

  it('keeps the qualifier while the focused owner is unknown', async () => {
    live.owner = null

    const { handler } = await contributions({ profiles: BUILT_ON_LOCAL })

    const { text } = await handler({ text: 'send it to @default-server' })

    expect(text).toContain('(message_agent target: "default@server")')
  })

  it("qualifies the active gateway's cold profiles.list rows for a sender elsewhere", async () => {
    // The prime fails, so the middleware falls back to the active gateway's list.
    hostMock.request.mockRejectedValueOnce(new Error('offline')).mockResolvedValue({
      profiles: [{ name: 'default' }, { name: 'writer' }]
    })
    hostMock.agents.mockRejectedValue(new Error('offline'))

    const { handler } = await contributions({ profiles: null })

    const { text } = await handler({ text: 'ask @writer' })

    expect(text).toContain('(message_agent target: "writer@local")')
  })

  it('names the connection the cold profiles.list was sent to, not the one active when it answers', async () => {
    let answer: (value: unknown) => void = () => undefined

    let asked = false

    // The prime's profiles.list fails; the middleware's own fallback hangs until answered.
    hostMock.request.mockImplementation(async (...args: unknown[]) => {
      if (args[0] !== 'profiles.list') {
        return {}
      }

      if ((args[1] as Record<string, unknown>)?.include_sessions !== false) {
        throw new Error('offline')
      }

      asked = true

      return new Promise(resolve => (answer = resolve))
    })

    const { handler } = await contributions({ profiles: null })
    const pending = handler({ text: 'ask @writer' })

    await vi.waitFor(() => expect(asked).toBe(true))
    // The window moves to the server while this device's list is in flight.
    live.active = 'server'
    answer({ profiles: [{ name: 'default' }, { name: 'writer' }] })

    expect((await pending).text).toContain('(message_agent target: "writer@local")')
  })

  it('keeps the sender the tag was typed for while a cold roster loads and focus moves', async () => {
    let answer: (value: unknown) => void = () => undefined

    live.owner = { connectionId: 'local', profile: 'writer' }
    live.focused = 'writer'
    hostMock.request.mockImplementation(async (...args: unknown[]) =>
      args[0] === 'profiles.list' ? new Promise(resolve => (answer = resolve)) : {}
    )
    hostMock.agents.mockResolvedValue({
      agents: [
        { connectionId: 'local', connectionKind: 'local', connectionLabel: 'This device', profile: 'writer' },
        {
          connectionId: 'server',
          connectionKind: 'remote',
          connectionLabel: 'Server',
          handle: 'default-server',
          profile: 'default'
        }
      ],
      sources: []
    } as never)

    const { handler } = await contributions({ profiles: null })
    const pending = handler({ text: 'ask @default-server' })

    await vi.waitFor(() => expect(hostMock.request).toHaveBeenCalledWith('profiles.list', expect.anything()))
    // The user moves to a server bot's tile before this device's roster answers.
    live.owner = { connectionId: 'server', profile: 'ops' }
    live.focused = 'ops'
    answer({ profiles: [{ name: 'writer' }] })

    // This tile still submits to this device: 'hermes' would reach its own default.
    expect((await pending).text).toContain('(message_agent target: "default@server")')
  })

  it.each([
    ['the cold profiles.list fallback', true],
    ['a prime with no keyed route', false]
  ])(
    'never credits %s to the published connection while another gateway holds the socket',
    async (_label, primeFails) => {
      // Mid-apply: this device is published as primary, the server's socket still answers.
      live.socket = 'server'
      live.owner = { connectionId: 'server', profile: 'default' }
      live.focused = 'default'
      hostMock.request.mockImplementation(async (...args: unknown[]) => {
        if (args[0] !== 'profiles.list') {
          return {}
        }

        if (primeFails && (args[1] as Record<string, unknown>)?.include_sessions !== false) {
          throw new Error('offline')
        }

        return { profiles: [{ name: 'default' }, { name: 'writer' }] }
      })
      hostMock.agents.mockRejectedValue(new Error('offline'))

      const { handler } = await contributions({ profiles: null })
      const { text } = await handler({ text: 'ask @writer and @hermes' })

      // The server's rows: its writer is local to the sender, its default is the sender.
      expect(text).toContain('@writer = agent profile "writer"')
      expect(text).not.toContain('@local')
      expect(text).not.toContain('agent profile "default"')
    }
  )

  it.each([
    ['the cold profiles.list fallback', true],
    ['a prime with no keyed route', false]
  ])('credits %s to the socket that answered for a sender on the published connection', async (_label, primeFails) => {
    live.socket = 'server'
    live.owner = { connectionId: 'local', profile: 'default' }
    live.focused = 'default'
    hostMock.request.mockImplementation(async (...args: unknown[]) => {
      if (args[0] !== 'profiles.list') {
        return {}
      }

      if (primeFails && (args[1] as Record<string, unknown>)?.include_sessions !== false) {
        throw new Error('offline')
      }

      return { profiles: [{ name: 'default' }, { name: 'writer' }] }
    })
    hostMock.agents.mockRejectedValue(new Error('offline'))

    const { handler } = await contributions({ profiles: null })
    const { text } = await handler({ text: 'ask @writer and @hermes' })

    // The server's rows, read by this device's default: both need the qualifier.
    expect(text).toContain('(message_agent target: "writer@server")')
    expect(text).toContain('(message_agent target: "default@server")')
  })

  it('merges the rich rows against the gateway that answered, not the query key', async () => {
    // Mid-apply: this device is published, the server's socket answers its profiles.list.
    live.socket = 'server'
    live.owner = { connectionId: 'server', profile: 'ops' }
    hostMock.request.mockImplementation(async (...args: unknown[]) =>
      args[0] === 'profiles.list'
        ? { profiles: [{ name: 'default', ui_meta: { 'hermes-bots': { title: 'Server Helper' } } }, { name: 'ops' }] }
        : {}
    )
    hostMock.agents.mockResolvedValue({
      agents: [
        { connectionId: 'local', connectionKind: 'local', connectionLabel: 'This device', profile: 'default' },
        { connectionId: 'local', connectionKind: 'local', connectionLabel: 'This device', profile: 'writer' },
        { connectionId: 'server', connectionKind: 'remote', connectionLabel: 'Server', profile: 'default' },
        { connectionId: 'server', connectionKind: 'remote', connectionLabel: 'Server', profile: 'ops' }
      ],
      sources: [
        { connectionId: 'local', kind: 'local' },
        { connectionId: 'server', kind: 'remote' }
      ]
    } as never)

    const { handler } = await contributions({ profiles: null })
    const { text } = await handler({ text: 'ask @server-helper' })

    // The server's own default, read by the server's ops: bare. 'default@local' is this device's.
    // Its bare handle is the target itself, so no annotation is needed.
    expect(text).toContain('@hermes = agent profile "default" ("Server Helper").')
    expect(text).not.toContain('default@local')
  })

  it("merges the pane's null-keyed roster against the gateway that answered", async () => {
    // Recovery: no connection is published, the server's socket still answers.
    live.active = null
    live.socket = 'server'
    hostMock.request.mockImplementation(async (...args: unknown[]) =>
      args[0] === 'profiles.list'
        ? { profiles: [{ name: 'default', ui_meta: { 'hermes-bots': { title: 'Server Helper' } } }, { name: 'ops' }] }
        : {}
    )
    hostMock.agents.mockResolvedValue({
      agents: [
        { connectionId: 'local', connectionKind: 'local', connectionLabel: 'This device', profile: 'default' },
        { connectionId: 'server', connectionKind: 'remote', connectionLabel: 'Server', profile: 'default' },
        { connectionId: 'server', connectionKind: 'remote', connectionLabel: 'Server', profile: 'ops' }
      ],
      sources: [
        { connectionId: 'local', kind: 'local' },
        { connectionId: 'server', kind: 'remote' }
      ]
    } as never)

    const { handler } = await contributions({ profiles: null })
    const { useRoster } = await import('./data')

    useRoster()
    const query = paneQuery.current!
    cache.set(JSON.stringify(query.queryKey), { key: query.queryKey, value: await query.queryFn() })

    const { text } = await handler({ text: 'ask @server-helper' })

    expect(text).toContain('@hermes = agent profile "default" ("Server Helper").')
    expect(text).not.toContain('default@local')
  })

  it('places rows the union enumeration failed to scope on the gateway that served them', async () => {
    // profiles.list answers, host.agents fails: the cached rows carry no connectionId.
    hostMock.request.mockResolvedValue({ profiles: [{ name: 'default' }, { name: 'writer' }] })
    hostMock.agents.mockRejectedValue(new Error('offline'))

    const { handler } = await contributions({ profiles: null })

    expect((await handler({ text: 'ask @writer' })).text).toContain('(message_agent target: "writer@local")')

    // The server's own default is sending: this device's default is not "self".
    live.owner = { connectionId: 'server', profile: 'default' }
    live.focused = 'default'

    expect((await handler({ text: 'ask @hermes' })).text).toContain('(message_agent target: "default@local")')
  })
})

describe('a queued send is written for the chat it drains into, not the focused one', () => {
  // The server's ops chat has focus; this device's writer chat drains its queue in its own tile.
  const WRITER_CHAT = { sessionId: 'rt-writer', storedSessionId: 'writer-chat' }

  it("targets the submitting chat's own gateway while another connection's chat has focus", async () => {
    live.owners['writer-chat'] = { connectionId: 'local', profile: 'writer' }

    const { handler } = await contributions({ profiles: BUILT_ON_LOCAL })

    const { text } = await handler({ text: 'ask @default-this-device and @ops' }, WRITER_CHAT)

    // writer's own gateway resolves its default bare; the focused bot is not the sender, so it is offered.
    expect(text).toContain('@default-this-device = agent profile "default" (message_agent target: "hermes")')
    expect(text).toContain('@ops = agent profile "ops" — on Server (message_agent target: "ops@server")')
    expect(text).not.toContain('default@local')
  })

  it('hands out no target while the submitting chat has no known owner', async () => {
    const { handler } = await contributions({ profiles: BUILT_ON_LOCAL })

    const { text } = await handler({ text: 'ask @default-server, @writer and @ops' }, WRITER_CHAT)

    // A bare name or a qualifier resolves differently on every gateway (a qualifier
    // the relay misses still falls through to local friendly names).
    expect(text).toContain('@default-server = agent profile "default" (no message_agent target')
    expect(text).toContain('@writer = agent profile "writer" (no message_agent target')
    // Not the focused bot, so not "self".
    expect(text).toContain('@ops = agent profile "ops" (no message_agent target')
    expect(text).not.toContain('message_agent target: "')
  })

  it('never takes an unknown sender for a roster row', async () => {
    const { isActiveRosterBot } = await import('./data')
    const unknown = { connectionId: '', exact: true, name: '' }

    expect(isActiveRosterBot({ name: 'default' }, unknown)).toBe(false)
    expect(isActiveRosterBot({ connectionId: 'local', name: 'default' }, unknown)).toBe(false)
  })

  it('resolves the destination by its runtime id when the queue scope is a lineage root', async () => {
    // writer's tip is bound to the runtime; its root alone resolves to nobody.
    live.owners['rt-writer'] = { connectionId: 'local', profile: 'writer' }

    const { handler } = await contributions({ profiles: BUILT_ON_LOCAL })

    const { text } = await handler(
      { text: 'ask @default-this-device' },
      { sessionId: 'rt-writer', storedSessionId: 'writer-root' }
    )

    expect(text).toContain('@default-this-device = agent profile "default" (message_agent target: "hermes")')
  })

  it("keeps the focused owner for the focused chat's own send under its lineage root", async () => {
    // The composer scope is the root; focus holds the tip. The root alone is ambiguous.
    live.focusedStored = 'ops-tip'

    const { handler } = await contributions({ profiles: BUILT_ON_LOCAL })

    const { text } = await handler(
      { text: 'ask @default-this-device and @default-server' },
      { sessionId: 'rt-ops', storedSessionId: 'ops-root' }
    )

    expect(text).toContain('— on This device (message_agent target: "default@local")')
    expect(text).toContain('@default-server = agent profile "default" (message_agent target: "hermes")')
  })

  it("hands out no target for a fresh draft's send while a stored chat has focus", async () => {
    const { handler } = await contributions({ profiles: BUILT_ON_LOCAL })

    const { text } = await handler({ text: 'send it to @default-server' }, { sessionId: null, storedSessionId: null })

    // Not the focused chat, owner unknown: no target that could reach the wrong bot.
    expect(text).toContain('(no message_agent target')
    expect(text).not.toContain('"hermes"')
  })

  it("lets a runtime that resolves elsewhere outrank a lineage root shared with the focused chat", async () => {
    // The focused server chat and a local continuation of a copied history share root 'ops-chat'.
    live.owners['rt-local-copy'] = { connectionId: 'local', profile: 'writer' }

    const { handler } = await contributions({ profiles: BUILT_ON_LOCAL })

    const { text } = await handler(
      { text: 'ask @default-this-device' },
      { sessionId: 'rt-local-copy', storedSessionId: 'ops-chat' }
    )

    expect(text).toContain('@default-this-device = agent profile "default" (message_agent target: "hermes")')
  })

  it("reads a focused tile's owner route before the focused-owner atom", async () => {
    // The tile's route answers (host.sessionOwner); the atom lost its evicted owner hint.
    live.owners['ops-chat'] = { connectionId: 'server', profile: 'ops' }
    live.owner = null

    const { handler, provide } = await contributions({ profiles: BUILT_ON_LOCAL })

    expect((await handler({ text: 'send it to @default-server' })).text).toContain(
      '@default-server = agent profile "default" (message_agent target: "hermes")'
    )
    // This device's default is not the sender.
    expect(provide('').map(item => item.insert)).toContain('@default-this-device')
  })

  it('reads the focused owner for a send from the focused chat itself', async () => {
    const { handler } = await contributions({ profiles: BUILT_ON_LOCAL })

    const { text } = await handler(
      { text: 'send it to @default-server' },
      { sessionId: 'rt-ops', storedSessionId: 'ops-chat' }
    )

    expect(text).toContain('@default-server = agent profile "default" (message_agent target: "hermes")')
  })
})

describe('one server registered under two addresses', () => {
  // The union roster collapses the install's bots onto one address; the chat keeps the other.
  const COLLAPSED = [
    { connectionId: 'server-b', handle: 'default-server', name: 'default', remoteSource: true, sourceScoped: true },
    { connectionId: 'server-b', name: 'ops', remoteSource: true, sourceScoped: true }
  ]

  const sources = (install?: string) => [
    { connectionId: 'local', installId: 'a'.repeat(32), kind: 'local' },
    { connectionId: 'server-a', kind: 'remote', ...(install ? { installId: install } : {}) },
    { connectionId: 'server-b', kind: 'remote', ...(install ? { installId: install } : {}) }
  ]

  beforeEach(() => {
    live.owner = { connectionId: 'server-a', profile: 'ops' }
  })

  it("treats the install's other address as the sender's own gateway", async () => {
    const { handler, provide } = await contributions({ profiles: COLLAPSED, sources: sources('b'.repeat(32)) })

    const { text } = await handler({ text: 'send it to @default-server' })

    // Local to the sender; no hermes profile on any address, so the default answers 'hermes'.
    expect(text).toContain('(message_agent target: "hermes")')
    expect(provide('').map(item => item.insert)).not.toContain('@ops')
  })

  it("keeps 'default' when only the other address lists a real hermes profile", async () => {
    // The collapse kept `default` on server-a (its inventory has no hermes) and `hermes` on server-b.
    live.owner = { connectionId: 'server-b', profile: 'ops' }

    const { handler } = await contributions({
      profiles: [
        { connectionId: 'server-a', handle: 'default-server', name: 'default', remoteSource: true, sourceScoped: true },
        { connectionId: 'server-b', name: 'hermes', remoteSource: true, sourceScoped: true },
        { connectionId: 'server-b', name: 'ops', remoteSource: true, sourceScoped: true }
      ],
      sources: sources('b'.repeat(32))
    })

    const { text } = await handler({ text: 'send it to @default-server' })

    // 'hermes' would reach the real hermes profile on that gateway.
    expect(text).toContain('(message_agent target: "default")')
  })

  it("keeps 'default' when the sender's own address lacks the real hermes profile", async () => {
    // Reversed: the sender sits on server-a, whose inventory (and so the default row's claim) has no hermes.
    const { handler } = await contributions({
      profiles: [
        { connectionId: 'server-a', handle: 'default-server', name: 'default', remoteSource: true, sourceScoped: true },
        { connectionId: 'server-b', name: 'hermes', remoteSource: true, sourceScoped: true },
        { connectionId: 'server-a', name: 'ops', remoteSource: true, sourceScoped: true }
      ],
      sources: sources('b'.repeat(32))
    })

    const { text } = await handler({ text: 'send it to @default-server' })

    expect(text).toContain('(message_agent target: "default")')
  })

  it('keeps the alias identity through a refresh whose union enumeration fails', async () => {
    // This device answers profiles.list; host.agents fails, so the server rows are retained ones.
    hostMock.request.mockResolvedValue({ profiles: [{ name: 'default' }, { name: 'writer' }] })
    hostMock.agents.mockRejectedValue(new Error('offline'))

    const { handler } = await contributions({ profiles: null })
    const { $lastRoster } = await import('./data')

    // The last good snapshot (since evicted from the roster query) knew both addresses are one install.
    cache.set(JSON.stringify(['hermes-bots', 'roster', 'earlier']), {
      key: ['hermes-bots', 'roster', 'earlier'],
      value: { fetchedAt: 1, sources: sources('b'.repeat(32)) }
    })
    $lastRoster.set(COLLAPSED as never)

    expect((await handler({ text: 'send it to @default-server' })).text).toContain('(message_agent target: "hermes")')
  })

  it("keeps a source's last install id when only its own enumeration fails", async () => {
    // The window is on server-b; server-a timed out, so the union reports it without an install id.
    live.active = 'server-b'
    hostMock.request.mockResolvedValue({ profiles: [{ name: 'default' }, { name: 'ops' }] })
    hostMock.agents.mockResolvedValue({
      agents: [
        { connectionId: 'local', connectionKind: 'local', connectionLabel: 'This device', profile: 'default' },
        {
          connectionId: 'server-b',
          connectionKind: 'remote',
          connectionLabel: 'Server',
          handle: 'default-server',
          profile: 'default'
        },
        { connectionId: 'server-b', connectionKind: 'remote', connectionLabel: 'Server', profile: 'ops' }
      ],
      sources: [
        { connectionId: 'local', installId: 'a'.repeat(32), kind: 'local' },
        { connectionId: 'server-a', error: 'timeout', kind: 'remote', reachable: false },
        { connectionId: 'server-b', installId: 'b'.repeat(32), kind: 'remote' }
      ]
    } as never)

    const { handler, provide } = await contributions({ profiles: null })

    cache.set(JSON.stringify(['hermes-bots', 'roster', 'earlier']), {
      key: ['hermes-bots', 'roster', 'earlier'],
      value: { fetchedAt: 1, sources: sources('b'.repeat(32)) }
    })

    expect((await handler({ text: 'send it to @default-server' })).text).toContain('(message_agent target: "hermes")')
    // server-b's ops is the sender itself.
    expect(provide('').map(item => item.insert)).not.toContain('@ops')
  })

  it('stops treating an address as the install once the registry edits it', async () => {
    let changed: (payload: { connectionId: string; reason: string }) => void = () => undefined

    vi.stubGlobal('hermesDesktop', {
      connections: { onChanged: (listener: typeof changed) => ((changed = listener), () => undefined) }
    })

    try {
      const { handler } = await contributions({ profiles: COLLAPSED, sources: sources('b'.repeat(32)) })

      expect((await handler({ text: 'send it to @default-server' })).text).toContain('(message_agent target: "hermes")')

      // server-b now points at another gateway: the install id the snapshot holds is void.
      changed({ connectionId: 'server-b', reason: 'updated' })

      expect((await handler({ text: 'send it to @default-server' })).text).toContain(
        '(message_agent target: "default@server-b")'
      )
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('never retains an install id seen before the registry edited that connection', async () => {
    let changed: (payload: { connectionId: string; reason: string }) => void = () => undefined

    vi.stubGlobal('hermesDesktop', {
      connections: { onChanged: (listener: typeof changed) => ((changed = listener), () => undefined) }
    })

    try {
      live.active = 'server-b'
      hostMock.request.mockResolvedValue({ profiles: [{ name: 'default' }, { name: 'ops' }] })
      // The edited address now reaches a gateway whose identity probe returns no install id.
      hostMock.agents.mockResolvedValue({
        agents: [
          {
            connectionId: 'server-b',
            connectionKind: 'remote',
            connectionLabel: 'Server',
            handle: 'default-server',
            profile: 'default'
          }
        ],
        sources: [
          { connectionId: 'server-a', installId: 'b'.repeat(32), kind: 'remote' },
          { connectionId: 'server-b', kind: 'remote' }
        ]
      } as never)

      const { handler } = await contributions({ profiles: null })

      cache.set(JSON.stringify(['hermes-bots', 'roster', 'earlier']), {
        key: ['hermes-bots', 'roster', 'earlier'],
        value: { fetchedAt: 1, sources: sources('b'.repeat(32)) }
      })
      changed({ connectionId: 'server-b', reason: 'updated' })

      expect((await handler({ text: 'send it to @default-server' })).text).toContain(
        '(message_agent target: "default@server-b")'
      )
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('keeps addresses distinct while their install ids are unknown', async () => {
    const { handler } = await contributions({ profiles: COLLAPSED, sources: sources() })

    expect((await handler({ text: 'send it to @default-server' })).text).toContain(
      '(message_agent target: "default@server-b")'
    )
  })
})

describe('the self filter compares the complete owner pair', () => {
  it("offers the active connection's namesake and hides the sender itself", async () => {
    live.owner = { connectionId: 'server', profile: 'default' }
    live.focused = 'default'

    const { handler, provide } = await contributions({ profiles: BUILT_ON_LOCAL })

    const inserts = provide('default').map(item => item.insert)

    expect(inserts).toContain('@default-this-device')
    expect(inserts).not.toContain('@default-server')

    const { text } = await handler({ text: 'ask @default-this-device' })

    expect(text).toContain('(message_agent target: "default@local")')
  })

  it("hides the sender on this device and offers the server's namesake", async () => {
    live.owner = { connectionId: 'local', profile: 'default' }
    live.focused = 'default'
    live.active = 'server'

    const { provide } = await contributions({ cacheKey: 'server', profiles: BUILT_ON_SERVER })

    const inserts = provide('default').map(item => item.insert)

    expect(inserts).toContain('@default-server')
    expect(inserts).not.toContain('@default-this-device')
  })
})
