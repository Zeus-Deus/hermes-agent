/**
 * A room member whose connection is not registered on this Desktop.
 *
 * Room membership rides the gateway projection, and every Desktop writes its
 * members in ITS OWN connection namespace. A second Desktop (or an older
 * registry) that reached this machine as connection `laptop` publishes the
 * same bot as `laptop::alice`; merged here it sits next to `local::alice`
 * — one bot, two seats. This Desktop has no `laptop` connection, so that
 * seat can never be reached: driving it fails every turn (or, once held,
 * piles up held room messages forever), its handle shadows the real
 * member's `@alice`, and every other member is told about a phantom
 * participant `@alice [on laptop]`.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

import type * as groupChat from './group-chat'
import type * as groupMembership from './group-membership'
import type * as groupRounds from './group-rounds'
import { createGroupGateway, drain, runTimersInline, scriptedStorage } from './group-test-utils'
import type { GatewayOptions, ScriptedGateway } from './group-test-utils'
import type { GroupMember } from './types'

const { host } = vi.hoisted(() => ({ host: {} as Record<string, unknown> }))

vi.mock('@hermes/plugin-sdk', async () => {
  const { pluginSdkMock } = await import('./group-test-utils')

  return pluginSdkMock(host)
})

interface Room {
  chat: typeof groupChat
  gateway: ScriptedGateway
  membership: typeof groupMembership
  /** `connectionId::profile` of every member turn submitted, in order. */
  routed: string[]
  rounds: typeof groupRounds
}

async function loadRoom(registered: null | string[], options: GatewayOptions = {}): Promise<Room> {
  vi.resetModules()
  const gateway = createGroupGateway(options)

  for (const key of Object.keys(host)) {
    delete host[key]
  }

  Object.assign(host, gateway.host)
  const routed: string[] = []
  const requestProfile = gateway.host.requestProfile as (...args: unknown[]) => Promise<unknown>

  host.requestProfile = (route: { connectionId: string; profile: string }, method: string, ...rest: unknown[]) => {
    if (method === 'prompt.submit') {
      routed.push(`${route.connectionId}::${route.profile}`)
    }

    return requestProfile(route, method, ...rest)
  }

  if (registered) {
    host.connections = async () => registered.map(id => ({ id, kind: id === 'local' ? 'local' : 'remote', label: id }))
  }

  const [chat, membership, rounds, shared] = await Promise.all([
    import('./group-chat'),
    import('./group-membership'),
    import('./group-rounds'),
    import('./shared')
  ])

  shared.setPluginCtx(scriptedStorage(gateway.storage))

  return { chat, gateway, membership, routed, rounds }
}

const ALICE: GroupMember = {
  name: 'alice',
  connectionId: 'local',
  connectionKind: 'local',
  connectionLabel: 'This device',
  sourceScoped: true
}

const BOB: GroupMember = {
  name: 'bob',
  connectionId: 'server',
  connectionKind: 'remote',
  connectionLabel: 'Server',
  remoteSource: true,
  sourceScoped: true
}

/** The same bot as another Desktop's registry names it — no `laptop` here. */
const PHANTOM: GroupMember = {
  name: 'alice',
  connectionId: 'laptop',
  connectionKind: 'remote',
  connectionLabel: 'laptop',
  remoteSource: true,
  sourceScoped: true
}

const MEMBERS = [ALICE, BOB, PHANTOM]

function seedRoom(room: Room) {
  room.chat.$groupChats.set({
    g: { log: [], members: MEMBERS, roomId: 'room', sessions: {}, watermarks: {} }
  })
}

async function send(room: Room, text: string, thread?: null | string) {
  const sent = room.rounds.sendToGroupChat('g', room.chat.$groupChats.get().g.members || MEMBERS, text, thread)
  await drain(() => Boolean(room.chat.$groupChats.get().g?.running))

  return sent
}

beforeEach(() => {
  runTimersInline()
})

describe('a member seated on a connection this Desktop does not have', () => {
  it('is never driven, and no other member is told about it', async () => {
    const room = await loadRoom(['local', 'server'], { turn: () => '(pass)' })
    seedRoom(room)

    await send(room, '@everyone status?')

    expect(room.routed).not.toContain('laptop::alice')
    expect([...new Set(room.routed)].sort()).toEqual(['local::alice', 'server::bob'])

    for (const call of room.gateway.calls) {
      expect(call.prompt).not.toContain('[on laptop]')
    }
  })

  it('does not take the real member\'s @handle', async () => {
    const room = await loadRoom(['local', 'server'], { turn: () => '(pass)' })
    seedRoom(room)

    await send(room, '@alice check the build queue')

    expect([...new Set(room.routed)]).toEqual(['local::alice'])
  })

  it('is marked as a missing source and kept, so the room shows it degraded instead of dropping it', async () => {
    const room = await loadRoom(['local', 'server'], { turn: () => '(pass)' })
    seedRoom(room)

    await send(room, '@everyone status?')

    const stored = room.chat.$groupChats.get().g.members || []
    const phantom = stored.find(member => member.connectionId === 'laptop')

    expect(stored).toHaveLength(3)
    expect(phantom?.sourceMissing).toBe(true)
    expect(stored.filter(member => member.sourceMissing)).toHaveLength(1)
  })

  it('puts the very first "stop @alice" on the real member and never holds messages for the phantom', async () => {
    const room = await loadRoom(['local', 'server'], { turn: () => '(pass)' })
    seedRoom(room)
    // What the plugin does at load, before any drive has read the registry.
    await room.rounds.registeredConnectionIds()

    const thread = await send(room, 'stop @alice')
    await send(room, '@bob keep going', thread)

    const after = room.chat.$groupChats.get().g

    // The phantom's hold (the registry view could have lagged) is inert:
    // it is never driven, so nothing is ever held for it.
    expect(Object.keys(after.holds || {})).toContain('local::alice')
    expect(Object.keys(after.holds || {})).not.toContain('server::bob')
    expect(Object.keys(after.heldMessages || {})).not.toContain('laptop::alice')
    expect(room.routed).not.toContain('laptop::alice')
    expect(room.routed).not.toContain('local::alice')
  })

  it('keeps the missing-source mark when a newer projection re-seats the same member', async () => {
    const room = await loadRoom(['local', 'server'])

    const local = {
      g: {
        log: [],
        members: [ALICE, BOB, { ...PHANTOM, sourceMissing: true, sourceReachable: false }],
        roomId: 'room',
        syncRevision: 1,
        watermarks: {}
      }
    }

    const merged = room.chat.mergeRemoteGroupChatSnapshotIntoRooms(
      {
        version: 3,
        rooms: { 'id:room': { name: 'g', roomId: 'room', log: [], members: MEMBERS, revision: 2 } }
      },
      local
    )

    const byKey = new Map((merged.g.members || []).map(member => [`${member.connectionId}::${member.name}`, member]))

    expect(byKey.get('laptop::alice')?.sourceMissing).toBe(true)
    expect(byKey.get('laptop::alice')?.remoteSource).toBe(true)
    expect(byKey.get('local::alice')?.sourceMissing).toBeUndefined()
  })

  it('still holds a member on a connection added after the last registry read', async () => {
    const room = await loadRoom(['local'], { turn: () => 'on it' })
    room.chat.$groupChats.set({ g: { log: [], members: [ALICE, BOB], roomId: 'room', sessions: {}, watermarks: {} } })
    // The send path's view predates the new `server` connection …
    await room.rounds.registeredConnectionIds()
    // … which the registry (and so the drive) already has.
    host.connections = async () => [{ id: 'local' }, { id: 'server' }]

    await send(room, 'stop @bob')

    expect(Object.keys(room.chat.$groupChats.get().g.holds || {})).toEqual(['server::bob'])
    expect(room.routed).not.toContain('server::bob')
  })

  it('holds a same-named member on a just-added connection addressed by its device handle', async () => {
    const twin: GroupMember = {
      name: 'alice',
      handle: 'alice-server',
      connectionId: 'server',
      connectionKind: 'remote',
      connectionLabel: 'Server',
      remoteSource: true,
      sourceScoped: true
    }

    for (const [text, held] of [
      ['stop @alice-server', ['server::alice']],
      // The shared form: the drive's fresh view could route it to either seat.
      ['stop @alice', ['local::alice', 'server::alice']],
      ['@all stop', ['local::alice', 'server::alice']]
    ] as const) {
      const room = await loadRoom(['local'], { turn: () => 'on it' })
      room.chat.$groupChats.set({ g: { log: [], members: [ALICE, twin], roomId: 'room', sessions: {}, watermarks: {} } })
      // The send path's view predates `server`; the registry already has it.
      await room.rounds.registeredConnectionIds()
      host.connections = async () => [{ id: 'local' }, { id: 'server' }]

      await send(room, text)

      expect(Object.keys(room.chat.$groupChats.get().g.holds || {}).sort()).toEqual(held)

      for (const key of held) {
        expect(room.routed).not.toContain(key)
      }
    }
  })

  it('does not start a thread that a Stop cancelled while the registry was being read', async () => {
    const room = await loadRoom(null, { turn: () => 'on it' })
    let release: (rows: unknown[]) => void = () => undefined
    host.connections = () => new Promise(resolve => (release = resolve))
    room.chat.$groupChats.set({
      g: { holdDetection: false, log: [], members: MEMBERS, roomId: 'room', sessions: {}, watermarks: {} }
    })

    const thread = room.rounds.sendToGroupChat('g', MEMBERS, '@bob ship it')
    await room.rounds.stopGroupThread('g', thread, MEMBERS)
    release([{ id: 'local' }, { id: 'server' }])

    for (let i = 0; i < 50; i++) {
      await new Promise(resolve => setImmediate(resolve))
    }

    expect(room.gateway.calls).toEqual([])
  })

  it('still drives every seat when the registry cannot be read', async () => {
    const room = await loadRoom(null, { turn: () => '(pass)' })
    seedRoom(room)

    await send(room, '@everyone status?')

    expect([...new Set(room.routed)].sort()).toEqual(['laptop::alice', 'local::alice', 'server::bob'])
  })
})
