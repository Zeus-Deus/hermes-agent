import { afterEach, describe, expect, it, vi } from 'vitest'

import { $gatewayState, $sessions, setSessions } from '@/store/session'
import { $sessionTiles } from '@/store/session-states'

import {
  createTileResumeBudget,
  recentTileResumes,
  sessionTileResumeFailure,
  shouldResumeSessionTile,
  startUnrestoredTileTitleBackfill,
  TILE_RESUME_STORM_LIMIT,
  TILE_RESUME_STORM_WINDOW_MS,
  tileResumeStormed
} from './session-tile'

describe('shouldResumeSessionTile', () => {
  const live = {
    gatewayOpen: true,
    removalPending: false,
    resuming: false,
    runtimeId: null,
    tileError: undefined
  }

  it('resumes an unbound tile once the gateway is open', () => {
    expect(shouldResumeSessionTile(live)).toBe(true)
  })

  it('does not resume a session the user is deleting', () => {
    // A 4001 racing the delete unbinds the tile runtime, re-arming the resume
    // effect against an id that is already gone: the resume 404s and latches an
    // error card for a chat that is on its way out.
    expect(shouldResumeSessionTile({ ...live, removalPending: true })).toBe(false)
  })

  it('waits for the gateway, a free slot, and an unbound, unlatched tile', () => {
    expect(shouldResumeSessionTile({ ...live, gatewayOpen: false })).toBe(false)
    expect(shouldResumeSessionTile({ ...live, runtimeId: 'rt-1' })).toBe(false)
    expect(shouldResumeSessionTile({ ...live, tileError: 'boom' })).toBe(false)
    expect(shouldResumeSessionTile({ ...live, resuming: true })).toBe(false)
  })
})

describe('sessionTileResumeFailure', () => {
  it('keeps a confirmed durable session retryable instead of repeating a stale 404', () => {
    expect(sessionTileResumeFailure('session not found', true, true)).toBe(
      'Session is still available — retry resuming it.'
    )
  })

  it('fails safe on an inconclusive durable lookup', () => {
    expect(sessionTileResumeFailure('404', false, true)).toBe('Session unavailable — you can retry resuming it.')
  })

  it('does not overwrite a tile that rebound while the lookup was pending', () => {
    expect(sessionTileResumeFailure('session not found', true, false)).toBeUndefined()
  })
})

describe('tile resume storm budget', () => {
  it('counts only resumes inside the window', () => {
    const now = 1_000_000
    const stale = now - TILE_RESUME_STORM_WINDOW_MS
    const fresh = now - TILE_RESUME_STORM_WINDOW_MS + 1
    expect(recentTileResumes([stale, fresh, now], now)).toEqual([fresh, now])
  })

  it('trips at the limit and lets an old storm age out', () => {
    const now = 1_000_000
    const underLimit = Array.from({ length: TILE_RESUME_STORM_LIMIT - 1 }, (_, i) => now - i * 1_000)
    const atLimit = Array.from({ length: TILE_RESUME_STORM_LIMIT }, (_, i) => now - i * 1_000)
    expect(tileResumeStormed(underLimit, now)).toBe(false)
    expect(tileResumeStormed(atLimit, now)).toBe(true)
    expect(tileResumeStormed(atLimit, now + TILE_RESUME_STORM_WINDOW_MS)).toBe(false)
  })

  it('spends successful resumes, latches the next attempt, and resets for Retry', () => {
    let now = 1_000_000
    const budget = createTileResumeBudget(() => now)
    for (let cycle = 0; cycle < TILE_RESUME_STORM_LIMIT; cycle += 1) {
      expect(budget.take()).toBe(true)
      budget.spend()
      now += 20_000
    }
    expect(budget.take()).toBe(false)
    expect(budget.take()).toBe(true)
  })

  it('does not spend failed resumes', () => {
    const budget = createTileResumeBudget(() => 1_000_000)
    for (let attempt = 0; attempt < TILE_RESUME_STORM_LIMIT * 2; attempt += 1) {
      expect(budget.take()).toBe(true)
    }
  })
})

describe('startUnrestoredTileTitleBackfill (#94167)', () => {
  afterEach(() => {
    $gatewayState.set('idle')
    $sessionTiles.set([])
    setSessions([])
  })

  it('backfills unlisted unrestored tiles by id via their ownerRoute once the gateway opens', async () => {
    const ownerRoute = { connectionId: 'conn-a', profile: 'writer' }
    setSessions([{ id: 'listed', title: 'Already listed' } as never])
    $sessionTiles.set([
      { ownerRoute, storedSessionId: 'old-chat' },
      { storedSessionId: 'listed' },
      { runtimeId: 'rt-live', storedSessionId: 'live' },
      { storedSessionId: 'bot', workspaceTabTitle: 'Bot Chat' }
    ])

    const lookup = vi.fn(async (id: string) => {
      const row = { id, title: 'Quarterly review' } as never
      setSessions(prev => [row, ...prev])

      return row
    })

    const stop = startUnrestoredTileTitleBackfill(lookup as never)
    expect(lookup).not.toHaveBeenCalled()

    $gatewayState.set('open')
    await vi.waitFor(() => expect(lookup).toHaveBeenCalledTimes(1))
    expect(lookup).toHaveBeenCalledWith('old-chat', ownerRoute)
    expect($sessions.get().find(row => row.id === 'old-chat')?.title).toBe('Quarterly review')

    // One-shot: a later reconnect does not re-probe.
    $gatewayState.set('idle')
    $gatewayState.set('open')
    expect(lookup).toHaveBeenCalledTimes(1)
    stop()
  })
})
