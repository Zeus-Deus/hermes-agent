import { registryBackendScopeKey } from '@hermes/shared'
import type { HermesSkin } from '@hermes/shared/skin'

import {
  notifyCronChanged,
  notifyPairingChanged,
  notifyPetChanged,
  notifyPlatformsChanged,
  notifySessionsChanged,
  type PetChangeMeta,
  setChangeEventsAvailable
} from '@/store/live-sync'
import { normalizeProfileKey } from '@/store/profile'
import {
  $selectedStoredSessionId,
  getSessionOwnerHints,
  idsShareLineage,
  ownerLookupSessionRows,
  requestSessionResume,
  sessionMatchesStoredId
} from '@/store/session'
import type { SessionOwnerRoute } from '@/store/session-request-router'
import {
  dropSessionState,
  holdSessionOwnerUntilForeground,
  runtimeSessionScope,
  unbindTileRuntime
} from '@/store/session-states'
// Leaf import (not the `@/themes` barrel) to avoid pulling the ThemeProvider
// module graph into the gateway event hot path.
import { ingestBackendSkin } from '@/themes/backend-sync'

import type { GatewayEventContext } from './types'

/** Resolve a durable owner without trusting the event's arrival socket.
 *  session.reclaimed is broadcast to every client, so that socket is only a
 *  bystander. A unique persisted route is safe; same-id twins fail closed. */
function reclaimOwnerRoute(durableIds: string[], runtimeScope: string | undefined): SessionOwnerRoute | null | undefined {
  const hintsByScope = new Map<string, SessionOwnerRoute>()

  for (const durableId of durableIds) {
    for (const hint of getSessionOwnerHints(durableId)) {
      hintsByScope.set(registryBackendScopeKey(hint.connectionId, normalizeProfileKey(hint.profile)), hint)
    }
  }

  if (runtimeScope) {
    // The existing live-work scope ledger is stronger than durable metadata
    // for same-id twins. Use it only to select a COMPLETE hint (preserving
    // targetProfile/mode); never turn the broadcast's bystander socket into an
    // owner or introduce a second structured runtime-owner registry.
    return hintsByScope.get(runtimeScope) ?? null
  }

  const hintScopes = new Set(hintsByScope.keys())
  const bareProfiles = new Set<string>()

  for (const row of ownerLookupSessionRows().filter(candidate =>
    durableIds.some(durableId => sessionMatchesStoredId(candidate, durableId))
  )) {
    const connectionId = row.connection_id?.trim()
    const profile = normalizeProfileKey(row.profile)

    if (connectionId) {
      const scope = registryBackendScopeKey(connectionId, profile)

      hintsByScope.set(scope, hintsByScope.get(scope) ?? { connectionId, profile })
    } else {
      bareProfiles.add(profile)
    }
  }

  const hints = [...hintsByScope.values()]

  if (hints.length !== 1) {
    return hints.length > 1 || bareProfiles.size > 1 ? null : undefined
  }

  const owner = hints[0]
  const ownerScope = registryBackendScopeKey(owner.connectionId, owner.profile)

  const compatibleProfiles = new Set([
    normalizeProfileKey(owner.profile),
    normalizeProfileKey(owner.targetProfile || owner.profile)
  ])

  if (![...bareProfiles].every(profile => compatibleProfiles.has(profile))) {
    return null
  }

  // A row-only exact route proves uniqueness but may omit targetProfile/mode.
  // Let the established resume resolver consume that row instead of persisting
  // an incomplete hint here.
  return hintScopes.has(ownerScope) ? owner : undefined
}

/** gateway.ready / skin.changed / change-watcher broadcasts / session.reclaimed. */
export function handleLifecycleEvent(ctx: GatewayEventContext): boolean {
  const { deps, event, payload, fromActiveSource } = ctx

  if (event.type === 'gateway.ready') {
    // Seed the active skin into the desktop theme registry without applying,
    // so a fresh connect never overrides the user's persisted desktop theme.
    ingestBackendSkin((payload as { skin?: HermesSkin } | undefined)?.skin, { apply: false })
    // Backends with the change watcher broadcast pet/cron/sessions change
    // events; consumers demote their legacy polls to slow backstops.
    setChangeEventsAvailable(Boolean((payload as { change_events?: boolean } | undefined)?.change_events))

    return true
  }

  if (event.type === 'skin.changed') {
    // A runtime skin switch (Hermes activating an authored skin, or `/skin`
    // on another surface). Only the active source+profile's change repaints.
    if (fromActiveSource()) {
      ingestBackendSkin(payload as HermesSkin | undefined, { apply: true })
    }

    return true
  }

  if (
    event.type === 'pet.changed' ||
    event.type === 'cron.changed' ||
    event.type === 'sessions.changed' ||
    event.type === 'platforms.changed' ||
    event.type === 'pairing.changed'
  ) {
    // Change-watcher broadcasts (server._broadcast_watched_changes): the
    // backend's on-disk signature moved. Route to the live-sync ticks the
    // former pollers now subscribe to. Only the active source+profile's
    // changes apply — background profile sockets (and other connections'
    // gateways) watch their own homes.
    if (fromActiveSource()) {
      if (event.type === 'pet.changed') {
        notifyPetChanged(payload as PetChangeMeta | undefined)
      } else if (event.type === 'cron.changed') {
        notifyCronChanged()
      } else if (event.type === 'platforms.changed') {
        notifyPlatformsChanged()
      } else if (event.type === 'pairing.changed') {
        notifyPairingChanged()
      } else {
        notifySessionsChanged()
      }
    }

    return true
  }

  if (event.type === 'session.reclaimed') {
    // The backend reclaimed a live session we may still be holding (idle
    // TTL, LRU cap, or the WS-orphan reap). Without this the runtime id
    // stays cached until something fails against it, which reads as the
    // session vanishing rather than being reclaimed. Drop the cached state
    // now — the stored row is untouched, so the sidebar keeps the
    // conversation and reopening it resumes from the DB.
    const reclaimed = payload as
      | { reason?: string; session_id?: string; stored_session_id?: string }
      | undefined

    const reclaimedRuntimeId = String(reclaimed?.session_id ?? '').trim()
    const reclaimedStoredId = String(reclaimed?.stored_session_id ?? '').trim()
    const selectedStoredId = $selectedStoredSessionId.get()?.trim() || ''
    const reclaimedRuntimeScope = reclaimedRuntimeId ? runtimeSessionScope(reclaimedRuntimeId) : undefined

    const rebindActiveMain = Boolean(
      reclaimed?.reason === 'ws_orphan_reap' &&
        reclaimedRuntimeId &&
        reclaimedRuntimeId === deps.activeSessionIdRef.current &&
        selectedStoredId &&
        reclaimedStoredId &&
        idsShareLineage(selectedStoredId, reclaimedStoredId, ownerLookupSessionRows())
    )

    const ownerRoute = rebindActiveMain
      ? reclaimOwnerRoute([...new Set([selectedStoredId, reclaimedStoredId])], reclaimedRuntimeScope)
      : undefined

    if (reclaimedRuntimeId) {
      dropSessionState(reclaimedRuntimeId)
      // A tile bound to the reclaimed runtime would otherwise render an
      // empty transcript forever: its view reads $sessionStates[runtime]
      // (just dropped) and its resume effect is gated on !runtimeId, so a
      // bound tile never re-resumes (#82620). Unbind it so the effect
      // refires against the intact stored session — and purge the wiring
      // cache's entry, or resumeTile's warm path would hand the dead
      // runtime straight back instead of cold-resuming a live one.
      unbindTileRuntime(reclaimedRuntimeId)
      deps.sessionStateByRuntimeIdRef.current.delete(reclaimedRuntimeId)

      // Delete every durable alias that still points at this dead runtime. A
      // raw SessionStateCache.delete does not run its onEvict callback, and one
      // stale reverse entry would make the explicit resume's warm path hand the
      // reclaimed id straight back instead of minting/reusing a live runtime.
      for (const [storedSessionId, runtimeId] of deps.runtimeIdByStoredSessionIdRef.current) {
        if (runtimeId === reclaimedRuntimeId) {
          deps.runtimeIdByStoredSessionIdRef.current.delete(storedSessionId)
        }
      }
    }

    if (rebindActiveMain && ownerRoute !== null && ctx.claimReclaimedRuntime(reclaimedRuntimeId)) {
      // Reuse the route-resume door: it already owns exact routing,
      // single-flight resume, transcript preservation and navigation-drift
      // guards. Do not replay prompt.submit here.
      if (ownerRoute) {
        holdSessionOwnerUntilForeground(selectedStoredId, ownerRoute)
      }

      requestSessionResume(selectedStoredId, ownerRoute)
    }

    // The row's ended_at moved, so refresh the lists that render it.
    notifySessionsChanged()

    return true
  }

  return false
}
