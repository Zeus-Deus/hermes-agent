import { clearBotAttention, noteBotAttention } from './data'
import { groupFailureReason, recordGroupActivity } from './group-activity'
import {
  $groupChats,
  appendGroupChatEntry,
  GROUP_CHAT_HISTORY_LIMIT,
  GROUP_CHAT_MAX_CONTINUATIONS,
  GROUP_CHAT_MAX_MESSAGES,
  groupThreadOf,
  shouldCommitMemberTurn,
  updateGroupChat
} from './group-chat'
import type { GroupChatRoom } from './group-chat'
import { groupMemberAuthor, groupMemberKey } from './group-membership'
import {
  buildGroupChatTurnPrompt,
  formatGroupDeltaLines,
  GROUP_ADDRESSED_NUDGE_SUFFIX,
  isGroupChatSelf
} from './group-round-prompt'
import { type GroupMemberTurnOptions, isGroupPassText, runGroupChatMemberTurn } from './group-turns'
import type { Attachment, GroupMember, GroupMessage, GroupSeenStamp } from './types'

export interface GroupRoundMemberContext {
  group: string
  members: GroupMember[]
  thread: string
  startEpoch: number
  binding: { isLive(): boolean }
  isCurrent(): boolean
  failedMembers?: Set<string>
  /** #129443: member keys the driving user send explicitly addressed
   *  (@everyone / @mention). An addressed member's "(pass)" gets one bounded
   *  nudge; a second "(pass)" is recorded as explicit noncompliance — never
   *  ordinary silence. Absent/empty = collaborative turn, where a plain
   *  "(pass)" stays legitimate. */
  addressedKeys?: null | Set<string>
}

/** #93129: a held member's skip must consume its delta exactly once —
 *  advance the watermark past the current log so the same entries never
 *  re-trigger the skip. Null = nothing to consume (no write, no spin). */
export function heldMemberWatermarkAdvance(seen: number | undefined, logLength: number): null | number {
  return logLength > (seen || 0) ? logLength : null
}

/** Remember held entries after their watermarks advance. Keep the first entry
 *  (the hold-triggering instruction) plus the newest bounded tail, and dedupe
 *  by id so repeated held passes remain idempotent. */
export function heldMemberMessageIds(existing: string[] | undefined, delta: GroupMessage[]): string[] {
  const ids = [...(existing || []), ...delta.map(entry => entry.id).filter((id): id is string => Boolean(id))]
  const unique = [...new Set(ids)]

  if (unique.length <= GROUP_CHAT_HISTORY_LIMIT) {
    return unique
  }

  return [unique[0], ...unique.slice(-(GROUP_CHAT_HISTORY_LIMIT - 1))]
}

/** What a turn submitted now has seen: the newest room entry, plus how many
 *  entries of `thread` this log holds and the `at` of the oldest — so a
 *  Desktop whose merged log has more of them before that anchor knows the
 *  anchor does not cover its own prefix (groupLogSeenCursor). */
export function groupSeenStamp(log: GroupMessage[], thread: string): GroupSeenStamp | null {
  const seenThrough = log.at(-1)?.id

  if (!seenThrough) {
    return null
  }

  const own = log.filter((entry: GroupMessage) => groupThreadOf(entry) === thread)

  return { seenCount: own.length, seenSince: Number((own[0] || log.at(-1))?.at || 0), seenThrough }
}

/** The cursor the room log itself proves for `member` in `thread`. Watermarks
 *  are this Desktop's own log indices and never ride the projection, but a
 *  member's thread session is resolved by its title on the member's gateway —
 *  the same session for every Desktop. A Desktop that did not drive the
 *  earlier turns (another machine, another build, a lost record) therefore
 *  had no cursor and replayed the whole thread, the member's own replies
 *  included, as "new since your last turn". Every reply records what its turn
 *  was submitted with (groupSeenStamp), so the member's stamped replies in
 *  this thread bound what its session already holds: everything through the
 *  furthest anchor, then its own entries that follow.
 *
 *  An anchor proves nothing when it is missing from the log or not before its
 *  reply, and nothing when this log holds more of the thread's entries in the
 *  stamped span than the turn's log did: the timestamp merge can sort an
 *  entry the turn never had (another Desktop's failed send) before the
 *  anchor. Which entry that is cannot be told without per-entry acks, so the
 *  whole proof is dropped — replaying a little is safe, skipping is not. */
export function groupLogSeenCursor(log: GroupMessage[], member: GroupMember, thread: string): number {
  const position = new Map<string, number>()
  let proven = -1

  log.forEach((entry: GroupMessage, index: number) => {
    if (entry?.id) {
      position.set(entry.id, index)
    }

    // Every valid stamp is proof; the strongest wins. A reply harvested late
    // can sit after a newer turn's reply with an older anchor.
    const anchor = entry?.seenThrough ? position.get(entry.seenThrough) : undefined

    if (
      anchor !== undefined &&
      anchor > proven &&
      groupThreadOf(entry) === thread &&
      authoredByMember(entry, member) &&
      stampCoversPrefix(log, entry, anchor, thread)
    ) {
      proven = anchor
    }
  })

  if (proven < 0) {
    return 0
  }

  let mark = proven + 1

  while (mark < log.length && (groupThreadOf(log[mark]) !== thread || authoredByMember(log[mark], member))) {
    mark += 1
  }

  return mark
}

/** True when the stamped turn's log held at least as many of `thread`'s
 *  entries in its span (`at` from `seenSince`, through the anchor) as this
 *  log does. Fewer here is fine: this log lacks some (older history, a lagging
 *  merge), and what it lacks it cannot skip. */
function stampCoversPrefix(log: GroupMessage[], stamp: GroupMessage, anchor: number, thread: string): boolean {
  const { seenCount, seenSince } = stamp

  if (!Number.isFinite(seenCount) || !Number.isFinite(seenSince)) {
    return false
  }

  let held = 0

  for (let index = 0; index <= anchor; index++) {
    if (groupThreadOf(log[index]) === thread && Number(log[index]?.at || 0) >= Number(seenSince)) {
      held += 1
    }
  }

  return held <= Number(seenCount)
}

/** The member's turn payload from log index `seen`: this thread's entries
 *  plus any held entries being released, oldest first. Held entries before
 *  `proven` (the log-derived cursor) are ones the member's session already
 *  holds; `withheld` says some were left out for that reason. */
function groupTurnPayload(
  context: GroupRoundMemberContext,
  member: GroupMember,
  room: GroupChatRoom,
  seen: number,
  heldIds: string[],
  proven = 0
) {
  const { members, thread } = context
  const delta = room.log.slice(seen).filter((e: GroupMessage) => groupThreadOf(e) === thread)
  const heldSet = new Set(heldIds)
  let withheld = false

  const delivered = room.log.filter((entry: GroupMessage, index: number) => {
    const held = Boolean(entry.id && heldSet.has(entry.id))
    withheld ||= held && index < proven

    return held && index >= proven
  })

  const deliveredIds = new Set(delivered.map((entry: GroupMessage) => entry.id).filter(Boolean))

  const visibleDelta = [
    ...delivered,
    ...delta.filter((entry: GroupMessage) => !entry.id || !deliveredIds.has(entry.id))
  ].sort((left, right) => Number(left.at || 0) - Number(right.at || 0))

  const prompt = buildGroupChatTurnPrompt({
    groupName: context.group,
    members,
    viewer: member,
    deltaLines: formatGroupDeltaLines(visibleDelta, member, context.group)
  })

  // Images riding this delta (user attachments — member entries don't
  // carry images today, but flatMap keeps this future-proof) get staged
  // into the member's session so the model sees the pixels, not just
  // the transcript's [attached image: …] marker.
  const images = visibleDelta.flatMap((e: GroupMessage) => (Array.isArray(e.images) ? e.images : []))

  return { delta, images, prompt, visibleDelta, withheld }
}

function prepareGroupRoundMember(context: GroupRoundMemberContext, member: GroupMember) {
  const { thread } = context

  const room = $groupChats.get()[context.group] || {
    log: [],
    watermarks: {}
  }

  const memberKey = groupMemberKey(member)
  const markKey = `${thread}::${memberKey}`
  const local = room.watermarks[markKey] || 0
  const proven = groupLogSeenCursor(room.log, member, thread)
  const seen = Math.max(local, proven)
  // Delta: NEW room entries, narrowed to this thread — the member's
  // turn sees only the conversation it's part of.
  const delta = room.log.slice(seen).filter((e: GroupMessage) => groupThreadOf(e) === thread)

  if (!delta.length) {
    return null
  }

  // #93129: a member the user told to stop is HELD — no turn until an
  // explicit release (resume / @all resume / a direct non-stop
  // mention). Consume the delta exactly once (watermark past the
  // current log) so the same entries never re-trigger this skip, and
  // surface WHY the bot is silent in the activity feed the first time.
  const heldEntry = (room.holds || {})[memberKey]

  if (heldEntry) {
    const advance = heldMemberWatermarkAdvance(seen, room.log.length)
    updateGroupChat(context.group, (r: GroupChatRoom) => {
      if (advance !== null) {
        r.watermarks[markKey] = advance
      }

      r.heldMessages = {
        ...(r.heldMessages || {}),
        // From this Desktop's own watermark, not the log-derived cursor: the
        // member's session may be gone by the release, and a replacement
        // must still get what the proof covered (groupTurnPayload).
        [memberKey]: heldMemberMessageIds(
          r.heldMessages?.[memberKey],
          seen > local ? room.log.slice(local).filter((e: GroupMessage) => groupThreadOf(e) === thread) : delta
        )
      }

      if (r.holds?.[memberKey] && !r.holds[memberKey].noted) {
        r.holds = {
          ...r.holds,
          [memberKey]: {
            ...r.holds[memberKey],
            noted: true
          }
        }
      }

      return r
    })

    if (!heldEntry.noted) {
      recordGroupActivity(context.group, {
        kind: 'held',
        member: groupMemberKey(member),
        thread
      })
    }

    return null
  }

  const heldIds = room.heldMessages?.[memberKey] || []
  const payload = groupTurnPayload(context, member, room, seen, heldIds, proven)
  // The log proved more than this Desktop's watermark (or proved held
  // entries seen): if the member's session turns out to be minted by this
  // turn, it holds none of that.
  const fallback = seen > local || payload.withheld ? groupTurnPayload(context, member, room, local, heldIds) : null

  // A user entry this turn is about to see for the first time: whatever the
  // member already posted was written without it, so it answers nothing here.
  const seesNewUserEntry = payload.visibleDelta.some((entry: GroupMessage) => entry.from?.kind === 'user')

  return {
    room,
    memberKey,
    markKey,
    prompt: payload.prompt,
    deltaImages: payload.images,
    freshFallback: fallback ? { images: fallback.images, prompt: fallback.prompt } : null,
    heldIds,
    seesNewUserEntry
  }
}

/** True while the user's explicit address to `member` is unanswered in this
 *  thread: this turn is the first to see a user entry, or the member has not
 *  posted since the latest one. Position alone is not enough, because a turn
 *  that started before a follow-up can land after it. */
function memberOwesAnswer(
  context: GroupRoundMemberContext,
  member: GroupMember,
  log: GroupMessage[],
  seesNewUserEntry: boolean
): boolean {
  return Boolean(context.addressedKeys?.has(groupMemberKey(member))) &&
    (seesNewUserEntry || !answeredSinceLastUser(log, member, context.thread))
}

/** True when `member` has a room entry in `thread` after the latest user entry there. */
function answeredSinceLastUser(log: GroupMessage[], member: GroupMember, thread: string): boolean {
  for (let i = log.length - 1; i >= 0; i--) {
    const entry = log[i]

    if (groupThreadOf(entry) !== thread) {
      continue
    }

    if (entry.from?.kind === 'user') {
      return false
    }

    if (authoredByMember(entry, member)) {
      return true
    }
  }

  return false
}

/** Each invocation owns its descriptor, so an old completion cannot clear a newer turn. */
async function runVisibleMemberTurn(
  context: GroupRoundMemberContext,
  member: GroupMember,
  prompt: string,
  images?: Attachment[],
  options?: GroupMemberTurnOptions
) {
  const turn = { ...member }
  updateGroupChat(context.group, (room: GroupChatRoom) => ({ ...room, turn }), { sync: false })

  try {
    return await runGroupChatMemberTurn(context.group, member, prompt, context.thread, images, options)
  } finally {
    if (context.binding.isLive() && $groupChats.get()[context.group]?.turn === turn) {
      updateGroupChat(context.group, (room: GroupChatRoom) => ({ ...room, turn: null }), { sync: false })
    }
  }
}

export async function runGroupRoundMember(
  context: GroupRoundMemberContext,
  member: GroupMember
): Promise<boolean | null> {
  const { thread, startEpoch, binding } = context

  if (context.failedMembers?.has(groupMemberKey(member))) {
    return false
  }

  const prepared = prepareGroupRoundMember(context, member)

  if (!prepared) {
    return false
  }

  const { room, memberKey, markKey, prompt, deltaImages, freshFallback, heldIds, seesNewUserEntry } = prepared
  const anchorId = room.log.at(-1)?.id ?? null
  const seen = groupSeenStamp(room.log, thread)
  // Owed only until the member answers: after its reply to the user's address,
  // a pass on a teammate's reply is ordinary consensus, not noncompliance.
  const owesAnswer = memberOwesAnswer(context, member, room.log, seesNewUserEntry)
  let reply: null | string = null
  let accepted = false

  try {
    reply = await runVisibleMemberTurn(context, member, prompt, deltaImages, { freshFallback, seen })

    // #129443: the participation rules ("reply only with something new,
    // else (pass)") let a directly addressed member pass just because a
    // teammate already answered — the room then settles as ordinary
    // consensus and the user's explicit address silently disappears. One
    // bounded nudge re-asks with the directive spelled out; the recovered
    // reply replaces the pass and flows through the exact same commit path
    // below. A nudge that throws falls into the catch like any failed turn.
    // `isCurrent()` (not the bare binding): a superseded drive's pass is
    // discarded by the epoch check right below anyway, so nudging it would
    // burn a model call whose result can never be committed.
    if (context.isCurrent() && reply !== null && isGroupPassText(reply) && owesAnswer) {
      reply = await runVisibleMemberTurn(
        context,
        member,
        `${prompt}${GROUP_ADDRESSED_NUDGE_SUFFIX}`,
        deltaImages,
        { seen }
      )
    }

    accepted = true

    // Needs-attention hook (#93091 item 3): a turn that produced a real
    // reply (or an explicit pass) is a good turn — clear the badge.
    // A timed-out turn also returns null but never threw; leaving any
    // prior badge in place there is the conservative choice.
    if (reply !== null) {
      clearBotAttention(groupMemberKey(member))
    }
  } catch (error: any) {
    if (!binding.isLive()) {
      return null
    }

    const reason = groupFailureReason(error)
    recordGroupActivity(context.group, {
      kind: 'failed',
      member: groupMemberKey(member),
      thread,
      ...(reason
        ? {
            reason
          }
        : {})
    })
    noteBotAttention(groupMemberKey(member), reason || error?.message || error)
    context.failedMembers?.add(groupMemberKey(member))
    reply = null // a failed turn is a pass, never a room error
  }

  // #93127: the turn may have finished AFTER a newer user send bumped
  // the room epoch. That newer send's loop re-drives this member with
  // the full delta, so committing this stale result (watermark advance
  // + append) would double-deliver the same reply. Drop it here —
  // BEFORE the watermark advance and BEFORE the append. Only a newer
  // USER entry in THIS thread makes the re-drive premise true: a
  // cross-thread send bumps the epoch too, but its loop filters this
  // thread out and would never regenerate the finished reply. The
  // during-turn tail is anchored by entry id, not index — the history
  // trim drops entries from the FRONT, so an index slice could
  // overshoot after a mid-turn trim and silently commit a stale turn.
  if (!binding.isLive()) {
    return null
  }

  const roomNow = $groupChats.get()[context.group] || {
    log: []
  }

  const epochNow = roomNow.epoch || 0
  const anchorIdx = anchorId === null ? -1 : roomNow.log.findIndex((e: GroupMessage) => e.id === anchorId)
  // Anchor trimmed away ⇒ every pre-turn entry was dropped, so every
  // surviving entry is newer — scanning the whole log stays exact.
  const turnTail = anchorIdx >= 0 ? roomNow.log.slice(anchorIdx + 1) : roomNow.log

  const newerUserEntryInThread = turnTail.some(
    (e: GroupMessage) => e.from?.kind === 'user' && groupThreadOf(e) === thread
  )

  if (
    (roomNow.stoppedEpoch || 0) > startEpoch ||
    !shouldCommitMemberTurn(startEpoch, epochNow, newerUserEntryInThread)
  ) {
    recordGroupActivity(context.group, {
      kind: 'cancelled',
      member: groupMemberKey(member),
      thread
    })

    return null
  }

  // Resolve the frozen submit boundary against the retained log. If it was
  // trimmed away, every surviving entry is still unseen. Throws do not
  // acknowledge input, and a timed-out turn keeps its submitted boundary.
  if (accepted) {
    updateGroupChat(context.group, (r: GroupChatRoom) => {
      r.watermarks[markKey] = anchorIdx + 1

      if (heldIds.length) {
        const deliveredIds = new Set(heldIds)
        const remaining = (r.heldMessages?.[memberKey] || []).filter(id => !deliveredIds.has(id))
        r.heldMessages = {
          ...(r.heldMessages || {})
        }

        if (remaining.length) {
          r.heldMessages[memberKey] = remaining
        } else {
          delete r.heldMessages[memberKey]
        }
      }

      return r
    })
  }

  const spoke = reply !== null && !isGroupPassText(reply)

  if (reply !== null && spoke) {
    appendGroupChatEntry(context.group, groupMemberAuthor(member), reply, thread, undefined, seen)
  } else if (reply !== null && context.isCurrent() && owesAnswer) {
    // #129443: the nudge was passed on too. Record the noncompliance where
    // the user looks (activity row + roster badge) instead of letting the
    // user's explicit address settle as ordinary quiet consensus. Only a
    // CURRENT drive's pass is disclosed: a turn the epoch check just
    // tolerated committing (a cross-thread send superseded its drive) is
    // stale residue, and flagging it would point the user at an address
    // their newer send already moved past.
    const reason = 'explicitly addressed member passed twice'

    recordGroupActivity(context.group, {
      kind: 'failed',
      member: groupMemberKey(member),
      reason,
      thread
    })
    noteBotAttention(groupMemberKey(member), reason)
  }

  // A member's own entries — its reply, and the rows group-external-writes.ts
  // mirrored out of its own session — are never news to their author, so the
  // watermark steps over them. A user entry that arrived during inference
  // stops the walk: a reply cannot acknowledge what it never saw.
  updateGroupChat(context.group, (r: GroupChatRoom) => {
    let mark = r.watermarks[markKey] || 0

    while (mark < r.log.length && authoredByMember(r.log[mark], member)) {
      mark += 1
    }

    if (mark !== (r.watermarks[markKey] || 0)) {
      r.watermarks[markKey] = mark
    }

    return r
  })

  return spoke
}

function authoredByMember(entry: GroupMessage, member: GroupMember): boolean {
  return entry?.from?.kind === 'member' && isGroupChatSelf(entry.from, member)
}

export async function runGroupContinuationMembers(
  context: GroupRoundMemberContext,
  pendingKeys: string[],
  continuations: number,
  posted: number
): Promise<number | null> {
  const { members, isCurrent } = context
  let spokeThisRound = 0

  if (pendingKeys.length && continuations <= GROUP_CHAT_MAX_CONTINUATIONS) {
    const citedMembers = members.filter((member: GroupMember) => pendingKeys.includes(groupMemberKey(member)))

    if (citedMembers.length && posted < GROUP_CHAT_MAX_MESSAGES) {
      const strandedNow = ($groupChats.get()[context.group] || {}).stranded || {}

      const continuationResponders = citedMembers.filter(
        (member: GroupMember) => !Object.prototype.hasOwnProperty.call(strandedNow, groupMemberKey(member))
      )

      for (const member of continuationResponders) {
        if (!isCurrent() || posted >= GROUP_CHAT_MAX_MESSAGES || continuations > GROUP_CHAT_MAX_CONTINUATIONS) {
          break
        }

        const result = await runGroupRoundMember(context, member)

        if (result === null) {
          return null
        }

        if (result) {
          posted += 1
          spokeThisRound += 1
        }
      }
    }
  }

  return spokeThisRound
}
