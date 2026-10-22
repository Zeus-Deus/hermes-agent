"""The CLI's spinner thread is the only thing that refreshes the live-work footer. One failed
poll (a gateway hang-up mid ``subagent.list``) used to end that thread: the footer froze on its
last state for the rest of the session while the status bar kept counting the running work."""
import logging
import types

from hermes_cli import cli_tui_spinner
from hermes_cli.cli_tui_mixin import CLITuiMixin


class _Monitor:
    def __init__(self, cli, failures):
        self.cli, self.failures, self.ticks = cli, failures, 0

    def tick(self):
        self.ticks += 1
        if self.ticks <= self.failures:
            raise RuntimeError(f"poll {self.ticks} failed")
        self.cli._should_exit = True  # the first good tick ends the test


def _run(monkeypatch, failures):
    monkeypatch.setattr(cli_tui_spinner.time, "sleep", lambda _s: None)
    cli = types.SimpleNamespace(_should_exit=False, _app=object(), _command_running=False,
                                _invalidate=lambda **_kw: None)
    cli._subagent_monitor = monitor = _Monitor(cli, failures)
    CLITuiMixin._tui_spinner_loop(cli)
    return monitor


def test_a_failed_footer_poll_does_not_stop_the_spinner_thread(monkeypatch):
    monitor = _run(monkeypatch, failures=1)
    assert monitor.ticks == 2  # the loop went on and polled again


def test_a_failing_poll_is_logged_once_per_streak_not_every_tick(monkeypatch, caplog):
    with caplog.at_level(logging.DEBUG, logger=cli_tui_spinner.__name__):
        monitor = _run(monkeypatch, failures=3)
    assert monitor.ticks == 4
    warnings = [r for r in caplog.records if r.levelno == logging.WARNING]
    assert len(warnings) == 1 and warnings[0].exc_info is not None
