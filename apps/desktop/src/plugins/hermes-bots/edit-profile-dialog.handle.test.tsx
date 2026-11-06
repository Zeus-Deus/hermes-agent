/**
 * Edit Profile sets the default bot's custom @handle (#89720): only the
 * default gets the field, the value lands in its backend's
 * `ui_meta['hermes-bots'].mentionHandle`, and a refusal names the reason.
 */

import type * as HermesSdk from '@hermes/plugin-sdk'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { translateBots } from './i18n-test-helper'
import type { RosterRow } from './types'

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn()
  Element.prototype.hasPointerCapture = vi.fn(() => false)
  Element.prototype.releasePointerCapture = vi.fn()
})

const { notify, request, configured } = vi.hoisted(() => ({
  configured: { applied: { ui_meta: true, ui_meta_revisions: { 'hermes-bots': 2 } } } as Record<string, unknown>,
  notify: vi.fn(),
  request: vi.fn()
}))

vi.mock('@hermes/plugin-sdk', async importOriginal => {
  const sdk = await importOriginal<typeof HermesSdk>()

  return {
    ...sdk,
    host: { ...sdk.host, notify, notifyError: notify, request },
    usePluginI18n: () => translateBots
  }
})

const { $lastRoster } = await import('./data')
const { EditProfileDialog } = await import('./edit-profile-dialog')

/** A default on a backend that resolves custom handles: it reports `mention_handle`. */
const DEFAULT_BOT: RosterRow = {
  mention_handle: '',
  name: 'default',
  ui_meta: { 'hermes-bots': { shape: 'cloud' } },
  ui_meta_revisions: {}
}

function configureCalls() {
  return request.mock.calls.filter(([method]) => method === 'profiles.configure').map(([, params]) => params)
}

function handleInput() {
  return screen.getByPlaceholderText('hermes') as HTMLInputElement
}

beforeEach(() => {
  vi.clearAllMocks()
  request.mockImplementation(async (method: string) =>
    method === 'profiles.list'
      ? { profiles: [DEFAULT_BOT, { name: 'researcher' }] }
      : method === 'profiles.configure'
        ? configured
        : {}
  )
  $lastRoster.set([DEFAULT_BOT, { name: 'researcher' }])
})

afterEach(() => {
  cleanup()
})

describe('the default bot’s handle field', () => {
  it('saves a normalized handle into the default’s Bot Mode metadata', async () => {
    render(<EditProfileDialog bot={DEFAULT_BOT} onClose={() => undefined} open />)

    fireEvent.change(handleInput(), { target: { value: '@Maia' } })
    expect(handleInput().value).toBe('maia')
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(configureCalls()).toHaveLength(1))
    expect(configureCalls()[0]).toMatchObject({
      name: 'default',
      ui_meta: { 'hermes-bots': { mentionHandle: 'maia', shape: 'cloud' } }
    })
  })

  it.each([
    ['hermes', 'A handle uses lowercase letters'],
    ['researcher', '@researcher is already used by another bot.']
  ])('refuses %j before writing anything', async (value, message) => {
    render(<EditProfileDialog bot={DEFAULT_BOT} onClose={() => undefined} open />)

    fireEvent.change(handleInput(), { target: { value } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(notify).toHaveBeenCalled())
    expect(String(notify.mock.calls[0][0].message)).toContain(message)
    expect(configureCalls()).toEqual([])
  })

  it('shows the backend’s reason when it refuses the handle', async () => {
    request.mockImplementation(async (method: string) =>
      method === 'profiles.list'
        ? { profiles: [DEFAULT_BOT] }
        : method === 'profiles.configure'
          ? { applied: { ui_meta: false, ui_meta_error: '@maia is already the name of a profile on this machine.' } }
          : {}
    )
    render(<EditProfileDialog bot={DEFAULT_BOT} onClose={() => undefined} open />)

    fireEvent.change(handleInput(), { target: { value: 'maia' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() =>
      expect(notify).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'error', message: '@maia is already the name of a profile on this machine.' })
      )
    )
  })

  it('keeps the dialog open with the edit when the backend never took the handle', async () => {
    request.mockImplementation(async () => {
      throw new Error('socket closed')
    })
    const onClose = vi.fn()
    render(<EditProfileDialog bot={DEFAULT_BOT} onClose={onClose} open />)

    fireEvent.change(handleInput(), { target: { value: 'maia' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(notify).toHaveBeenCalledWith(expect.objectContaining({ kind: 'error' })))
    expect(String(notify.mock.calls[0][0].message)).toContain('The handle was not saved')
    expect(notify).not.toHaveBeenCalledWith(expect.objectContaining({ kind: 'success' }))
    expect(onClose).not.toHaveBeenCalled()
    expect(handleInput().value).toBe('maia')
  })

  it('is not offered for a named bot', () => {
    render(<EditProfileDialog bot={{ name: 'researcher' }} onClose={() => undefined} open />)

    expect(screen.queryByPlaceholderText('hermes')).toBeNull()
  })

  it('is not offered on an older backend that would store the handle without answering to it', () => {
    render(<EditProfileDialog bot={{ ...DEFAULT_BOT, mention_handle: undefined }} onClose={() => undefined} open />)

    expect(screen.queryByPlaceholderText('hermes')).toBeNull()
  })

  it('opens on the handle the backend stores', () => {
    const bot = { ...DEFAULT_BOT, mention_handle: 'maia', ui_meta: { 'hermes-bots': { mentionHandle: 'maia' } } }
    render(<EditProfileDialog bot={bot} onClose={() => undefined} open />)

    expect(handleInput().value).toBe('maia')
  })
})
