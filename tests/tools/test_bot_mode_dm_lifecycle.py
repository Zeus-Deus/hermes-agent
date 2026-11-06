"""A ``message_agent`` delivery must not depend on the process or session that sent it.

* The runner outlives the sender's agent close: a fast sender's turn-end sweep, or a Desktop/TUI
  session the client closes, used to SIGTERM it (``agent_close``) while the teammate was still
  answering, so the reply never came back (#130559, #134898).
* The runner boots on the install's current interpreter: after ``hermes update`` swaps the store
  Python, a long-running host still reports the deleted one as ``sys.executable``, and every
  runner, fan-out runner and relay reply waiter built from it exited 127 (#144658).
"""

from __future__ import annotations

import json
import shlex
import subprocess
import sys
from pathlib import Path

import pytest

from tools import bot_mode_dm


@pytest.fixture()
def registry():
    from tools.process_registry import process_registry

    saved = dict(process_registry._running), dict(process_registry._finished)
    yield process_registry
    for proc_id in list(process_registry._running):
        if proc_id not in saved[0]:
            process_registry.kill_process(proc_id, source="test_cleanup")
    process_registry._running.clear()
    process_registry._finished.clear()
    process_registry._running.update(saved[0])
    process_registry._finished.update(saved[1])


def _close_sender_agent(task_id: str) -> None:
    """The sender's real agent close (``AIAgent.close`` → ``_close_task_resources``): its
    owned-process sweep is what killed the runner (``termination_source=agent_close``)."""
    from agent.client_lifecycle import ClientLifecycleMixin

    class _Sender(ClientLifecycleMixin):
        _process_owner_task_ids = {task_id}

    _Sender()._close_task_resources(task_id)


def test_the_delivery_runner_outlives_the_senders_agent_close(tmp_path, registry):
    """The real runner spawn (``_spawn_delivery`` → ``terminal_tool`` → process registry), then
    the sender's real agent close while the teammate is still answering: the runner keeps
    running and exits with the reply, instead of being SIGTERMed with nothing delivered."""
    runner = tmp_path / "runner.py"
    marker = tmp_path / "go"
    runner.write_text(
        "import json, os, sys, time\n"
        f"while not os.path.exists({str(marker)!r}):\n"
        "    time.sleep(0.05)\n"
        "print(json.dumps({'status': 'settled', 'reply': 'done'}))\n",
        encoding="utf-8",
    )
    task_id = "sender-turn-130559"
    ack = json.loads(bot_mode_dm._spawn_delivery(
        shlex.join([sys.executable, str(runner)]), "@researcher", delivery_id="a" * 64,
        task_id=task_id, agent=None))
    assert ack.get("status") == "queued" and ack.get("process_id"), ack
    proc = registry.get(ack["process_id"])
    assert proc is not None and proc.owner_task_id == task_id

    _close_sender_agent(task_id)
    # Still running a second later; on main the sweep had already SIGTERMed it (-15, agent_close).
    still = registry.wait(ack["process_id"], timeout=1)
    assert still["status"] == "timeout" and not proc.exited, (still, proc.exit_code, proc.termination_source)

    marker.write_text("", encoding="utf-8")  # the teammate answers after the sender closed
    finished = registry.wait(ack["process_id"], timeout=30)
    assert finished["status"] == "exited" and finished.get("exit_code") == 0, finished
    assert '"reply": "done"' in finished["output"], finished


@pytest.fixture()
def updated_store(tmp_path, monkeypatch):
    """``hermes update`` swapped the store Python: PM's facts name the new entry, and this
    long-running process's ``sys.executable`` is the deleted previous one."""
    runtime = tmp_path / "runtime"
    fresh = runtime / "python-3.99.1" / "bin" / "python3"
    fresh.parent.mkdir(parents=True)
    fresh.symlink_to(sys.executable)
    (runtime / "facts.json").write_text(json.dumps({"packages": {"python": {"entry": "python-3.99.1"}}}),
                                        encoding="utf-8")
    monkeypatch.setenv("HERMES_RUNTIME_DIR", str(runtime))
    stale = runtime / ".previous-python-3.99.0" / "bin" / "python3"
    monkeypatch.setattr(sys, "executable", str(stale))
    assert not stale.exists()
    return fresh


def test_every_runner_command_boots_on_the_current_store_python(tmp_path, monkeypatch, updated_store):
    from tools import bot_relay
    from tools import bot_mode_dm_coordination as coordination

    dm_file = tmp_path / "dm.txt"
    dm_file.write_text("ping", encoding="utf-8")
    local = bot_mode_dm._delivery_command(["hermes", "-p", "researcher"], str(dm_file), stdin_file=False)
    waiter = bot_relay.waiter_command(tmp_path, {"id": "e" * 32, "target_handle": "bob",
                                                 "target_connection": "laptop"})
    spawned = []
    monkeypatch.setattr(bot_mode_dm, "_dm_dir", lambda: tmp_path)
    monkeypatch.setattr(bot_mode_dm, "_spawn_delivery", lambda command, label, **kw: (
        spawned.append(command) or json.dumps({"status": "queued", "process_id": "proc_x"})))
    sender = type("S", (), {"task_id": None, "agent": None})()
    coordination._start_combined([{"command": local, "label": "@researcher", "dm_file": None,
                                   "delivery_id": "d" * 64}], sender)

    for command in (local, waiter, *spawned):
        assert shlex.split(command)[0] == str(updated_store), command


def test_a_relay_reply_waiter_built_after_the_update_runs(tmp_path, updated_store):
    """The real waiter command, run the way the tracked local backend runs it (bash): before the
    fix bash could not find the deleted interpreter and exited 127, so the reply never woke the
    sender."""
    from tools import bot_relay

    envelope = {"id": "f" * 32, "target_handle": "bob", "target_connection": "laptop"}
    reply = Path(bot_relay.relay_root(tmp_path)) / bot_relay.REPLIES_DIR / f"{envelope['id']}.json"
    reply.parent.mkdir(parents=True, exist_ok=True)
    reply.write_text(json.dumps({"reply": "hi from bob"}), encoding="utf-8")
    argv = shlex.split(bot_relay.waiter_command(tmp_path, envelope))
    argv[-1] = "5"  # budget
    done = subprocess.run(["bash", "-c", shlex.join(argv)], capture_output=True, text=True, timeout=60,
                          check=False)
    assert done.returncode == 0, (done.returncode, done.stderr)
    assert "hi from bob" in done.stdout


def test_a_developer_install_without_a_store_keeps_its_own_interpreter(tmp_path, monkeypatch):
    from tools import bot_relay

    monkeypatch.setenv("HERMES_RUNTIME_DIR", str(tmp_path / "no-store"))
    assert bot_relay.runner_python() == sys.executable


def test_a_developer_venv_keeps_its_interpreter_even_with_a_store_present(tmp_path, monkeypatch, updated_store):
    """A host on its own (developer) venv owns its dependencies: a store on the machine must not
    swap in a bare store Python that cannot boot a checkout with no committed environment, even
    when the venv was created from that store Python. The real waiter command runs on the venv."""
    from tools import bot_relay

    venv_python = tmp_path / "venv" / "bin" / "python3"
    venv_python.parent.mkdir(parents=True)
    venv_python.symlink_to(updated_store)  # a venv's python links to its base: here the store's
    monkeypatch.setattr(sys, "executable", str(venv_python))
    assert bot_relay.runner_python() == str(venv_python)

    envelope = {"id": "b" * 32, "target_handle": "bob", "target_connection": "laptop"}
    reply = Path(bot_relay.relay_root(tmp_path)) / bot_relay.REPLIES_DIR / f"{envelope['id']}.json"
    reply.parent.mkdir(parents=True, exist_ok=True)
    reply.write_text(json.dumps({"reply": "hi from bob"}), encoding="utf-8")
    argv = shlex.split(bot_relay.waiter_command(tmp_path, envelope))
    assert argv[0] == str(venv_python)
    argv[-1] = "5"  # budget
    done = subprocess.run(["bash", "-c", shlex.join(argv)], capture_output=True, text=True, timeout=60,
                          check=False)
    assert done.returncode == 0 and "hi from bob" in done.stdout, (done.returncode, done.stderr)


def test_a_host_on_a_retired_but_present_store_entry_moves_to_the_current_one(monkeypatch, updated_store):
    """The previous store entry may linger until GC: a host on it still moves to the entry PM names."""
    from tools import bot_relay

    retired = Path(sys.executable)
    retired.parent.mkdir(parents=True)
    retired.symlink_to(Path(updated_store).resolve())
    assert retired.exists()
    assert bot_relay.runner_python() == str(updated_store)
