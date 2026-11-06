/**
 * The default profile's custom @handle (#89720). Every machine's default bot
 * is @hermes, so a Desktop connected to a laptop and a server sees two of
 * them. A default whose backend stores `ui_meta['hermes-bots'].mentionHandle`
 * is advertised and resolved by that handle instead; this source's own
 * default keeps answering @hermes so earlier tags still land.
 */

import { describe, expect, it, vi } from 'vitest'

import { canonicalGroupRoster } from './canonical-groups'
import {
  botHandle,
  botMentionTag,
  claimDefaultHandles,
  customDefaultHandle,
  mentionHandleTaken,
  mergeMultiSourceRoster,
  normalizeMentionHandle,
  resolveRosterMentions
} from './data'
import { durableGroupChatMembers } from './group-membership'
import { groupReplyMentionTag, parseGroupChatMentions } from './group-mentions'
import { buildGroupChatTurnPrompt } from './group-round-prompt'
import type { GroupMember, RosterRow } from './types'

vi.mock('@hermes/plugin-sdk', async () => {
  const { atom } = await import('nanostores')

  return { atom, host: {}, queryClient: undefined, useQuery: vi.fn(), useValue: vi.fn() }
})

vi.mock('./shared', () => ({ getPluginCtx: () => null, ID: 'hermes-bots' }))

/** What a backend that resolves custom handles reports on its default row. */
const withHandle = (mention_handle: string) => ({ mention_handle })

/** A Desktop on `laptop` connected to `server`: both list a default (so the registry suffixes both
 *  handles), the laptop's carries a custom handle. */
function twoMachines(laptopHandle = 'maia', serverHandle = ''): RosterRow[] {
  const local = {
    profiles: [{ name: 'default', ...(laptopHandle ? withHandle(laptopHandle) : {}) }, { name: 'researcher' }]
  }

  const agent = (connectionId: string, profile: string, handle: string, extra = {}) => ({
    connectionId,
    connectionKind: connectionId === 'laptop' ? ('local' as const) : ('remote' as const),
    connectionLabel: connectionId === 'laptop' ? 'Laptop' : 'Server',
    handle,
    profile,
    targetProfile: profile,
    ...extra
  })

  const union = {
    agents: [
      agent('laptop', 'default', 'default-laptop'),
      agent('laptop', 'researcher', 'researcher'),
      agent('server', 'default', 'default-server', serverHandle ? { profileMetadata: withHandle(serverHandle) } : {})
    ],
    primaryConnectionId: 'laptop'
  }

  return mergeMultiSourceRoster(local, union, 'laptop').profiles as RosterRow[]
}

describe('normalizeMentionHandle', () => {
  it.each([
    ['@Maia', 'maia'],
    [' lead-2 ', 'lead-2'],
    ['hermes', ''],
    ['default', ''],
    ['everyone', ''],
    ['two words', ''],
    ['default-server', ''],
    ['-lead', ''],
    ['x'.repeat(65), ''],
    [7, '']
  ])('%j → %j (the backend rule)', (value, expected) => {
    expect(normalizeMentionHandle(value)).toBe(expected)
  })
})

describe('a default with a custom handle', () => {
  it('is advertised by it in the roster and the @picker tag, over the device-suffixed alias', () => {
    const [laptop, , server] = twoMachines()

    expect(botHandle(laptop.name, laptop)).toBe('maia')
    expect(botMentionTag(laptop)).toBe('maia')
    // The server's default has none: it keeps its device-qualified handle.
    expect(botHandle(server.name, server)).toBe('default-server')
  })

  it('outranks a Bot Mode title as the picker tag', () => {
    const row = { mention_handle: 'maia', name: 'default', ui_meta: { 'hermes-bots': { title: 'Research Lead' } } }

    expect(botMentionTag(row as RosterRow)).toBe('maia')
  })

  it('tells two machines’ defaults apart, and @hermes stays this machine’s own', () => {
    const rows = twoMachines('maia', 'atlas')

    const tagged = (text: string) =>
      resolveRosterMentions(text, rows, { connectionId: 'laptop', name: 'researcher' }).map(
        row => `${row.name}@${row.connectionId}`
      )

    expect(rows.map(row => botHandle(row.name, row))).toEqual(['maia', 'researcher', 'atlas'])
    expect(tagged('@maia ping')).toEqual(['default@laptop'])
    expect(tagged('@atlas ping')).toEqual(['default@server'])
    expect(tagged('@default-server ping')).toEqual(['default@server'])
  })

  it('keeps answering @hermes on its own source', () => {
    const rows = claimDefaultHandles<RosterRow>([
      { connectionId: 'local', name: 'default', ...withHandle('maia') },
      { connectionId: 'local', name: 'researcher' }
    ])

    for (const tag of ['@maia', '@hermes', '@default']) {
      expect(resolveRosterMentions(`${tag} ping`, rows, { name: 'researcher' }).map(row => row.name)).toEqual([
        'default'
      ])
    }
  })

  it('never lets another machine’s default pick up a bare @hermes', () => {
    const rows = claimDefaultHandles<RosterRow>([
      { connectionId: 'local', name: 'researcher' },
      { connectionId: 'server', handle: 'default', name: 'default', remoteSource: true, ...withHandle('atlas') }
    ])

    expect(resolveRosterMentions('@hermes ping', rows, { name: 'researcher' })).toEqual([])
    expect(resolveRosterMentions('@atlas ping', rows, { name: 'researcher' }).map(row => row.connectionId)).toEqual([
      'server'
    ])
  })

  it('yields to a real profile of that name on the same source, like @hermes', () => {
    const rows = claimDefaultHandles<RosterRow>([
      { connectionId: 'local', name: 'default', ...withHandle('maia') },
      { connectionId: 'local', name: 'maia' },
      { connectionId: 'server', name: 'default', remoteSource: true, ...withHandle('maia') }
    ])

    expect(rows.map(row => botHandle(row.name, row))).toEqual(['hermes', 'maia', 'maia'])
    expect(customDefaultHandle(rows[0].name, rows[0])).toBe('')
  })

  it('ignores the handle on a named profile and an invalid stored value', () => {
    expect(botHandle('researcher', { name: 'researcher', ...withHandle('maia') })).toBe('researcher')
    expect(botHandle('default', { name: 'default', ...withHandle('not valid') })).toBe('hermes')
  })

  it('reads the backend copy only: a cleared server value wins over a stale durable one', () => {
    const row = { mention_handle: '', mentionHandle: 'maia', name: 'default' }

    expect(botHandle('default', row as RosterRow)).toBe('hermes')
  })

  it('is never advertised from an older backend that only stores the metadata', () => {
    // That backend's message_agent, relay door and prompt still know only @hermes.
    const row = { name: 'default', ui_meta: { 'hermes-bots': { mentionHandle: 'maia' } } } as RosterRow

    expect([botHandle('default', row), botMentionTag(row)]).toEqual(['hermes', 'hermes'])
  })
})

describe('the Bots editor collision check', () => {
  it('refuses a handle another row already answers to, on any machine', () => {
    const rows = twoMachines('', 'atlas')
    const self = rows[0]

    expect(mentionHandleTaken('researcher', self, rows)).toBe(true)
    expect(mentionHandleTaken('atlas', self, rows)).toBe(true)
    expect(mentionHandleTaken('maia', self, rows)).toBe(false)

    const titled = [...rows, { connectionId: 'server', name: 'scribe', remoteSource: true, title: 'Maia' } as RosterRow]
    expect(mentionHandleTaken('maia', self, titled)).toBe(true)
  })
})

describe('group rooms', () => {
  const lead = { connectionId: 'local', name: 'default', ...withHandle('maia') } as RosterRow
  const researcher = { connectionId: 'local', name: 'researcher' } as RosterRow

  it('seat the default under its custom handle and keep the earlier one on the durable member', () => {
    const [member] = durableGroupChatMembers([lead])

    expect([member.mentionHandle, member.handle]).toEqual(['maia', 'hermes'])
    // Without the live row (connection switched), the descriptor alone still says @maia.
    expect(botHandle(member.name, member)).toBe('maia')
  })

  it('give a gateway-hosted room started from live rows the custom handle', () => {
    const route = { connectionId: 'local', profile: 'default' }
    const result = canonicalGroupRoster(route as never, [lead, researcher] as GroupMember[])

    expect('roster' in result && result.roster.map(member => member.handle)).toEqual(['maia', 'researcher'])
  })

  it('give a gateway-hosted room the custom handle', () => {
    const members = durableGroupChatMembers([lead, researcher])
    const route = { connectionId: 'local', profile: 'default' }

    const result = canonicalGroupRoster(
      route as never,
      members.map(member => ({ ...member, connectionId: 'local' }))
    )

    expect('roster' in result && result.roster.map(member => member.handle)).toEqual(['maia', 'researcher'])
  })

  it('introduce it by that handle in the turn prompt', () => {
    const members = durableGroupChatMembers([lead, researcher])
    const prompt = buildGroupChatTurnPrompt({ deltaLines: [], groupName: 'ops', members, viewer: members[0] })

    expect(prompt).toContain('You are @maia,')
    expect(buildGroupChatTurnPrompt({ deltaLines: [], groupName: 'ops', members, viewer: members[1] })).toContain(
      '@maia'
    )
  })

  it('address it by the custom handle and by @hermes', () => {
    const members = durableGroupChatMembers([lead, researcher])

    for (const tag of ['@maia', '@hermes']) {
      expect([...parseGroupChatMentions(`${tag} go`, members).mentioned]).toHaveLength(1)
    }

    expect(parseGroupChatMentions('@maia go', members).mentioned).toEqual(
      parseGroupChatMentions('@hermes go', members).mentioned
    )
  })

  it('keep a device-suffixed earlier handle, and give a bare @hermes to no one when two defaults sit', () => {
    const [laptop, , server] = twoMachines('maia', '')
    const members = durableGroupChatMembers([laptop, server])
    const tagged = (text: string) => [...parseGroupChatMentions(text, members).mentioned]

    expect(members.map(member => member.handle)).toEqual(['default-laptop', 'default-server'])
    expect(tagged('@maia go')).toEqual(['laptop::default'])
    expect(tagged('@default-laptop go')).toEqual(['laptop::default'])
    expect(tagged('@hermes go')).toEqual([])
    // The live rows (what a seated room prefers) still answer the suffixed handle.
    expect([...parseGroupChatMentions('@default-laptop go', [laptop, server] as GroupMember[]).mentioned]).toEqual([
      'laptop::default'
    ])
  })

  it('give a handle two machines chose on their own to neither, and reply by the earlier one', () => {
    const [laptop, , server] = twoMachines('maia', 'maia')
    const members = durableGroupChatMembers([laptop, server])
    const tagged = (text: string) => [...parseGroupChatMentions(text, members).mentioned]

    expect(tagged('@maia go')).toEqual([])
    expect(tagged('@default-laptop go')).toEqual(['laptop::default'])
    expect(tagged('@default-server go')).toEqual(['server::default'])
    expect(members.map(member => groupReplyMentionTag(member, members))).toEqual(['default-laptop', 'default-server'])
  })

  it('let a real bot of that name on another machine keep it, whatever the seat order', () => {
    const [laptop] = twoMachines('maia', '')
    const serverMaia = { connectionId: 'server', handle: 'maia', name: 'maia', remoteSource: true } as RosterRow

    for (const seated of [
      [laptop, serverMaia],
      [serverMaia, laptop]
    ]) {
      const members = durableGroupChatMembers(seated)
      const tagged = (text: string) => [...parseGroupChatMentions(text, members).mentioned]

      expect(tagged('@maia go')).toEqual(['server::maia'])
      expect(tagged('@default-laptop go')).toEqual(['laptop::default'])
      expect(
        groupReplyMentionTag(
          members.find(member => member.name === 'default')!,
          members
        )
      ).toBe('default-laptop')
    }
  })

  it('introduce each colliding default by a tag that reaches it alone', () => {
    const [laptop, , server] = twoMachines('maia', 'maia')
    const members = durableGroupChatMembers([laptop, server])
    const prompt = buildGroupChatTurnPrompt({ deltaLines: [], groupName: 'ops', members, viewer: members[0] })

    expect(prompt).toContain('You are @default-laptop,')
    expect(prompt).toContain('@default-server')
    expect(prompt).not.toContain('@maia')
  })
})

describe('room collisions through friendly names', () => {
  it('keep a real bot’s name even when the default is also titled like its handle, in either seat order', () => {
    const lead = {
      connectionId: 'laptop',
      handle: 'default-laptop',
      name: 'default',
      remoteSource: true,
      title: 'Maia',
      ...withHandle('maia')
    } as RosterRow

    const serverMaia = { connectionId: 'server', handle: 'maia', name: 'maia', remoteSource: true } as RosterRow

    for (const seated of [
      [serverMaia, lead],
      [lead, serverMaia]
    ]) {
      const members = durableGroupChatMembers(seated)

      expect([...parseGroupChatMentions('@maia go', members).mentioned]).toEqual(['server::maia'])
    }
  })

  it('give two defaults titled and handled alike neither tag', () => {
    const [laptop, , server] = twoMachines('maia', 'maia').map(row => ({ ...row, title: 'Maia' }))

    for (const seated of [
      [laptop, server],
      [server, laptop]
    ]) {
      const members = durableGroupChatMembers(seated)

      expect([...parseGroupChatMentions('@maia go', members).mentioned]).toEqual([])
    }
  })
})

describe('a custom handle equal to a title’s first word', () => {
  it('leaves that word with the titled bot, in either seat order', () => {
    const [laptop] = twoMachines('alice', '')

    const writer = {
      connectionId: 'server',
      handle: 'writer',
      name: 'writer',
      remoteSource: true,
      title: 'Alice Smith'
    } as RosterRow

    for (const seated of [
      [laptop, writer],
      [writer, laptop]
    ]) {
      const members = durableGroupChatMembers(seated)

      expect([...parseGroupChatMentions('@alice go', members).mentioned]).toEqual(['server::writer'])
      expect([...parseGroupChatMentions('@default-laptop go', members).mentioned]).toEqual(['laptop::default'])
    }
  })
})

describe('a custom handle equal to a collapsed title', () => {
  it.each(['Alice-Bob', 'Alice_Bob'])(
    'leaves %j’s collapsed spelling with the titled default, in either seat order',
    title => {
      const [laptop, , server] = twoMachines('alicebob', 'atlas')
      const titled = { ...server, title }

      for (const seated of [
        [laptop, titled],
        [titled, laptop]
      ]) {
        const members = durableGroupChatMembers(seated)

        expect([...parseGroupChatMentions('@alicebob go', members).mentioned]).toEqual(['server::default'])
      }
    }
  )
})

describe('a custom handle equal to another default’s collapsed custom handle', () => {
  it.each([
    ['ma-ia', 'maia'],
    ['maia', 'ma-ia']
  ])(
    'leaves each exact handle with its own default (laptop %j, server %j), in either seat order',
    (laptopHandle, serverHandle) => {
      const [laptop, , server] = twoMachines(laptopHandle, serverHandle)

      for (const seated of [
        [laptop, server],
        [server, laptop]
      ]) {
        for (const members of [seated as GroupMember[], durableGroupChatMembers(seated)]) {
          const tagged = (text: string) => [...parseGroupChatMentions(text, members).mentioned]

          expect(tagged(`@${laptopHandle} go`)).toEqual(['laptop::default'])
          expect(tagged(`@${serverHandle} go`)).toEqual(['server::default'])
          expect(tagged(`@${laptopHandle} @${serverHandle} go`).sort()).toEqual(['laptop::default', 'server::default'])
        }
      }
    }
  )
})

describe('a custom handle equal to a sibling’s -local address', () => {
  it('leaves @<name>-local with that sibling, in either seat order', () => {
    const lead = { connectionId: 'local', mentionHandle: 'writer-local', name: 'default' } as GroupMember
    const writer = { connectionId: 'local', name: 'writer' } as GroupMember

    const server = {
      connectionId: 'server',
      handle: 'default-server',
      name: 'default',
      remoteSource: true
    } as GroupMember

    for (const members of [
      [lead, writer, server],
      [server, writer, lead]
    ]) {
      expect([...parseGroupChatMentions('@writer-local go', members).mentioned]).toEqual(['writer'])
    }
  })
})

describe('a custom handle shaped like a device tag', () => {
  it('is not a handle, so a default never loses its own device tag to @hermes', () => {
    const [laptop, , server] = twoMachines('maia', 'default-server')
    const members = durableGroupChatMembers([laptop, server])

    expect(customDefaultHandle(server.name, server)).toBe('')
    expect(members.map(member => member.handle)).toEqual(['default-laptop', 'default-server'])
    expect([...parseGroupChatMentions('@hermes go', members).mentioned]).toEqual([])
    expect([...parseGroupChatMentions('@default-server go', members).mentioned]).toEqual(['server::default'])
  })
})

describe('a custom handle equal to another default’s earlier handle', () => {
  it('never takes that machine’s device tag, in either seat order', () => {
    const [laptop, , server] = twoMachines('default-server', 'atlas')

    for (const seated of [
      [laptop, server],
      [server, laptop]
    ]) {
      const members = durableGroupChatMembers(seated)

      expect([...parseGroupChatMentions('@default-server go', members).mentioned]).toEqual(['server::default'])
      expect([...parseGroupChatMentions('@atlas go', members).mentioned]).toEqual(['server::default'])
    }
  })
})

describe('the roster resolver', () => {
  it('keeps a form three bots share unresolved', () => {
    const rows = ['a', 'b', 'c'].map(
      connectionId => ({ connectionId, name: 'default', remoteSource: true, ...withHandle('maia') }) as RosterRow
    )

    expect(resolveRosterMentions('@maia ping', rows, { name: 'researcher' })).toEqual([])
    expect(resolveRosterMentions('@maia@b ping', rows, { name: 'researcher' }).map(row => row.connectionId)).toEqual([
      'b'
    ])
  })
})
