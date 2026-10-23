"""Reject interval commas without a space before creating or replacing a loop."""

import pytest

from hermes_cli import loops


@pytest.mark.parametrize("args", ["5m,/check-build", "every 5m,/check-build"])
@pytest.mark.parametrize("existing", [False, True], ids=["create", "replace"])
def test_interval_comma_without_space_leaves_loop_unchanged(args, existing, tmp_path, monkeypatch):
    from hermes_state import SessionDB

    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    db = SessionDB(db_path=tmp_path / "state.db")
    monkeypatch.setattr(loops, "_get_session_db", lambda: db)
    try:
        manager = loops.LoopManager("comma-validation")
        previous = manager.set("check CI", interval_seconds=300) if existing else None
        before = db.get_meta("loop:comma-validation")

        result = loops.dispatch_loop_command(manager, args)
        persisted = db.get_meta("loop:comma-validation")

        assert result["created"] is False, {"result": result, "persisted": persisted}
        assert "comma" in result["output"]
        assert manager.state is previous
        assert persisted == before
        restored = loops.LoopManager(manager.session_id)
        assert (restored.state.to_json() if restored.state else None) == before
    finally:
        db.close()


@pytest.mark.parametrize(
    ("args", "interval", "prompt"),
    [
        ("3,000 things", None, "3,000 things"),
        ("3, things", None, "3, things"),
        ("3 things", None, "3 things"),
        ("check,then report", None, "check,then report"),
        ("check 5m,/check-build", None, "check 5m,/check-build"),
        ("every day, check CI", None, "day, check CI"),
        ("5m check,then report", 300, "check,then report"),
        ("every 5m /check-build,then-report", 300, "/check-build,then-report"),
    ],
)
def test_other_commas_and_bare_numbers_remain_prompt_text(args, interval, prompt):
    parsed = loops.parse_loop_args(args)
    assert parsed["error"] is None
    assert parsed["interval_seconds"] == interval
    assert parsed["prompt"] == prompt
