import { normalizeProfileKey } from '@/store/profile'
import { getSessionOwnerHints, sessionMatchesStoredId } from '@/store/session'
import type { SessionInfo } from '@/types/hermes'

/** A chat's owner as a complete registry connection / profile pair. */
export interface PluginFocusedSessionOwner {
  connectionId: string
  profile: string
}

/** The owner of stored session `storedSessionId`: its unique immutable owner
 *  hint, else its unique connection-qualified aggregated row; null when
 *  ambiguous or unresolved. */
export function storedSessionOwner(storedSessionId: string, sessions: SessionInfo[]): PluginFocusedSessionOwner | null {
  const hints = getSessionOwnerHints(storedSessionId)

  if (hints.length === 1) {
    return {
      connectionId: hints[0].connectionId,
      profile: normalizeProfileKey(hints[0].profile)
    }
  }

  if (hints.length > 1) {
    return null
  }

  const owners = new Map<string, PluginFocusedSessionOwner>()

  for (const row of sessions.filter(session => sessionMatchesStoredId(session, storedSessionId))) {
    const connectionId = String(row.connection_id || '').trim()
    const profile = normalizeProfileKey(row.profile)

    if (connectionId) {
      owners.set(`${connectionId}::${profile}`, { connectionId, profile })
    }
  }

  return owners.size === 1 ? [...owners.values()][0] : null
}
