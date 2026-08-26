import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

// #94071 — New Bot on a non-active connection:
//   1. the profile-origin picker offers the SAME choices for every target
//      (fresh, or a clone of any profile that exists on THAT machine), sourced
//      from a routed profiles.list — never forced to `default`;
//   2. the credential/inherit wording names the create target, not the
//      window's active gateway;
//   3. provider readiness on the target is preflighted before the automatic
//      intro turn — an unready target keeps the bot, badges it, and withholds
//      the doomed first turn instead of surfacing "agent init failed";
//   4. editor/create surfaces (MCP setup, hub installs) ride the owning
//      backend's route instead of the active gateway.

const source = readFileSync(new URL('../plugin.js', import.meta.url), 'utf8')

/** Values built inside a vm context belong to another realm; strict deepEqual
 *  rejects their prototypes even when the shapes match. Compare plain data. */
const plain = value => JSON.parse(JSON.stringify(value))

function slice(startMarker, endMarker) {
  const start = source.indexOf(startMarker)
  assert.notEqual(start, -1, `missing: ${startMarker}`)
  const end = source.indexOf(endMarker, start)
  assert.ok(end > start, `missing delimiter: ${endMarker}`)
  return source.slice(start, end)
}

function loadOriginHelpers() {
  const context = {}
  vm.createContext(context)
  return vm.runInContext(
    `${slice('/** "Inherit" means the launch/default profile', 'function ModelPicker(')}
;({ botInheritLabel, cloneSourcesFromProfileList, resolveCloneSource, requestForCreateTarget })`,
    context
  )
}

function loadReadinessHelpers({ notify, noteBotAttention }) {
  const context = { host: { notify }, noteBotAttention }
  vm.createContext(context)
  return vm.runInContext(
    `${slice('/** A bot was created on a backend that cannot serve a model yet', '// Bot Mode sessions are ALWAYS hidden')}
;({ noteProviderSetupNeeded, preflightProviderReadiness, prepareBotFirstChat })`,
    context
  )
}

function loadClassifier() {
  const atom = initial => {
    let value = initial
    return { get: () => value, set: next => (value = next) }
  }
  const context = { atom }
  vm.createContext(context)
  return vm.runInContext(
    `${slice('const BOT_ATTENTION_CLASSES', '/** Last good cron list')}
;({ attentionReasonFromError })`,
    context
  )
}

function loadMcpRpc(hostRequest) {
  const context = { host: { request: hostRequest } }
  vm.createContext(context)
  return vm.runInContext(
    `${slice('async function mcpRpc(', 'function McpSetupButton(')}
;({ mcpRpc, mcpSetupSupported })`,
    context
  )
}

function loadCanonicalCreation({ openSession, request }) {
  const start = source.indexOf('const canonicalCreations = new Map()')
  const end = source.indexOf('function displayName(', start)
  const context = {
    host: { openSession, request },
    backendTargetProfile: (route, name) => route?.targetProfile || name,
    botOwner: name => ({ bot: { name }, key: name, name, route: null }),
    requestForBot: (_bot, method, params) => context.host.request(method, params),
    window: { setTimeout: callback => callback() }
  }
  assert.ok(start > -1 && end > start, 'canonical creation section exists')
  vm.runInNewContext(`${source.slice(start, end)}\nglobalThis.__c = { createCanonicalChat };`, context)
  return context.__c
}

// ── 1. profile origin on a remote target ────────────────────────────────────

test('cloneSourcesFromProfileList: target list → default first, envelope or bare array', () => {
  const { cloneSourcesFromProfileList } = loadOriginHelpers()

  assert.deepEqual(
    plain(cloneSourcesFromProfileList({ profiles: [{ name: 'omar' }, { name: 'default' }, { name: '' }, {}] })),
    ['default', 'omar']
  )
  assert.deepEqual(plain(cloneSourcesFromProfileList([{ name: 'a' }, { name: 'b' }])), ['default', 'a', 'b'])
  assert.deepEqual(plain(cloneSourcesFromProfileList(null)), ['default'])
  assert.deepEqual(plain(cloneSourcesFromProfileList({ profiles: 'nope' })), ['default'])
})

test('resolveCloneSource: fresh stays fresh on every target; remote picks are validated against the target', () => {
  const { resolveCloneSource } = loadOriginHelpers()

  // Fresh profile is a first-class remote choice — the issue's headline gap.
  assert.equal(resolveCloneSource('__none__', { remoteTarget: true, targetProfiles: ['default', 'omar'] }), null)
  assert.equal(resolveCloneSource('__none__', { remoteTarget: false }), null)
  // Local creates are untouched.
  assert.equal(resolveCloneSource('researcher', { remoteTarget: false }), 'researcher')
  // A remote pick that exists THERE is honored.
  assert.equal(resolveCloneSource('omar', { remoteTarget: true, targetProfiles: ['default', 'omar'] }), 'omar')
  // A name the remote box doesn't have (stale local pick) falls back to its default.
  assert.equal(resolveCloneSource('local-only', { remoteTarget: true, targetProfiles: ['default', 'omar'] }), 'default')
  // List not loaded yet / failed → default, never a guess.
  assert.equal(resolveCloneSource('omar', { remoteTarget: true, targetProfiles: null }), 'default')
  assert.equal(resolveCloneSource('omar', { remoteTarget: true, targetProfiles: [] }), 'default')
})

test('regression: the clone picker is never disabled or pinned to default for a remote target', () => {
  assert.doesNotMatch(source, /disabled: remoteTarget/)
  assert.doesNotMatch(source, /remoteTarget \? 'default' : cloneFrom/)
  assert.doesNotMatch(source, /clone_from: cloneFrom === '__none__' \? null : remoteTarget \? 'default' : cloneFrom/)
  assert.match(source, /clone_from: cloneSource,/)
  assert.match(source, /value: remoteTarget \? cloneSource \|\| '__none__' : cloneFrom,/)
  assert.match(source, /\.\.\.cloneChoices\.map\(name => jsx\(SelectItem, \{ value: name, children: name \}, name\)\)/)
  // The capability catalog preview follows the same resolved source.
  assert.match(source, /const capSource = cloneSource \|\| 'default'/)
  assert.match(source, /requestForTarget\('profiles\.describe', \{ name: capSource \}\)/)
})

test('requestForCreateTarget routes profile discovery and writes to the selected backend', async () => {
  const { requestForCreateTarget } = loadOriginHelpers()
  const calls = []
  const hostApi = {
    request: async (method, params) => calls.push({ via: 'ambient', method, params }),
    requestProfile: async (route, method, params) => calls.push({ via: 'profile', route, method, params })
  }

  await requestForCreateTarget(hostApi, { remoteTarget: false, targetConnection: 'ignored' }, 'profiles.list', {
    include_sessions: false
  })
  await requestForCreateTarget(hostApi, { remoteTarget: true, targetConnection: 'homelab' }, 'profiles.create', {
    name: 'omar',
    clone_from: null
  })

  assert.deepEqual(plain(calls), [
    { via: 'ambient', method: 'profiles.list', params: { include_sessions: false } },
    {
      via: 'profile',
      route: { connectionId: 'homelab', mode: 'remote', profile: 'default', targetProfile: 'default' },
      method: 'profiles.create',
      params: { name: 'omar', clone_from: null }
    }
  ])
})

// ── 2. target-explicit wording ──────────────────────────────────────────────

test('botInheritLabel names the owning connection; legacy rows keep the old label', () => {
  const { botInheritLabel } = loadOriginHelpers()

  assert.equal(botInheritLabel({ name: 'omar', connectionLabel: 'This device' }), 'Inherit from default on This device')
  assert.equal(botInheritLabel({ name: 'omar', connectionLabel: '  ' }), 'Inherit (launch profile)')
  assert.equal(botInheritLabel(null), 'Inherit (launch profile)')
})

test('regression: share-keys and inherit copy are scoped to the create target', () => {
  const dialog = slice('function CreateAgentDialog(', 'function routineBot(')

  assert.doesNotMatch(dialog, /'Share keys & accounts with the main profile'/)
  assert.match(dialog, /`Share keys & accounts with the default profile on \$\{credentialHostLabel\}`/)
  assert.match(dialog, /Credentials are never copied between machines\./)
  assert.match(dialog, /inheritLabel: `Inherit from default on \$\{credentialHostLabel\}`/)
  assert.match(dialog, /placeholderModel: `inherited from default on \$\{credentialHostLabel\}`/)
  // The host label is the TARGET's (remote) or the active connection's own row.
  assert.match(
    dialog,
    /const credentialHostLabel = remoteTarget\s*\? targetLabel\s*: \(connections \|\| \[\]\)\.find\(c => c\.id === \(activeConnectionId \|\| 'local'\)\)\?\.label \|\| 'this device'/
  )
  // Editor: every ModelPicker in AdvancedProfileConfig carries the bot-qualified label.
  const editor = slice('function AdvancedProfileConfig(', 'function HubSkillsSection(')
  assert.equal((editor.match(/jsx\(ModelPicker, \{\s*bot,\s*inheritLabel,/g) || []).length, 3)
  assert.match(source, /jsx\(SelectItem, \{ value: NONE, children: inheritLabel \}\)/)
})

// ── 3. provider readiness before the intro turn ─────────────────────────────

test('preflightProviderReadiness: ok=false → not ready with the backend reason; ok/unsupported/errors fail open', async () => {
  const { preflightProviderReadiness } = loadReadinessHelpers({ notify() {}, noteBotAttention() {} })
  const calls = []
  const request = answer => async (method, params) => {
    calls.push({ method, params })
    if (typeof answer === 'function') return answer()
    return answer
  }

  assert.deepEqual(
    plain(
      await preflightProviderReadiness(
        request({ ok: false, error: 'No usable credentials found for anthropic.' }),
        'omar'
      )
    ),
    { ready: false, reason: 'No usable credentials found for anthropic.' }
  )
  assert.deepEqual(plain(calls.at(-1)), { method: 'setup.runtime_check', params: { profile: 'omar' } })
  assert.deepEqual(plain(await preflightProviderReadiness(request({ ok: false }), 'omar')), {
    ready: false,
    reason: 'No inference provider is configured.'
  })
  assert.deepEqual(plain(await preflightProviderReadiness(request({ ok: true, provider: 'nous' }), 'omar')), {
    ready: true,
    reason: null
  })
  // Older gateway without the RPC / transport blip → ready (the intro turn reports itself).
  assert.deepEqual(
    plain(
      await preflightProviderReadiness(
        request(() => {
          throw new Error('unknown method: setup.runtime_check')
        }),
        'omar'
      )
    ),
    { ready: true, reason: null }
  )
  assert.deepEqual(plain(await preflightProviderReadiness(request(undefined), 'omar')), { ready: true, reason: null })
})

test('noteProviderSetupNeeded badges the bot as missing_config and points at the TARGET machine', () => {
  const badges = []
  const toasts = []
  const { noteProviderSetupNeeded } = loadReadinessHelpers({
    notify: toast => toasts.push(toast),
    noteBotAttention: (key, reason) => badges.push({ key, reason })
  })

  noteProviderSetupNeeded('local::omar', 'This device', 'No usable credentials found for anthropic.')

  assert.deepEqual(badges, [{ key: 'local::omar', reason: 'missing_config' }])
  assert.equal(toasts.length, 1)
  assert.equal(toasts[0].kind, 'info')
  assert.match(toasts[0].message, /^Configure a model on This device before this bot's first chat/)
  assert.match(toasts[0].message, /No usable credentials found for anthropic\./)
  assert.match(toasts[0].message, /run `hermes model` on This device/)
})

test('prepareBotFirstChat preflights before badging the owning target', async () => {
  const events = []
  const { prepareBotFirstChat } = loadReadinessHelpers({
    notify: toast => events.push({ type: 'notify', message: toast.message }),
    noteBotAttention: (key, reason) => events.push({ type: 'badge', key, reason })
  })

  const readiness = await prepareBotFirstChat({
    request: async (method, params) => {
      events.push({ type: 'request', method, params })
      return { ok: false, error: "Profile 'omar' does not exist on this backend." }
    },
    profile: 'omar',
    ownerKey: 'homelab::omar',
    hostLabel: 'Home Lab'
  })

  assert.deepEqual(plain(readiness), {
    ready: false,
    reason: "Profile 'omar' does not exist on this backend."
  })
  assert.deepEqual(
    events.map(event => event.type),
    ['request', 'badge', 'notify']
  )
  assert.deepEqual(plain(events[0]), {
    type: 'request',
    method: 'setup.runtime_check',
    params: { profile: 'omar' }
  })
  assert.deepEqual(events[1], { type: 'badge', key: 'homelab::omar', reason: 'missing_config' })
  assert.match(events[2].message, /^Configure a model on Home Lab/)
})

test('classifier: readiness-check phrasings classify as missing_config', () => {
  const { attentionReasonFromError } = loadClassifier()

  assert.equal(attentionReasonFromError('No usable credentials found for openrouter.'), 'missing_config')
  assert.equal(attentionReasonFromError('No Hermes provider is configured.'), 'missing_config')
  assert.equal(attentionReasonFromError('No inference provider is configured.'), 'missing_config')
  assert.equal(
    attentionReasonFromError('agent init failed: No LLM provider configured. Run `hermes model` to select a provider'),
    'missing_config'
  )
  // Transient classes still never badge.
  assert.equal(attentionReasonFromError('502 server error'), null)
})

test('regression: submit uses the preflight result to withhold the intro turn when unready', () => {
  const dialog = slice('function CreateAgentDialog(', 'function routineBot(')
  const preflight = dialog.indexOf('const readiness = await prepareBotFirstChat({')
  const resetAt = dialog.indexOf('reset()\n      onClose()', preflight)
  const intro = dialog.indexOf('createCanonicalChat(slug, { kickoff: true, ready: readiness.ready })')

  assert.ok(preflight > -1, 'preflight runs on the create target')
  assert.ok(resetAt > preflight, "preflight closes over this render's target before reset()")
  assert.ok(intro > resetAt, 'intro is gated on readiness')
  // Remote creates are preflighted and badged by the same helper before their
  // early return (they never create a local canonical chat).
  assert.ok(preflight < dialog.indexOf('if (wasRemote) {', preflight))
})

test('createCanonicalChat({ kickoff: true, ready: false }) creates, titles, pins and opens — and sends NO prompt', async () => {
  const events = []
  const { createCanonicalChat } = loadCanonicalCreation({
    openSession: async id => events.push(`open:${id}`),
    request: async method => {
      events.push(method)
      if (method === 'session.create') return { stored_session_id: 'stored-1', session_id: 'runtime-1' }
      return {}
    }
  })

  assert.equal(await createCanonicalChat('omar', { kickoff: true, ready: false }), 'stored-1')
  assert.deepEqual(events, ['session.list', 'session.create', 'session.title', 'open:stored-1'])
})

test('createCanonicalChat({ kickoff: true, ready: false }) still lands in the chat when the first open raced the lazy row', async () => {
  const events = []
  let attempts = 0
  const { createCanonicalChat } = loadCanonicalCreation({
    openSession: async id => {
      attempts += 1
      events.push(`open:${id}`)
      if (attempts === 1) throw new Error('not yet')
    },
    request: async method => {
      events.push(method)
      if (method === 'session.create') return { stored_session_id: 'stored-1', session_id: 'runtime-1' }
      return {}
    }
  })

  assert.equal(await createCanonicalChat('omar', { kickoff: true, ready: false }), 'stored-1')
  assert.deepEqual(events, ['session.list', 'session.create', 'session.title', 'open:stored-1', 'open:stored-1'])
  assert.equal(events.includes('prompt.submit'), false)
})

test('createCanonicalChat({ ready: false }) also withholds the old-gateway compat kickoff', async () => {
  // Eager session.title is rejected (older gateway) — on a ready target that
  // is the one case a non-kickoff mint still sends a persistence prompt. An
  // unready target must not: the lazy row is left to the next click instead.
  const events = []
  const { createCanonicalChat } = loadCanonicalCreation({
    openSession: async id => {
      events.push(`open:${id}`)
      throw new Error('Session not found')
    },
    request: async method => {
      events.push(method)
      if (method === 'session.create') return { stored_session_id: 'stored-1', session_id: 'runtime-1' }
      if (method === 'session.title') throw new Error('unknown method: session.title')
      return {}
    }
  })

  assert.equal(await createCanonicalChat('omar', { kickoff: true, ready: false }), 'stored-1')
  assert.deepEqual(events, ['session.list', 'session.create', 'session.title', 'open:stored-1', 'open:stored-1'])
})

test('createCanonicalChat({ kickoff: true }) on a ready target still introduces the bot (unchanged behavior)', async () => {
  const events = []
  const { createCanonicalChat } = loadCanonicalCreation({
    openSession: async () => undefined,
    request: async method => {
      events.push(method)
      if (method === 'session.create') return { stored_session_id: 'stored-1', session_id: 'runtime-1' }
      return {}
    }
  })

  await createCanonicalChat('omar', { kickoff: true })
  assert.equal(events.includes('prompt.submit'), true)
})

// ── 4. owner-routed editor / create surfaces ────────────────────────────────

test('mcpRpc rides the supplied request fn (owning backend) and falls back to host.request', async () => {
  const hostCalls = []
  const routed = []
  const { mcpRpc } = loadMcpRpc(async (method, params) => {
    hostCalls.push({ method, params })
    return 'ambient'
  })

  const viaRoute = await mcpRpc('mcp.servers.list', { profile: 'omar' }, async (method, params) => {
    routed.push({ method, params })
    return 'owner'
  })
  assert.deepEqual(plain(viaRoute), { ok: true, result: 'owner' })
  assert.deepEqual(routed, [{ method: 'mcp.servers.list', params: { profile: 'omar' } }])
  assert.deepEqual(hostCalls, [])

  const ambient = await mcpRpc('mcp.servers.list', {})
  assert.deepEqual(plain(ambient), { ok: true, result: 'ambient' })
  assert.equal(hostCalls.length, 1)

  const unsupported = await mcpRpc('mcp.servers.list', {}, async () => {
    throw new Error('unknown method: mcp.servers.list')
  })
  assert.deepEqual(plain(unsupported), { ok: false, unsupported: true })
})

test('mcpSetupSupported probes and caches each owning backend independently', async () => {
  const ambientCalls = []
  const oldCalls = []
  const newCalls = []
  const { mcpSetupSupported } = loadMcpRpc(async (...args) => ambientCalls.push(args))
  const oldBackend = async (method, params) => {
    oldCalls.push({ method, params })
    throw new Error(`unknown method: ${method}`)
  }
  const newBackend = async (method, params) => {
    newCalls.push({ method, params })
    return { servers: [] }
  }

  assert.equal(await mcpSetupSupported(oldBackend, 'connection:old'), false)
  assert.equal(await mcpSetupSupported(newBackend, 'connection:new'), true)
  assert.equal(await mcpSetupSupported(oldBackend, 'connection:old'), false)
  assert.equal(await mcpSetupSupported(newBackend, 'connection:new'), true)

  assert.deepEqual(plain(oldCalls), [{ method: 'mcp.servers.list', params: {} }])
  assert.deepEqual(plain(newCalls), [{ method: 'mcp.servers.list', params: {} }])
  assert.deepEqual(ambientCalls, [])
})

test('regression: MCP setup + hub installs carry the owning route (editor) or the create target (New Bot)', () => {
  const button = slice('function McpSetupButton(', 'function botAppearance(')
  assert.match(button, /const rpc = \(method, params\) => mcpRpc\(method, params, request\)/)
  assert.doesNotMatch(button, /await mcpRpc\(/)
  assert.equal((button.match(/await rpc\(/g) || []).length, 6)

  const editor = slice('function AdvancedProfileConfig(', 'function HubSkillsSection(')
  assert.match(editor, /const requestForThisBot = \(method, params\) => requestForBot\(bot, method, params\)/)
  // The editor passes the bot's logical NAME (requestForBot rewrites it to
  // the backend profile) — never the {connectionId, profile} scope object.
  assert.match(editor, /jsx\(McpSetupButton, \{\s*profile: bot\.name,\s*entry: m,\s*request: requestForThisBot,/)
  assert.match(editor, /jsx\(HubSkillsSection, \{\s*forProfile: bot\.name,\s*request: requestForThisBot,/)
  assert.doesNotMatch(editor, /profile: backendScope,\s*entry: m/)
  assert.doesNotMatch(editor, /forProfile: backendScope/)

  const hub = slice('function HubSkillsSection(', 'function emptyAdvancedState(')
  assert.match(hub, /function HubSkillsSection\(\{ forProfile, onInstalled, request \}\)/)
  assert.doesNotMatch(hub, /host\.request\('skills\.manage'/)
  assert.match(hub, /await send\('skills\.manage', \{ action: 'search', query: q \}\)/)
  assert.match(hub, /await send\('skills\.manage', \{\s*action: 'install',/)

  const dialog = slice('function CreateAgentDialog(', 'function routineBot(')
  assert.match(dialog, /ensureProfile: ensureAgentCreated,\s*request: requestForTarget,/)
  assert.match(dialog, /jsx\(HubSkillsSection, \{\s*forProfile: null,\s*request: requestForTarget,/)
})
