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

/** How the metadata half of a save went, for the dialog: whether it failed, what to tell the
 *  user, and whether to stay open. A changed handle counts only when its backend persisted it:
 *  an unreachable or older backend leaves nothing that could answer to it, so the dialog keeps
 *  the edit for a retry instead of reporting success. */
export function metaSaveOutcome(
  persistence: { serverError?: string; serverOutcome: string } | null,
  handle: { patch?: Pick<BotMeta, 'mentionHandle'> },
  messages: { handleNotSaved: string; savedLocally: string }
): { failed: false; keepOpen: false } | { failed: true; keepOpen: boolean; message: string } {
  const handleFailed = Boolean(handle.patch) && persistence?.serverOutcome !== 'persisted'

  if (persistence?.serverOutcome !== 'failed' && !handleFailed) {
    return { failed: false, keepOpen: false }
  }

  // The backend names why it refused (a handle another profile holds).
  const fallback = handleFailed ? messages.handleNotSaved : messages.savedLocally

  return { failed: true, keepOpen: handleFailed, message: persistence?.serverError || fallback }
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
