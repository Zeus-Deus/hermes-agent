"""Real classic CLI: complete a loop's skill, run its tool, and reject a mistyped interval.

Only the model is scripted; input, menus, slash routing, skill loading, scheduling,
terminal tool execution and persistence run in a credential-free child on a real PTY.
"""

import json
import sqlite3

import pytest

from tests.fakes.fake_llm_provider import FakeLLMServer, Text, ToolCall, write_hermes_home

pytestmark = [pytest.mark.platforms("linux"), pytest.mark.live_system_guard_bypass]


@pytest.fixture
def loop_cli(tmp_path):
    from tests.e2e.core.terminal._pty import PtyHermes

    config = (
        "updates:\n  check: false\n"
        "auxiliary:\n  title_generation:\n    enabled: false\n"
        "memory:\n  memory_enabled: false\n  user_profile_enabled: false\n"
        "loops:\n  min_interval_seconds: 5\n"
    )
    responses = [
        ToolCall("terminal", {"command": "printf 'loop skill executed\\n' >> loop-proof.txt"}),
        Text("LOOP_SKILL_EXECUTED"),
    ] * 2
    with FakeLLMServer(responses) as llm:
        home = write_hermes_home(tmp_path / "home" / ".hermes", llm.base_url, extra_config=config)
        skill = home / "skills" / "loop-proof" / "SKILL.md"
        skill.parent.mkdir(parents=True)
        skill.write_text(
            "---\nname: loop-proof\ndescription: Loop proof skill\n---\n\n"
            "LOOP_SKILL_SENTINEL: Check the build and report the result.\n",
            encoding="utf-8",
        )
        term = PtyHermes(tmp_path, ["chat", "--cli", "--yolo"], None, rows=50, cols=120)
        try:
            term.wait_ready()
            yield term, llm
        finally:
            print("--- final CLI frame ---\n" + term.dump())
            term.close()


def _loop_states(term):
    with sqlite3.connect(f"file:{term.hermes_home / 'state.db'}?mode=ro", uri=True) as db:
        return [json.loads(row[0]) for row in db.execute("SELECT value FROM state_meta WHERE key LIKE 'loop:%'")]


def test_tab_completed_loop_skill_executes_and_persists(loop_cli):
    from tests.e2e.core.terminal._pty import poll

    term, llm = loop_cli
    term.write("/loop 5m /loop-pr")
    term.wait_for_text("Loop proof skill", timeout=12)
    print("--- completion menu ---\n" + term.dump())
    term.write("\t")
    term.wait_for_text("/loop 5m /loop-proof", timeout=12)
    term.submit(" --times 1")
    llm.wait_for_requests(2, timeout=60)
    term.wait_for_text("LOOP_SKILL_EXECUTED", timeout=60)
    term.wait_turns_persisted(1)
    proof = term.root / "work" / "loop-proof.txt"
    poll(proof.exists, timeout=10, what="the loop skill's real terminal-tool output")
    assert proof.read_text() == "loop skill executed\n"
    first_request = llm.main_requests()[0]
    assert "LOOP_SKILL_SENTINEL" in json.dumps(first_request["messages"])
    states = _loop_states(term)
    assert len(states) == 1
    assert states[0]["prompt"] == "/loop-proof"
    assert states[0]["mode"] == "interval"
    assert states[0]["interval_seconds"] == 300
    assert states[0]["ticks_fired"] == 1
    assert states[0]["status"] == "done"
    assert term.exit() == 0
    assert not term.leftover_processes()


def test_completed_proactive_skill_repeats_and_stops_at_its_cap(loop_cli):
    from tests.e2e.core.terminal._pty import poll

    term, llm = loop_cli
    term.write("/proactive every 5s /loop-pr")
    term.wait_for_text("Loop proof skill", timeout=12)
    term.write("\t")
    term.wait_for_text("/proactive every 5s /loop-proof", timeout=12)
    term.submit(" --times 2")
    llm.wait_for_requests(4, timeout=60)
    poll(lambda: _loop_states(term)[0]["status"] == "done", timeout=15, what="two completed loop ticks")
    proof = term.root / "work" / "loop-proof.txt"
    assert proof.read_text() == "loop skill executed\n" * 2
    states = _loop_states(term)
    assert states[0]["ticks_fired"] == 2
    assert states[0]["interval_seconds"] == 5
    assert len(llm.main_requests()) == 4
    assert term.exit() == 0
    assert not term.leftover_processes()


def test_mistyped_interval_is_visible_and_does_not_schedule(loop_cli):
    term, llm = loop_cli
    term.submit("/loop 5m, /loop-proof")
    term.wait_for_text("remove the comma after the interval", timeout=12)
    term.submit("/loop status")
    term.wait_for_text("No loop set.", timeout=12)
    assert not _loop_states(term)
    assert not llm.main_requests()
    assert term.exit() == 0
    assert not term.leftover_processes()
