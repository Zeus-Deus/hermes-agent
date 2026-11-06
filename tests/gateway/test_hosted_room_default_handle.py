"""Hosted-room mentions for a default seated under its custom @handle (#89720).

A gateway-hosted room created after the default profile got a custom handle freezes that handle
(``maia``). ``@hermes`` keeps reaching the default everywhere else, so the room resolves it too —
but never over a member that holds ``hermes`` itself.
"""

import pytest

from gateway import hosted_room_context as context
from gateway import hosted_room_discussion as discussion
from gateway import hosted_rooms


def _roster(*members, unseated=()):
    profiles = [member["profile"] for member in members] + list(unseated)
    return discussion.validate_roster(list(members), local_profiles=profiles)


def _member(profile, handle):
    """The member shape the Desktop's ``canonicalGroupRoster`` sends to ``groups.create``."""
    return {"member_id": profile, "profile": profile, "handle": handle, "target": {"kind": "local", "profile": profile}}


def _addressed(text, members):
    return [member.profile for member in discussion.resolve_mentions((text,), members, default_all=False)]


@pytest.mark.parametrize("text, expected", [
    ("@hermes status?", ["default"]),
    ("@hermes @research status?", ["default", "research"]),
    ("@maia status?", ["default"]),
    ("@research status?", ["research"]),
])
def test_hermes_still_reaches_a_default_seated_under_its_custom_handle(text, expected):
    members = _roster(_member("default", "maia"), _member("research", "research"))
    assert _addressed(text, members) == expected


def test_the_alias_addresses_one_member_and_unaddressed_text_still_reaches_everyone():
    members = _roster(_member("default", "maia"), _member("research", "research"))
    assert [m.profile for m in discussion.resolve_mentions(("@hermes status?",), members)] == ["default"]
    assert [m.profile for m in discussion.resolve_mentions(("status?",), members)] == ["default", "research"]


def test_a_member_holding_hermes_keeps_it():
    members = _roster(_member("default", "maia"), _member("hermes", "hermes"))
    assert _addressed("@hermes status?", members) == ["hermes"]


def test_a_default_frozen_as_default_gets_no_alias():
    """Frozen as ``default``: a real ``hermes`` profile held @hermes on that install."""
    members = _roster(_member("default", "default"), _member("research", "research"))
    assert _addressed("@hermes status?", members) == []


def test_an_unseated_hermes_profile_keeps_the_name():
    """With a real ``hermes`` profile on the gateway, @hermes names that profile, never the default."""
    members = _roster(_member("default", "maia"), _member("research", "research"), unseated=("hermes",))
    assert _addressed("@hermes @research status?", members) == ["research"]
    assert _addressed("@maia status?", members) == ["default"]


def test_lead_routing_leaves_a_message_to_hermes_with_the_default(tmp_path):
    """In a lead-routed room, a message the resolver addresses never detours through the lead."""
    db, room_id, gateway = tmp_path / "state.db", "room-lead", hosted_rooms.local_authority_gateway_id()
    members = [_member("default", "maia"), _member("research", "research")]
    hosted_rooms.create_room(db, room_id=room_id, name="Ops", members=members, authority_gateway_id=gateway, now=1)
    context.set_room_context(db, room_id=room_id, event_id="ctx", purpose="Ops", notes="",
                             routing="lead", lead_member_id="research")
    seq = hosted_rooms.append_event(
        db, room_id=room_id, event_id="u1", kind="message.user", actor={"kind": "user", "id": "desktop"},
        payload={"text": "@hermes check the deploy", "thread_id": "t1"}, authority_gateway_id=gateway,
        authority_epoch=1)["seq"]
    room = {**hosted_rooms.room_state(db, room_id=room_id), "members": members}
    events = hosted_rooms.read_events(db, room_id=room_id, limit=hosted_rooms.MAX_LOG_LIMIT)["events"]

    decision = discussion.plan_next_task(room, events, local_profiles=("default", "research"),
                                         room_context=context.room_context(db, room_id=room_id, before_seq=seq))

    assert (decision.reason, decision.task.member.profile) == ("member_turn", "default")
