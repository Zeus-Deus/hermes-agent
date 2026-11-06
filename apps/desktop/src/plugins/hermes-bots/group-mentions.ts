/**
 * The room @mention parse: which members a message addresses, and the tag that addresses one
 * member alone. Shared by the round driver, the room composer and the turn prompt.
 */
import {
  botFriendlyNames,
  botHandle,
  botMentionTag,
  customDefaultHandle,
  mentionNameForms,
  precustomHandle
} from './data'
import { groupMemberKey } from './group-membership'
import type { GroupMember } from './types'

/** `parseGroupChatMentions`' gap-fill pass: every live identity's forms are claimed first, so a
 *  live name always wins. Renamed members answer to previous handles (#110200). */
function gapFillMemberForms(members: GroupMember[], handles: Map<string, string>) {
  for (const member of members) {
    const key = groupMemberKey(member)
    const previous = Array.isArray(member.previous_names) ? member.previous_names : []

    for (const name of previous) {
      for (const form of mentionNameForms(name)) {
        if (form && !handles.has(form)) {
          handles.set(form, key)
        }
      }
    }
  }
}

/** Every lower-cased form a member answers to by its live identity: profile name, @handle,
 *  picker tag, the handle a custom-handle default had before (`default-server`), each also
 *  collapsed as the parser reads it, and its title / friendly-name forms. */
function memberIdentityForms(member: GroupMember): Set<string> {
  const title = String(member.title || '').trim()

  return new Set(
    [member.name, botHandle(member.name, member), botMentionTag(member), precustomHandle(member.name, member)]
      .map(form => String(form || '').toLowerCase())
      .flatMap(form => [form, form.replace(/[\s_-]+/g, '')])
      .concat([title, ...botFriendlyNames(member)].flatMap(name => mentionNameForms(name)))
      .filter(Boolean)
  )
}

/** A default's custom handle (#89720) is chosen on one machine, so in a room it can collide with
 *  another member's live identity: the same handle picked by another machine's default, or
 *  another machine's bot of that name. It is claimed only when no other seat answers to it — a
 *  real name keeps it, and two defaults sharing one name neither; each still answers its
 *  source-qualified earlier handle, which `groupReplyMentionTag` offers instead. A contested
 *  handle the default picked up another way (its title "Maia") goes back to the one other seat
 *  that holds it by a real name, or to no one. */
function claimUncontestedCustomHandles(members: GroupMember[], handles: Map<string, string>) {
  const identities = members.map(member => [member, groupMemberKey(member), memberIdentityForms(member)] as const)

  for (const [member, key] of identities) {
    const custom = customDefaultHandle(member.name, member)
    const holders = identities.filter(([other, otherKey, forms]) => otherKey !== key && custom && forms.has(custom))

    for (const form of custom ? [custom, custom.replace(/[._-]+/g, '')] : []) {
      if (!holders.length) {
        // The collapsed spelling (`ma-ia` → `maia`) only fills a gap, like every other variant.
        if (form === custom || !handles.has(form)) {
          handles.set(form, key)
        }
      } else if (handles.get(form) === key) {
        const owners = holders.filter(([other]) => customDefaultHandle(other.name, other) !== custom)

        if (owners.length === 1) {
          handles.set(form, owners[0][1])
        } else {
          handles.delete(form)
        }
      }
    }
  }
}

/** Deterministic @mention parse. Handles @name, @"two words" via display
 *  titles, and @everyone/@all. Names match case-insensitively against member
 *  profile names, display titles, and collapsed no-space forms. */
export function parseGroupChatMentions(text: unknown, members: GroupMember[]) {
  const source = String(text || '')
  const mentioned = new Set<string>()
  let everyone = false
  const handles = new Map<string, string>()

  for (const member of members) {
    const title = String(member.title || '').trim()

    // Normalize legacy "default" handles without aliasing device-qualified
    // defaults to @hermes: that would retarget the primary tag by roster order.
    // A default with a custom handle seats its earlier one here, exactly as before it had one;
    // the custom handle joins after every live identity (`claimUncontestedCustomHandles`).
    const handle = String(
      (customDefaultHandle(member.name, member)
        ? precustomHandle(member.name, member)
        : botHandle(member.name, member)) || ''
    ).trim()

    const forms = new Set([
      member.name.toLowerCase(),
      member.name.toLowerCase().replace(/[\s_-]+/g, ''),
      ...(handle ? [handle.toLowerCase(), handle.toLowerCase().replace(/[\s_-]+/g, '')] : []),
      ...(title
        ? [title.toLowerCase(), title.toLowerCase().replace(/[\s_-]+/g, ''), title.split(/\s+/)[0].toLowerCase()]
        : [])
    ])

    // Renamed members answer to their friendly names too (profile
    // display_name and Bot Mode title), in slugged and collapsed forms —
    // the same tags the roster autocomplete inserts.
    for (const friendly of botFriendlyNames(member)) {
      for (const form of mentionNameForms(friendly)) {
        forms.add(form)
      }
    }

    // A same-named Connections twin gets `@<name>-<device>` from the registry,
    // but the room's own-source member keeps its bare name and so loses every
    // shared form to the twin (Map last-wins). `@<name>-local` is its
    // always-available unambiguous address.
    if (!member.remoteSource) {
      forms.add(`${member.name.toLowerCase()}-local`)
    }

    for (const form of forms) {
      if (form) {
        handles.set(form, groupMemberKey(member))
      }
    }

    // Normalized slug/collapsed variants of a live identity, gap-filled only — an exact live name elsewhere always wins, so an old handle can never squat (#110200).
    for (const raw of [member.name, handle, title, ...botFriendlyNames(member)]) {
      for (const form of mentionNameForms(raw)) {
        if (form && !handles.has(form)) {
          handles.set(form, groupMemberKey(member))
        }
      }
    }
  }

  gapFillMemberForms(members, handles)
  claimUncontestedCustomHandles(members, handles)

  for (const match of source.matchAll(/@([a-z0-9][a-z0-9._-]*)/gi)) {
    const handle = match[1].toLowerCase()

    if (handle === 'everyone' || handle === 'all') {
      everyone = true

      continue
    }

    if (handle === 'user') {
      continue
    }

    const resolved = handles.get(handle) || handles.get(handle.replace(/[._-]+/g, ''))

    if (resolved) {
      mentioned.add(resolved)
    }
  }

  return {
    everyone,
    mentioned
  }
}

/** The `@tag` "Reply to" seeds for one member: its friendly tag when that
 *  routes to this member alone, else the first owner-qualified form that does
 *  (`@<name>-<device>` for a Connections twin, `@<name>-local` for the room's
 *  own-source twin — see #89883). A bare `{ name }` of a member who left the
 *  room resolves to nothing and keeps its friendly tag. */
export function groupReplyMentionTag(member: GroupMember, members: GroupMember[]): string {
  const key = groupMemberKey(member)

  const candidates = [
    botMentionTag(member),
    botHandle(member.name, member),
    precustomHandle(member.name, member),
    `${member.name}-local`
  ]
    .map(tag => String(tag || '').trim())
    .filter(Boolean)

  return (
    candidates.find(tag => {
      const { mentioned } = parseGroupChatMentions(`@${tag}`, members)

      return mentioned.size === 1 && mentioned.has(key)
    }) ||
    candidates[0] ||
    ''
  )
}
