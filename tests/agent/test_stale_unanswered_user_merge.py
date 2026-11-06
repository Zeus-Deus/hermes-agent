"""A stale unanswered user turn merged with a new one is labelled, never passed off as the new request.

A process death between a turn's start and its reply leaves that prompt in the store with no
assistant row. Once the crash marker has aged out nothing re-sends it, so the next message (a
person's, or a bot DM delivered days later) lands right behind it and the alternation repair folds
both into one user turn. Providers reject consecutive user turns, so the merge stays; what changes
is that an unanswered part that the new message does not follow up (older than the stale window, or
from the other side of the person/machinery line, like a bot DM after a person's prompt) is labelled
as such and the new part is marked as the current request. A quick double send keeps the plain
``"\\n\\n"`` join.
"""

import pytest

from agent.agent_runtime_helpers import repair_message_sequence
from agent.message_metadata import MERGED_TURN_PREFIX
from agent.session_persistence import SessionPersistenceMixin, _db_flush_row
from hermes_state import SessionDB
from tests.agent import test_in_place_preflight_rewind as rewind

session = rewind.session  # shared fixture: AIAgent with a mocked client over a temp SessionDB

OLD_TS = 1_756_060_279.0  # 2025-08-24 18:31:19 UTC
DAYS_LATER = OLD_TS + 5 * 24 * 3600
STALE_ASK = "Tell me which workspace I'm on."
DM = "Message from bot (@bob): please investigate X"


def _history(old_ts, new_ts, **extra):
    return [
        {"role": "user", "content": "earlier question"},
        {"role": "assistant", "content": "earlier answer"},
        {"role": "user", "content": STALE_ASK, "timestamp": old_ts, **extra},
        {"role": "user", "content": DM, "timestamp": new_ts},
    ]


def test_stale_unanswered_prompt_is_labelled_and_new_message_marked_current():
    messages = _history(OLD_TS, DAYS_LATER)

    assert repair_message_sequence(None, messages) == 1

    # One provider turn (strict alternation), both texts kept, in order.
    assert [m["role"] for m in messages] == ["user", "assistant", "user"]
    merged = messages[2]["content"]
    assert merged != f"{STALE_ASK}\n\n{DM}"
    old_label, rest = merged.split(f"\n\n{STALE_ASK}\n\n", 1)
    new_label, new_text = rest.split("\n\n", 1)
    assert new_text == DM
    assert old_label == "[Earlier message from 2025-08-24 18:31 UTC, left without a reply:]"
    assert "current request" in new_label and "2025-08-29 18:31 UTC" in new_label
    # The persist override still replaces only the absorbed (current) turn.
    assert messages[2][MERGED_TURN_PREFIX] == merged[: -len(DM) - 2]
    # Settled: the next pre-request pass does not touch it again.
    assert repair_message_sequence(None, messages) == 0


@pytest.mark.parametrize("gap", [0.0, 30.0, 14 * 60.0])
def test_fresh_consecutive_prompts_keep_the_plain_join(gap):
    messages = _history(OLD_TS, OLD_TS + gap)
    assert repair_message_sequence(None, messages) == 1
    assert messages[2]["content"] == f"{STALE_ASK}\n\n{DM}"
    assert messages[2][MERGED_TURN_PREFIX] == STALE_ASK


@pytest.mark.parametrize("old_ts,new_ts", [(None, DAYS_LATER), (OLD_TS, None), ("x", DAYS_LATER), (True, DAYS_LATER)])
def test_unknown_timestamps_keep_the_plain_join(old_ts, new_ts):
    messages = _history(old_ts, new_ts)
    assert repair_message_sequence(None, messages) == 1
    assert messages[2]["content"] == f"{STALE_ASK}\n\n{DM}"


@pytest.mark.parametrize("side", [2, 3])
@pytest.mark.parametrize("kind", ["model_switch", "personality_switch"])
def test_pivot_marker_rows_are_not_labelled_as_requests(side, kind):
    messages = _history(OLD_TS, DAYS_LATER)
    messages[side]["display_kind"] = kind
    assert repair_message_sequence(None, messages) == 1
    assert messages[2]["content"] == f"{STALE_ASK}\n\n{DM}"


@pytest.mark.parametrize("kind", ["internal_notification", "process_complete", "hidden"])
def test_machinery_delivered_requests_are_labelled(kind):
    """A gateway bot DM is an internal event: its row is ``internal_notification``, and still the request."""
    messages = _history(OLD_TS, DAYS_LATER)
    messages[3]["display_kind"] = kind
    assert repair_message_sequence(None, messages) == 1
    assert messages[2]["content"].startswith("[Earlier message from 2025-08-24 18:31 UTC")
    assert messages[2]["content"].endswith(f"asks you to.]\n\n{DM}")


@pytest.mark.parametrize("side", [2, 3])
def test_fresh_merge_across_the_person_machinery_line_is_labelled(side):
    """A bot DM a minute after a person's unanswered prompt (or the reverse) is not its follow-up."""
    messages = _history(OLD_TS, OLD_TS + 60)
    messages[side]["display_kind"] = "internal_notification"
    assert repair_message_sequence(None, messages) == 1
    merged = messages[2]["content"]
    assert merged.startswith("[Earlier message from 2025-08-24 18:31 UTC, left without a reply:]")
    assert "[New message from 2025-08-24 18:32 UTC. This is the current request;" in merged


def test_fresh_machinery_rows_keep_the_plain_join():
    messages = _history(OLD_TS, OLD_TS + 60)
    messages[2]["display_kind"] = "process_complete"
    messages[3]["display_kind"] = "internal_notification"
    assert repair_message_sequence(None, messages) == 1
    assert messages[2]["content"] == f"{STALE_ASK}\n\n{DM}"


def test_fresh_prompt_after_an_absorbed_marker_keeps_the_plain_join():
    """The survivor keeps the marker's old timestamp; staleness is measured from the newest request part."""
    marker = {"role": "user", "content": "[System: model changed]", "display_kind": "model_switch", "timestamp": OLD_TS}
    ask = {"role": "user", "content": "Investigate invoice drift.", "timestamp": OLD_TS + 3600}
    follow = {"role": "user", "content": "The invoice number is 1234.", "timestamp": OLD_TS + 3610}
    messages = [{"role": "assistant", "content": "hi"}, marker, ask, follow]
    assert repair_message_sequence(None, messages) == 2
    assert messages[1]["content"] == "[System: model changed]\n\nInvestigate invoice drift.\n\nThe invoice number is 1234."


def test_quick_follow_up_after_a_labelled_merge_joins_the_new_request():
    late = {"role": "user", "content": "also check Y", "timestamp": DAYS_LATER + 10}
    messages = _history(OLD_TS, DAYS_LATER) + [late]
    assert repair_message_sequence(None, messages) == 2
    merged = messages[2]["content"]
    assert merged.count("[Earlier message from") == 1 and merged.count("[New message from") == 1
    assert merged.endswith(f"asks you to.]\n\n{DM}\n\nalso check Y")


def test_stale_prompt_then_marker_then_new_request_is_labelled_once():
    marker = {"role": "user", "content": "[System: model changed]", "display_kind": "model_switch",
              "timestamp": DAYS_LATER - 5}
    messages = _history(OLD_TS, DAYS_LATER)
    messages.insert(3, marker)
    assert repair_message_sequence(None, messages) == 2
    merged = messages[2]["content"]
    assert merged.startswith("[Earlier message from 2025-08-24 18:31 UTC")
    assert f"{STALE_ASK}\n\n[System: model changed]\n\n[New message from" in merged
    assert merged.endswith(f"\n\n{DM}")


def test_request_time_bookkeeping_never_reaches_the_wire():
    from agent.message_metadata import MERGED_TURN_REQUEST_TS, PERSISTENCE_ONLY_MESSAGE_FIELDS

    messages = _history(OLD_TS, DAYS_LATER)
    repair_message_sequence(None, messages)
    assert messages[2][MERGED_TURN_REQUEST_TS] == DAYS_LATER
    assert MERGED_TURN_REQUEST_TS in PERSISTENCE_ONLY_MESSAGE_FIELDS


def test_empty_side_keeps_existing_behaviour():
    messages = _history(OLD_TS, DAYS_LATER)
    messages[3]["content"] = ""
    assert repair_message_sequence(None, messages) == 1
    assert messages[2]["content"] == STALE_ASK


def test_persist_override_keeps_labels_and_replaces_only_the_current_turn():
    wire = "[2025-08-29T20:31:19+0200] " + DM
    messages = _history(OLD_TS, DAYS_LATER)
    messages[3]["content"] = wire
    assert repair_message_sequence(None, messages) == 1
    merged_wire = messages[2]["content"]
    agent = object.__new__(SessionPersistenceMixin)
    agent._persist_user_message_idx = 2
    agent._persist_user_message_override = DM
    agent._persist_user_message_timestamp = None
    agent._persist_user_message_platform_id = None
    expected = merged_wire[: -len(wire)] + DM
    row = _db_flush_row(agent, messages[2], True)
    assert row["content"] == expected
    assert row["api_content"] == merged_wire
    agent._apply_persist_user_message_override(messages)
    assert messages[2]["content"] == expected


def test_restore_labels_a_durable_stale_pair(tmp_path):
    db = SessionDB(db_path=tmp_path / "state.db")
    try:
        db.create_session("s1", "system prompt")
        db.append_message(session_id="s1", role="user", content="earlier question", timestamp=OLD_TS - 60)
        db.append_message(session_id="s1", role="assistant", content="earlier answer", timestamp=OLD_TS - 30)
        db.append_message(session_id="s1", role="user", content=STALE_ASK, timestamp=OLD_TS)
        db.append_message(session_id="s1", role="user", content=DM, timestamp=DAYS_LATER)
        first = db.get_messages_as_conversation("s1", repair_alternation=True)
        second = db.get_messages_as_conversation("s1", repair_alternation=True)
    finally:
        db.close()
    assert [m["role"] for m in first] == ["user", "assistant", "user"]
    merged = first[2]["content"]
    assert f"\n\n{STALE_ASK}\n\n" in merged and merged.endswith(f"\n\n{DM}")
    assert "left without a reply" in merged and "current request" in merged
    # Deterministic: every reload yields the same bytes (prompt-cache prefix stays stable).
    assert second[2]["content"] == merged


@pytest.mark.parametrize("surface", ["gateway", "cli"])
def test_full_turn_sends_the_new_message_as_the_current_request(session, surface):
    """Real agent + store: a prompt left unanswered days ago, then a DM. The request labels both parts, the
    stored row keeps those bytes, and the next turn replays the merged row unchanged (stable cache prefix)."""
    from types import SimpleNamespace

    db, agent = session
    db.create_session("sid", "system prompt")
    db.append_message(session_id="sid", role="user", content="earlier question", timestamp=OLD_TS - 60)
    db.append_message(session_id="sid", role="assistant", content="earlier answer", timestamp=OLD_TS - 30)
    db.append_message(session_id="sid", role="user", content=STALE_ASK, timestamp=OLD_TS)  # crash: no reply row
    cli = SimpleNamespace(conversation_history=db.get_messages_as_conversation("sid", repair_alternation=True))

    def run(text):
        agent.client.chat.completions.create.side_effect = [rewind._reply(f"reply to {text[:12]}", 1_000)]
        if surface == "gateway":
            from gateway.run import _build_gateway_agent_history

            history = _build_gateway_agent_history(db.get_messages_as_conversation("sid", repair_alternation=True))[0]
            # A bot DM is admitted as an internal event (gateway.session_bot._admit), so its row is
            # ``internal_notification`` and carries the sender as the turn author.
            agent.run_conversation(user_message=text, conversation_history=history, task_id="sid",
                                   persist_user_message=text, persist_user_display_kind="internal_notification",
                                   turn_author={"id": "bot:bob", "name": "bob", "is_bot": True})
        else:
            from hermes_cli.cli_chat_turn_mixin import CLIChatTurnMixin

            CLIChatTurnMixin._chat_stage_user_message(cli, agent, text)
            result = agent.run_conversation(user_message=text, conversation_history=cli.conversation_history[:-1],
                                            task_id="sid", persist_user_message=None)
            cli.conversation_history = result.get("messages", cli.conversation_history)
        return [m for m in agent.client.chat.completions.create.call_args.kwargs["messages"] if m["role"] != "system"]

    request = run(DM)
    assert [m["role"] for m in request] == ["user", "assistant", "user"]
    sent = request[-1]["content"]
    assert sent.startswith("[Earlier message from 2025-08-24 18:31 UTC") and f"\n\n{STALE_ASK}\n\n" in sent
    assert sent.endswith(f"current request; treat the earlier message as background and act on it only if this one "
                         f"asks you to.]\n\n{DM}")

    stored = [m for m in db.get_messages_as_conversation("sid", repair_alternation=True)]
    assert [m["role"] for m in stored] == ["user", "assistant", "user", "assistant"]
    assert stored[2]["content"] == sent

    request = run("thanks")
    assert [m["role"] for m in request] == ["user", "assistant", "user", "assistant", "user"]
    assert request[2]["content"] == sent


@pytest.mark.parametrize("surface", ["cli", "resume", "gateway"])
def test_in_place_compaction_carries_the_labelled_row_once(session, surface):
    """The labelled merge is still one dict for two durable rows: compaction keeps exactly one copy of it."""
    import time
    from types import SimpleNamespace

    db, agent = session
    cli = SimpleNamespace(conversation_history=[])
    for n in range(1, 13):
        rewind._turn(db, agent, cli, surface, n, 5_000)
    db.append_message("sid", "user", "U12x this prompt never got a reply", timestamp=time.time() - 3 * 86400)
    if surface == "cli":
        cli.conversation_history = db.get_messages_as_conversation("sid", repair_alternation=True)
    elif surface == "resume":
        cli.conversation_history = db.get_resume_conversations("sid")[0]
    rewind._turn(db, agent, cli, surface, 13, 5_000)
    rewind._turn(db, agent, cli, surface, 14, 200_000)  # over the threshold: the next turn compacts first
    rewind._turn(db, agent, cli, surface, 15, 20_000)

    assert getattr(agent, "_last_compaction_in_place", None) is True
    assert {f"A{n}" for n in range(1, 16)} <= rewind._replies_displayed(db)
    live = [m["content"] for m in db.get_messages_as_conversation("sid") if isinstance(m.get("content"), str)]
    [carried_prompt] = [c for c in live if "U12x" in c]
    assert carried_prompt.startswith("[Earlier message from ")
    assert carried_prompt.endswith("\n\nU13 please continue with the next step")
    recalled = [row["content"] for row in db._conn.execute(
        "SELECT content FROM messages WHERE session_id = 'sid' AND (active = 1 OR compacted = 1)").fetchall()]
    carried = live[next(i for i, c in enumerate(live) if "Numbered steps" in c) + 1:]
    assert [recalled.count(c) for c in carried] == [carried.count(c) for c in carried]
    assert [c.split(" ")[0] for c in live[-2:]] == ["U15", "A15"]
