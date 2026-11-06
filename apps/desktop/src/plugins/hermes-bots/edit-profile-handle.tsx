/**
 * Edit Profile's Handle field: the default bot's custom @handle (#89720).
 * Only the default has one — every other bot's handle is its profile name —
 * and its backend stores it in `ui_meta['hermes-bots'].mentionHandle`.
 */

import { Input } from '@hermes/plugin-sdk'

import { isDefaultBot, mentionHandleTaken, normalizeMentionHandle } from './data'
import { labeled } from './dialog-parts'
import type { BotsMessages } from './i18n-messages'
import type { BotMeta, RosterRow } from './types'

/** Whether `bot` gets the field — the default, on a backend that resolves a custom handle (it
 *  sends `mention_handle`; an older one would store the value and never answer to it) — and the
 *  handle stored there now ('' for none). */
export function openingHandle(bot: null | RosterRow): { edits: boolean; handle: string } {
  const edits = Boolean(bot && isDefaultBot(bot) && typeof bot.mention_handle === 'string')
  const stored = bot?.ui_meta?.['hermes-bots']?.mentionHandle || bot?.mention_handle

  return { edits, handle: edits ? String(stored || '') : '' }
}

/** The save's handle half: nothing when untouched, a patch for a new (or cleared) handle, or the
 *  reason it cannot be saved. The roster check spans every machine this Desktop sees; the
 *  default's own backend re-checks its install when the patch lands. */
export function editedHandle(
  bot: RosterRow,
  opened: string,
  current: string,
  roster: null | RosterRow[] | undefined,
  editor: BotsMessages['editor']
): { error?: string; patch?: Pick<BotMeta, 'mentionHandle'> } {
  if (current.trim() === opened.trim()) {
    return {}
  }

  const handle = normalizeMentionHandle(current)

  if (current.trim() && !handle) {
    return { error: editor.handleInvalid }
  }

  if (mentionHandleTaken(handle, bot, roster)) {
    return { error: editor.handleTaken(handle) }
  }

  return { patch: { mentionHandle: handle } }
}

/** One save patch from the look and handle halves; null when neither changed. */
export function mergedPatch(look: BotMeta | null, handle: { patch?: Pick<BotMeta, 'mentionHandle'> }) {
  return handle.patch ? { ...look, ...handle.patch } : look
}

/** What a refused server write tells the user: the backend's reason when it gave one. */
export function saveFailureMessage(persistence: { serverError?: string } | null, fallback: string) {
  return persistence?.serverError || fallback
}

interface HandleFieldProps {
  editor: BotsMessages['editor']
  hidden: boolean
  onChange: (value: string) => void
  value: string
}

export function DefaultHandleField({ editor, hidden, onChange, value }: HandleFieldProps) {
  if (hidden) {
    return null
  }

  return labeled(
    editor.handle,
    <div className="grid gap-1">
      <Input
        onChange={event => onChange(event.target.value.replace(/^@/, '').toLowerCase())}
        placeholder="hermes"
        value={value}
      />
      <div className="text-[0.65rem] text-(--ui-text-quaternary)">{editor.handleHint}</div>
    </div>
  )
}
