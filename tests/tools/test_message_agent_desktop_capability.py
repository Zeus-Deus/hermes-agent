"""``message_agent`` in a regular Desktop chat (#94018): a gateway-issued, per-session capability.

The grant is the owner's ``LOCAL_DESKTOP_CHAT`` mark, frozen into a ``gui`` chat's creation policy only
when the creating connection redeemed a native ticket and declared itself the Desktop app. It is read
from that persisted receipt, never from ``agent.platform`` (the client's create ``source``) or the
title, so it stays fixed for the session's life: rename, reset and a resume from another surface do
not move it, and subagents, legacy ``serve`` sessions and other policies never get it.
"""
from __future__ import annotations

import json
import textwrap
from dataclasses import replace
from pathlib import Path
from types import SimpleNamespace

import pytest
import pytest_asyncio

from tools import bot_mode_dm, bot_mode_probe

TOOL = bot_mode_dm.MESSAGE_AGENT_TOOL_NAME


@pytest.fixture(autouse=True)
def _fresh_probe_cache():
    bot_mode_probe._reset_cache_for_tests()
    yield
    bot_mode_probe._reset_cache_for_tests()


def _home(tmp_path: Path, *, managed: bool) -> Path:
    home = tmp_path / ".hermes"
    home.mkdir()
    if managed:
        bot = home / "profiles" / "researcher"
        bot.mkdir(parents=True)
        (bot / "profile.yaml").write_text(textwrap.dedent("""\
            description: teammate for tests
            ui_meta:
              hermes-bots:
                shape: cloud
            """), encoding="utf-8")
    return home


class _Agent:
    """The attributes the gate reads off an ``AIAgent``; ``platform`` is the client-declared surface."""

    def __init__(self, db, session_id: str, platform: str = "desktop"):
        self._session_db = db
        self.session_id = session_id
        self._session_title_hint = None
        self._bot_mode_protocol = True
        self.platform = platform
        self.tools: list = []
        self.valid_tool_names: set = set()


async def _owner(tmp_path, monkeypatch, *, managed=True):
    from gateway import run
    from gateway.config import GatewayConfig
    from gateway.session import SessionStore
    from gateway.session_authority import initialize_session_authority
    from gateway.session_contract import SessionActor
    from hermes_state import SessionDB

    home = _home(tmp_path, managed=managed)
    monkeypatch.setenv("HERMES_HOME", str(home))
    monkeypatch.setattr(run, "_load_gateway_config", lambda *a, **k: {"platform_toolsets": {"cli": []}})
    store = SessionStore(home / "sessions", GatewayConfig())
    store._db = SessionDB(db_path=home / "state.db")
    runner = SimpleNamespace(session_store=store, _session_db=store._db, adapters={}, _draining=False,
                             _evict_cached_agent=lambda route: None)
    runner._adapter_for_source = lambda source: runner.adapters.get(source.platform)
    authority = await initialize_session_authority(runner, profile_id="default", instance_id="fixture")
    authority._schedule = lambda ref: None
    actor = SessionActor("uid:1000", "default", frozenset({"session:create", "session:read", "session:submit",
                                                          "session:control"}), "native")

    def create(source, *, desktop_local, request_id, trusted_policy=None):
        from gateway.session_local import stage_local_session
        from gateway.session_local_recovery import restore_local_session
        from hermes_state_local import commit_local_session
        staged = stage_local_session(authority, actor, {"request_id": request_id, "source": source,
                                                        "cwd": str(tmp_path), "model": "fixture", "toolsets": []},
                                     trusted_policy=trusted_policy, client_local=True, desktop_local=desktop_local)
        commit_local_session(authority.db, epoch=authority.epoch, receipt=staged)
        return restore_local_session(authority, staged["session_id"]).session_id

    return SimpleNamespace(home=home, db=store._db, authority=authority, actor=actor, create=create, store=store)


@pytest_asyncio.fixture
async def owner(tmp_path, monkeypatch):
    o = await _owner(tmp_path, monkeypatch)
    yield o
    o.store._db.close()


# ── the grant matrix ─────────────────────────────────────────────────────────


@pytest.mark.asyncio
@pytest.mark.parametrize("source,desktop_local,title,granted", [
    ("gui", True, None, True),                  # a regular chat the local Desktop started
    ("gui", True, "Research thread", True),
    ("gui", True, "Bot Chat", True),
    ("gui", False, None, False),                # 'gui' from a connection the gateway did not prove local
    ("gui", False, "Research thread", False),
    ("gui", False, "Bot Chat", True),           # the canonical Bot Chat keeps its title grant
    ("tui", True, None, False),                 # a declared Desktop connection creating a TUI session
    ("cli", False, None, False),
    ("cli", False, "Bot Chat", True),           # `chat -c "Bot Chat"`: the bot-to-bot recipient
])
async def test_the_grant_follows_the_gateway_mark_not_the_client_source(owner, source, desktop_local, title, granted):
    sid = owner.create(source, desktop_local=desktop_local, request_id=f"{source}-{desktop_local}-{title}")
    if title:
        owner.db.set_session_title(sid, title)
    # The client-declared surface is irrelevant: every platform label gets the same answer.
    for platform in ("desktop", "gui", "tui", "cli"):
        agent = _Agent(owner.db, sid, platform)
        assert bot_mode_dm.message_agent_authorized(agent) is granted, (platform, source, title)
        assert bot_mode_dm.ensure_message_agent_tool(agent) is granted
        assert (TOOL in agent.valid_tool_names) is granted
        assert [t["function"]["name"] for t in agent.tools] == ([TOOL] if granted else [])


@pytest.mark.asyncio
async def test_an_unmanaged_install_never_grants_it(tmp_path, monkeypatch):
    o = await _owner(tmp_path, monkeypatch, managed=False)
    try:
        sid = o.create("gui", desktop_local=True, request_id="desk")
        agent = _Agent(o.db, sid)
        assert bot_mode_dm.local_desktop_chat_capability(agent) is True  # the capability exists...
        assert bot_mode_dm.message_agent_authorized(agent) is False      # ...but Bot Mode is off
        assert bot_mode_dm.ensure_message_agent_tool(agent) is False and agent.tools == []
        refused = json.loads(bot_mode_dm.message_agent_tool(target="researcher", message="hi", agent=agent))
        assert "not Bot-Mode-managed" in refused["error"]
    finally:
        o.store._db.close()


# ── fixed for the session's life ─────────────────────────────────────────────


@pytest.mark.asyncio
async def test_renaming_a_desktop_chat_keeps_the_tool_and_the_tool_list(owner):
    from tools.mcp_tool_agent import _reinject_authorized_dynamic_tools

    sid = owner.create("gui", desktop_local=True, request_id="desk")
    owner.db.set_session_title(sid, "Bot Chat")
    agent = _Agent(owner.db, sid)
    assert bot_mode_dm.ensure_message_agent_tool(agent) is True
    first = json.dumps(agent.tools, sort_keys=True)

    owner.db.set_session_title(sid, "Work room")
    assert bot_mode_dm.ensure_message_agent_tool(agent) is True
    assert json.dumps(agent.tools, sort_keys=True) == first  # byte-identical: the prompt cache holds
    # A registry rebuild (compaction, MCP refresh) re-gates the injected tool; it stays.
    staged, names = [], set()
    _reinject_authorized_dynamic_tools(agent, staged, names)
    assert TOOL in names and [t["function"]["name"] for t in staged] == [TOOL]
    # A fresh agent on the renamed session (cold resume) reads the same persisted grant.
    assert bot_mode_dm.message_agent_authorized(_Agent(owner.db, sid, "tui")) is True


@pytest.mark.asyncio
async def test_a_cold_resume_from_another_surface_neither_adds_nor_removes_it(owner):
    desk = owner.create("gui", desktop_local=True, request_id="desk")
    cli = owner.create("cli", desktop_local=False, request_id="cli")
    tui = owner.create("tui", desktop_local=False, request_id="tui")
    for platform in ("cli", "tui", "desktop"):
        assert bot_mode_dm.message_agent_authorized(_Agent(owner.db, desk, platform)) is True
        assert bot_mode_dm.message_agent_authorized(_Agent(owner.db, cli, platform)) is False
        assert bot_mode_dm.message_agent_authorized(_Agent(owner.db, tui, platform)) is False


@pytest.mark.asyncio
async def test_a_reset_segment_of_a_desktop_chat_keeps_the_grant(owner):
    from gateway.session_local_recovery import restore_local_session
    from gateway.session_mutations import mutate_session

    desk = owner.create("gui", desktop_local=True, request_id="desk")
    ref = restore_local_session(owner.authority, desk)
    row = owner.db.get_session(desk)
    reset = await mutate_session(owner.authority, owner.actor, ref, dict(
        session_id=desk, request_id="reset", expected_revision=row["runtime_revision"],
        expected_generation=row["runtime_generation"], operation="reset", payload={}))
    segment = reset["target_session_id"]
    assert segment != desk
    assert bot_mode_dm.message_agent_authorized(_Agent(owner.db, segment)) is True


# ── never for sessions the gateway did not issue it to ───────────────────────


@pytest.mark.asyncio
async def test_a_subagent_of_a_desktop_chat_never_gets_it(owner):
    desk = owner.create("gui", desktop_local=True, request_id="desk")
    child = "child-of-desk"
    owner.db.create_session(child, "subagent", parent_session_id=desk)
    owner.db._execute_write(lambda c: c.execute("UPDATE sessions SET chat_id=? WHERE id=?", (desk, child)))
    agent = _Agent(owner.db, child)
    assert bot_mode_dm.message_agent_authorized(agent) is False
    assert bot_mode_dm.ensure_message_agent_tool(agent) is False


@pytest.mark.asyncio
async def test_a_legacy_serve_session_claiming_desktop_never_gets_it(owner):
    """Legacy ``serve`` stores the client's ``source`` and builds the agent with it: no receipt, no grant."""
    owner.db.create_session("legacy-desk", "desktop")
    agent = _Agent(owner.db, "legacy-desk", "desktop")
    assert bot_mode_dm.message_agent_authorized(agent) is False
    refused = json.loads(bot_mode_dm.message_agent_tool(target="researcher", message="hi", agent=agent))
    assert "Bot Chat" in refused["error"] and "do not retry" in refused["error"]


@pytest.mark.asyncio
async def test_a_hosted_room_member_never_gets_it_even_from_a_declared_desktop(owner):
    """``session_hosted_rpc`` stages members as ``bot_room`` through a trusted policy: no owner mark."""
    from gateway.session_policy import build_policy
    policy = build_policy({"source": "gui", "cwd": str(owner.home), "model": "fixture", "toolsets": []}, {})
    room = owner.create("gui", desktop_local=True, request_id="room",
                        trusted_policy=replace(policy, source="bot_room", platform="bot_room"))
    assert bot_mode_dm.message_agent_authorized(_Agent(owner.db, room, "bot_room")) is False


@pytest.mark.parametrize("source", ["cli", "tui", "bot_room", "kanban", "cron", "a2a", "local", None])
def test_only_a_gui_policy_carries_the_capability(source):
    from gateway.session_policy import LOCAL_DESKTOP_CHAT, is_local_desktop_chat
    marked = {"source": source, "config_json": json.dumps({LOCAL_DESKTOP_CHAT: True}), "request_json": "{}"}
    assert is_local_desktop_chat(marked) is False
    assert is_local_desktop_chat({**marked, "source": "gui"}) is True
    # A mark an earlier build stamped into the creation request still counts.
    assert is_local_desktop_chat({"source": "gui", "config_json": "{}",
                                  "request_json": json.dumps({LOCAL_DESKTOP_CHAT: True})}) is True
    assert is_local_desktop_chat({"source": "gui", "config_json": "{}", "request_json": "{}"}) is False
    assert is_local_desktop_chat({"source": "gui", "config_json": None, "request_json": "[]"}) is False


def test_a_worker_store_answers_from_the_policy_it_was_handed():
    """A managed worker cannot read the owner's receipts: its store carries the frozen policy's mark for
    its one session; a delegated child's store never does."""
    from agent.runtime_session_child import ChildSessionStore
    from agent.runtime_session_store import RuntimeSessionStore

    store = object.__new__(RuntimeSessionStore)
    store.scope = {"session_id": "s1"}
    assert store.local_desktop_chat("s1") is False
    store.desktop_chat = True
    assert store.local_desktop_chat("s1") is True
    assert store.local_desktop_chat("other") is False
    child = object.__new__(ChildSessionStore)
    child.scope = {"session_id": "s1-child"}
    assert child.local_desktop_chat("s1-child") is False
    db = SimpleNamespace(local_desktop_chat=store.local_desktop_chat, db_path="unused/state.db")
    assert bot_mode_dm.local_desktop_chat_capability(_Agent(db, "s1")) is True
    assert bot_mode_dm.local_desktop_chat_capability(_Agent(db, "s2")) is False


def test_the_worker_bootstrap_stamps_the_store_from_the_frozen_policy():
    import inspect
    from agent import managed_worker
    source = inspect.getsource(managed_worker.execute)
    assert "store.desktop_chat = is_local_desktop_chat(policy)" in source
    assert source.index("store.desktop_chat") < source.index("_construct_agent(")


def test_an_unreadable_receipt_grants_nothing_and_is_not_cached():
    class _Broken:
        db_path = "unused/state.db"

        def _read_ctx(self):
            raise RuntimeError("db locked")

    agent = _Agent(_Broken(), "s1")
    assert bot_mode_dm.local_desktop_chat_capability(agent) is False
    assert not hasattr(agent, "_local_desktop_chat")


# ── dispatch: same predicate, then the ordinary roster path ──────────────────


@pytest.mark.asyncio
async def test_a_desktop_chat_dispatch_reaches_roster_validation(owner):
    desk = owner.create("gui", desktop_local=True, request_id="desk")
    owner.db.set_session_title(desk, "Research thread")
    result = json.loads(bot_mode_dm.message_agent_tool(target="nosuchbot", message="hi", agent=_Agent(owner.db, desk)))
    assert "Bot Chat" not in result["error"]  # past the gate
    assert result["teammates"] == ["researcher"]  # the roster check answered


@pytest.mark.asyncio
async def test_a_desktop_chat_dispatch_is_sent_as_that_chat(owner, monkeypatch):
    """A valid target goes to the ordinary transport with the calling chat as the sender: the reply
    wakes the session that asked (no Bot Chat assumption on the sending side)."""
    from tools import bot_mode_dm_chain

    desk = owner.create("gui", desktop_local=True, request_id="desk")
    agent = _Agent(owner.db, desk)
    sent = {}

    def fake_send_gated(targets, reply, body, compose, sender):
        sent.update(targets=targets, reply=reply, agent=sender.agent, task_id=sender.task_id, text=compose(reply))
        return json.dumps({"status": "queued"})

    monkeypatch.setattr(bot_mode_dm_chain, "send_gated", fake_send_gated)
    ack = json.loads(bot_mode_dm.message_agent_tool(target="researcher", message="check this", agent=agent,
                                                    task_id="turn-1"))
    assert ack == {"status": "queued"}
    assert sent["targets"] == ["researcher"] and sent["reply"] is True
    assert sent["agent"] is agent and sent["task_id"] == "turn-1"
    assert sent["text"].startswith("Message from ") and sent["text"].endswith("check this")


@pytest.mark.asyncio
async def test_a_forged_call_from_a_plain_chat_is_refused_at_dispatch(owner):
    plain = owner.create("gui", desktop_local=False, request_id="plain")
    result = json.loads(bot_mode_dm.message_agent_tool(target="researcher", message="hi", agent=_Agent(owner.db, plain)))
    assert "Bot Chat" in result["error"] and "teammates" not in result


# ── end to end: the creating connection decides, over the real RPC ───────────


@pytest.mark.asyncio
@pytest.mark.parametrize("native,declared,granted", [
    (True, True, True),     # the Desktop on this machine
    (True, False, False),   # a native ticket that never declared the Desktop (the CLI, the TUI)
    (False, True, False),   # a remote or dashboard credential that says it is the Desktop
])
async def test_only_a_proven_local_desktop_connection_issues_it(tmp_path, monkeypatch, native, declared, granted):
    from tests.gateway.test_local_desktop_identity import _connect, _request

    conn = await _connect(tmp_path, monkeypatch, native=native,
                          config="model:\n  provider: openrouter\n  default: anthropic/claude-sonnet-4\n")
    try:
        # Bot Mode on the install that owns the session store.
        bot = Path(conn.authority.db.db_path).parent / "profiles" / "researcher"
        bot.mkdir(parents=True)
        (bot / "profile.yaml").write_text("ui_meta:\n  hermes-bots:\n    shape: cloud\n", encoding="utf-8")
        await _request(conn, 1, "client.capabilities", {"server_requests": True, "desktop_local": declared})
        created = await _request(conn, 2, "session.create", {"source": "gui", "request_id": "a"})
        sid = created["result"]["stored_session_id"]
        agent = _Agent(conn.authority.db, sid)
        assert bot_mode_dm.message_agent_authorized(agent) is granted
        # The client cannot assert the mark itself: it is not a create field.
        spoof = await _request(conn, 3, "session.create", {"source": "gui", "request_id": "b", "desktop_local": True})
        assert "error" in spoof, spoof
    finally:
        await conn.connection.close()


def test_the_schema_is_unchanged_and_never_registered():
    from tools.registry import registry
    import toolsets
    assert TOOL not in getattr(registry, "_tools", {})
    assert all(TOOL not in names for names in toolsets.TOOLSETS.values())
