/**
 * The cross-connection bot relay: the Desktop-as-router loops that let a bot
 * on one gateway reach a bot on another.
 *
 * There is one relay per renderer, so its lifecycle lives in the module-scoped
 * `relay` record below rather than in an atom — no UI reads it. plugin.tsx
 * drives the two doors, startBotRelay / stopBotRelay.
 */

import { host, LruCache } from '@hermes/plugin-sdk'

import { botHandle, clearBotAttention, noteBotAttention } from './data'
import { RELAY_DELIVER_TIMEOUT_MS } from './relay-budget'
import { ID } from './shared'
import type { ProfileRoute, RosterRow } from './types'

// ── cross-connection bot relay ────────────────────────────────────────────
// Connections ARE the peer set: every gateway this Desktop holds a socket
// to (local, remote URL, SSH, Hermes Cloud, docker) must be able to find
// every other connection's agents and message them via message_agent. The
// Desktop is the relay — it owns every socket. Two loops:
//  - roster loop: pushes each gateway the union roster of agents on the
//    OTHER connections (bot_relay.roster.sync), so message_agent resolves
//    cross-connection targets and Bot Chat prompts list them;
//  - drain loop: collects queued envelopes from every gateway
//    (bot_relay.outbox.drain), delivers each on the target connection's
//    own socket (bot_relay.deliver), and posts the reply back to the
//    sender gateway (bot_relay.reply) where a waiter wakes the sender.
// Older backends without the RPCs fail per-call and are skipped — the
// relay degrades to whatever subset of connections supports it.
const RELAY_ROSTER_INTERVAL_MS = 60_000
// Backstop cadence only (#93594): the push path below carries envelope latency,
// so the interval poll exists for older backends that cannot signal
// `bot_relay.outbox.pending`. On a shell with that door, the tick must not
// open a gateway socket for a route that has not signaled outbox work — that
// dial/teardown is the idle ~30s cost (#118856). It was 4s back when the
// poll WAS the delivery path, which (before route retention) also meant a
// fresh WebSocket dial + teardown per registered connection every 4s.
const RELAY_DRAIN_INTERVAL_MS = 30_000
// Push path (#93091): the gateway broadcasts `bot_relay.outbox.pending` when
// an envelope lands on disk; a burst of signals inside this window collapses
// to ONE drain. The interval poll above stays as the backstop for older
// backends (and connections whose events don't reach the tap).
const RELAY_PUSH_DEBOUNCE_MS = 250

/** Everything the two loops mutate. */
interface RelayLifecycle {
  disposed: boolean
  drainBusy: boolean
  /** A push landing while a drain is ALREADY running would be lost forever —
   *  the gateway signature is monotone (one event per new envelope, never
   *  re-broadcast) — so remember it and re-schedule after the drain finishes. */
  drainRerun: boolean
  drainTimer: null | ReturnType<typeof setInterval>
  pushDebounceTimer: null | ReturnType<typeof setTimeout>
  pushUnsub: (() => void) | null
  rosterBusy: boolean
  /** Invalidates pending roster reads when the relay stops or restarts. */
  rosterGeneration: number
  /** Id of the sole connection whose roster clear went out; null once the peer set relays again. */
  rosterClearedFor: null | string
  rosterTimer: null | ReturnType<typeof setInterval>
}

const relay: RelayLifecycle = {
  disposed: false,
  drainBusy: false,
  drainRerun: false,
  drainTimer: null,
  pushDebounceTimer: null,
  pushUnsub: null,
  rosterBusy: false,
  rosterGeneration: 0,
  rosterClearedFor: null,
  rosterTimer: null
}

// Relay-route socket retention (#93594): connection id → release fn. While
// the relay is active each registered connection's pooled socket is pinned
// open (host.retainProfileSocket) so drain RPCs reuse ONE persistent
// WebSocket instead of dialing and tearing down a fresh one per tick.
// Feature-detected — older shells lack the door and fall back to per-call
// leases. Local routes get a no-op release inside the host (idle-reaper
// exemption). stopBotRelay releases everything.
const relayRouteRetentions = new Map<string, () => void>()
// Claimed envelopes remain pinned to their sender until terminal reply ACK.
// The sender's durable claimed directory restores these after renderer restart.
const pendingRelays = new Map<string, Map<string, RelayEnvelope>>()

function pendingRelaysFor(sender: RelayConnection): Map<string, RelayEnvelope> {
  const senderKey = JSON.stringify(sender.route)
  const pending = pendingRelays.get(senderKey) || new Map<string, RelayEnvelope>()
  pendingRelays.set(senderKey, pending)

  return pending
}

// Routes whose gateway has signaled `bot_relay.outbox.pending` since the last
// drain pass. `*` means the event carried no connection id (local/legacy
// primary, or an older payload) — every route may hold that envelope, so the
// pass still visits them. A route absent from this set has no outbox work;
// opening a socket to drain it is the idle dial.
const RELAY_OUTBOX_ANY = '*'
const routesWithOutboxWork = new Set<string>()

function relayBotModeOn(): boolean {
  const decisions = host.pluginDecisions?.get() ?? {}

  return ID in decisions ? Boolean(decisions[ID]) : true
}

function noteRelayOutboxWork(event?: { connectionId?: string }) {
  const id = String(event?.connectionId || '').trim()

  routesWithOutboxWork.add(id || RELAY_OUTBOX_ANY)
}

function takeRelayOutboxWork(): { any: boolean; ids: Set<string> } {
  const any = routesWithOutboxWork.has(RELAY_OUTBOX_ANY)
  const ids = new Set(routesWithOutboxWork)

  routesWithOutboxWork.clear()

  return { any, ids }
}

function routeSignaledOutboxWork(connectionId: string, work: { any: boolean; ids: Set<string> }): boolean {
  return work.any || work.ids.has(connectionId)
}

/** One reachable gateway plus a representative route onto it. The route carries
 *  identity only, so the human label comes from the registry (connectionLabels). */
interface RelayConnection {
  id: string
  route: ProfileRoute
}

/** One agent as pushed to a peer gateway's relay roster. */
interface RelayAgentRow {
  connection_id: string
  connection_label: string
  description: string
  handle: string
  /** The answering gateway's install id: lets the receiving gateway tell one machine two
   *  Desktops relay from two machines both Desktops call by the same connection name. */
  install_id?: string
  profile: string
  title: string
}

// ── the Desktop's own machine, as other gateways must name it (#142128) ──
// 'local' is the registry's reserved id for the machine THIS Desktop runs on —
// and every Desktop has one. Rows stamped with it in another gateway's relay
// roster read as "whichever Desktop drains the envelope": a server holding two
// Desktops' pushes delivered `default@local` to the wrong machine's default.
// Outbound, the id becomes `local-<first 12 hex of that gateway's install id>`
// (tools/bot_relay.py own_relay_connection_id mirrors it, so the gateway also
// recognises its own form); inbound, the drain maps it back. A local backend
// that reports no install id keeps the legacy 'local'. Until the local gateway
// has answered, this Desktop cannot tell its own machine from another one, so
// an envelope that needs that answer waits for it instead of guessing.
const LOCAL_CONNECTION_ID = 'local'
const INSTALL_ID_RE = /^[0-9a-f]{32}$/
const LOCAL_RELAY_ID_RE = /^local-[0-9a-f]{12}$/

/** The relay id of `connectionId` given the install id its gateway reports. */
function relayConnectionId(connectionId: string, installId?: unknown): string {
  const install = String(installId || '')
    .trim()
    .toLowerCase()

  return connectionId === LOCAL_CONNECTION_ID && INSTALL_ID_RE.test(install)
    ? `${LOCAL_CONNECTION_ID}-${install.slice(0, 12)}`
    : connectionId
}

/** This Desktop's local relay id from the local gateway's profiles.list: `local-<install>`, the
 *  bare 'local' when that gateway reports no install id (legacy), null while it has not answered. */
let localRelayId: null | string = null

function noteRelayInstall(connectionId: string, installId: unknown) {
  if (connectionId === LOCAL_CONNECTION_ID) {
    localRelayId = relayConnectionId(connectionId, installId)
  }
}

/** `connectionId` as the relay names it to other gateways, for text that hands a bot a target
 *  (the @mention note): what the relay itself learned first, else the install id the union
 *  roster saw. null while this machine's id is unknown — a guessed bare 'local' could reach
 *  another Desktop's machine — and for a registry connection in the `local-<hex>` namespace:
 *  the relay does not relay it, and that id names some Desktop's own machine instead. */
export function relayTargetConnection(connectionId: string, installId?: unknown): null | string {
  if (connectionId !== LOCAL_CONNECTION_ID && LOCAL_RELAY_ID_RE.test(connectionId.toLowerCase())) {
    return null
  }

  if (connectionId !== LOCAL_CONNECTION_ID || localRelayId !== null) {
    return relayWireId(connectionId)
  }

  const id = relayConnectionId(connectionId, installId)

  return id === LOCAL_CONNECTION_ID ? null : id
}

/** What another gateway calls `connectionId`. */
function relayWireId(connectionId: string): string {
  return connectionId === LOCAL_CONNECTION_ID && localRelayId ? localRelayId : connectionId
}

// ── who is pushing a roster (#139219) ──
// Every Desktop relaying for a gateway pushes it a roster; the gateway keeps one slice per
// publisher and resolves against their union, so two Desktops no longer overwrite each other
// (the last push used to win and a bare name flapped between machines). Each renderer runs its
// own relay with its own reads, so the publisher is per window, not per install: two windows of
// one Desktop must not replace each other's slice either. Kept in sessionStorage, which a window
// keeps across reloads, so a reload replaces its own slice instead of leaving one to expire.
const PUBLISHER_STORAGE_KEY = 'hermes.botRelay.publisher'
const PUBLISHER_RE = /^desktop-[0-9a-f]{12}$/

function windowPublisherId(): string {
  try {
    const kept = window.sessionStorage.getItem(PUBLISHER_STORAGE_KEY) || ''

    if (PUBLISHER_RE.test(kept)) {
      return kept
    }
  } catch {
    // No storage (tests, sandboxed renderer): a per-run id.
  }

  const id = `desktop-${Array.from({ length: 12 }, () => Math.floor(Math.random() * 16).toString(16)).join('')}`

  try {
    window.sessionStorage.setItem(PUBLISHER_STORAGE_KEY, id)
  } catch {
    // Per-run id only.
  }

  return id
}

const RUN_PUBLISHER_ID = windowPublisherId()

function rosterPublisher(): string {
  return RUN_PUBLISHER_ID
}

/** The sender gateway listed the Desktops whose roster carried the envelope's target and it is
 *  not this one's alone: when this Desktop has no connection of that name, a listed Desktop
 *  that does delivers it, so a "not connected" reply here would beat that real answer. */
function listedForOthers(envelope: RelayEnvelope): boolean {
  return listedPublishers(envelope).some(id => id !== RUN_PUBLISHER_ID)
}

function listedPublishers(envelope: RelayEnvelope): string[] {
  return Array.isArray(envelope?.target_publishers) ? envelope.target_publishers.map(String) : []
}

/** This Desktop has a connection of the target's name, but the envelope names no install to check
 *  it against and lists only other Desktops: their machine of that name is the target, and this
 *  one's may be a different machine under the same name. */
function namedForOtherDesktops(envelope: RelayEnvelope): boolean {
  const listed = listedPublishers(envelope)

  return !envelope?.target_install && listed.length > 0 && !listed.includes(RUN_PUBLISHER_ID)
}

/** The install the target connection answers from right now ('' when it reports none), or
 *  null when it could not be asked. Asked per envelope that names a target install: a
 *  connection repointed since the last roster fetch would pass a cached check. */
async function liveInstall(route: ProfileRoute): Promise<null | string> {
  try {
    const res = await host.requestProfile<{ install_id?: string }>(route, 'profiles.list', {
      include_sessions: false
    })

    const install = String(res?.install_id || '')
      .trim()
      .toLowerCase()

    return INSTALL_ID_RE.test(install) ? install : ''
  } catch {
    return null
  }
}

/** Two Desktops can give different machines one connection name (#139219): whether this
 *  Desktop's connection of that name is the machine the envelope names. 'other' — it answers
 *  from another install, or reports none (the target's gateway did); 'unknown' — it could not
 *  be asked, so the envelope waits for a later drain instead of being delivered on a guess. */
async function targetInstallMatch(route: ProfileRoute, want: string): Promise<'other' | 'ok' | 'unknown'> {
  const have = await liveInstall(route)

  return have === null ? 'unknown' : have === want ? 'ok' : 'other'
}

/** The route an envelope is delivered on: the target connection, scoped to the target profile. */
function deliveryRouteOf(target: RelayConnection, envelope: RelayEnvelope): ProfileRoute {
  return { ...target.route, profile: String(envelope.target_profile), targetProfile: String(envelope.target_profile) }
}

/** Pin `route`'s socket for one delivery once it answers from the install the envelope names:
 *  the check and the delivery then ride ONE socket (the pool keys sockets per connection and
 *  profile, so a representative route could answer from the machine before an edit). Returns
 *  the release, or null when the envelope must wait (other install, or none could be asked). */
async function holdTarget(route: ProfileRoute, envelope: RelayEnvelope): Promise<(() => void) | null> {
  const want = String(envelope?.target_install || '').toLowerCase()

  if (!want) {
    return () => {}
  }

  let held: unknown = null

  try {
    held = typeof host.retainProfileSocket === 'function' ? host.retainProfileSocket(route) : null
  } catch {
    held = null
  }

  const release = () => {
    try {
      if (typeof held === 'function') {
        held()
      }
    } catch {
      // Disposer from an older shell shape — never break delivery.
    }
  }

  if ((await targetInstallMatch(route, want)) === 'ok') {
    return release
  }

  release()

  return null
}

/** A gateway from before the slices refusing the unknown `publisher` key: the canonical door
 *  answers a typed invalid_params, the tui_gateway door a 4000 naming the field. */
function refusedPublisher(error: any): boolean {
  return (
    String(error?.data?.reason || '') === 'invalid_params' ||
    (error?.code === 4000 && String(error?.message || '').includes('publisher'))
  )
}

/** Push `agents` as this Desktop's roster slice; to a gateway from before the slices, the
 *  legacy way (it replaces its whole roster, as it always did). */
async function pushRelayRoster(route: ProfileRoute, agents: RelayAgentRow[]) {
  try {
    await host.requestProfile(route, 'bot_relay.roster.sync', { agents, publisher: rosterPublisher() })
  } catch (error: any) {
    if (!refusedPublisher(error)) {
      throw error
    }

    await host.requestProfile(route, 'bot_relay.roster.sync', { agents })
  }
}

/** A target id naming some Desktop's local machine: a `local-<install>` form, or the
 *  legacy bare 'local' an older Desktop pushed. */
function namesALocalMachine(id: string): boolean {
  return id === LOCAL_CONNECTION_ID || LOCAL_RELAY_ID_RE.test(id.toLowerCase())
}

/** Remove the mandatory local registry source only when Electron identifies
 * one unambiguous REMOTE primary. Older or inconsistent route inventories
 * fail open to the prior peer set. Distinct remote peers always remain. */
function relayEligibleRoutes(routes: ProfileRoute[]): ProfileRoute[] {
  const routesByConnection = new Map<string, ProfileRoute[]>()

  for (const route of routes) {
    if (
      !route ||
      typeof route.connectionId !== 'string' ||
      !route.connectionId ||
      (route.mode !== 'local' && route.mode !== 'remote') ||
      (route.primary !== undefined && route.primary !== true)
    ) {
      return routes
    }

    const grouped = routesByConnection.get(route.connectionId) || []

    grouped.push(route)
    routesByConnection.set(route.connectionId, grouped)
  }

  const primaryGroups = [...routesByConnection.entries()].filter(([, grouped]) =>
    grouped.some(route => route.primary === true)
  )

  if (primaryGroups.length !== 1) {
    return routes
  }

  const [primaryId, primaryRoutes] = primaryGroups[0]

  if (primaryRoutes.some(route => route.mode !== 'remote' || route.primary !== true)) {
    return routes
  }

  const localGroups = [...routesByConnection.entries()].filter(([, grouped]) =>
    grouped.some(route => route.mode === 'local')
  )

  if (
    localGroups.length !== 1 ||
    localGroups[0][1].some(route => route.mode !== 'local') ||
    localGroups[0][0] === primaryId
  ) {
    return routes
  }

  const localId = localGroups[0][0]

  return routes.filter(route => route.connectionId !== localId)
}

/** A queued cross-connection message drained from a gateway's outbox. */
interface RelayEnvelope {
  canonical_delivery_v1?: boolean
  id?: string
  message?: string
  from_profile?: string
  from_handle?: string
  target_connection?: string
  /** The target machine's install id when the sender gateway knew it (#139219). */
  target_install?: string
  /** The Desktops whose roster listed the target when it was sent (#139219). */
  target_publishers?: unknown
  target_profile?: string
}

/** Reconcile retention with the CURRENT connection set: pin new connections,
 *  release removed ones. Runs on every drain/roster connection fetch. */
function syncRelayRetention(connections: RelayConnection[]) {
  if (typeof host.retainProfileSocket !== 'function') {
    return
  }

  const live = new Set(connections.map(connection => JSON.stringify(connection.route)))

  for (const [id, release] of [...relayRouteRetentions]) {
    if (!live.has(id)) {
      relayRouteRetentions.delete(id)

      try {
        release()
      } catch {
        // Never let a release failure break the relay loop.
      }
    }
  }

  if (relay.disposed) {
    return
  }

  for (const connection of connections) {
    if (!relayRouteRetentions.has(JSON.stringify(connection.route))) {
      relayRouteRetentions.set(JSON.stringify(connection.route), host.retainProfileSocket(connection.route))
    }
  }
}

/** Drop every relay pin — stop/dispose path. */
function releaseRelayRetention() {
  for (const release of relayRouteRetentions.values()) {
    try {
      release()
    } catch {
      // Disposer from an older shell shape — never break teardown.
    }
  }

  relayRouteRetentions.clear()
}

/** Every relay-eligible profile route, once each. The canonical gateway keeps a
 *  roster and an outbox per profile home, so drain/roster/pins are per ROUTE;
 *  the peer set (is there anything to relay between?) is per connection id. */
async function relayConnections(): Promise<RelayConnection[]> {
  if (typeof host.profileRoutes !== 'function' || typeof host.requestProfile !== 'function') {
    return []
  }

  try {
    const rawRoutes = await host.profileRoutes()

    // `local-<hex>` is the relay's name for a Desktop's OWN machine on every gateway: a registry
    // connection whose label slugs into that namespace would be indistinguishable from one (on
    // this Desktop or any other), so it is not relayed at all.
    const routes = relayEligibleRoutes(Array.isArray(rawRoutes) ? rawRoutes : []).filter(
      route => !LOCAL_RELAY_ID_RE.test(String(route?.connectionId || '').toLowerCase())
    )

    const byConnection = new Map<string, ProfileRoute>()

    for (const route of routes) {
      const id = String(route?.connectionId || '')

      const key = JSON.stringify(route)

      if (id && !byConnection.has(key)) {
        byConnection.set(key, route)
      }
    }

    return [...byConnection.values()].map(route => ({
      id: route.connectionId,
      route
    }))
  } catch {
    return []
  }
}

/** Distinct connections among the relay routes: profiles of one connection are not peers. */
function peerCount(connections: RelayConnection[]): number {
  return new Set(connections.map(connection => connection.id)).size
}

/** Human label per connection id, from the registry — the only place that has one.
 *  A `host.profileRoutes()` route carries identity alone, so without this the roster a
 *  peer gateway shows its bots ("@chii on 127-0-0-1-9119", tools/bot_mode_probe.py) and
 *  its refusal text name machines by raw connection id. A build with no registry rejects
 *  the call, and ids stay. */
async function connectionLabels(): Promise<Map<string, string>> {
  if (typeof host.connections !== 'function') {
    return new Map()
  }

  try {
    const rows = await host.connections()

    return new Map(
      (Array.isArray(rows) ? rows : [])
        .map(row => [String(row?.id || ''), String(row?.label || '').trim()] as const)
        .filter(([id, label]) => Boolean(id && label))
    )
  } catch {
    return new Map()
  }
}

/** The agents living on one connection, as relay roster rows.
 *  Returns null on FAILURE (transient RPC blip, slow socket) — distinct from
 *  a genuine empty profile list. Conflating the two would push a fresh union
 *  roster missing a LIVE connection's agents, and the gateway-side liveness
 *  check (bot_relay._target_liveness) reads "absent from a fresh roster" as
 *  definitively offline → false runtime_offline refusals (#93091 item 2). */
async function relayAgentsOn(
  connection: RelayConnection,
  labels: Map<string, string>
): Promise<RelayAgentRow[] | null> {
  try {
    const res = await host.requestProfile<{ install_id?: string; profiles?: RosterRow[] }>(
      connection.route,
      'profiles.list',
      {
        include_sessions: false
      }
    )

    const profiles = Array.isArray(res?.profiles) ? res.profiles : []
    // This connection's default is @hermes only while it has no real 'hermes' profile.
    const hermesTaken = profiles.some(profile => profile?.name === 'hermes')
    const label = labels.get(connection.id) || connection.id

    noteRelayInstall(connection.id, res?.install_id)

    const install = String(res?.install_id || '')
      .trim()
      .toLowerCase()

    const rows = profiles
      .map(profile => ({
        profile: String(profile?.name || ''),
        handle: botHandle(
          profile?.name,
          hermesTaken && profile?.name === 'default' ? { ...profile, hermesHandleTaken: true } : profile
        ),
        connection_id: relayWireId(connection.id),
        connection_label: label,
        title: String(profile?.ui_meta?.['hermes-bots']?.title || profile?.display_name || ''),
        description: String(profile?.description || ''),
        ...(INSTALL_ID_RE.test(install) ? { install_id: install } : {})
      }))
      .filter(row => row.profile)

    host.traceIdentityChange?.(
      'bot-relay',
      `rows ${connection.id}`,
      rosterTrace(rows, String(res?.install_id || ''), connection.id)
    )

    return rows
  } catch {
    return null
  }
}

/** Which connection last answered from each install: a second connection
 *  answering from the same machine is a misrouted request (or one machine
 *  registered twice) and is flagged in the trace. */
const answeringInstall = new Map<string, string>()

function rosterTrace(rows: RelayAgentRow[], installId: string, connectionId: string): string {
  const other = installId ? answeringInstall.get(installId) : undefined
  const flag = other && other !== connectionId ? `MISROUTED (same install as ${other}) ` : ''

  if (installId && connectionId && !flag) {
    answeringInstall.set(installId, connectionId)
  }

  return `${flag}install=${installId.slice(0, 8) || '-'} n=${rows.length} [${rows.map(row => `${row.connection_id}/${row.profile}=${JSON.stringify(row.title)}`).join(' ')}]`
}

/** Last good agent rows per connection id — reused when a fetch blips so a
 *  transient failure never reads as "everyone on that machine went away".
 *  The sweep below drops disconnected ids, but only on a cycle that had two
 *  or more connections to relay between; the ceiling is what bounds the rest.
 *  Every live connection is rewritten each cycle, so eviction can only ever
 *  reach ids that stopped being fetched. */
const RELAY_AGENTS_CACHE_MAX = 32
const relayAgentsCache = new LruCache<string, RelayAgentRow[]>(RELAY_AGENTS_CACHE_MAX)

/** Push every gateway the union roster of agents on the OTHER connections. */
async function syncRelayRosters() {
  if (relay.disposed || relay.rosterBusy || !relayBotModeOn()) {
    return
  }

  relay.rosterBusy = true
  const generation = relay.rosterGeneration
  const isCurrent = () => !relay.disposed && relay.rosterGeneration === generation && relayBotModeOn()

  try {
    const connections = await relayConnections()

    if (!isCurrent()) {
      return
    }

    // A connection removed and re-added under a new id answers from the same
    // install; remembering the departed id flagged the replacement MISROUTED.
    const live = new Set(connections.map(connection => connection.id))

    for (const [install, connectionId] of answeringInstall) {
      if (!live.has(connectionId)) {
        answeringInstall.delete(install)
      }
    }

    const labels = await connectionLabels()

    if (!isCurrent()) {
      return
    }

    if (peerCount(connections) < 2) {
      // Nothing to relay — but the gateways that remain still hold the last
      // pushed roster, so a departed machine's agents would stay in every
      // bot's prompt (and as message_agent targets) until a second connection
      // reappears. Push the now-empty roster once per sole connection so it
      // forgets it — a replacement sole connection has never been told. An
      // empty route list (registry not loaded yet) must not spend the clear.
      if (peerCount(connections) === 1 && connections[0].id !== relay.rosterClearedFor) {
        const cleared = await Promise.all(
          connections.map(async connection => {
            if (!isCurrent()) {
              return false
            }

            try {
              await pushRelayRoster(connection.route, [])

              return true
            } catch {
              // An older backend without the relay RPCs, but also a socket that is not up yet —
              // requestProfile throws for both. Either way this gateway still holds the departed
              // machine's agents, so the clear is NOT spent and the next tick tries again.
              return false
            }
          })
        )

        // Spend it only once every gateway has actually forgotten.
        if (isCurrent() && cleared.every(Boolean)) {
          relay.rosterClearedFor = connections[0].id
        }
      }

      return
    }

    relay.rosterClearedFor = null

    const agentsByConnection = new Map<string, RelayAgentRow[]>()
    // One profiles.list per connection: its routes share a socket and answer one profile set.
    const firstRoutes = connections.filter((connection, index) => connections.findIndex(other => other.id === connection.id) === index)
    await Promise.all(
      firstRoutes.map(async connection => {
        const agents = await relayAgentsOn(connection, labels)

        if (!isCurrent()) {
          return
        }

        if (agents === null) {
          // Transient fetch failure: reuse the last good rows for this
          // connection (or contribute nothing this cycle) so the pushed
          // roster never drops a live machine's agents — absence from a
          // fresh roster means offline to the gateway-side fail-fast.
          agentsByConnection.set(connection.id, relayAgentsCache.get(connection.id) || [])
        } else {
          relayAgentsCache.set(connection.id, agents)
          agentsByConnection.set(connection.id, agents)
        }
      })
    )

    if (!isCurrent()) {
      return
    }

    // Connections gone from profileRoutes are genuinely disconnected — drop
    // their cache so a later reconnect starts from live data.
    const liveIds = new Set(connections.map(connection => connection.id))

    for (const id of [...relayAgentsCache.keys()]) {
      if (!liveIds.has(id)) {
        relayAgentsCache.delete(id)
      }
    }

    await Promise.all(
      connections.map(async connection => {
        if (!isCurrent()) {
          return
        }

        const others: RelayAgentRow[] = []

        for (const [id, agents] of agentsByConnection) {
          if (id !== connection.id) {
            others.push(...agents)
          }
        }

        try {
          await pushRelayRoster(connection.route, others)
        } catch {
          // Older backend without the relay RPCs — skip this connection.
        }
      })
    )
  } finally {
    if (relay.rosterGeneration === generation) {
      relay.rosterBusy = false
    }
  }
}

/** Drain every gateway's outbox and deliver each envelope on the target
 *  connection's own socket; the reply (or error) is posted back to the
 *  sender gateway for its waiter. */
async function drainRelayOutboxes() {
  if (relay.disposed || !relayBotModeOn()) {
    return
  }

  if (relay.drainBusy) {
    // A push signal raced an in-flight drain. The gateway never re-sends it
    // (monotone signature), so without this flag the envelope would wait out
    // the full poll interval — exactly the latency the push path removes.
    relay.drainRerun = true

    return
  }

  relay.drainBusy = true

  try {
    const connections = await relayConnections()

    // Retention follows the relay-eligible set: with fewer than two
    // connections there is nothing to relay, so nothing stays pinned.
    syncRelayRetention(peerCount(connections) >= 2 ? connections : [])

    if (peerCount(connections) < 2) {
      return
    }

    // A shell with the push door already knows which routes have mail. Do not
    // open a throwaway socket to ask a route that has not signaled — Bot Mode
    // off is the early return above; no outbox work is this skip (#118856).
    // Older shells have no event, so the interval remains their only drain.
    const pushDoor = typeof host.onEvent === 'function'
    const work = pushDoor ? takeRelayOutboxWork() : { any: true, ids: new Set<string>() }

    const byId = new Map(connections.map(connection => [connection.id, connection]))

    // Phase 1 — claim every gateway's outbox before delivering anything. The
    // gateway checks an envelope's age against bot_mode.envelope_ttl_seconds
    // AT the claim, so a claim must never wait behind another gateway's
    // delivery turn: draining and delivering sender by sender let one long
    // turn (up to RELAY_DELIVER_TIMEOUT_MS) age a sibling gateway's envelope
    // past the TTL before it was even claimed, and that sender's waiter got
    // `queued_expired` for a message nothing was wrong with.
    const queued: RelayQueuedEnvelope[] = []

    for (const sender of connections) {
      if (pushDoor && !routeSignaledOutboxWork(sender.id, work)) {
        continue
      }

      try {
        const res = await drainRelayOutbox(sender.route)

        const pending = pendingRelaysFor(sender)
        const offered = Array.isArray(res?.envelopes) ? res.envelopes : []

        for (const envelope of offered) {
          if (envelope.id && !pending.has(envelope.id)) {pending.set(envelope.id, structuredClone(envelope))}
        }

        forgetSettledPins(pending, offered)

        // Every claimed-but-unACKed envelope rides again: a delivery that
        // settled without an exact identity, or whose ACK was lost, retries
        // from the sender's pin instead of being silently dropped.
        for (const envelope of pending.values()) {
          queued.push({ envelope, sender })
        }
      } catch {
        // Older backend without the relay RPCs — skip this connection.
      }
    }

    // Phase 2 — deliver, without holding the drain. Envelopes for the same
    // target profile stay in order, one turn at a time (the target gateway
    // serialises that profile's turns behind its turn lock anyway; a second
    // envelope sent while the first runs would only burn its lock-wait
    // budget). Different targets run concurrently, so one long turn never
    // holds every other bot's mail. The lanes outlive this drain: `drainBusy`
    // covers the claim only, so a push that lands while a turn runs claims
    // its envelope NOW instead of after that turn — otherwise the TTL clock
    // kept running against a message the Desktop had not even looked at.
    learnLocalRelayId(queued, byId)

    for (const { envelope, sender } of queued) {
      enqueueRelayDelivery(sender, envelope, byId)
    }
  } finally {
    relay.drainBusy = false

    if (relay.drainRerun && !relay.disposed) {
      // Envelopes signaled mid-drain: schedule one follow-up pass (debounced)
      // instead of leaving them to the interval poll.
      relay.drainRerun = false
      scheduleRelayPushDrain()
    }
  }
}

/** Claim `route`'s outbox as this window: the gateway offers an envelope that lists the Desktops
 *  relaying its target to those only (#139219). A gateway from before the slices refuses the key
 *  and drains the legacy way. */
async function drainRelayOutbox(route: ProfileRoute): Promise<{ envelopes?: RelayEnvelope[] }> {
  try {
    return await host.requestProfile<{ envelopes?: RelayEnvelope[] }>(route, 'bot_relay.outbox.drain', {
      publisher: rosterPublisher()
    })
  } catch (error: any) {
    if (!refusedPublisher(error)) {
      throw error
    }

    return host.requestProfile<{ envelopes?: RelayEnvelope[] }>(route, 'bot_relay.outbox.drain', {})
  }
}

/** The gateway re-offers a canonical envelope on every drain until its reply lands or it times
 *  out (tools/bot_relay.py _replay_unanswered), so one it no longer offers is settled: a pin kept
 *  for it (a deferred delivery) must not deliver it after that. Older envelopes keep their pin —
 *  for them it is the only retry. */
function forgetSettledPins(pending: Map<string, RelayEnvelope>, offered: RelayEnvelope[]) {
  const ids = new Set(offered.map(envelope => envelope?.id))

  for (const [id, pinned] of pending) {
    if (pinned?.canonical_delivery_v1 === true && !ids.has(id)) {
      pending.delete(id)
    }
  }
}

interface RelayQueuedEnvelope {
  envelope: RelayEnvelope
  sender: RelayConnection
}

// Delivery lanes: `target_connection::target_profile` → the tail of that
// target's in-flight deliveries. A lane entry is removed once its tail
// settles so an idle target holds no state.
const relayLanes = new Map<string, Promise<void>>()

/** Queue one claimed envelope behind the deliveries already running for the
 *  same target profile; other targets are untouched. */
function enqueueRelayDelivery(sender: RelayConnection, envelope: RelayEnvelope, byId: Map<string, RelayConnection>) {
  const key = `${String(envelope?.target_connection || '')}::${String(envelope?.target_profile || '')}`

  const tail = (relayLanes.get(key) ?? Promise.resolve()).then(() =>
    relay.disposed ? undefined : deliverRelayEnvelope(sender, envelope, byId)
  )

  relayLanes.set(key, tail)
  void tail.finally(() => {
    if (relayLanes.get(key) === tail) {
      relayLanes.delete(key)
    }
  })
}

function relayDeliverParams(sender: RelayConnection, envelope: RelayEnvelope, envelopeId: string) {
  return {
    id: envelopeId,
    profile: String(envelope?.target_profile || ''),
    message: String(envelope?.message || ''),
    from_profile: String(envelope?.from_profile || ''),
    from_handle: String(envelope?.from_handle || ''),
    from_connection: relayWireId(String(sender.id))
  }
}

type RelayDeliverResult = {
  status?: string
  delivery_id?: string
  admission_id?: string | null
  refused?: true | null
  reply?: string
  error?: string
  reason?: string
}

/** Act on a `bot_relay.deliver` answer: only a settled/failed receipt for THIS
 *  envelope posts back; anything else stays retained for recovery. A receipt
 *  names its admission, or is `refused` (terminal `failed`, nothing admitted). */
async function settleRelayDelivery(
  res: RelayDeliverResult,
  envelopeId: string,
  attentionKey: string,
  postReply: (payload: { error?: string; reason?: string; reply?: string }) => Promise<void>
) {
  const refused = res.refused === true && res.status === 'failed'

  if (res.delivery_id !== envelopeId || !(res.admission_id || refused)) {
    noteBotAttention(attentionKey, 'Delivery identity unavailable; retained for recovery')

    return
  }

  if (res.status !== 'settled' && res.status !== 'failed') {
    if (res.status === 'ambiguous') {noteBotAttention(attentionKey, 'unknown_execution')}

    return
  }

  if (res.status === 'failed') {
    noteBotAttention(attentionKey, res.reason || res.error || 'delivery failed')
    await postReply({ error: res.error || res.reply || 'delivery failed', reason: res.reason })

    return
  }

  clearBotAttention(attentionKey)
  await postReply({
    reply: String(res?.reply || '')
  })
}

/** The connection an envelope's `target_connection` names on THIS Desktop; 'foreign' when it
 *  names another Desktop's local machine, 'unresolved' when that depends on an id this Desktop
 *  has not learned yet. Registry ids never use the `local-<hex>` namespace (relayConnections),
 *  and the bare 'local' is this machine only while its gateway reports no install id: from
 *  then on only an older Desktop's roster says 'local'. */
function relayTargetOf(
  id: string,
  byId: Map<string, RelayConnection>
): RelayConnection | 'foreign' | 'unresolved' | undefined {
  if (localRelayId !== null && id.toLowerCase() === localRelayId) {
    // Our machine, but not relayed by this renderer right now (e.g. a remote primary): leave it
    // to whoever relays it — a "not connected" reply would beat that delivery's real answer.
    return byId.get(LOCAL_CONNECTION_ID) ?? 'foreign'
  }

  if (id !== LOCAL_CONNECTION_ID && byId.has(id)) {
    return byId.get(id)
  }

  if (namesALocalMachine(id)) {
    // Not knowing our own id yet, either form may be this machine — unless this Desktop does
    // not relay its machine at all (no local route), which also means it cannot learn the id.
    return localRelayId === null && byId.has(LOCAL_CONNECTION_ID) ? 'unresolved' : 'foreign'
  }

  return byId.get(id)
}

/** A drain can run before the roster loop has heard the local gateway's install id (renderer
 *  start, or a blip on its profiles.list); an envelope naming a local machine needs it. Asked in
 *  the background, once at a time: only the envelopes that need the answer wait for it
 *  (deliverRelayEnvelope holds them), never the drain or anyone else's mail. */
let localRelayIdLookup: null | Promise<void> = null

function learnLocalRelayId(queued: RelayQueuedEnvelope[], byId: Map<string, RelayConnection>) {
  const local = byId.get(LOCAL_CONNECTION_ID)

  if (
    localRelayId !== null ||
    localRelayIdLookup !== null ||
    !local ||
    !queued.some(
      ({ envelope, sender }) =>
        sender.id === LOCAL_CONNECTION_ID || namesALocalMachine(String(envelope?.target_connection || ''))
    )
  ) {
    return
  }

  const generation = relay.rosterGeneration

  localRelayIdLookup = host
    .requestProfile<{ install_id?: string }>(local.route, 'profiles.list', { include_sessions: false })
    .then(res => {
      if (relay.rosterGeneration === generation) {
        noteRelayInstall(LOCAL_CONNECTION_ID, res?.install_id)
        // The held envelopes noted their sender's outbox work: drain them now, not at the backstop.
        scheduleRelayPushDrain()
      }
    })
    .catch(() => {
      // Unreachable local gateway: the held envelopes retry on the backstop drain.
    })
    .finally(() => {
      localRelayIdLookup = null
    })
}

/** The envelope's target on this Desktop (`relayTargetOf`), or null when this Desktop must not
 *  act on it (yet). 'foreign' — another Desktop's machine, or a connection this Desktop lacks
 *  that other Desktops relay (`listedForOthers`): that Desktop drains this gateway too and
 *  delivers it. No reply either — the first reply wins, so an error here would beat its real
 *  answer; the gateway re-offers the unanswered envelope on every drain until one lands or it
 *  times out. Unknown own id — the target may or may not be this machine, and a local sender has
 *  no name the recipient can reply to: stay pinned and mark the sender as having work, so a later
 *  drain retries once the id is known. */
function actionableTarget(
  sender: RelayConnection,
  envelope: RelayEnvelope,
  envelopeId: string,
  byId: Map<string, RelayConnection>,
  pending: Map<string, RelayEnvelope>
): RelayConnection | null | undefined {
  const target = relayTargetOf(String(envelope?.target_connection || ''), byId)

  if (target === 'foreign') {
    pending.delete(envelopeId)

    return null
  }

  // Left to the listed Desktops, but re-checked on later drains: this Desktop may gain the
  // connection, or be the only one left relaying it.
  if (
    target === 'unresolved' ||
    (target === undefined ? listedForOthers(envelope) : namedForOtherDesktops(envelope)) ||
    (sender.id === LOCAL_CONNECTION_ID && localRelayId === null)
  ) {
    noteRelayOutboxWork({ connectionId: sender.id })

    return null
  }

  return target
}

/** Deliver one claimed envelope on the target connection's own socket and post
 *  the reply (or the error) back to the sender gateway for its waiter. */
async function deliverRelayEnvelope(
  sender: RelayConnection,
  envelope: RelayEnvelope,
  byId: Map<string, RelayConnection>
) {
  const envelopeId = String(envelope?.id || '')
  const pending = pendingRelaysFor(sender)

  // A later drain re-queues every pinned envelope; the lane serialises them, so
  // one already ACKed by an earlier delivery in this lane must not ride twice.
  if (!envelopeId || !pending.has(envelopeId)) {
    return
  }

  const target = actionableTarget(sender, envelope, envelopeId, byId, pending)

  if (target === null) {
    return
  }

  // The install check below can outlast this relay: stopBotRelay() (or a stop and restart) or
  // Bot Mode turned off while it runs must stop the delivery, so the lifecycle is fenced too.
  const generation = relay.rosterGeneration

  const release = target ? await holdTarget(deliveryRouteOf(target, envelope), envelope) : () => {}

  if (release === null) {
    // Not the machine the envelope names, or that could not be checked: a later drain re-checks.
    noteRelayOutboxWork({ connectionId: sender.id })

    return
  }

  try {
    // The check can outlast a drain that no longer offers the envelope (answered or timed out
    // meanwhile, forgetSettledPins): only a still-pinned envelope goes out, and only from the
    // relay run that started the check.
    if (!relay.disposed && relay.rosterGeneration === generation && relayBotModeOn() && pending.has(envelopeId)) {
      await deliverOrAnswer(sender, envelope, envelopeId, target, pending)
    } else if (!relay.disposed && pending.has(envelopeId)) {
      // Bot Mode off, or a relay restarted meanwhile: still unanswered, so the gateway re-offers
      // it and the running relay's backstop drain checks it again.
      noteRelayOutboxWork({ connectionId: sender.id })
    }
  } finally {
    release()
  }
}

/** Deliver `envelope` on `target` (or answer that its connection is not here) and post the
 *  reply back to the sender gateway for its waiter. */
async function deliverOrAnswer(
  sender: RelayConnection,
  envelope: RelayEnvelope,
  envelopeId: string,
  target: RelayConnection | undefined,
  pending: Map<string, RelayEnvelope>
) {
  const postReply = async (payload: { error?: string; reason?: string; reply?: string }) => {
    try {
      await host.requestProfile(sender.route, 'bot_relay.reply', {
        id: envelopeId,
        ...payload
      })
      pending.delete(envelopeId)
    } catch {
      // Sender gateway unreachable — its waiter times out with guidance.
    }
  }

  if (!target) {
    await postReply({
      error: `connection '${envelope?.target_connection}' is not connected to this Desktop right now`
    })

    return
  }

  // Needs-attention hook (#93091 item 3): a delivered background DM is
  // this bot's "good turn"; a classified delivery failure badges it.
  const attentionKey = `${target.id}::${String(envelope?.target_profile || '')}`

  try {
    const res = await host.requestProfile<RelayDeliverResult>(
      deliveryRouteOf(target, envelope),
      'bot_relay.deliver',
      relayDeliverParams(sender, envelope, envelopeId),
      RELAY_DELIVER_TIMEOUT_MS
    )

    await settleRelayDelivery(res, envelopeId, attentionKey, postReply)
  } catch (error: any) {
    // #93091: bot_relay.deliver classifies the failed turn and ships the
    // typed code in the JSON-RPC error's `data.reason`; forward it into
    // the sender-side reply file so the waiter (and the sending agent)
    // get the machine-readable cause, and prefer it for the badge —
    // classified codes beat free-text re-parsing.
    const reason = String(error?.data?.reason || '').trim()
    noteBotAttention(attentionKey, reason || error?.message || error)

    // A transport exception can follow a committed admission; never settle it as failure.
    if (!reason || reason === 'runtime_unavailable') {return}
    await postReply({
      error: String(error?.message || error || 'delivery failed'),
      ...(reason
        ? {
            reason
          }
        : {})
    })
  }
}

/** Push-notified drain (#93091): collapse a burst of pending signals into
 *  one drain call ~RELAY_PUSH_DEBOUNCE_MS after the first signal. */
function scheduleRelayPushDrain() {
  if (relay.disposed || typeof setTimeout !== 'function') {
    return
  }

  if (relay.pushDebounceTimer !== null) {
    return
  }

  relay.pushDebounceTimer = setTimeout(() => {
    relay.pushDebounceTimer = null
    void drainRelayOutboxes()
  }, RELAY_PUSH_DEBOUNCE_MS)
}

export function startBotRelay() {
  relay.disposed = false
  relay.rosterClearedFor = null

  // Source-shape test harnesses evaluate plugin.js without DOM timers —
  // the relay only runs where a real event loop exists.
  if (typeof setInterval !== 'function' || typeof clearInterval !== 'function') {
    return
  }

  if (relay.rosterTimer === null) {
    relay.rosterTimer = setInterval(() => void syncRelayRosters(), RELAY_ROSTER_INTERVAL_MS)
    void syncRelayRosters()
  }

  if (relay.drainTimer === null) {
    relay.drainTimer = setInterval(() => void drainRelayOutboxes(), RELAY_DRAIN_INTERVAL_MS)
  }

  // Push path: the gateway change watcher broadcasts when an envelope hits
  // the outbox; drain immediately (debounced) instead of waiting the poll
  // out. Feature-detected — older shells have no host.onEvent — and only
  // those shells still open a socket from the interval. A signaled event
  // names its connection when the renderer stamped one; an untagged event
  // (local/legacy primary) may belong to any route.
  if (relay.pushUnsub === null && typeof host.onEvent === 'function') {
    relay.pushUnsub = host.onEvent('bot_relay.outbox.pending', event => {
      noteRelayOutboxWork(event)
      scheduleRelayPushDrain()
    })
  }
}

export function stopBotRelay() {
  relay.disposed = true
  relay.rosterGeneration += 1
  relay.rosterBusy = false
  // A rerun remembered mid-drain must not leak into the next start —
  // it would fire one stale drain after restart.
  relay.drainRerun = false
  routesWithOutboxWork.clear()
  localRelayIdLookup = null
  // Queued deliveries check `disposed` before they run; forget the lane tails
  // so a restart starts every target fresh instead of behind stale chains.
  relayLanes.clear()
  // Unpin every relay-retained socket (#93594): with the relay stopped the
  // pooled entries return to dispose-at-refcount-0 semantics.
  releaseRelayRetention()

  if (relay.rosterTimer !== null) {
    clearInterval(relay.rosterTimer)
    relay.rosterTimer = null
  }

  if (relay.drainTimer !== null) {
    clearInterval(relay.drainTimer)
    relay.drainTimer = null
  }

  if (relay.pushDebounceTimer !== null) {
    clearTimeout(relay.pushDebounceTimer)
    relay.pushDebounceTimer = null
  }

  if (relay.pushUnsub !== null) {
    try {
      relay.pushUnsub()
    } catch {
      // Disposer from an older shell shape — never break teardown.
    }

    relay.pushUnsub = null
  }
}
