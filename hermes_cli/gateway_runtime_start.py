"""One detached-process primitive; callers must first prove owner/service absence."""
from __future__ import annotations

import os
from pathlib import Path
import subprocess
import sys

from hermes_cli._subprocess_compat import windows_detach_popen_kwargs, _WINDOWS_GATEWAY_BREAKAWAY_ENV
from hermes_cli.gateway_launchd_runtime import GatewayJob, start_gateway_job
from hermes_cli.gateway_runtime_service import RuntimeStartError, remaining


# One launch's policy and pins, never the shared daemon's: hook consent would become daemon-lifetime
# auto-approval for messaging/cron, and a Kanban worker's or terminal's pins would retarget every later
# session's board, cwd and source. The behaviour values main's CLI read per process (ephemeral prompt,
# prefill file, provider request, project plugins) ride each session's ``client_env`` instead
# (agent.session_client_env); an operator-started gateway keeps its own environment.
DAEMON_STRIPPED_ENV = (
    "HERMES_PROFILE", "HERMES_YOLO_MODE", "HERMES_IGNORE_RULES", "HERMES_SAFE_MODE",
    "HERMES_IGNORE_USER_CONFIG", "HERMES_ACCEPT_HOOKS", "HERMES_SESSION_SOURCE", "TERMINAL_CWD",
    "HERMES_KANBAN_TASK", "HERMES_KANBAN_WORKSPACE", "HERMES_KANBAN_BRANCH", "HERMES_KANBAN_RUN_ID",
    "HERMES_KANBAN_CLAIM_LOCK", "HERMES_KANBAN_CLAIM_TTL_SECONDS", "HERMES_KANBAN_GOAL_MODE",
    "HERMES_KANBAN_GOAL_MAX_TURNS", "HERMES_KANBAN_DB", "HERMES_KANBAN_WORKSPACES_ROOT",
    "HERMES_KANBAN_BOARD", "HERMES_TENANT", "HERMES_SESSION_SOURCE_EXPLICIT", "HERMES_TURN_AUTHOR",
    # Human-presence/one-shot markers: inherited, every messaging/cron turn would read as attended or -q.
    "HERMES_INTERACTIVE", "HERMES_GATEWAY_SESSION", "HERMES_SINGLE_QUERY_SESSION",
    "HERMES_EPHEMERAL_SYSTEM_PROMPT", "HERMES_PREFILL_MESSAGES_FILE", "HERMES_INFERENCE_PROVIDER",
    "HERMES_ENABLE_PROJECT_PLUGINS", "HERMES_TUI_CLIENT_ENV",
    # A terminal's shell under a systemd service (gnome-terminal-server, a user unit) carries these; the
    # unmanaged daemon would then identify as "systemd" and maintenance would refuse it as supervised.
    "INVOCATION_ID", "JOURNAL_STREAM",
    # Same for any process below a launchd/--external-supervisor gateway (its agents' tools, scripts they
    # run): the daemon would identify as "launchd", never arm --idle-exit, and outlive every client.
    # HERMES_S6_SUPERVISED_CHILD stays: without it `gateway run` in an s6 container redirects to s6.
    "XPC_SERVICE_NAME", "LAUNCHD_SOCKET", "HERMES_LAUNCHD_LABEL",
    "HERMES_GATEWAY_EXTERNAL_SUPERVISOR", "HERMES_SUPERVISED_CHILD",
    # systemd's notify socket and watchdog name the unit's main process: the daemon would feed them.
    "NOTIFY_SOCKET", "WATCHDOG_USEC", "WATCHDOG_PID",
)


LAUNCH_LOCK_NAME = "gateway-launch.lock"


class LaunchClaim:
    """This client's claim on starting its install's gateway; ``release()`` once its ensure returns."""

    def __init__(self, handle=None):
        self._handle = handle  # None: the lock file was unusable, so the start runs unserialized

    def release(self) -> None:
        if self._handle is not None:
            from gateway.status import _release_file_lock
            _release_file_lock(self._handle)
            self._handle.close()
            self._handle = None


def claim_launch(profile_home: Path) -> LaunchClaim | None:
    """The install's cold-start claim, or None while another client holds it.

    Clients that find no owner at the same moment (terminal panes resuming after a reboot) would
    each start a gateway. Those starts fight over the same profile locks and the losers exit, often
    before the winner holds anything a client can observe, so the client of a losing start reported
    its exit as fatal. One claimant per install (named profiles share the default root's lock) starts
    the gateway; the others keep polling and find its owner. The OS drops the lock if the claimant
    dies, and the detached gateway never inherits the descriptor.
    """
    from gateway.runtime_ownership import _open_lock
    from gateway.status import _try_acquire_file_lock
    from hermes_cli.gateway_runtime_multiplex import multiplexer_root_for
    try:
        fd = _open_lock((multiplexer_root_for(profile_home) or profile_home) / LAUNCH_LOCK_NAME)
    except OSError:
        return LaunchClaim()
    handle = os.fdopen(fd, "r+", encoding="utf-8")
    if _try_acquire_file_lock(handle):
        return LaunchClaim(handle)
    handle.close()
    return None


def release_launch(claim: LaunchClaim | None) -> None:
    """End a :func:`claim_launch` claim; ``None`` (never claimed) is a no-op."""
    if claim is not None:
        claim.release()


def spawn_unmanaged_gateway(profile_home: Path, *, deadline: float, idle_exit: bool = False,
                            force: bool = False) -> subprocess.Popen | GatewayJob:
    """Request a daemon, not readiness. Refuse Windows no-breakaway fallback.

    No --replace, persistence, login changes, elevation, shell, or inherited stdio.
    The gateway runtime's own exclusive ownership fence arbitrates racing starts.
    ``idle_exit``: the daemon ends itself once idle (a chat/TUI/cron client's own start; never
    Desktop's ``gateway ensure``, which keeps its attached gateway for the app's lifetime).
    ``force``: a ``gateway restart --force --detach`` replacement keeps the ``--force`` its old owner
    needed (a named profile under a multiplexer), or it exits on the run-side guard.
    """
    home = profile_home.resolve()
    root = Path(__file__).resolve().parent.parent
    # A root home is only pinned by an explicit selector: without one the child's
    # _apply_profile_override follows the sticky active_profile and boots the wrong
    # profile's daemon. A <root>/profiles/<name> home is already trusted as-is.
    selector = [] if home.parent.name == "profiles" else ["--profile", "default"]
    command = [sys.executable, "-m", "hermes_cli.main", *selector, "gateway", "run", "--quiet",
               *(["--idle-exit"] if idle_exit else []), *(["--force"] if force else [])]
    # The target profile's own secrets, never the launching client's: a `hermes -p work` client's
    # dotenv would otherwise become the default daemon's frozen launch env (host_gateway_child_env).
    from tools.environments.local import served_profile_child_env
    env = served_profile_child_env(base=dict(os.environ), target_home=home, inherit_credentials=True)
    if sys.platform == "win32":
        from hermes_cli.gateway_windows import windowless_gateway_restart_spec
        command, _, overlay = windowless_gateway_restart_spec(command)
        if not overlay:
            raise RuntimeStartError("windows_interpreter_unavailable")
        env.update(overlay)
        env[_WINDOWS_GATEWAY_BREAKAWAY_ENV] = "1"
    env.update(HERMES_HOME=str(home), HERMES_GATEWAY_DETACHED="1", PYTHONIOENCODING="utf-8")
    # Profile selection is the explicit home, not the invoking client's display
    # name. Launch-only approval/context/config flags ride the launching session's frozen
    # policy, not the shared daemon or every later session.
    from gateway.session_context import _VAR_MAP  # the launching turn's session identity, too
    from tools.environments.local_env_policy import carry_gateway_profile_pin
    carry_gateway_profile_pin(env)  # the supervisor markers go; the daemon's tools keep their pin
    for key in (*DAEMON_STRIPPED_ENV, *_VAR_MAP):
        env.pop(key, None)
    remaining(deadline)
    logs = home / "logs"
    logs.mkdir(parents=True, exist_ok=True)
    if sys.platform == "darwin":  # LAN access must outlive the app that asked for the gateway
        if job := start_gateway_job(command, env=env, cwd=root, log_path=logs / "gateway-stdio.log",
                                    deadline=deadline):
            return job
    try:
        with (logs / "gateway-stdio.log").open("ab", buffering=0) as output:
            remaining(deadline)
            return subprocess.Popen(command, cwd=root, env=env, close_fds=True,
                                    stdin=subprocess.DEVNULL, stdout=output, stderr=output,
                                    # detached-spawn: ok — a gateway daemon launch must outlive its launcher
                                    **windows_detach_popen_kwargs())
    except OSError as exc:
        reason = "windows_breakaway_unavailable" if sys.platform == "win32" else "spawn_failed"
        raise RuntimeStartError(reason) from exc


def start_detached_replacement(profile_home: Path, *, force: bool = False) -> int:
    """``gateway restart --detach`` with no service: start the stopped owner's replacement the way
    ``gateway ensure`` starts an absent one. In the foreground, the restarting client (Desktop's
    bounded, piped call) would itself become the long-lived gateway it only meant to restart."""
    import time
    try:
        spawn_unmanaged_gateway(profile_home, deadline=time.monotonic() + 30, force=force)
    except RuntimeStartError as exc:
        print(f"✗ Could not start the gateway in the background: {exc}", file=sys.stderr)
        return 1
    print("✓ Started the gateway in the background")
    return 0


def stdio_log_path(profile_home: Path) -> Path:
    return profile_home / "logs" / "gateway-stdio.log"


def stdio_log_size(profile_home: Path) -> int:
    """Where this launch's output will start in the append-only stdio log."""
    try:
        return stdio_log_path(profile_home).stat().st_size
    except OSError:
        return 0


_BANNER_PREFIXES = ("┌", "│", "├", "└")
_TAIL_LINES = 15
_TAIL_BYTES = 64 * 1024


def startup_failure_report(profile_home: Path, offset: int, status: int, pid: int | None = None) -> str:
    """What a client prints when the gateway it started died before serving: the exit status, the
    redacted tail of THIS launch's stdio (the traceback lives there, written before logging is up and
    before the detached-stdio redactor is installed) and the command that shows the whole log."""
    path = stdio_log_path(profile_home)
    try:
        with path.open("rb") as log:
            log.seek(max(offset, path.stat().st_size - _TAIL_BYTES))
            text = log.read().decode("utf-8", errors="replace")
    except OSError:
        text = ""
    lines = [line.rstrip() for line in text.splitlines()
             if line.strip() and not line.lstrip().startswith(_BANNER_PREFIXES)][-_TAIL_LINES:]
    if not lines:
        # A clean refusal (config/credential verdict, exit 78) is logged, not printed: the runtime
        # status file names it.
        from gateway.status import read_runtime_status
        status_file = read_runtime_status(profile_home / "gateway_state.json") or {}
        if status_file.get("exit_reason") and pid is not None and status_file.get("pid") == pid:
            lines = [str(status_file["exit_reason"])[:2000]]
            path = profile_home / "logs" / "gateway.log"
    from agent.redact import redact_sensitive_text
    tail = redact_sensitive_text("\n".join(lines), force=True, redact_url_credentials=True)
    see = f'type "{path}"' if sys.platform == "win32" else f"tail -n 200 '{path}'"
    body = "\n".join("  " + line for line in tail.splitlines()) if tail else "  (it wrote no output)"
    return f"the gateway exited with status {status} before it could serve:\n{body}\nFull log: {see}"
