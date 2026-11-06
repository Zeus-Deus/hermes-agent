"""Interrupt placeholder wording substituted into empty non-final wire rows, and the labels the
alternation repair puts on a stale unanswered user turn it merges into a new one.

Split out of ``agent/agent_runtime_helpers.py`` (code-health size ratchet); a leaf module with no
module-level imports so every reader (runtime helpers, turn prep, the conversation loop) can import it directly.
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


# Role=user pivot rows written between turns (tui_gateway ``_is_pivot_marker``): notices, never a request.
_PIVOT_MARKER_DISPLAY_KINDS = frozenset({"model_switch", "personality_switch"})


def _request_time(msg: dict) -> float | None:
    """When *msg*'s newest request part arrived: a merge survivor records it (its own ``timestamp`` stays
    the first row's), a pivot marker is not a request, and a non-numeric time is unknown."""
    from agent.message_metadata import MERGED_TURN_REQUEST_TS

    if MERGED_TURN_REQUEST_TS in msg:
        return msg[MERGED_TURN_REQUEST_TS]
    ts = msg.get("timestamp")
    if msg.get("display_kind") in _PIVOT_MARKER_DISPLAY_KINDS or isinstance(ts, bool):
        return None
    return float(ts) if isinstance(ts, (int, float)) else None


def stale_unanswered_turn_prefix(prev: dict, new: dict, prev_text: str, new_text: str) -> str | None:
    """Text to put before ``new_text`` when ``_merge_consecutive_users`` folds an unanswered turn into a
    new one that is not its follow-up, else None (the plain ``"\\n\\n"`` join). Providers reject
    consecutive user turns, so both stay in one turn; the labels stop the model answering the old prompt
    as the new request. Not a follow-up: it arrived past the stale window, or from the other side of the
    person/machinery line (a bot DM or background notice after a person's prompt, or the reverse).
    Records on *prev* when its newest request part arrived, so a later merge measures from that.
    Call before the merge rewrites *prev*."""
    from agent.message_metadata import MERGED_TURN_REQUEST_TS
    from gateway.response_filters import is_machinery_display_kind

    old_ts, new_ts = _request_time(prev), _request_time(new)
    known = [ts for ts in (old_ts, new_ts) if ts is not None]
    prev[MERGED_TURN_REQUEST_TS] = max(known) if known else None
    if not prev_text or not new_text or old_ts is None or new_ts is None:
        return None
    other_origin = is_machinery_display_kind(prev.get("display_kind")) != is_machinery_display_kind(
        new.get("display_kind"))
    if not other_origin and new_ts - old_ts <= STALE_UNANSWERED_TURN_SECS:
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
