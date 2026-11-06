/**
 * The default profile's custom @handle (#89720) as rows and durable members carry it. Pure, so
 * the room and gateway-room helpers read it without the roster store.
 */
import type { RosterRow } from './types'

/** Tokens no bot @handle may take: the mention parsers reserve them. */
const RESERVED_MENTION_FORMS = ['all', 'everyone', 'user', 'default', 'hermes']

/** `value` as a custom @handle — lower-cased, leading `@` dropped — or '' when it is not one: the
 *  profile-id shape, no reserved token, and not a `default-<device>` tag (the connection
 *  registry's name for a default on several machines: a default handled like one could not tell
 *  its own device tag from its custom handle). Same rule as the backend's
 *  `tools/bot_mode_probe.normalize_mention_handle`, which gates the save. */
export function normalizeMentionHandle(value: unknown): string {
  if (typeof value !== 'string') {
    return ''
  }

  const handle = value.trim().replace(/^@/, '').toLowerCase()

  return /^[a-z0-9][a-z0-9_-]{0,63}$/.test(handle) &&
    !RESERVED_MENTION_FORMS.includes(handle) &&
    !handle.startsWith('default-')
    ? handle
    : ''
}

/** The custom handle a default row's OWN backend answers to (`mention_handle`, which only a
 *  backend whose resolvers support it sends), else the copy a durable group member carries.
 *  Never the raw `ui_meta` value or this window's local meta: it is a routing identity, and only
 *  what that backend's `message_agent`, relay door and system prompt resolve may be advertised. */
export function storedCustomHandle(bot: Partial<RosterRow> | null | undefined): string {
  return normalizeMentionHandle(typeof bot?.mention_handle === 'string' ? bot.mention_handle : bot?.mentionHandle)
}

/** The default profile's custom @handle (#89720), or '' when it has none — or when a real profile
 *  on the same source holds that name (`claimDefaultHandles`; the backend applies the same rule). */
export function customDefaultHandle(name: null | string | undefined, bot?: Partial<RosterRow> | null): string {
  if (
    String(name || '')
      .trim()
      .toLowerCase() !== 'default' ||
    bot?.customHandleTaken
  ) {
    return ''
  }

  return storedCustomHandle(bot)
}
