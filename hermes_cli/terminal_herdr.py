"""Tell Herdr which session this pane holds, so a Herdr server restart reopens it.

Herdr (a terminal workspace manager) restores each pane after a restart by running the command its
agent last reported there. Herdr's own Hermes plugin reported from a plugin hook, but hooks now run
in the shared gateway, whose environment has no pane: ``HERDR_PANE_ID`` exists only in the client
the user started in the pane. The classic CLI is that client, so it reports the command itself,
following Herdr's agent self-report contract (https://herdr.dev/docs/add-herdr-support/).

Only the resume command is reported, never state: Herdr keeps detecting Hermes's state from the
screen, accepts the command once it sees Hermes running in the pane (``resume_not_accepted`` until
then, so the report is retried), and drops it when that process exits. Best-effort throughout: a
background thread sends the newest report only, and failures are ignored. Outside a Herdr pane, or
without a terminal on stdin/stdout (``-q`` from a script or another agent), nothing is sent.
"""
from __future__ import annotations

import logging
import os
import subprocess
import threading
import time

logger = logging.getLogger(__name__)

# Our own integration id: Herdr reserves ``herdr:`` sources for the integrations it ships.
_SOURCE = "hermes"
# The label Herdr detects Hermes by; only the detected agent may own the pane's resume command.
_AGENT = "hermes"
# Herdr refuses the command until it has detected Hermes in the pane, a moment after startup.
_RETRY_DELAYS = (0.5, 1.0, 2.0, 4.0)
_TIMEOUT = 2.0

_lock = threading.Condition()
_pending: tuple | None = None  # (herdr binary, pane id, argv): the newest report not yet sent
_accepted: tuple | None = None  # (pane id, argv) Herdr last accepted
_worker: threading.Thread | None = None


def _herdr_pane() -> tuple[str, str] | None:
    """``(herdr binary, pane id)`` when this process is the interactive client in a Herdr pane."""
    if os.environ.get("HERDR_ENV") != "1":
        return None
    binary = os.environ.get("HERDR_BIN_PATH", "").strip()
    pane = os.environ.get("HERDR_PANE_ID", "").strip()
    if not binary or not pane:
        return None
    try:
        if not (os.isatty(0) and os.isatty(1)):
            return None
    except OSError:
        return None
    return binary, pane


def resume_argv(session_id: str) -> list[str] | None:
    """The command that reopens ``session_id`` here: this profile, the classic CLI. ``None`` for a
    ``HERMES_HOME`` that is no profile (``custom``), which no ``-p`` name can select again."""
    from hermes_cli.profiles import get_active_profile_name

    profile = get_active_profile_name()
    if profile == "custom":
        return None
    return ["hermes", "-p", profile, "--cli", "--resume", session_id]


def report_session(session_id: str | None) -> None:
    """Report ``session_id`` as this pane's session. Never raises, never blocks."""
    global _pending, _worker
    try:
        where = _herdr_pane() if session_id else None
        if session_id is None or where is None:
            return
        argv = resume_argv(session_id)
        if argv is None:
            return
        binary, pane = where
        with _lock:
            if _accepted == (pane, tuple(argv)) and _pending is None:
                return
            _pending = (binary, pane, tuple(argv))
            if _worker is None:
                from agent.memory_provider import spawn_context_thread

                _worker = spawn_context_thread(_drain, name="herdr-session-report")
                _worker.start()
            else:
                _lock.notify_all()
    except Exception:
        logger.debug("Herdr session report skipped", exc_info=True)


def _drain() -> None:
    global _pending, _accepted, _worker
    while True:
        with _lock:
            job, _pending = _pending, None
            if job is None:
                _worker = None
                return
            if _accepted == job[1:]:
                continue
        for delay in (0.0, *_RETRY_DELAYS):
            with _lock:
                if delay and _pending is None:
                    _lock.wait(delay)
                if _pending is not None:
                    break  # a newer session superseded this one
            outcome = _send(*job)
            if outcome == "accepted":
                with _lock:
                    _accepted = job[1:]
            if outcome != "retry":
                break


def _send(binary: str, pane: str, argv: tuple) -> str:
    """One report: ``accepted``, ``retry`` (Herdr has not seen Hermes in the pane yet) or ``failed``
    (an older Herdr without resume commands, a stopped server, ...)."""
    command = [binary, "pane", "report-agent-session", pane, "--source", _SOURCE, "--agent", _AGENT,
               "--seq", str(time.time_ns()), "--agent-session-id", argv[-1], "--", *argv]
    try:
        done = subprocess.run(command, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                              stderr=subprocess.PIPE, text=True, timeout=_TIMEOUT, check=False)
    except (OSError, subprocess.SubprocessError):
        return "failed"
    if done.returncode == 0:
        return "accepted"
    return "retry" if "resume_not_accepted" in (done.stderr or "") else "failed"
