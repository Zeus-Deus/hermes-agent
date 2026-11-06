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


def _request_info(msg: dict) -> tuple[float | None, bool | None]:
    """``(time, machinery)`` of *msg*'s newest request part; ``(None, None)`` when it holds none (a pivot
    marker). A merge survivor records it (its own ``timestamp`` and ``display_kind`` stay the first
    row's), and a replay projection that drops ``display_kind`` carries it (``replay_request_info``)."""
    from agent.message_metadata import MERGED_TURN_REQUEST
    from gateway.response_filters import is_machinery_display_kind

    recorded = msg.get(MERGED_TURN_REQUEST)
    if isinstance(recorded, dict):
        return recorded.get("at"), recorded.get("machinery")
    kind, metadata = msg.get("display_kind"), msg.get("display_metadata")
    if kind in _PIVOT_MARKER_DISPLAY_KINDS:
        return None, None
    ts = msg.get("timestamp")
    # A muted diagnostic wake is stored ``hidden`` with this category (session_persistence); only a
    # trusted wake carries it, never a person's message.
    muted = isinstance(metadata, dict) and metadata.get("notification_category") == "diagnostic"
    return (float(ts) if isinstance(ts, (int, float)) and not isinstance(ts, bool) else None,
            is_machinery_display_kind(kind) or muted)


def replay_request_info(msg: dict) -> dict | None:
    """The request record a replay copy of user row *msg* must carry when it keeps only content and
    timestamp; None when those already say it (a person's row, never merged)."""
    from agent.message_metadata import MERGED_TURN_REQUEST

    if isinstance(recorded := msg.get(MERGED_TURN_REQUEST), dict):
        return dict(recorded)
    at, machinery = _request_info(msg)
    return None if machinery is False else {"at": at, "machinery": machinery}


def stale_unanswered_turn_prefix(prev: dict, new: dict, prev_text: str, new_text: str) -> str | None:
    """Text to put before ``new_text`` when ``_merge_consecutive_users`` folds an unanswered turn into a
    new one that is not its follow-up, else None (the plain ``"\\n\\n"`` join). Providers reject
    consecutive user turns, so both stay in one turn; the labels stop the model answering the old prompt
    as the new request. Not a follow-up: it arrived past the stale window, or from the other side of the
    person/machinery line (a bot DM or background notice after a person's prompt, or the reverse).
    Records on *prev* its newest request part, so a later merge measures from that. Call before the
    merge rewrites *prev*."""
    from agent.message_metadata import MERGED_TURN_REQUEST

    (old_ts, old_machinery), (new_ts, new_machinery) = _request_info(prev), _request_info(new)
    # An empty row asks nothing: it leaves the newest request as it was.
    newest = (new_ts, new_machinery) if new_machinery is not None and new_text else (old_ts, old_machinery)
    # Recorded whenever anything is known: the merge may yet drop the survivor's own display_kind.
    if newest != (None, False) or MERGED_TURN_REQUEST in prev:
        prev[MERGED_TURN_REQUEST] = {"at": newest[0], "machinery": newest[1]}
    if (not prev_text or not new_text or old_ts is None or new_ts is None
            or old_machinery is None or new_machinery is None):
        return None
    if old_machinery == new_machinery and new_ts - old_ts <= STALE_UNANSWERED_TURN_SECS:
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
