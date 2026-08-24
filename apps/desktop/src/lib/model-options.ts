import { getGlobalModelOptions, type HermesGateway, type ModelOptionsResponse } from '@/hermes'
import type { ModelOptionProvider } from '@/types/hermes'

/**
 * True only when a persisted **manual** composer pick has been removed from the
 * catalog (its provider still ships models, but no longer this one) — so a new
 * chat would keep 404'ing the dead model. Deliberately conservative to never
 * clobber a still-valid pick: an unknown/absent provider, an empty model list
 * (re-auth / unconfigured), or a not-yet-loaded catalog all return false.
 */
export function manualPickRemoved(
  providers: ModelOptionProvider[] | undefined,
  provider: string,
  model: string
): boolean {
  if (!providers?.length || !provider || !model) {
    return false
  }

  const row = providers.find(p => p.slug === provider || p.name === provider)

  if (!row) {
    return false
  }

  const models = row.models ?? []

  // Empty list means the provider is present but unconfigured / awaiting
  // re-auth, not that the model was dropped — leave the pick alone.
  if (models.length === 0) {
    return false
  }

  return !models.includes(model)
}

/** A gateway dispatcher: the ambient `gateway.request`, or a session-owner
 *  routed one (`requestForSessionProfile`) for surfaces bound to a session. */
export type ModelOptionsDispatch = <T>(method: string, params?: Record<string, unknown>) => Promise<T>

interface ModelOptionsRequest {
  /** When false, include ambient/unconfigured providers (onboarding/setup
   *  surfaces). Chat pickers default to true so only explicitly configured
   *  providers are listed (#56974). */
  explicitOnly?: boolean
  gateway?: HermesGateway
  /** Profile whose REST catalog the recovery path reads. Defaults to the
   *  active API profile — wrong for a tile bound to another profile's
   *  session, so session-bound surfaces pass their owner's profile. */
  profile?: null | string
  refresh?: boolean
  /**
   * Owner-routed dispatcher for the `model.options` read. Takes precedence
   * over `gateway`: the backend resolves `session_id` in ITS OWN process, so
   * a catalog read for a session owned by another profile/connection must go
   * out on that owner's socket — the ambient one never held the runtime, and
   * silently answers with its own global config instead (#93892).
   */
  request?: ModelOptionsDispatch
  sessionId?: null | string
}

export function modelOptionsQueryKey(profile: null | string | undefined, sessionId?: null | string) {
  const profileKey = (profile ?? '').trim() || 'default'

  return ['model-options', profileKey, sessionId || 'global'] as const
}

function hasSelectableModels(options: ModelOptionsResponse | null | undefined): boolean {
  return options?.providers?.some(provider => (provider.models?.length ?? 0) > 0) ?? false
}

function restModelOptions(
  opts: { explicitOnly: boolean; refresh?: true },
  profile: null | string | undefined
): Promise<ModelOptionsResponse> {
  const key = (profile ?? '').trim()

  // Only pin the profile when the caller named one — the default keeps the
  // active API profile scope (and the call shape) every other caller relies on.
  return key ? getGlobalModelOptions(opts, key) : getGlobalModelOptions(opts)
}

export async function requestModelOptions({
  explicitOnly = true,
  gateway,
  profile,
  refresh = false,
  request,
  sessionId
}: ModelOptionsRequest): Promise<ModelOptionsResponse> {
  const dispatch: ModelOptionsDispatch | undefined =
    request ??
    (gateway ? <T>(method: string, params?: Record<string, unknown>) => gateway.request<T>(method, params) : undefined)

  if (dispatch) {
    const params: Record<string, unknown> = {}

    if (sessionId) {
      params.session_id = sessionId
    }

    if (refresh) {
      params.refresh = true
    }

    if (explicitOnly) {
      params.explicit_only = true
    }

    let gatewayError: unknown
    let gatewayOptions: ModelOptionsResponse | undefined
    let restFallback: ModelOptionsResponse | undefined

    try {
      gatewayOptions = (await dispatch<ModelOptionsResponse | undefined>('model.options', params)) ?? undefined
    } catch (error) {
      gatewayError = error
    }

    if (gatewayOptions && hasSelectableModels(gatewayOptions)) {
      return gatewayOptions
    }

    // A connected Desktop gateway can occasionally return only the current
    // provider/model (or an empty provider list) while its authenticated REST
    // catalog is already populated. Recover through the same profile-scoped
    // endpoint Settings uses, but keep the live session selection authoritative.
    try {
      const restOptions = await restModelOptions({ explicitOnly, ...(refresh ? { refresh: true } : {}) }, profile)

      if (hasSelectableModels(restOptions)) {
        return {
          ...restOptions,
          ...(gatewayOptions?.provider ? { provider: gatewayOptions.provider } : {}),
          ...(gatewayOptions?.model ? { model: gatewayOptions.model } : {})
        }
      }

      restFallback = restOptions
    } catch {
      // Preserve the gateway result (or its original error) when the recovery
      // path is unavailable.
    }

    if (gatewayOptions) {
      return gatewayOptions
    }

    // The dispatcher answered with nothing at all (no catalog, no error): the
    // REST read is the only catalog we have, selectable models or not.
    if (restFallback && gatewayError === undefined) {
      return restFallback
    }

    throw gatewayError ?? new Error('model.options returned no catalog')
  }

  return restModelOptions({ explicitOnly, ...(refresh ? { refresh: true } : {}) }, profile)
}
