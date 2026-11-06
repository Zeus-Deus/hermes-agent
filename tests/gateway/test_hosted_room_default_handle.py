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


def test_an_installed_hermes_profile_this_gateway_does_not_serve_keeps_the_name(tmp_path, monkeypatch):
    """A gateway serving only some profiles checks rooms against those (``room_profiles`` gives
    ``default`` + ``research`` here), but @hermes names the install's real ``hermes`` profile
    wherever it is served, so the default never answers it."""
    from tests.tools.test_bot_mode_dm import _managed_home

    monkeypatch.setenv("HERMES_HOME", str(_managed_home(tmp_path, teammates=("research", "hermes"))))
    members = discussion.validate_roster(
        [_member("default", "maia"), _member("research", "research")], local_profiles=("default", "research"))

    assert _addressed("@hermes @research check", members) == ["research"]
    assert _addressed("@maia check", members) == ["default"]


def test_the_seated_defaults_own_install_decides_the_alias_not_the_gateways(tmp_path, monkeypatch):
    """A named gateway (``/A/profiles/research``) seats a default from another install (``/B``)
    through ``hosted_rooms.profiles.default``. ``/B`` has a real ``hermes`` profile this gateway does
    not serve, so @hermes names that profile there and the default never answers it, even though
    the gateway's own install ``/A`` has no ``hermes`` profile."""
    import asyncio
    import json
    from types import SimpleNamespace

    from gateway.session_hosted_service import CanonicalHostedRoomService
    from hermes_state import SessionDB
    from hermes_state_runtime import begin_runtime_epoch
    from tests.tools.test_bot_mode_dm import _managed_home

    (tmp_path / "A").mkdir()
    (tmp_path / "B").mkdir()
    gateway_home = _managed_home(tmp_path / "A", teammates=("research",)) / "profiles" / "research"
    default_home = _managed_home(tmp_path / "B", teammates=("hermes",)).resolve()
    (gateway_home / "config.yaml").write_text(
        json.dumps({"hosted_rooms": {"profiles": {"default": str(default_home)}}}), encoding="utf-8")
    monkeypatch.setenv("HERMES_HOME", str(gateway_home))
    with SessionDB(gateway_home / "state.db") as db:
        authority = SimpleNamespace(db=db, profile_id=str(gateway_home), epoch=begin_runtime_epoch(db, instance_id="t"))
        service = CanonicalHostedRoomService(authority, asyncio.new_event_loop())
        assert service.profile_homes() == {"research": gateway_home, "default": default_home}
        room = service.create_room(room_id="room", name="Ops",
                                   members=[_member("default", "maia"), _member("research", "research")])
        gateway = hosted_rooms.local_authority_gateway_id()
        hosted_rooms.append_event(
            db.db_path, room_id="room", event_id="u1", kind="message.user", actor={"kind": "user", "id": "desktop"},
            payload={"text": "@hermes @research check", "thread_id": "t1"}, authority_gateway_id=gateway,
            authority_epoch=1)
        room = hosted_rooms.room_state(db.db_path, room_id="room")
        events = hosted_rooms.read_events(db.db_path, room_id="room", limit=hosted_rooms.MAX_LOG_LIMIT)["events"]

        decision = discussion.plan_next_task(room, events, local_profiles=service.room_profiles(room))

        assert (decision.reason, decision.task.member.profile) == ("member_turn", "research")
        members = discussion.validate_room(room, local_profiles=service.room_profiles(room)).members
        assert _addressed("@hermes @research check", members) == ["research"]
        assert _addressed("@maia check", members) == ["default"]
