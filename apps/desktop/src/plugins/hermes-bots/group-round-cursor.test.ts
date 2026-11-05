/**
 * "New messages in the room since your last turn" must mean exactly that,
 * whichever Desktop drives the turn.
 *
 * Watermarks are this Desktop's own log indices and never ride the gateway
 * projection, while a member's thread session is found by its title
 * (`Group: <roomId> · <thread>`) on the member's own gateway — the SAME
 * session for every Desktop. So a Desktop that did not drive the earlier
 * turns (a second machine, a second build, a lost record) had no cursor and
 * replayed the whole thread into a session that already held it, the
 * member's own replies included ("Creative Media Agent (you): …").
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

import type * as groupChat from './group-chat'
import type * as groupRoundMembers from './group-round-members'
import type * as groupRounds from './group-rounds'
import { createGroupGateway, drain, runTimersInline, scriptedStorage } from './group-test-utils'
import type { GatewayOptions, ScriptedGateway } from './group-test-utils'
import type * as groupTurns from './group-turns'
import type { GroupMember, GroupMessage } from './types'

const { host } = vi.hoisted(() => ({ host: {} as Record<string, unknown> }))

vi.mock('@hermes/plugin-sdk', async () => {
  const { pluginSdkMock } = await import('./group-test-utils')

  return pluginSdkMock(host)
})

interface Desktop {
  chat: typeof groupChat
  gateway: ScriptedGateway
  members: typeof groupRoundMembers
  rounds: typeof groupRounds
  turns: typeof groupTurns
}

/** A fresh Desktop: its own module state and storage. Pass another
 *  Desktop's gateway to reach the same member sessions it reached. */
async function loadDesktop(options: GatewayOptions = {}, reuse?: ScriptedGateway): Promise<Desktop> {
  vi.resetModules()
  const gateway = reuse || createGroupGateway(options)

  for (const key of Object.keys(host)) {
    delete host[key]
  }

  Object.assign(host, gateway.host)

  const [chat, members, rounds, turns, shared] = await Promise.all([
    import('./group-chat'),
    import('./group-round-members'),
    import('./group-rounds'),
    import('./group-turns'),
    import('./shared')
  ])

  shared.setPluginCtx(scriptedStorage(gateway.storage))

  return { chat, gateway, members, rounds, turns }
}

const BOB: GroupMember = {
  name: 'bob',
  connectionId: 'server',
  connectionKind: 'remote',
  connectionLabel: 'Server',
  remoteSource: true,
  sourceScoped: true
}

const ALICE: GroupMember = {
  name: 'alice',
  connectionId: 'local',
  connectionKind: 'local',
  connectionLabel: 'This device',
  sourceScoped: true
}

const MEMBERS = [BOB, ALICE]

async function send(desktop: Desktop, text: string, thread?: null | string) {
  const sent = desktop.rounds.sendToGroupChat('g', MEMBERS, text, thread)
  await drain(() => Boolean(desktop.chat.$groupChats.get().g?.running))

  return sent
}

/** A stamp from a turn whose log held `count` of the thread's entries, from `at` 1. */
const stamp = (seenThrough: string, seenCount: number) => ({ seenCount, seenSince: 1, seenThrough })

const bobPrompts = (desktop: Desktop) =>
  desktop.gateway.calls.filter(call => call.profile === 'bob').map(call => call.prompt)

beforeEach(() => {
  runTimersInline()
})

describe('a member turn driven by a Desktop that did not drive the earlier turns', () => {
  it('delivers only what the member has not seen, never its own replies', async () => {
    // Desktop A runs the first exchange.
    const first = await loadDesktop({
      turn: ({ profile }) => (profile === 'bob' ? 'Brief: draft the release notes in two passes.' : '(pass)')
    })

    first.chat.$groupChats.set({ g: { log: [], members: MEMBERS, roomId: 'room', sessions: {}, watermarks: {} } })
    const thread = await send(first, '@bob bring @alice up to date')

    expect(first.chat.$groupChats.get().g.log.map((entry: GroupMessage) => entry.from.name)).toContain('bob')

    const projection = first.chat.groupChatSyncSnapshot(first.chat.$groupChats.get())

    // Desktop B only ever saw the room through the gateway projection; it
    // reaches bob's gateway, where bob's thread session lives.
    const firstCalls = bobPrompts(first).length
    const second = await loadDesktop({}, first.gateway)
    second.chat.$groupChats.set(second.chat.mergeRemoteGroupChatSnapshotIntoRooms(projection, {}))

    await send(second, '@bob go for it', thread)

    const [prompt] = bobPrompts(second).slice(firstCalls)

    expect(prompt).toContain('You (user): @bob go for it')
    expect(prompt).not.toContain('bring @alice up to date')
    expect(prompt).not.toContain('Brief: draft the release notes')
  })

  it('gives a member session minted by this turn the whole thread, not the shortened delta', async () => {
    const first = await loadDesktop({
      turn: ({ profile }) => (profile === 'bob' ? 'Brief: draft the release notes in two passes.' : '(pass)')
    })

    first.chat.$groupChats.set({ g: { log: [], members: MEMBERS, roomId: 'room', sessions: {}, watermarks: {} } })
    const thread = await send(first, '@bob bring @alice up to date')
    const projection = first.chat.groupChatSyncSnapshot(first.chat.$groupChats.get())

    // bob's session is gone on its gateway (deleted, or a gateway that never
    // had it): the title lookup misses and the turn mints a new one.
    const second = await loadDesktop({ turn: () => '(pass)' })
    second.chat.$groupChats.set(second.chat.mergeRemoteGroupChatSnapshotIntoRooms(projection, {}))

    await send(second, '@bob go for it', thread)

    const [prompt] = bobPrompts(second)

    expect(prompt).toContain('bring @alice up to date')
    expect(prompt).toContain('Brief: draft the release notes')
    expect(prompt).toContain('You (user): @bob go for it')
  })

  it('still gives the whole thread when the first submit into a minted session failed', async () => {
    const first = await loadDesktop({
      turn: ({ profile }) => (profile === 'bob' ? 'Brief: draft the release notes in two passes.' : '(pass)')
    })

    first.chat.$groupChats.set({ g: { log: [], members: MEMBERS, roomId: 'room', sessions: {}, watermarks: {} } })
    const thread = await send(first, '@bob bring @alice up to date')
    const projection = first.chat.groupChatSyncSnapshot(first.chat.$groupChats.get())

    // bob's session is gone; the replacement is minted, then the submit fails.
    const second = await loadDesktop({
      failFirstSubmitWith: Object.assign(new Error('gateway refused the prompt'), { code: 5000 }),
      turn: () => '(pass)'
    })

    second.chat.$groupChats.set(second.chat.mergeRemoteGroupChatSnapshotIntoRooms(projection, {}))

    await send(second, '@bob go for it', thread)
    expect(bobPrompts(second)).toEqual([])

    // The retry resumes that still-empty session.
    await send(second, '@bob go for it, again', thread)

    const [prompt] = bobPrompts(second)

    expect(prompt).toContain('bring @alice up to date')
    expect(prompt).toContain('Brief: draft the release notes')
    expect(prompt).toContain('You (user): @bob go for it, again')
  })

  it('does not trust an anchor whose prefix holds an entry the stamping turn never had', async () => {
    const { members } = await loadDesktop()
    const kickoff: GroupMessage = { at: 1, from: { kind: 'user', name: 'You' }, id: 'u-kick', text: '@bob kick off', thread: 't' }

    // u0 stayed on this Desktop (its submit failed); another Desktop, before
    // it ever saw u0, delivered u1 and bob answered. The merge sorts u0 first.
    const log: GroupMessage[] = [
      kickoff,
      { at: 2, from: { kind: 'user', name: 'You' }, id: 'u0', text: '@bob first', thread: 't' },
      { at: 3, from: { kind: 'user', name: 'You' }, id: 'u1', text: '@bob second', thread: 't' },
      {
        at: 4,
        from: { kind: 'member', name: 'bob', source: 'Server' },
        id: 'r1',
        seenCount: 2,
        seenSince: 1,
        seenThrough: 'u1',
        text: 'on the second',
        thread: 't'
      }
    ]

    expect(members.groupLogSeenCursor(log, BOB, 't')).toBe(0)

    // Without u0 the same stamp proves everything through bob's reply.
    const delivered = log.filter(entry => entry.id !== 'u0')
    expect(members.groupLogSeenCursor(delivered, BOB, 't')).toBe(3)

    // Older history the stamping Desktop never held does not void its proof.
    const older: GroupMessage = { at: 0, from: { kind: 'user', name: 'You' }, id: 'u-old', text: 'old', thread: 't' }
    expect(members.groupLogSeenCursor([older, ...delivered], BOB, 't')).toBe(4)
  })

  it('stamps each reply with what its log held of the thread', async () => {
    const desktop = await loadDesktop({ turn: ({ profile }) => (profile === 'bob' ? 'done' : '(pass)') })

    desktop.chat.$groupChats.set({ g: { log: [], members: MEMBERS, roomId: 'room', sessions: {}, watermarks: {} } })
    await send(desktop, '@bob ship it')

    const log = desktop.chat.$groupChats.get().g.log
    const reply = log.find((entry: GroupMessage) => entry.from.name === 'bob')
    const compact = desktop.chat.groupChatSyncSnapshot(desktop.chat.$groupChats.get()).rooms['id:room'].log.at(-1)

    expect(reply).toMatchObject({ seenCount: 1, seenSince: log[0].at, seenThrough: log[0].id })
    expect(compact).toMatchObject({ seenCount: 1, seenSince: log[0].at, seenThrough: log[0].id })
  })

  it('takes the furthest anchor when a late reply lands after a newer one', async () => {
    const { members } = await loadDesktop()

    const log: GroupMessage[] = [
      { at: 1, from: { kind: 'user', name: 'You' }, id: 'u1', text: 'one', thread: 't' },
      { at: 2, from: { kind: 'user', name: 'You' }, id: 'u2', text: 'two', thread: 't' },
      { at: 3, from: { kind: 'member', name: 'bob', source: 'Server' }, id: 'r2', ...stamp('u2', 2), text: 'b', thread: 't' },
      { at: 4, from: { kind: 'member', name: 'bob', source: 'Server' }, id: 'r1', ...stamp('u1', 1), text: 'a', thread: 't' }
    ]

    expect(members.groupLogSeenCursor(log, BOB, 't')).toBe(4)
  })

  it('still delivers a user message that landed while the member was answering', async () => {
    const desktop = await loadDesktop({ turn: () => '(pass)' })

    const log: GroupMessage[] = [
      { at: 1, from: { kind: 'user', name: 'You' }, id: 'u1', text: '@bob start', thread: 't' },
      { at: 2, from: { kind: 'user', name: 'You' }, id: 'u2', text: '@bob also check the audio', thread: 't' },
      {
        at: 3,
        from: { kind: 'member', name: 'bob', source: 'Server' },
        id: 'f1',
        ...stamp('u1', 1),
        text: 'started',
        thread: 't'
      }
    ]

    desktop.chat.$groupChats.set({
      g: { log, members: MEMBERS, roomId: 'room', sessions: { 'thread:t::server::bob': 'sid-bob' }, watermarks: {} }
    })
    // bob's thread session exists on its gateway (it answered `started`).
    desktop.gateway.sessions.set('sid-bob', {
      messages: [{ content: '[Group chat: "g"] …', role: 'user' }, { content: 'started', role: 'assistant' }],
      profile: 'bob',
      runtime: 'rt-bob',
      stored: 'sid-bob',
      title: 'Group: room · t'
    })

    await send(desktop, '@bob status?', 't')

    const [prompt] = bobPrompts(desktop)

    expect(prompt).not.toContain('@bob start')
    expect(prompt).toContain('@bob also check the audio')
    expect(prompt).toContain('@bob status?')
  })

  it('stamps a reply harvested after its turn timed out with what that turn had seen', async () => {
    const desktop = await loadDesktop()
    const log: GroupMessage[] = [{ at: 1, from: { kind: 'user', name: 'You' }, id: 'u1', text: '@bob dig in', thread: 't' }]

    desktop.chat.$groupChats.set({
      g: {
        log,
        members: MEMBERS,
        roomId: 'room',
        sessions: { 'thread:t::server::bob': 'sid-bob' },
        stranded: { 'server::bob': { before: 0, ...stamp('u1', 1), thread: 't' } },
        watermarks: {}
      }
    })
    desktop.gateway.sessions.set('sid-bob', {
      messages: [
        { content: '[Group chat: "g"] You are @bob, one participant in a group chat.', role: 'user' },
        { content: 'Dug in: the late answer.', role: 'assistant' }
      ],
      profile: 'bob',
      runtime: 'rt-bob',
      stored: 'sid-bob',
      title: 'Group: room · t'
    })

    await desktop.turns.harvestStrandedGroupReply('g', BOB)

    const late = desktop.chat.$groupChats.get().g.log.at(-1)

    expect(late?.text).toBe('Dug in: the late answer.')
    expect(late).toMatchObject(stamp('u1', 1))
    expect(desktop.chat.groupChatSyncSnapshot(desktop.chat.$groupChats.get()).rooms['id:room'].log.at(-1)).toMatchObject(
      stamp('u1', 1)
    )
  })

  it('reads the cursor only from the member\'s own stamped replies', async () => {
    const { members } = await loadDesktop()

    const log: GroupMessage[] = [
      { at: 1, from: { kind: 'user', name: 'You' }, id: 'u1', text: 'hi', thread: 't' },
      { at: 2, from: { kind: 'member', name: 'alice', source: 'This device' }, id: 's1', ...stamp('u1', 1), text: 'a', thread: 't' },
      { at: 3, from: { kind: 'member', name: 'bob', source: 'Server' }, id: 'f0', text: 'unstamped', thread: 't' },
      { at: 4, from: { kind: 'member', name: 'bob', source: 'Server' }, id: 'f1', ...stamp('gone', 9), text: 'b', thread: 't' },
      { at: 5, from: { kind: 'member', name: 'bob', source: 'Server' }, id: 'f2', ...stamp('u1', 1), text: 'c', thread: 'other' },
      // An anchor without its count proves nothing either.
      { at: 6, from: { kind: 'member', name: 'bob', source: 'Server' }, id: 'f3', seenThrough: 'u1', text: 'd', thread: 't' }
    ]

    // Another member's stamp, an unstamped reply, a trimmed anchor and a
    // reply in another thread prove nothing about bob in thread `t`.
    expect(members.groupLogSeenCursor(log, BOB, 't')).toBe(0)
    // Alice's own stamp: past its anchor and its own reply.
    expect(members.groupLogSeenCursor(log, ALICE, 't')).toBe(2)
  })
})
