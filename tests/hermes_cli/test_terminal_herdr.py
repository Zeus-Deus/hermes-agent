"""The classic CLI tells Herdr how to reopen its pane (hermes_cli/terminal_herdr.py).

Plugin hooks run in the shared gateway, which has no ``HERDR_PANE_ID``, so Herdr's own Hermes
plugin never reports a session there and a Herdr restart reopened Hermes panes as plain shells.
These tests drive a fake ``herdr`` binary through ``HERDR_BIN_PATH`` and assert what it received.
"""

import json
import os
import stat
import sys
from pathlib import Path

import pytest

from hermes_cli import terminal_herdr
from tests.waiting import wait_until

pytestmark = pytest.mark.platforms("posix")  # the fake herdr is a POSIX script

PANE = "w1:p2"


@pytest.fixture
def herdr(tmp_path, monkeypatch):
    """A Herdr pane on a fake ``herdr``: its calls land in ``calls``; the first ``reject`` calls
    answer ``resume_not_accepted`` as Herdr does before it has detected Hermes in the pane."""
    log = tmp_path / "herdr-calls.jsonl"
    script = tmp_path / "herdr"
    script.write_text(
        f"#!{sys.executable}\n"
        "import json, os, sys\n"
        f"log = {str(log)!r}\n"
        "with open(log, 'a') as f:\n"
        "    f.write(json.dumps(sys.argv[1:]) + '\\n')\n"
        "calls = sum(1 for _ in open(log))\n"
        "if calls <= int(os.environ.get('FAKE_HERDR_REJECT', '0')):\n"
        "    sys.stderr.write('{\"error\":{\"code\":\"resume_not_accepted\"}}\\n')\n"
        "    sys.exit(1)\n"
    )
    script.chmod(script.stat().st_mode | stat.S_IXUSR)
    monkeypatch.setenv("HERDR_ENV", "1")
    monkeypatch.setenv("HERDR_PANE_ID", PANE)
    monkeypatch.setenv("HERDR_BIN_PATH", str(script))
    monkeypatch.setattr(terminal_herdr.os, "isatty", lambda fd: True)
    for name in ("_pending", "_accepted", "_worker"):
        monkeypatch.setattr(terminal_herdr, name, None)

    class Herdr:
        @staticmethod
        def calls():
            return [json.loads(line) for line in log.read_text().splitlines()] if log.exists() else []

        @staticmethod
        def settled():
            with terminal_herdr._lock:
                return terminal_herdr._worker is None

    yield Herdr
    wait_until(Herdr.settled, timeout=15, what="the report thread to finish")


@pytest.fixture
def coder_profile(tmp_path, monkeypatch):
    home = tmp_path / ".hermes" / "profiles" / "coder"
    home.mkdir(parents=True)
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    monkeypatch.setenv("HERMES_HOME", str(home))
    return home


def _resume_command(call):
    return call[call.index("--") + 1:]


def test_reports_the_profile_resume_command_to_the_pane(herdr, coder_profile):
    terminal_herdr.report_session("sess-1")
    wait_until(herdr.settled, timeout=15)

    [call] = herdr.calls()
    assert call[:4] == ["pane", "report-agent-session", PANE, "--source"]
    assert call[4:8] == ["hermes", "--agent", "hermes", "--seq"]
    assert call[8].isdigit()
    assert call[9:11] == ["--agent-session-id", "sess-1"]
    assert _resume_command(call) == ["hp", "hermes", "-p", "coder", "--cli", "--resume", "sess-1"]


def test_retries_until_herdr_sees_hermes_then_reports_each_session_once(herdr, coder_profile, monkeypatch):
    monkeypatch.setenv("FAKE_HERDR_REJECT", "2")
    terminal_herdr.report_session("sess-1")
    wait_until(herdr.settled, timeout=15)
    assert [_resume_command(c)[-1] for c in herdr.calls()] == ["sess-1"] * 3

    terminal_herdr.report_session("sess-1")  # every turn reports; an accepted session is not resent
    terminal_herdr.report_session("sess-2")  # /new, /resume or compression moved the pane on
    wait_until(herdr.settled, timeout=15)
    assert [_resume_command(c)[-1] for c in herdr.calls()] == ["sess-1"] * 3 + ["sess-2"]


def test_default_profile_is_named_so_a_sticky_profile_cannot_move_the_pane(herdr, tmp_path, monkeypatch):
    home = tmp_path / ".hermes"
    home.mkdir()
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    monkeypatch.setenv("HERMES_HOME", str(home))
    terminal_herdr.report_session("sess-1")
    wait_until(herdr.settled, timeout=15)
    assert _resume_command(herdr.calls()[0]) == ["hp", "hermes", "-p", "default", "--cli", "--resume", "sess-1"]


@pytest.mark.parametrize("case", ["outside_herdr", "no_terminal", "custom_home"])
def test_nothing_is_reported_where_no_pane_can_reopen_it(herdr, coder_profile, tmp_path, monkeypatch, case):
    if case == "outside_herdr":
        monkeypatch.delenv("HERDR_ENV")
    elif case == "no_terminal":  # `hermes -q` from a script or another agent in the pane
        monkeypatch.setattr(terminal_herdr.os, "isatty", lambda fd: False)
    else:  # a HERMES_HOME that is no profile: no `-p` name selects it again
        custom = tmp_path / ".hermes" / "scratch-home"
        custom.mkdir()
        monkeypatch.setenv("HERMES_HOME", str(custom))
    terminal_herdr.report_session("sess-1")
    assert herdr.settled() and herdr.calls() == []


def test_cli_resume_command_moves_the_pane_to_the_resumed_session(herdr, coder_profile):
    from unittest.mock import MagicMock, patch

    from cli import HermesCLI

    cli = HermesCLI.__new__(HermesCLI)
    cli.session_id, cli._resumed, cli._pending_title = "current", False, None
    cli.conversation_history, cli.agent, cli._pending_resume_sessions = [], None, None
    cli.resume_display = "minimal"
    cli._session_db = MagicMock()
    cli._session_db.get_session.return_value = {"id": "older", "title": "Research"}
    history = [{"role": "user", "content": "hello"}, {"role": "assistant", "content": "hi"}]
    cli._session_db.get_resume_conversations.return_value = history, history
    cli._session_db.resolve_resume_session_id.return_value = "older"
    with patch("hermes_cli.main._resolve_session_by_name_or_id", return_value="older"), patch("cli._cprint"):
        cli._handle_resume_command("/resume older")

    wait_until(herdr.settled, timeout=15)
    assert cli.session_id == "older"
    assert [_resume_command(c) for c in herdr.calls()] == [["hp", "hermes", "-p", "coder", "--cli", "--resume", "older"]]


def test_a_stopped_herdr_never_reaches_the_caller(herdr, coder_profile, monkeypatch):
    monkeypatch.setenv("HERDR_BIN_PATH", os.fspath(Path(os.environ["HERDR_BIN_PATH"]).with_name("missing")))
    terminal_herdr.report_session("sess-1")
    wait_until(herdr.settled, timeout=15)
    assert herdr.calls() == []
