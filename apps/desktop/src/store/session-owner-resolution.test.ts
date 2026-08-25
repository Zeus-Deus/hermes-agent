import { beforeEach, describe, expect, it } from 'vitest'

import { $connectionsRegistry } from './connections'
import { $profiles } from './profile'
import {
  ambientGatewayOwnsEverySession,
  assertSessionOwnerResolved,
  sessionOwnerIsKnown
} from './session-owner-resolution'

const registry = (...ids: string[]) =>
  ({
    connections: ids.map(id => ({ id })),
    lastUsed: ids[0] ?? null,
    launchMode: 'primary',
    primary: ids[0] ?? null
  }) as never

beforeEach(() => {
  $connectionsRegistry.set(null)
  $profiles.set([])
})

describe('session owner topology', () => {
  it('requires exact owners in registry topology while preserving legacy profile routes', () => {
    $connectionsRegistry.set(registry('local'))
    $profiles.set([{ name: 'default' }] as never)

    expect(sessionOwnerIsKnown('default')).toBe(false)
    expect(ambientGatewayOwnsEverySession()).toBe(false)
    expect(() =>
      assertSessionOwnerResolved('default', { method: 'session.resume', sessionId: 'registry-profile' })
    ).toThrow(/could not be resolved/i)

    $connectionsRegistry.set(registry('local', 'homelab'))
    expect(sessionOwnerIsKnown(null)).toBe(false)
    expect(ambientGatewayOwnsEverySession()).toBe(false)
    expect(() => assertSessionOwnerResolved(null, { method: 'session.resume', sessionId: 'unknown-owner' })).toThrow(
      /could not be resolved/i
    )

    $connectionsRegistry.set(null)
    expect(sessionOwnerIsKnown('default')).toBe(true)
    expect(ambientGatewayOwnsEverySession()).toBe(true)
    expect(() =>
      assertSessionOwnerResolved(null, { method: 'session.resume', sessionId: 'legacy-single-profile' })
    ).not.toThrow()

    $profiles.set([{ name: 'default' }, { name: 'loki' }] as never)
    expect(sessionOwnerIsKnown('loki')).toBe(true)
    expect(ambientGatewayOwnsEverySession()).toBe(false)
    expect(() =>
      assertSessionOwnerResolved('loki', { method: 'session.resume', sessionId: 'legacy-profile-owner' })
    ).not.toThrow()
  })
})
