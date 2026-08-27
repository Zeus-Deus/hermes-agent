import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const getConnectionConfig = vi.fn()
const saveConnectionConfig = vi.fn()

// This test owns the machine-level GatewaySettings contract. The managed SSH
// update section mounted below the registry has its own focused coverage
// (store/managed-updates.test.ts); keep its store subscriptions out of this
// single-purpose test.
vi.mock('./managed-updates-section', () => ({ ManagedUpdatesSection: () => null }))

const localConnection = {
  cloudOrg: '',
  envOverride: false,
  mode: 'local',
  remoteAuthMode: 'token',
  remoteOauthConnected: false,
  remoteTokenPreview: null,
  remoteTokenSet: false,
  secureTokenStorage: true,
  remoteTokenPlainText: false,
  remoteUrl: '',
  sshHost: '',
  sshUser: '',
  sshPort: null,
  sshKeyPath: '',
  sshRemoteHermesPath: '',
  sshRemoteProfile: ''
}

beforeEach(() => {
  getConnectionConfig.mockResolvedValue(localConnection)
  saveConnectionConfig.mockResolvedValue(localConnection)
  Object.defineProperty(window, 'hermesDesktop', {
    configurable: true,
    value: { getConnectionConfig, saveConnectionConfig }
  })
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('GatewaySettings', () => {
  it('loads the machine-level connection config (no profile scoping)', async () => {
    const { GatewaySettings } = await import('./gateway-settings')

    render(<GatewaySettings />)
    expect(await screen.findByText('Local gateway')).toBeTruthy()
    expect(
      screen.getByText('Start a private Hermes backend on localhost. This is the default and works offline.')
    ).toBeTruthy()

    // The page manages the machine's gateway connections; it must load the
    // global config, never a per-profile override.
    await waitFor(() => expect(getConnectionConfig).toHaveBeenCalledWith(null))
    expect(getConnectionConfig).not.toHaveBeenCalledWith(expect.any(String))

    // The legacy per-profile scope switcher must not render.
    expect(screen.queryByText('Applies to')).toBeNull()
    expect(screen.queryByText('All profiles')).toBeNull()
    expect(screen.queryByText('Use default gateway')).toBeNull()
  })

  it('requires explicit confirmation before saving a token without secure storage', async () => {
    const remoteConnection = {
      ...localConnection,
      mode: 'remote',
      remoteTokenPreview: 'old…oken',
      remoteTokenSet: true,
      secureTokenStorage: false,
      remoteUrl: 'https://gateway.example.com/hermes'
    }

    getConnectionConfig.mockResolvedValue(remoteConnection)
    saveConnectionConfig.mockResolvedValue({
      ...remoteConnection,
      remoteTokenPlainText: true
    })

    const { GatewaySettings } = await import('./gateway-settings')
    const { container } = render(<GatewaySettings />)

    await screen.findByText('Session token')
    const tokenInput = container.querySelector('input[type="password"]')

    expect(tokenInput).not.toBeNull()
    fireEvent.change(tokenInput!, { target: { value: 'replacement-token' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save for next restart' }))

    expect(await screen.findByText('Store the gateway token in plain text?')).toBeTruthy()
    expect(saveConnectionConfig).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Save as plain text' }))

    await waitFor(() =>
      expect(saveConnectionConfig).toHaveBeenCalledWith(
        expect.objectContaining({
          allowPlainTextToken: true,
          remoteToken: 'replacement-token'
        })
      )
    )
  })
})
