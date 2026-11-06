"""The default profile's custom @handle (#89720).

Every host's default bot is @hermes, so two connected machines both advertise @hermes. A custom
handle stored in the default's ``ui_meta['hermes-bots'].mentionHandle`` becomes the handle every
roster, the "You are" line, the DM signature and the relay advertise; @hermes keeps reaching the
local default so DMs addressed before the rename still land.
"""

import json
import textwrap

import pytest

from tests.tools.test_bot_mode_dm import _canonical_target, _capture_spawn, _FakeAgent, _managed_home
from tools import bot_mode_dm, bot_mode_probe, bot_relay


@pytest.fixture(autouse=True)
def _fresh_probe_cache():
    bot_mode_probe._reset_cache_for_tests()
    yield
    bot_mode_probe._reset_cache_for_tests()


def _set_default_handle(root, handle, title=""):
    lines = ["ui_meta:", "  hermes-bots:", "    shape: cloud", f"    mentionHandle: {handle}"]
    if title:
        lines.append(f"    title: {title}")
    (root / "profile.yaml").write_text("\n".join(lines) + "\n", encoding="utf-8")


def _rig(tmp_path, monkeypatch, teammates=("researcher",)):
    _capture_spawn(monkeypatch)
    monkeypatch.setattr(bot_relay, "_hermes_cli", lambda: "hermes")
    monkeypatch.setattr(bot_mode_dm, "_dm_dir", lambda: tmp_path)
    return _managed_home(tmp_path, teammates=teammates)


def test_rosters_and_the_you_are_line_advertise_the_custom_handle(tmp_path):
    root = _managed_home(tmp_path)
    _set_default_handle(root, "maia", title="Lead")

    teammates = bot_mode_probe.get_bot_mode_protocol_section(root / "profiles" / "researcher").split("Your teammates")[1]
    assert "`@maia`" in teammates and "`@hermes`" not in teammates
    assert "You are `@maia`" in bot_mode_probe.get_bot_mode_protocol_section(root)


def test_the_custom_handle_and_legacy_hermes_both_reach_the_local_default(tmp_path, monkeypatch):
    root = _rig(tmp_path, monkeypatch)
    _set_default_handle(root, "maia")
    authority = _canonical_target(monkeypatch, root)
    sender = _FakeAgent(root / "profiles" / "researcher")

    for target in ("@maia", "maia", "hermes", "default"):
        ack = json.loads(bot_mode_dm.message_agent_tool(target=target, message=f"ping {target}", agent=sender))
        assert ack["status"] == "queued" and ack["to"] == "@maia", (target, ack)
    assert [home for home, _params in authority.calls] == [root.resolve()] * 4


def test_default_signs_and_authors_dms_with_its_custom_handle(tmp_path, monkeypatch):
    root = _rig(tmp_path, monkeypatch)
    _set_default_handle(root, "maia", title="Lead")
    authority = _canonical_target(monkeypatch, root / "profiles" / "researcher")

    ack = json.loads(bot_mode_dm.message_agent_tool(target="researcher", message="status?", agent=_FakeAgent(root)))

    assert ack["status"] == "queued"
    (_home, params), = authority.calls
    assert params["message"].startswith("Message from 🤖 Lead (@maia): ")
    assert params["author"]["name"] == "maia"


def test_a_real_profile_named_like_the_handle_keeps_it(tmp_path, monkeypatch):
    """Same rule as @hermes: a live profile holding the name wins and the default falls back to
    @hermes — a profile created after the handle was set never loses its own DMs."""
    root = _rig(tmp_path, monkeypatch, teammates=("researcher", "maia"))
    _set_default_handle(root, "maia")
    authority = _canonical_target(monkeypatch, root, root / "profiles" / "maia")
    sender = _FakeAgent(root / "profiles" / "researcher")

    assert bot_mode_probe._handle("default", ["default", "researcher", "maia"], root) == "hermes"
    json.loads(bot_mode_dm.message_agent_tool(target="maia", message="a", agent=sender))
    json.loads(bot_mode_dm.message_agent_tool(target="hermes", message="b", agent=sender))
    assert [home for home, _p in authority.calls] == [(root / "profiles" / "maia").resolve(), root.resolve()]


def test_without_a_custom_handle_nothing_changes(tmp_path):
    root = _managed_home(tmp_path)
    names = ["default", "researcher"]
    assert bot_mode_probe._handle("default", names, root) == "hermes"
    assert bot_mode_probe._profile_for_handle("maia", names, root) == "maia"
    assert bot_mode_probe.local_taken_forms(root) == {"default", "hermes", "researcher"}


def test_an_unset_handle_leaves_the_capability_epoch_alone(tmp_path):
    root = _managed_home(tmp_path)
    (root / "profile.yaml").write_text("ui_meta:\n  hermes-bots:\n    shape: cloud\n", encoding="utf-8")
    before = bot_mode_probe.capability_fingerprint(root)
    _set_default_handle(root, "''")
    assert bot_mode_probe.capability_fingerprint(root) == before
    _set_default_handle(root, "maia")
    assert bot_mode_probe.capability_fingerprint(root) != before


@pytest.mark.parametrize("value, problem", [
    ("hermes", "reserved"), ("everyone", "reserved"), ("default", "reserved"),
    ("two words", "lowercase letters"), ("-lead", "lowercase letters"), ("x" * 65, "lowercase letters"),
    ("researcher", "name of a profile"), ("scribe", "tags another bot"), (7, "must be text"),
])
def test_validation_refuses_handles_that_cannot_name_the_default(tmp_path, value, problem):
    root = _managed_home(tmp_path)
    profile = root / "profiles" / "researcher" / "profile.yaml"
    profile.write_text(profile.read_text(encoding="utf-8") + "    title: Scribe\n", encoding="utf-8")

    with pytest.raises(ValueError, match=problem):
        bot_mode_probe.validate_default_handle(root, value)


def test_validation_normalizes_and_clears(tmp_path):
    root = _managed_home(tmp_path)
    assert bot_mode_probe.validate_default_handle(root, " @Maia ") == "maia"
    assert bot_mode_probe.validate_default_handle(root, "") == ""
    assert bot_mode_probe.validate_default_handle(root, None) == ""


# ── relay: a remote default with a custom handle ─────────────────────────────


def _remote_roster(home):
    bot_relay.write_remote_roster(home, [
        {"profile": "default", "handle": "maia", "connection_id": "laptop", "connection_label": "Laptop"},
        {"profile": "default", "handle": "hermes", "connection_id": "server", "connection_label": "Server"},
    ])
    return bot_relay.read_remote_roster(home)


def test_remote_defaults_are_told_apart_by_the_custom_handle(tmp_path):
    root = _managed_home(tmp_path)
    roster = _remote_roster(root)

    assert bot_relay.resolve_remote_target("maia", roster)["connection_id"] == "laptop"
    # Replies stamped before the rename (hermes@laptop) still reach that machine's default.
    assert bot_relay.resolve_remote_target("hermes@laptop", roster)["connection_id"] == "laptop"
    assert bot_relay.resolve_remote_target("hermes@server", roster)["connection_id"] == "server"
    assert bot_relay.remote_target_forms(roster, bot_mode_probe.local_taken_forms(root)) == ["maia", "hermes@server"]


def test_local_custom_handle_keeps_hermes_taken_so_no_remote_row_is_offered_bare_hermes(tmp_path):
    root = _managed_home(tmp_path)
    _set_default_handle(root, "maia")
    taken = bot_mode_probe.local_taken_forms(root)
    assert {"maia", "hermes", "default"} <= taken
    roster = _remote_roster(root)
    assert bot_relay.remote_target_forms(roster, taken) == ["maia@laptop", "hermes@server"]


def test_relayed_stamp_from_a_custom_handle_names_the_reply_safe_form(tmp_path):
    root = _managed_home(tmp_path)
    roster = _remote_roster(root)
    stamped = bot_relay.qualify_sender_stamp("Message from 🤖 Lead (@maia): hi", "maia", "laptop", roster,
                                             bot_mode_probe.local_taken_forms(root))
    assert stamped == "Message from 🤖 Lead (@maia): hi"
    assert bot_relay.resolve_remote_target("maia", roster)["connection_id"] == "laptop"


# ── gateway doors ────────────────────────────────────────────────────────────


def test_session_bot_admission_accepts_the_default_by_custom_handle_and_hermes(tmp_path):
    from types import SimpleNamespace

    from gateway.session_bot import _home
    from hermes_state_runtime import RuntimeStoreError

    root = _managed_home(tmp_path)
    _set_default_handle(root, "maia")
    authority = SimpleNamespace(db=SimpleNamespace(db_path=str(root / "state.db")), profile_id="p")
    actor = SimpleNamespace(profile_id="p", capabilities={"session:submit"})
    for profile in ("default", "hermes", "maia"):
        assert _home(authority, actor, profile) == root.resolve()
    with pytest.raises(RuntimeStoreError):
        _home(authority, actor, "researcher")


def test_profile_yaml_fixture_parses(tmp_path):
    root = _managed_home(tmp_path)
    _set_default_handle(root, "maia", title="Lead")
    assert bot_mode_probe.stored_default_handle(root) == "maia"
    (root / "profile.yaml").write_text(textwrap.dedent("""\
        ui_meta:
          hermes-bots:
            mentionHandle: Not Valid
        """), encoding="utf-8")
    assert bot_mode_probe.stored_default_handle(root) == ""
