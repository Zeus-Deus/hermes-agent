/**
 * Cross-connection Bot Mode: a roster row can belong to another registered
 * connection's backend, and a group chat can seat members from several
 * machines at once.
 *
 * Everything hangs off one rule — a source-scoped row carries an IMMUTABLE
 * route descriptor and every RPC for it goes through `host.requestProfile`
 * with that descriptor, never through the active gateway. The alias case is
 * the sharp edge: Desktop's identity for the row (`route.profile`) and the
 * backend's own name for it (`route.targetProfile`) differ, so the params of
 * every profile-shaped RPC have to be translated on the way out while the
 * route keeps the Desktop identity.
 *
 * Ported from tests/cross-connection-bots.test.mjs, which ran the whole
 * plugin.js bundle under `vm`.
 */

import type * as HermesSdk from '@hermes/plugin-sdk'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { GroupMember, ProfileRoute, RosterRow } from './types'

const { overrides, request, requestProfile } = vi.hoisted(() => ({
  overrides: {} as Record<string, unknown>,
  request: vi.fn(),
  requestProfile: vi.fn()
}))

vi.mock('@hermes/plugin-sdk', async importOriginal => {
  const sdk = await importOriginal<typeof HermesSdk>()

  overrides.request = request
  overrides.requestProfile = requestProfile

  return {
    ...sdk,
    host: new Proxy(sdk.host, {
      get: (target, prop) => (prop in overrides ? overrides[prop as string] : Reflect.get(target, prop))
    })
  }
})

const { botBackendProfileScope, botConnectionRoute, requestForBot } = await import('./routing')
const { groupMemberAuthor, groupMemberKey } = await import('./group-membership')

const { buildGroupChatTurnPrompt, formatGroupChatLine, formatGroupDeltaLines } = await import('./group-round-prompt')
const { parseGroupChatMentions, resolveGroupResponders } = await import('./group-rounds')

const aliasBot = {
  name: 'worker',
  route: {
    connectionId: 'remote-a',
    mode: 'remote',
    profile: 'worker',
    targetProfile: 'backend-worker'
  } satisfies ProfileRoute,
  sourceScoped: true
} as RosterRow

beforeEach(() => {
  vi.clearAllMocks()
  request.mockResolvedValue({})
  requestProfile.mockResolvedValue({})
})

describe('every source-scoped row resolves to an immutable owner', () => {
  it('routes only source-annotated rows, and freezes the descriptor', () => {
    expect(botConnectionRoute({ connectionId: 'local', name: 'writer' })).toBeNull()
    expect(botConnectionRoute({ name: 'writer' })).toBeNull()
    expect(Object.isFrozen(botConnectionRoute({ connectionId: 'spark', name: 'writer', sourceScoped: true }))).toBe(
      true
    )
    expect(botConnectionRoute({ connectionId: 'mac-mini', name: 'dixie', remoteSource: true })).toEqual({
      connectionId: 'mac-mini',
      mode: 'remote',
      profile: 'dixie',
      targetProfile: 'dixie'
    })
  })

  it('keeps Desktop identity separate from the backend target in the capability scope', () => {
    expect(
      botBackendProfileScope({
        connectionId: 'remote-a',
        mode: 'remote',
        profile: 'worker',
        targetProfile: 'backend-worker'
      })
    ).toEqual({ connectionId: 'remote-a', profile: 'backend-worker' })
  })
})

describe('requestForBot dispatches on the owner, not the active gateway', () => {
  it('sends source-scoped rows through requestProfile and local rows through request', async () => {
    await requestForBot({ name: 'local-bot' }, 'session.create', { title: 'x' })
    await requestForBot({ connectionId: 'local', name: 'local-bot', sourceScoped: true }, 'session.create', {
      title: 'x'
    })
    await requestForBot({ connectionId: 'mac-mini', name: 'dixie', remoteSource: true }, 'prompt.submit', {
      text: 'hi'
    })

    expect(request.mock.calls.map(([method]) => method)).toEqual(['session.create'])
    // A registered LOCAL source still uses the explicit descriptor.
    expect(requestProfile.mock.calls.map(([route, method]) => [route.connectionId, method])).toEqual([
      ['local', 'session.create'],
      ['mac-mini', 'prompt.submit']
    ])
  })

  it('translates every backend-profile RPC shape for a non-identity alias', async () => {
    await requestForBot(aliasBot, 'profiles.describe', { name: 'worker' })
    await requestForBot(aliasBot, 'profiles.configure', { name: 'worker', soul: 'x' })
    await requestForBot(aliasBot, 'profiles.create', { clone_from: 'worker', name: 'worker-2' })
    await requestForBot(aliasBot, 'session.create', { profile: 'worker', title: 'Bot Chat' })
    await requestForBot(aliasBot, 'cli.exec', { argv: ['--profile', 'worker', 'config', 'unset', 'model'] })
    await requestForBot(aliasBot, 'cli.exec', { argv: ['profile', 'describe', 'worker', '--text', 'worker'] })

    expect(requestProfile.mock.calls.map(([, , params]) => params)).toEqual([
      { name: 'backend-worker' },
      { name: 'backend-worker', soul: 'x' },
      { clone_from: 'backend-worker', name: 'worker-2' },
      { profile: 'backend-worker', title: 'Bot Chat' },
      { argv: ['--profile', 'backend-worker', 'config', 'unset', 'model'] },
      // Only the profile operand is rewritten — the trailing --text value is
      // the user's own argument and stays untouched.
      { argv: ['profile', 'describe', 'backend-worker', '--text', 'worker'] }
    ])
    // The route keeps Desktop's identity for the row throughout.
    expect(requestProfile.mock.calls.every(([route]) => route.profile === 'worker')).toBe(true)
  })
})

describe('a group room seats members from several machines', () => {
  it('source-qualifies remote member keys and leaves local ones bare', () => {
    // Bare names keep persisted-room compatibility for single-source rooms.
    expect(groupMemberKey({ name: 'ops' } as GroupMember)).toBe('ops')
    expect(groupMemberKey({ connectionId: 'mac-mini', name: 'dixie', remoteSource: true } as GroupMember)).toBe(
      'mac-mini::dixie'
    )
  })

  it('resolves @name-device to the remote member, keeping same-named agents distinct', () => {
    const members = [
      { name: 'dixie', title: '' },
      { connectionId: 'mac-mini', handle: 'dixie-mac-mini', name: 'dixie', remoteSource: true }
    ] as GroupMember[]

    const parsed = parseGroupChatMentions('hey @dixie-mac-mini can you check disk space', members)

    expect([...parsed.mentioned]).toEqual(['mac-mini::dixie'])

    const responders = resolveGroupResponders(
      [{ at: 1, from: { kind: 'user', name: 'You' }, text: '@dixie-mac-mini ping' }],
      members
    )

    expect(responders).toHaveLength(1)
    expect(responders[0].remoteSource).toBe(true)
  })

  it('badges cross-connection speakers with their device in lines and turn prompts', () => {
    expect(
      formatGroupChatLine({ at: 1, from: { kind: 'member', name: 'dixie', source: 'Mac Mini' }, text: 'done' }, 'ops')
    ).toBe('dixie [Mac Mini]: done')
    expect(
      buildGroupChatTurnPrompt({
        deltaLines: ['You (user): hi'],
        groupName: 'infra',
        members: [
          { name: 'ops', title: '' },
          { connectionId: 'mac-mini', connectionLabel: 'Mac Mini', name: 'dixie', remoteSource: true }
        ] as GroupMember[],
        viewer: { name: 'ops' } as GroupMember
      })
    ).toMatch(/@dixie \[on Mac Mini\]/)
  })

  it('names the Desktop’s own machine from a remote viewer’s side in turn prompts', () => {
    // "This device" is the Desktop's own connection — the viewer's machine only when the viewer
    // lives there too. A viewer on another gateway reading "[on This device]" took it for its own.
    const members = [
      { connectionId: 'local', connectionKind: 'local', connectionLabel: 'This device', name: 'alice', remoteSource: true },
      { connectionId: 'server', connectionKind: 'remote', connectionLabel: 'Server', name: 'bob', remoteSource: true },
      { connectionId: 'local', connectionKind: 'local', connectionLabel: 'This device', name: 'carol', remoteSource: true }
    ] as GroupMember[]

    const header = (viewer: GroupMember) =>
      buildGroupChatTurnPrompt({ deltaLines: [], groupName: 'g', members, viewer }).split('\n')[0]

    const fromServer = header(members[1])
    expect(fromServer).toMatch(/@alice \[on the machine running the Desktop app\]/)
    expect(fromServer).not.toMatch(/This device/)

    // A viewer on the Desktop's machine keeps the label it shares with the user.
    expect(header(members[2])).toMatch(/@alice \[on This device\], @bob \[on Server\]/)

    // An unscoped viewer (no connection metadata: the aggregate roster failed while a remote
    // gateway was active) is not assumed to be on the Desktop's machine.
    const unscoped = buildGroupChatTurnPrompt({
      deltaLines: [],
      groupName: 'g',
      members: [members[0], { name: 'dave' } as GroupMember],
      viewer: { name: 'dave' } as GroupMember
    }).split('\n')[0]

    expect(unscoped).toMatch(/@alice \[on the machine running the Desktop app\]/)

    // The transcript badges the speaker the same way: the stored `from.source` stays the
    // identity token, only its rendering for a viewer off the Desktop's machine changes.
    const reply = { at: 1, from: groupMemberAuthor(members[0]), text: 'The notes are ready.' }

    const withDelta = (viewer: GroupMember) =>
      buildGroupChatTurnPrompt({
        deltaLines: formatGroupDeltaLines([reply], viewer, 'g'),
        groupName: 'g',
        members,
        viewer
      })

    expect(reply.from.source).toBe('This device')
    expect(withDelta(members[1])).toMatch(/alice \[the machine running the Desktop app\]: The notes are ready\./)
    expect(withDelta(members[1])).not.toMatch(/This device/)
    expect(withDelta(members[2])).toMatch(/alice \[This device\]: The notes are ready\./)
    // Any other badge is a name, not a point of view: a remote connection labelled "local" stays.
    expect(formatGroupChatLine({ ...reply, from: { kind: 'member', name: 'alice', source: 'local' } }, members[1])).toBe(
      'alice [local]: The notes are ready.'
    )
  })

  it('badges a transcript speaker by its connection, not by the label text', () => {
    // The user renamed the Desktop's own connection "Laptop" and named a remote one "This
    // device" — the registry accepts both. The label no longer says which machine is whose.
    const members = [
      { connectionId: 'local', connectionKind: 'local', connectionLabel: 'Laptop', installId: 'gw-laptop', name: 'alice', remoteSource: true },
      { connectionId: 'server', connectionKind: 'remote', connectionLabel: 'This device', installId: 'gw-server', name: 'bob', remoteSource: true },
      { connectionId: 'mini', connectionKind: 'remote', connectionLabel: 'Mini', name: 'carol', remoteSource: true }
    ] as GroupMember[]

    const fromAlice = { at: 1, from: groupMemberAuthor(members[0]), text: 'Notes are on my disk.' }
    const fromBob = { at: 2, from: groupMemberAuthor(members[1]), text: 'Build is green.' }

    const lines = (viewer: GroupMember) => formatGroupDeltaLines([fromAlice, fromBob], viewer, 'g', members)

    // A viewer on another gateway: alice is on the Desktop's machine, bob is on his own.
    expect(lines(members[2])).toEqual([
      'alice [Laptop (the machine running the Desktop app)]: Notes are on my disk.',
      'bob [This device]: Build is green.'
    ])

    // A viewer on the Desktop's machine reads the labels it shares with the user.
    const local = { connectionId: 'local', connectionKind: 'local', connectionLabel: 'Laptop', name: 'dave' } as GroupMember
    expect(lines(local)).toEqual(['alice [Laptop]: Notes are on my disk.', 'bob [This device]: Build is green.'])

    // A pre-rename entry still resolves by its gateway identity, whatever its stored label.
    const stale = { at: 3, from: { gateway: 'gw-laptop', kind: 'member' as const, name: 'alice', source: 'This device' }, text: 'old' }
    expect(formatGroupChatLine(stale, members[2], 'g', members)).toBe('alice [the machine running the Desktop app]: old')

    // A badge no roster connection claims is a name, not a point of view: it stays verbatim
    // once the roster shows the Desktop's own connection goes by another label.
    const departed = { at: 4, from: { kind: 'member' as const, name: 'erin', source: 'This device' }, text: 'bye' }
    expect(formatGroupChatLine(departed, members[2], 'g', members)).toBe('erin [This device]: bye')

    // A same-labelled connection with a different gateway identity is not the speaker's.
    const twin = [
      { connectionId: 'local', connectionKind: 'local', connectionLabel: 'This device', installId: 'gw-a', name: 'alice' },
      members[2]
    ] as GroupMember[]

    const mirrored = { at: 5, from: { gateway: 'gw-b', kind: 'member' as const, name: 'alice', source: 'This device' }, text: 'hi' }
    expect(formatGroupChatLine(mirrored, members[2], 'g', twin)).toBe('alice [This device]: hi')
    expect(formatGroupChatLine({ ...mirrored, from: { ...mirrored.from, gateway: 'gw-a' } }, members[2], 'g', twin)).toBe(
      'alice [the machine running the Desktop app]: hi'
    )

    // Only with no roster at all is the registry's default label read as the Desktop's machine.
    expect(formatGroupChatLine(departed, members[2], 'g')).toBe('erin [the machine running the Desktop app]: bye')

    // The stored stamp is the identity token and is never rewritten.
    expect(fromBob.from.source).toBe('This device')
  })

  it('does not self-attribute a same-named default on another connection (#106851)', () => {
    // Cross-connection same profile name must not self-attribute in model prompt lines.
    const line = formatGroupChatLine(
      { at: 1, from: { kind: 'member', name: 'default', source: 'Connection B' }, text: 'Remote reply' },
      { name: 'default' }
    )

    expect(line).not.toContain('(you)')
    expect(line).toMatch(/Remote reply/)

    // CONTROL: same-connection self still gets (you)
    expect(
      formatGroupChatLine({ at: 2, from: { kind: 'member', name: 'default' }, text: 'Mine' }, { name: 'default' })
    ).toContain('(you)')

    // CONTROL: remote viewer seeing own remote line still gets (you)
    expect(
      formatGroupChatLine(
        { at: 3, from: { kind: 'member', name: 'default', source: 'Connection B' }, text: 'Mine remote' },
        { name: 'default', remoteSource: true, connectionLabel: 'Connection B', connectionId: 'conn-b' }
      )
    ).toContain('(you)')

    // String viewer API is local / unsourced — a sourced peer of the same
    // name must not pick up (you) just because the names match.
    expect(
      formatGroupChatLine(
        { at: 4, from: { kind: 'member', name: 'default', source: 'Connection B' }, text: 'Still remote' },
        'default'
      )
    ).not.toContain('(you)')

    // User lines stay on the (user) path even when the display name collides.
    expect(
      formatGroupChatLine({ at: 5, from: { kind: 'user', name: 'default' }, text: 'human' }, { name: 'default' })
    ).toContain('(user)')
    expect(
      formatGroupChatLine({ at: 5, from: { kind: 'user', name: 'default' }, text: 'human' }, { name: 'default' })
    ).not.toContain('(you)')
  })
})
