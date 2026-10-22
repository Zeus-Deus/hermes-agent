"""The classic CLI's spinner thread: repaints while a command runs and drives the live-work
footer's polls (``cli_subagent_monitor.SubagentMonitor.tick``)."""
from __future__ import annotations

import logging
import time

logger = logging.getLogger(__name__)


def run_spinner_loop(cli) -> None:
    """Until the CLI exits. This thread is the footer's only refresher: a failed poll (a gateway
    hang-up mid ``subagent.list``) is logged once per failing streak and retried on the next tick,
    never allowed to end the thread and freeze the footer for the rest of the session."""
    poll_failing = False
    while not cli._should_exit:
        if not cli._app:
            time.sleep(0.1)
            continue
        monitor = getattr(cli, "_subagent_monitor", None)
        if monitor is not None:
            try:
                monitor.tick()
                poll_failing = False
            except Exception:  # health: allow BLE001 -- any poll failure; the footer must outlive it
                logger.log(logging.DEBUG if poll_failing else logging.WARNING,
                           "live-work footer refresh failed", exc_info=True)
                poll_failing = True
        if cli._command_running:
            cli._invalidate(min_interval=0.1)
            time.sleep(0.1)
        else:
            # Never repaint the idle prompt on a timer: in non-full-screen mode background
            # redraws fight tmux/Ghostty/cmux viewport restoration after focus changes and
            # visually move the input area. Input/agent events invalidate explicitly.
            time.sleep(0.2)
