"""A mistyped interval must not silently create or replace a self-paced loop."""

import pytest

from hermes_cli.loops import LoopManager, dispatch_loop_command, parse_loop_args


@pytest.mark.parametrize("args", ["5m, /check-build", "every 5m, /check-build", "1h30m, check CI --times 2"])
def test_comma_after_interval_reports_the_correction(args):
    parsed = parse_loop_args(args)
    assert parsed["error"] is not None
    assert "comma" in parsed["error"]


def test_bad_interval_does_not_replace_a_persisted_loop(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    manager = LoopManager("loop-interval-validation")
    previous = manager.set("check CI", interval_seconds=300)
    result = dispatch_loop_command(manager, "5m, /check-build")
    assert result["created"] is False
    assert "comma" in result["output"]
    assert manager.state is previous
    restored = LoopManager(manager.session_id)
    assert restored.state is not None
    assert restored.state.prompt == "check CI"
    assert restored.state.mode == "interval"
    assert restored.state.interval_seconds == 300


@pytest.mark.parametrize("prompt", ["check 5m, then report", "3 things, then report", "every day, check CI"])
def test_commas_in_self_paced_prose_are_preserved(prompt):
    parsed = parse_loop_args(prompt)
    assert parsed["error"] is None
    assert parsed["interval_seconds"] is None
    expected = prompt.removeprefix("every ")
    assert parsed["prompt"] == expected
