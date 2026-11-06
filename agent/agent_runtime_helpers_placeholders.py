"""Interrupt placeholder wording substituted into empty non-final wire rows, and the labels the
alternation repair puts on a stale unanswered user turn it merges into a new one.

Split out of ``agent/agent_runtime_helpers.py`` (code-health size ratchet); a leaf module with no
imports so every reader (runtime helpers, turn prep, the conversation loop) can import it directly.
"""

# Placeholder for an empty non-final message the provider would reject. This is the single source of
# the wording: every healing path imports it from here, so healed transcripts read consistently.
#
# Wording matters: this text is substituted into an assistant row's ``content`` on the wire copy
# (``fill_empty_non_final_wire_payload``, ``repair_empty_non_final_messages``, and the projection in
# ``run_conversation``), so the model reads it as something IT said. A short natural-language phrase
# in that position gets echoed verbatim — a clean ``finish_reason=stop`` turn answering an ordinary
# instruction with just the placeholder (#132949, and #81841 for the same hazard on the scaffold).
# Keep it a structural label the model has no conversational reason to reproduce, never prose.
_INTERRUPTED_PLACEHOLDER = "[interrupt: no assistant output for this turn]"

# The spelling shipped before #132949. Models reproduce it verbatim, so rows already carrying it
# stay poisoned after the wording change; the replay filters reference this name to retire them.
_LEGACY_INTERRUPTED_PLACEHOLDER = "[response interrupted]"


# A user turn left unanswered (usually by a process death), merged into a later user turn this long after
# it, is labelled instead of joined bare. Same span as the Desktop auto-continue default (15 min): past it
# nothing re-sends the prompt on its own, so the next message is a new request, not a continuation.
STALE_UNANSWERED_TURN_SECS = 15 * 60


def _epoch(value: object) -> float | None:
    return float(value) if isinstance(value, (int, float)) and not isinstance(value, bool) else None


def stale_unanswered_turn_prefix(prev: dict, new: dict, prev_text: str, new_text: str) -> str | None:
    """Text to put before ``new_text`` when ``_merge_consecutive_users`` folds a stale unanswered turn
    into a new one, else None (the plain ``"\\n\\n"`` join). Providers reject consecutive user turns,
    so both stay in one turn; the labels stop the model answering the old prompt as the new request.
    Only two plain prompts with known times qualify: a display/notice row is not an unanswered ask."""
    old_ts, new_ts = _epoch(prev.get("timestamp")), _epoch(new.get("timestamp"))
    if (not prev_text or not new_text or prev.get("display_kind") or new.get("display_kind")
            or old_ts is None or new_ts is None or new_ts - old_ts <= STALE_UNANSWERED_TURN_SECS):
        return None
    from time import gmtime, strftime

    def when(ts: float) -> str:
        return strftime("%Y-%m-%d %H:%M UTC", gmtime(ts))

    # Cause-neutral: a crash is the usual source, but a notice row (/reload-mcp) or a turn a failure
    # left open reaches here too. Both labels carry their own time, so a re-merge stays readable.
    return (f"[Earlier message from {when(old_ts)}, left without a reply:]\n\n{prev_text}\n\n"
            f"[New message from {when(new_ts)}. This is the current request; treat the earlier message as "
            "background and act on it only if this one asks you to.]")


def hidden_interrupt_placeholder_row() -> dict:
    """A fresh assistant row that is invisible in transcripts but carries the placeholder as its
    non-empty ``api_content``, so the pre-call sanitizer does not re-heal it every call (#88955)."""
    return {"role": "assistant", "content": "", "display_kind": "hidden", "api_content": _INTERRUPTED_PLACEHOLDER}
