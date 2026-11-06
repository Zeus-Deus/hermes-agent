import { useCallback, useRef } from 'react'

import { interceptsTypedVoiceStop } from '@/lib/voice-stop-word'
import { isFreshDraftScope } from '@/store/composer'
import { $sessions, sessionMatchesStoredId } from '@/store/session'
import { storedSessionIdForRuntimeId } from '@/store/session-states'

import { type ComposerSubmitContext, runComposerMiddleware } from '../contrib'
import type { ChatBarProps } from '../types'

interface VoiceStopHandle {
  active: boolean
  end: () => void
}

/** The composer's own chat, for sends that do not name one. */
interface ComposerSession {
  sessionId?: string | null
  storedSessionId?: string | null
}

const sessionIdOrNull = (id: null | string | undefined) => String(id || '').trim() || null

/** `a` and `b` name one conversation: equal, or one session row (a lineage
 *  tip and its root) answers to both. */
const sameConversation = (a: string, b: string) =>
  a === b || $sessions.get().some(row => sessionMatchesStoredId(row, a) && sessionMatchesStoredId(row, b))

/** A runtime id bound to ANOTHER conversation than `stored` is stale — a
 *  drain can pair the queue's stored id with the previous chat's runtime
 *  mid-switch, which submit.ts drops before sending too. Unbound ids stay. */
function destinationRuntime(runtime: null | string, stored: null | string): null | string {
  if (!runtime || !stored) {
    return runtime
  }

  const bound = storedSessionIdForRuntimeId(runtime)

  return bound && !sameConversation(bound, stored) ? null : runtime
}

/** The chat a send goes to: what the caller named (a queue drain names its
 *  own session), else this composer's. A fresh-draft scope is no stored id. */
function submitContext(
  options: Parameters<ChatBarProps['onSubmit']>[1],
  own: ComposerSession
): ComposerSubmitContext {
  const named = sessionIdOrNull(options?.storedSessionId !== undefined ? options.storedSessionId : own.storedSessionId)
  const stored = named && !isFreshDraftScope(named) ? named : null
  const runtime = sessionIdOrNull(options?.sessionId !== undefined ? options.sessionId : own.sessionId)

  return { sessionId: destinationRuntime(runtime, stored), storedSessionId: stored }
}

export function useMiddlewareSubmit(onSubmitProp: ChatBarProps['onSubmit'], session: ComposerSession = {}) {
  // Typed stop phrase during an active voice conversation ends it — same
  // semantics as SAYING "stop" (voice-stop-word.ts) or clicking the pill's
  // end control. The caller populates it after useComposerVoice (the submit
  // wrapper is created first); render-time assignment keeps the ref current.
  const voiceStopRef = useRef<VoiceStopHandle>({ active: false, end: () => {} })
  // Read at send time: the composer can re-home (a fresh chat gets its id).
  const sessionRef = useRef(session)
  sessionRef.current = session

  // Every send (typed, queued, voice) passes through the contributed
  // middleware chain first — rewrite / pass-through / cancel. Empty chain =
  // exact pass-through, so surfaces without contributions are byte-identical.
  const onSubmit = useCallback<ChatBarProps['onSubmit']>(
    async (value, options) => {
      // Bare stop phrase typed while the voice conversation is live: end the
      // conversation (mic off, pill dismissed) instead of sending "stop" to
      // the agent. Spoken transcripts are already stop-checked inside
      // use-voice-conversation, so this only catches typed/queued sends.
      // Outside a voice conversation, typed "stop" is a normal message.
      const voiceStop = voiceStopRef.current

      if (interceptsTypedVoiceStop(voiceStop.active, value, options?.attachments?.length ?? 0)) {
        voiceStop.end()

        // Consumed (not rejected): report accepted so the submit engine
        // clears the draft instead of restoring "stop" into the composer.
        return true
      }

      // Middleware sees which chat this is — a queued send drains in its own
      // tile, which need not be the focused one.
      const draft = await runComposerMiddleware(
        { text: value, attachments: options?.attachments },
        submitContext(options, sessionRef.current)
      )

      if (!draft) {
        return false
      }

      return onSubmitProp(draft.text, { ...options, attachments: draft.attachments })
    },
    [onSubmitProp]
  )

  return { onSubmit, voiceStopRef }
}
