import { describe, expect, it } from 'vitest'

import {
  createTileResumeBudget,
  recentTileResumes,
  sessionTileResumeFailure,
  TILE_RESUME_STORM_LIMIT,
  TILE_RESUME_STORM_WINDOW_MS,
  tileResumeStormed
} from './session-tile'

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

// #93892: the resume chain had per-step timeouts but no overall budget, so a
// runtime that resumed and was reclaimed over and over spun the loader
// forever. These pin the budget helpers and the pane's use of them.
describe('tile resume storm budget', () => {
  it('counts only resumes inside the window', () => {
    const now = 1_000_000
    const stale = now - TILE_RESUME_STORM_WINDOW_MS
    const fresh = now - TILE_RESUME_STORM_WINDOW_MS + 1

    expect(recentTileResumes([stale, fresh, now], now)).toEqual([fresh, now])
  })

  it('trips once the limit of successful resumes lands inside one window', () => {
    const now = 1_000_000
    const underLimit = Array.from({ length: TILE_RESUME_STORM_LIMIT - 1 }, (_, i) => now - i * 1_000)
    const atLimit = Array.from({ length: TILE_RESUME_STORM_LIMIT }, (_, i) => now - i * 1_000)

    expect(tileResumeStormed(underLimit, now)).toBe(false)
    expect(tileResumeStormed(atLimit, now)).toBe(true)
  })

  it('lets an old storm age out of the window', () => {
    const then = 1_000_000
    const storm = Array.from({ length: TILE_RESUME_STORM_LIMIT }, (_, i) => then - i * 1_000)

    expect(tileResumeStormed(storm, then)).toBe(true)
    expect(tileResumeStormed(storm, then + TILE_RESUME_STORM_WINDOW_MS)).toBe(false)
  })

  it('createTileResumeBudget: successes spend it, the next take past the limit latches, Retry starts clean', () => {
    let now = 1_000_000
    const budget = createTileResumeBudget(() => now)

    // The reclaim loop: each cycle resumes (take + spend) ~20s apart.
    for (let cycle = 0; cycle < TILE_RESUME_STORM_LIMIT; cycle += 1) {
      expect(budget.take()).toBe(true)
      budget.spend()
      now += 20_000
    }

    // One more cycle inside the window: the pane must latch, not dial.
    expect(budget.take()).toBe(false)

    // The user's Retry (or a gateway reopen) gets a clean budget.
    expect(budget.take()).toBe(true)
  })

  it('createTileResumeBudget: failed resumes do not spend it', () => {
    const budget = createTileResumeBudget(() => 1_000_000)

    for (let attempt = 0; attempt < TILE_RESUME_STORM_LIMIT * 2; attempt += 1) {
      expect(budget.take()).toBe(true)
    }
  })
})
