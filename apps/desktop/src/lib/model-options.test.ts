import { afterEach, describe, expect, it, vi } from 'vitest'

import { setApiRequestConnection, setApiRequestProfile } from '@/api/client'
import { getGlobalModelOptions } from '@/hermes'

import { manualPickRemoved, modelOptionsQueryKey, requestModelOptions } from './model-options'

const globalOptions = { model: 'hermes-4', provider: 'nous', providers: [] }

vi.mock('@/hermes', () => ({
  getGlobalModelOptions: vi.fn(() => Promise.resolve(globalOptions))
}))

describe('requestModelOptions', () => {
  afterEach(() => {
    vi.clearAllMocks()
  })

  it('uses the connected gateway even before a session exists', async () => {
    const gatewayPayload = {
      model: 'BeastMode',
      provider: 'moa',
      providers: [{ models: ['BeastMode'], name: 'Mixture of Agents', slug: 'moa' }]
    }

    const gateway = {
      request: vi.fn(() => Promise.resolve(gatewayPayload))
    }

    await expect(requestModelOptions({ gateway: gateway as never, sessionId: null })).resolves.toBe(gatewayPayload)

    expect(gateway.request).toHaveBeenCalledWith('model.options', { explicit_only: true })
    expect(getGlobalModelOptions).not.toHaveBeenCalled()
  })

  it('recovers an empty gateway catalog through profile-scoped REST without replacing the session selection', async () => {
    const gatewayPayload = { model: 'hermes-local', provider: 'hermes-local' }

    const restPayload = {
      model: 'profile-default',
      provider: 'openai-codex',
      providers: [{ models: ['hermes-local'], name: 'Hermes Local vLLM', slug: 'hermes-local' }]
    }

    const gateway = {
      request: vi.fn(() => Promise.resolve(gatewayPayload))
    }

    vi.mocked(getGlobalModelOptions).mockResolvedValueOnce(restPayload)

    await expect(requestModelOptions({ gateway: gateway as never, sessionId: 'session-1' })).resolves.toEqual({
      ...restPayload,
      model: 'hermes-local',
      provider: 'hermes-local'
    })

    expect(getGlobalModelOptions).toHaveBeenCalledWith({ explicitOnly: true })
  })

  it('recovers through profile-scoped REST when the gateway catalog request fails', async () => {
    const restPayload = {
      model: 'hermes-local',
      provider: 'hermes-local',
      providers: [{ models: ['hermes-local'], name: 'Hermes Local vLLM', slug: 'hermes-local' }]
    }

    const gateway = {
      request: vi.fn(() => Promise.reject(new Error('gateway request unavailable')))
    }

    vi.mocked(getGlobalModelOptions).mockResolvedValueOnce(restPayload)

    await expect(requestModelOptions({ gateway: gateway as never, sessionId: 'session-1' })).resolves.toEqual(
      restPayload
    )
    expect(getGlobalModelOptions).toHaveBeenCalledWith({ explicitOnly: true })
  })

  it('preserves the gateway error when its REST recovery path also fails', async () => {
    const gatewayError = new Error('gateway request unavailable')

    const gateway = {
      request: vi.fn(() => Promise.reject(gatewayError))
    }

    vi.mocked(getGlobalModelOptions).mockRejectedValueOnce(new Error('REST request unavailable'))

    await expect(requestModelOptions({ gateway: gateway as never })).rejects.toBe(gatewayError)
  })

  it('keeps the gateway result when both catalog paths have no selectable models', async () => {
    const gatewayPayload = { model: 'hermes-local', provider: 'hermes-local', providers: [] }

    const gateway = {
      request: vi.fn(() => Promise.resolve(gatewayPayload))
    }

    await expect(requestModelOptions({ gateway: gateway as never })).resolves.toBe(gatewayPayload)
  })

  it('passes the active session id and refresh flag through the gateway', async () => {
    const gateway = {
      request: vi.fn(() => Promise.resolve(globalOptions))
    }

    await requestModelOptions({ gateway: gateway as never, refresh: true, sessionId: 'session-1' })

    expect(gateway.request).toHaveBeenCalledWith('model.options', {
      explicit_only: true,
      refresh: true,
      session_id: 'session-1'
    })
    expect(getGlobalModelOptions).toHaveBeenCalledWith({ explicitOnly: true, refresh: true })
  })

  it('falls back to REST when no gateway is connected', async () => {
    await requestModelOptions({ refresh: true })

    expect(getGlobalModelOptions).toHaveBeenCalledWith({ explicitOnly: true, refresh: true })
  })
})

describe('modelOptionsQueryKey', () => {
  afterEach(() => {
    setApiRequestConnection(null)
    setApiRequestProfile(null)
  })

  it('isolates new-chat catalogs by active gateway profile', () => {
    expect(modelOptionsQueryKey('default')).toEqual(['model-options', 'default', 'global'])
    expect(modelOptionsQueryKey('compass')).toEqual(['model-options', 'compass', 'global'])
    expect(modelOptionsQueryKey('default')).not.toEqual(modelOptionsQueryKey('compass'))
  })

  it('keeps session catalogs inside the owning profile namespace', () => {
    expect(modelOptionsQueryKey(' compass ', 'session-1')).toEqual(['model-options', 'compass', 'session-1'])
  })

  it('does not alias an explicit local catalog with an ambient remote catalog', () => {
    setApiRequestConnection('remote-active')
    setApiRequestProfile('bot')

    const explicitLocal = modelOptionsQueryKey({ connectionId: 'local', profile: 'bot' }, 'session-1')
    const ambientRemote = modelOptionsQueryKey('bot', 'session-1')

    expect(explicitLocal).toEqual(['model-options', 'conn:local::bot', 'session-1'])
    expect(ambientRemote).toEqual(['model-options', 'conn:remote-active::bot', 'session-1'])
    expect(explicitLocal).not.toEqual(ambientRemote)
  })

  it('keeps an explicit local pin distinct from the legacy ambient-local namespace', () => {
    const explicitLocal = modelOptionsQueryKey({ connectionId: 'local', profile: 'bot' }, 'session-1')
    const ambientLocal = modelOptionsQueryKey('bot', 'session-1')

    expect(explicitLocal).toEqual(['model-options', 'conn:local::bot', 'session-1'])
    expect(ambientLocal).toEqual(['model-options', 'bot', 'session-1'])
    expect(explicitLocal).not.toEqual(ambientLocal)
  })

  it('includes the effective active connection in ambient catalog keys', () => {
    setApiRequestProfile('bot')
    setApiRequestConnection('remote-a')
    const remoteA = modelOptionsQueryKey(undefined, 'session-1')

    setApiRequestConnection('remote-b')
    const remoteB = modelOptionsQueryKey(undefined, 'session-1')

    expect(remoteA).toEqual(['model-options', 'conn:remote-a::bot', 'session-1'])
    expect(remoteB).toEqual(['model-options', 'conn:remote-b::bot', 'session-1'])
    expect(remoteA).not.toEqual(remoteB)
  })

  it('keeps explicit remote owners isolated from ambient and same-profile peers', () => {
    setApiRequestConnection('ambient')

    const ownerA = modelOptionsQueryKey({ connectionId: 'owner-a', profile: 'bot' }, 'session-1')
    const ownerB = modelOptionsQueryKey({ connectionId: 'owner-b', profile: 'bot' }, 'session-1')
    const ambient = modelOptionsQueryKey('bot', 'session-1')

    expect(new Set([JSON.stringify(ownerA), JSON.stringify(ownerB), JSON.stringify(ambient)])).toHaveProperty(
      'size',
      3
    )
  })
})

describe('manualPickRemoved', () => {
  const providers = [
    { name: 'OpenRouter', slug: 'openrouter', models: ['owl-alpha', 'gpt-5.5'] },
    { name: 'Nous', slug: 'nous', models: [] } // present but unconfigured / re-auth
  ]

  it('flags a pick whose model was dropped from a populated provider', () => {
    expect(manualPickRemoved(providers, 'openrouter', 'nemotron-removed')).toBe(true)
  })

  it('keeps a pick that is still in the catalog', () => {
    expect(manualPickRemoved(providers, 'openrouter', 'gpt-5.5')).toBe(false)
  })

  it('matches the provider by name as well as slug', () => {
    expect(manualPickRemoved(providers, 'OpenRouter', 'gpt-5.5')).toBe(false)
    expect(manualPickRemoved(providers, 'OpenRouter', 'gone')).toBe(true)
  })

  it('never clobbers when the provider is absent (ambiguous / deauth)', () => {
    expect(manualPickRemoved(providers, 'anthropic', 'claude-sonnet-4.6')).toBe(false)
  })

  it('never clobbers when the provider has an empty model list (re-auth)', () => {
    expect(manualPickRemoved(providers, 'nous', 'hermes-4')).toBe(false)
  })

  it('never clobbers on a not-yet-loaded or empty catalog', () => {
    expect(manualPickRemoved(undefined, 'openrouter', 'gpt-5.5')).toBe(false)
    expect(manualPickRemoved([], 'openrouter', 'gpt-5.5')).toBe(false)
  })

  it('never clobbers when there is no pick', () => {
    expect(manualPickRemoved(providers, '', '')).toBe(false)
  })
})

// #93892: a session-bound surface (a tile) must read its catalog through the
// same owner-routed dispatcher it writes through. The backend resolves
// `session_id` in its own process, so the ambient socket answers a
// cross-profile session with ITS profile's catalog — silently.
describe('requestModelOptions owner routing', () => {
  afterEach(() => {
    vi.clearAllMocks()
  })

  it('prefers the owner-routed dispatcher over the ambient gateway', async () => {
    const ownerPayload = {
      model: 'bot-model',
      provider: 'nous',
      providers: [{ models: ['bot-model'], name: 'Nous', slug: 'nous' }]
    }

    const ambient = { request: vi.fn(() => Promise.resolve(globalOptions)) }
    const request = vi.fn(() => Promise.resolve(ownerPayload))

    await expect(
      requestModelOptions({ gateway: ambient as never, request: request as never, sessionId: 'tile-runtime' })
    ).resolves.toBe(ownerPayload)

    expect(request).toHaveBeenCalledWith('model.options', { explicit_only: true, session_id: 'tile-runtime' })
    expect(ambient.request).not.toHaveBeenCalled()
    expect(getGlobalModelOptions).not.toHaveBeenCalled()
  })

  it('pins the REST recovery read to the owner profile', async () => {
    const restPayload = {
      model: 'bot-default',
      provider: 'nous',
      providers: [{ models: ['bot-default'], name: 'Nous', slug: 'nous' }]
    }

    const request = vi.fn(() => Promise.reject(new Error('socket closed')))

    vi.mocked(getGlobalModelOptions).mockResolvedValueOnce(restPayload)

    await expect(
      requestModelOptions({ profile: 'bot', request: request as never, sessionId: 'tile-runtime' })
    ).resolves.toEqual(restPayload)

    expect(getGlobalModelOptions).toHaveBeenCalledWith({ explicitOnly: true }, 'bot')
  })

  it("keeps a remote-owner tile's empty WS catalog pinned during REST recovery while another connection is active", async () => {
    const ambientPayload = {
      model: 'ambient-model',
      provider: 'ambient',
      providers: [{ models: ['ambient-model'], name: 'Ambient', slug: 'ambient' }]
    }

    const ownerPayload = {
      model: 'owner-model',
      provider: 'owner',
      providers: [{ models: ['owner-model'], name: 'Owner', slug: 'owner' }]
    }

    const ownerScope = { connectionId: 'remote-owner', profile: 'backend-bot' }
    const request = vi.fn(() => Promise.resolve({ model: 'owner-model', provider: 'owner', providers: [] }))

    // Deterministically model the active-connection trap: an unpinned REST
    // read returns the foreground connection's catalog; only the exact tile
    // owner scope reaches the backend that owns the session.
    vi.mocked(getGlobalModelOptions).mockImplementationOnce(async (_opts, scope) =>
      JSON.stringify(scope as unknown) === JSON.stringify(ownerScope) ? ownerPayload : ambientPayload
    )

    await expect(
      requestModelOptions({ profile: ownerScope as never, request: request as never, sessionId: 'tile-runtime' })
    ).resolves.toEqual(ownerPayload)

    expect(getGlobalModelOptions).toHaveBeenCalledWith({ explicitOnly: true }, ownerScope)
  })

  it('keeps the unpinned REST call shape when no profile is named', async () => {
    const request = vi.fn(() => Promise.reject(new Error('socket closed')))

    // Neither path has a selectable model, so the dispatcher error surfaces —
    // this test is only about the REST call shape.
    await requestModelOptions({ request: request as never, sessionId: null }).catch(() => undefined)

    expect(getGlobalModelOptions).toHaveBeenCalledWith({ explicitOnly: true })
  })

  it('returns the REST catalog when the dispatcher yields nothing at all', async () => {
    const emptyRest = { providers: [] }
    const request = vi.fn(() => Promise.resolve(undefined))

    vi.mocked(getGlobalModelOptions).mockResolvedValueOnce(emptyRest as never)

    await expect(requestModelOptions({ request: request as never, sessionId: null })).resolves.toBe(emptyRest)
  })
})
