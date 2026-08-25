import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  getHermesConfigRecord,
  getMcpCatalog,
  getSkillContent,
  getSkills,
  getToolsets,
  getUsageAnalytics,
  installSkillFromHub,
  profileScopeKey,
  saveMcpServers,
  setApiRequestConnection,
  setApiRequestProfile,
  setSkillEnabled,
  setToolsetEnabled
} from './hermes'

// Contract: the Capabilities surface (skills / toolsets / MCP / hub / config)
// can be scoped to a (connection, profile) pair — a profile belongs to ONE
// gateway, so its skills/tools/MCP must be read from and written to THAT
// machine's backend. Three shapes:
//   - no scope         → ambient profile + ambient registry connection tag
//   - string scope     → explicit profile, ambient connection tag
//   - object scope     → explicit (connection, profile) pin; 'local' pins THIS
//                        machine explicitly (overriding the ambient connection
//                        tag AND the legacy remote route in the main process)
describe('capability helpers are connection-scoped', () => {
  const api = vi.fn(async (_req: { connectionId?: string; path: string; profile?: string }) => ({}) as never)

  beforeEach(() => {
    ;(window as { hermesDesktop?: unknown }).hermesDesktop = { api }
    api.mockClear()
  })

  afterEach(() => {
    setApiRequestProfile(null)
    setApiRequestConnection(null)
    delete (window as { hermesDesktop?: unknown }).hermesDesktop
  })

  const last = () => api.mock.calls.at(-1)?.[0] as { connectionId?: string; profile?: string }

  it('omits both scopes when none are active (single-source users unaffected)', () => {
    void getSkills()
    expect(last()).not.toHaveProperty('profile')
    expect(last()).not.toHaveProperty('connectionId')
  })

  it('carries the ambient registry connection on the legacy string/ambient path', () => {
    // A window activated onto a registered remote gateway must read THAT
    // machine's skills — not the local pool's (the ambient-tag half).
    setApiRequestProfile('research')
    setApiRequestConnection('gw-tailscale')

    void getSkills()
    void getToolsets()
    void getHermesConfigRecord()
    void getMcpCatalog()
    void getUsageAnalytics(30)

    for (const call of api.mock.calls) {
      expect((call[0] as { connectionId?: string }).connectionId).toBe('gw-tailscale')
      expect(call[0].profile).toBe('research')
    }
  })

  it('string scopes override the profile but keep the ambient connection', () => {
    setApiRequestProfile('research')
    setApiRequestConnection('gw-tailscale')

    void getSkills('coder')

    expect(last().profile).toBe('coder')
    expect(last().connectionId).toBe('gw-tailscale')
  })

  it('object scopes pin every read and write to the named connection', () => {
    void getSkills({ connectionId: 'homelab', profile: 'inbox-bot' })
    void getToolsets({ connectionId: 'homelab', profile: 'inbox-bot' })
    void getSkillContent('arxiv', { connectionId: 'homelab', profile: 'inbox-bot' })
    void setSkillEnabled('arxiv', false, { connectionId: 'homelab', profile: 'inbox-bot' })
    void setToolsetEnabled('browser', true, { connectionId: 'homelab', profile: 'inbox-bot' })
    void saveMcpServers({}, { connectionId: 'homelab', profile: 'inbox-bot' })
    void installSkillFromHub('official/research/arxiv', { connectionId: 'homelab', profile: 'inbox-bot' })

    for (const call of api.mock.calls) {
      expect((call[0] as { connectionId?: string }).connectionId).toBe('homelab')
      expect(call[0].profile).toBe('inbox-bot')
    }
  })

  it("a 'local' pin routes to THIS machine even while a remote gateway is active (#94071)", () => {
    setApiRequestProfile('research')
    setApiRequestConnection('gw-tailscale')

    void getSkills({ connectionId: 'local', profile: 'coder' })

    // Emitted verbatim: the main process keeps an explicit `local` registry-
    // pinned so it cannot inherit the active/legacy remote route. Dropping it
    // sent a "This device" bot's capability reads to the remote gateway,
    // which answered 404 "Profile 'coder' does not exist".
    expect(last().profile).toBe('coder')
    expect(last().connectionId).toBe('local')
  })

  it('an empty connection id in an object scope stays unpinned (legacy route, no ambient tag)', () => {
    setApiRequestProfile('research')
    setApiRequestConnection('gw-tailscale')

    void getSkills({ connectionId: '', profile: 'coder' })

    expect(last().profile).toBe('coder')
    expect(last()).not.toHaveProperty('connectionId')
  })

  it('profileScopeKey keeps legacy keys byte-identical and namespaces every explicit pin', () => {
    expect(profileScopeKey()).toBe('default')
    expect(profileScopeKey(null)).toBe('default')
    expect(profileScopeKey('coder')).toBe('coder')
    expect(profileScopeKey({ connectionId: '', profile: 'coder' })).toBe('coder')
    expect(profileScopeKey({ connectionId: 'homelab', profile: 'coder' })).toBe('homelab::coder')
    expect(profileScopeKey({ connectionId: 'homelab' })).toBe('homelab::default')
  })

  it("a 'local' pin is namespaced apart from the legacy key it no longer routes with (#94071)", () => {
    // capabilityScoped sends an explicit 'local' pin to THIS machine while a
    // legacy string scope follows the active gateway. Sharing the bare key
    // would let the query cache serve a remote same-named profile's
    // skills/toolsets/config to a "This device" bot's editor — and let that
    // editor's toggles write into the remote row.
    expect(profileScopeKey({ connectionId: 'local', profile: 'coder' })).toBe('local::coder')
    expect(profileScopeKey({ connectionId: 'local', profile: 'coder' })).not.toBe(profileScopeKey('coder'))
    expect(profileScopeKey({ connectionId: 'local' })).toBe('local::default')
  })
})
