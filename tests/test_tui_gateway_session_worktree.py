"""Integration coverage for the session-scoped worktree gateway RPC."""

from __future__ import annotations

import contextlib
import os
import subprocess
import threading
from pathlib import Path

import pytest

from tui_gateway import server


def _git(cwd: Path, *args: str) -> str:
    result = subprocess.run(
        ["git", *args],
        cwd=cwd,
        check=True,
        capture_output=True,
        text=True,
        encoding="utf-8",
    )
    return result.stdout.strip()


def _repo(path: Path) -> Path:
    path.mkdir()
    _git(path, "init", "-b", "main")
    _git(
        path,
        "-c",
        "user.email=test@example.invalid",
        "-c",
        "user.name=Test",
        "commit",
        "--allow-empty",
        "-m",
        "initial",
    )
    return path


def _add_tree(repo: Path, name: str) -> Path:
    target = repo / ".worktrees" / name
    target.parent.mkdir(exist_ok=True)
    _git(repo, "worktree", "add", "-b", f"test/{name}", str(target))
    return target


@pytest.fixture(autouse=True)
def _isolated_sessions(monkeypatch):
    previous = dict(server._sessions)
    server._sessions.clear()
    # Keep the integration tests focused on the runtime cwd transition rather
    # than background DB/git-metadata persistence owned by _set_session_cwd.
    monkeypatch.setattr(server, "_register_session_cwd", lambda _session: None)
    monkeypatch.setattr(
        server,
        "_persist_session_cwd_and_schedule_git_meta",
        lambda *_args, **_kwargs: None,
    )
    yield
    server._sessions.clear()
    server._sessions.update(previous)


def _call(rid: str, **params) -> dict:
    response = server.handle_request({
        "id": rid,
        "method": "session.worktree",
        "params": params,
    })
    assert isinstance(response, dict)
    return response


def test_nonlocal_terminal_backend_is_rejected_before_git_mutation(
    monkeypatch, tmp_path
):
    repo = _repo(tmp_path / "repo")
    server._sessions["sid"] = {
        "session_key": "stored",
        "cwd": str(repo),
        "running": False,
    }
    monkeypatch.setattr(server, "_effective_terminal_backend", lambda: "ssh")

    response = _call("remote", session_id="sid", action="new", name="must-not-exist")

    assert response["error"]["code"] == 4028
    assert "local" in response["error"]["message"].lower()
    assert not (repo / ".worktrees" / "must-not-exist").exists()


def test_compute_host_session_is_rejected_before_git_mutation(monkeypatch, tmp_path):
    repo = _repo(tmp_path / "repo")
    server._sessions["sid"] = {
        "session_key": "stored",
        "cwd": str(repo),
        "running": False,
    }
    monkeypatch.setattr(server, "_session_uses_compute_host", lambda _session: True)

    response = _call("compute", session_id="sid", action="new", name="must-not-exist")

    assert response["error"]["code"] == 4028
    assert "local" in response["error"]["message"].lower()
    assert not (repo / ".worktrees" / "must-not-exist").exists()


def test_status_and_list_are_derived_from_live_session_cwd_not_gateway_cwd(
    monkeypatch, tmp_path
):
    repo_a = _repo(tmp_path / "repo-a")
    repo_b = _repo(tmp_path / "repo-b")
    tree_a = _add_tree(repo_a, "lane-a")
    tree_b = _add_tree(repo_b, "lane-b")
    nested = tree_a / "nested"
    nested.mkdir()
    server._sessions["sid"] = {
        "session_key": "stored",
        "cwd": str(nested),
        "running": False,
        "agent": None,
    }
    monkeypatch.chdir(repo_b)

    status = _call("status", session_id="sid", action="status")
    listed = _call("list", session_id="sid", action="list")

    assert status["result"]["cwd"] == str(nested)
    assert status["result"]["repo_root"] == str(repo_a)
    assert status["result"]["worktree"]["path"] == str(tree_a)
    paths = {tree["path"] for tree in listed["result"]["worktrees"]}
    assert str(repo_a) in paths
    assert str(tree_a) in paths
    assert str(repo_b) not in paths
    assert str(tree_b) not in paths


def test_new_creates_in_session_repo_moves_session_and_emits_info(
    monkeypatch, tmp_path
):
    repo_a = _repo(tmp_path / "repo-a")
    repo_b = _repo(tmp_path / "repo-b")
    session = {
        "session_key": "stored",
        "cwd": str(repo_a),
        "running": False,
        "agent": None,
    }
    server._sessions["sid"] = session
    monkeypatch.chdir(repo_b)
    emitted = []
    monkeypatch.setattr(server, "_emit", lambda *args: emitted.append(args))

    response = _call("new", session_id="sid", action="new", name="Feature Lane")

    result = response["result"]
    created = Path(result["worktree"]["path"])
    assert created == repo_a / ".worktrees" / "feature-lane"
    assert created.is_dir()
    assert result["worktree"]["branch"] == "hermes/feature-lane"
    assert result["repo_root"] == str(repo_a)
    assert result["cwd"] == str(created)
    assert session["cwd"] == str(created)
    assert session["explicit_cwd"] is True
    assert emitted and emitted[-1][0:2] == ("session.info", "sid")
    assert emitted[-1][2]["cwd"] == str(created)
    assert _git(repo_b, "worktree", "list", "--porcelain").count("worktree ") == 1


def test_busy_new_rejects_before_creating_anything(tmp_path):
    repo = _repo(tmp_path / "repo")
    server._sessions["sid"] = {
        "session_key": "stored",
        "cwd": str(repo),
        "running": True,
        "agent": None,
    }

    response = _call("busy", session_id="sid", action="new", name="must-not-exist")

    assert response["error"]["code"] == 4009
    assert "busy" in response["error"]["message"]
    assert not (repo / ".worktrees").exists()
    assert _git(repo, "branch", "--list", "hermes/must-not-exist") == ""


def test_new_rejects_worktrees_symlink_that_escapes_repository(tmp_path):
    repo = _repo(tmp_path / "repo")
    external = tmp_path / "external"
    external.mkdir()
    try:
        (repo / ".worktrees").symlink_to(external, target_is_directory=True)
    except OSError as exc:
        pytest.skip(f"directory symlinks unavailable: {exc}")
    server._sessions["sid"] = {
        "session_key": "stored",
        "cwd": str(repo),
        "running": False,
    }

    response = _call(
        "escape-link", session_id="sid", action="new", name="must-not-escape"
    )

    assert response["error"]["code"] == -32602
    assert "escapes" in response["error"]["message"].lower()
    assert not (external / "must-not-escape").exists()
    assert _git(repo, "branch", "--list", "hermes/must-not-escape") == ""


@pytest.mark.parametrize(
    "name", ["", "!!!", "../escape", "ok/../../escape", "/tmp/escape"]
)
def test_new_rejects_empty_sanitized_or_traversing_names(tmp_path, name):
    repo = _repo(tmp_path / "repo")
    server._sessions["sid"] = {
        "session_key": "stored",
        "cwd": str(repo),
        "running": False,
        "agent": None,
    }

    response = _call("invalid", session_id="sid", action="new", name=name)

    assert response["error"]["code"] == -32602
    assert not (repo / ".worktrees").exists()


def test_new_requires_existing_git_repo_and_never_initializes_plain_directory(tmp_path):
    plain = tmp_path / "plain"
    plain.mkdir()
    server._sessions["sid"] = {
        "session_key": "stored",
        "cwd": str(plain),
        "running": False,
        "agent": None,
    }

    response = _call("not-git", session_id="sid", action="new")

    assert response["error"]["code"] == 4028
    assert "git repository" in response["error"]["message"].lower()
    assert not (plain / ".git").exists()
    assert not (plain / ".worktrees").exists()


def test_new_rolls_back_checkout_and_branch_when_session_move_fails(
    monkeypatch, tmp_path
):
    repo = _repo(tmp_path / "repo")
    session = {
        "session_key": "stored",
        "cwd": str(repo),
        "running": False,
        "agent": None,
    }
    server._sessions["sid"] = session
    monkeypatch.setattr(
        server,
        "_set_session_cwd",
        lambda *_args: (_ for _ in ()).throw(RuntimeError("persist failed")),
    )

    response = _call("rollback", session_id="sid", action="new", name="rollback-me")

    assert response["error"]["code"] == 5008
    assert "move failed" in response["error"]["message"]
    assert session["cwd"] == str(repo)
    assert not (repo / ".worktrees" / "rollback-me").exists()
    assert _git(repo, "branch", "--list", "hermes/rollback-me") == ""


def test_new_fails_before_creation_when_owner_db_is_unavailable(monkeypatch, tmp_path):
    repo = _repo(tmp_path / "repo")

    @contextlib.contextmanager
    def unavailable_db(_session):
        yield None

    monkeypatch.setattr(server, "_session_db", unavailable_db)
    server._sessions["sid"] = {
        "session_key": "stored",
        "cwd": str(repo),
        "running": False,
    }

    response = _call(
        "new-db-unavailable",
        session_id="sid",
        action="new",
        name="must-not-exist",
    )

    assert response["error"]["code"] == 4028
    assert "database" in response["error"]["message"].lower()
    assert not (repo / ".worktrees" / "must-not-exist").exists()


def test_new_rolls_back_when_durable_cwd_does_not_persist(monkeypatch, tmp_path):
    repo = _repo(tmp_path / "repo")
    session = {
        "session_key": "stored",
        "cwd": str(repo),
        "running": False,
        "agent": None,
    }
    server._sessions["sid"] = session

    class StaleDB:
        def get_session(self, _session_key):
            return {"cwd": str(repo)}

        def update_session_cwd(self, *_args, **_kwargs):
            return None

    @contextlib.contextmanager
    def stale_session_db(_session):
        yield StaleDB()

    monkeypatch.setattr(server, "_session_db", stale_session_db)

    response = _call("durable", session_id="sid", action="new", name="persist-me")

    assert response["error"]["code"] == 5008
    assert "persist" in response["error"]["message"]
    assert session["cwd"] == str(repo)
    assert not (repo / ".worktrees" / "persist-me").exists()
    assert _git(repo, "branch", "--list", "hermes/persist-me") == ""


def test_new_rollback_preserves_a_preexisting_branch(monkeypatch, tmp_path):
    repo = _repo(tmp_path / "repo")
    _git(repo, "branch", "hermes/reuse-me")
    original_tip = _git(repo, "rev-parse", "hermes/reuse-me")
    session = {
        "session_key": "stored",
        "cwd": str(repo),
        "running": False,
    }
    server._sessions["sid"] = session

    class StaleDb:
        def get_session(self, _key):
            return {"cwd": str(repo)}

        def update_session_cwd(self, _key, _cwd):
            return None

    @contextlib.contextmanager
    def stale_db(_session):
        yield StaleDb()

    monkeypatch.setattr(server, "_session_db", stale_db)

    response = _call(
        "new-existing-branch",
        session_id="sid",
        action="new",
        name="reuse-me",
    )

    assert response["error"]["code"] == 5008
    assert _git(repo, "rev-parse", "hermes/reuse-me") == original_tip
    assert not (repo / ".worktrees" / "reuse-me").exists()


def test_workspace_reconciliation_waits_for_worktree_mutation_lock(monkeypatch):
    applied = threading.Event()
    settled = threading.Event()
    moved = threading.Event()
    monkeypatch.setattr(
        server,
        "_apply_project_workspace_locked",
        lambda *_args: applied.set(),
    )
    monkeypatch.setattr(
        server,
        "_reconcile_session_cwd_from_terminal_locked",
        lambda *_args: settled.set() or True,
    )

    def run_move():
        server.handle_request({
            "id": "move",
            "method": "session.workspace.move",
            "params": {},
        })
        moved.set()

    server._session_worktree_lock.acquire()
    try:
        apply_thread = threading.Thread(
            target=server._apply_project_workspace, args=("sid", "/tmp")
        )
        settle_thread = threading.Thread(
            target=server._reconcile_session_cwd_from_terminal, args=({},)
        )
        move_thread = threading.Thread(target=run_move)
        apply_thread.start()
        settle_thread.start()
        move_thread.start()
        assert not applied.wait(0.05)
        assert not settled.wait(0.05)
        assert not moved.wait(0.05)
    finally:
        server._session_worktree_lock.release()

    apply_thread.join(timeout=1)
    settle_thread.join(timeout=1)
    move_thread.join(timeout=1)
    assert applied.is_set()
    assert settled.is_set()
    assert moved.is_set()


def test_prompt_submit_refuses_a_reserved_workspace(tmp_path):
    repo = _repo(tmp_path / "repo")
    server._sessions["sid"] = {
        "session_key": "stored",
        "cwd": str(repo),
        "running": False,
        "agent": None,
        "history": [],
        "history_lock": threading.RLock(),
        "_workspace_mutating": True,
    }

    response = server.handle_request({
        "id": "prompt",
        "method": "prompt.submit",
        "params": {"session_id": "sid", "text": "do not race"},
    })

    assert response["error"]["code"] == 4009
    assert "workspace operation" in response["error"]["message"]
    assert server._sessions["sid"]["running"] is False


def test_prune_refuses_while_any_live_session_is_running(tmp_path):
    repo = _repo(tmp_path / "repo")
    stale = _add_tree(repo, "stale")
    server._sessions.update({
        "caller": {"session_key": "caller", "cwd": str(repo), "running": False},
        "runner": {"session_key": "runner", "cwd": str(repo), "running": True},
    })

    response = _call("prune-busy", session_id="caller", action="prune")

    assert response["error"]["code"] == 4009
    assert stale.exists()


def test_prune_dry_run_and_real_run_protect_all_live_session_worktrees(tmp_path):
    repo = _repo(tmp_path / "repo")
    caller_tree = _add_tree(repo, "caller")
    sibling_tree = _add_tree(repo, "sibling")
    unused_tree = _add_tree(repo, "unused")
    caller_nested = caller_tree / "nested"
    caller_nested.mkdir()
    sibling_nested = sibling_tree / "nested"
    sibling_nested.mkdir()
    server._sessions.update({
        "caller": {
            "session_key": "caller-key",
            "cwd": str(caller_nested),
            "running": False,
            "agent": None,
        },
        "sibling": {
            "session_key": "sibling-key",
            "cwd": str(sibling_nested),
            "running": False,
            "agent": None,
        },
    })

    preview = _call("preview", session_id="caller", action="prune", dry_run=True)

    planned = preview["result"]
    assert planned["dry_run"] is True
    assert caller_tree.is_dir() and sibling_tree.is_dir() and unused_tree.is_dir()
    assert str(caller_tree) in planned["protected"]
    assert str(sibling_tree) in planned["protected"]
    assert any("unused" in action for action in planned["actions"])
    assert all(
        "caller" not in action and "sibling" not in action
        for action in planned["actions"]
    )

    pruned = _call("prune", session_id="caller", action="prune", dry_run=False)

    assert pruned["result"]["dry_run"] is False
    assert caller_tree.is_dir()
    assert sibling_tree.is_dir()
    assert not unused_tree.exists()
    assert any("unused" in action for action in pruned["result"]["actions"])
