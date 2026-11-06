"""Hosted-room mentions for a default seated under its custom @handle (#89720).

A gateway-hosted room created after the default profile got a custom handle freezes that handle
(``maia``). ``@hermes`` keeps reaching the default everywhere else, so the room resolves it too —
but never over a member that holds ``hermes`` itself.
"""

import pytest

from gateway import hosted_room_discussion as discussion


def _roster(*members):
    profiles = [member["profile"] for member in members]
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
