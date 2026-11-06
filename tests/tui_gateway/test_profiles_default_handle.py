"""``profiles.configure`` gates the default profile's custom @handle (#89720).

The Bots editor writes ``ui_meta['hermes-bots'].mentionHandle`` on the default profile. A changed
handle must be a valid, unclaimed tag on this install; an unchanged one rides every later save of
the block untouched, so a colour edit never fails over the handle.
"""

from __future__ import annotations

import pytest

import tui_gateway.server as srv
from tools.bot_mode_probe import stored_default_handle


@pytest.fixture
def home(tmp_path, monkeypatch):
    hermes_home = tmp_path / ".hermes"
    (hermes_home / "profiles" / "researcher").mkdir(parents=True)
    (hermes_home / "profiles" / "researcher" / "config.yaml").write_text("{}\n")  # identity marker
    monkeypatch.setenv("HERMES_HOME", str(hermes_home))
    return hermes_home


def _configure(name, block):
    result = srv._methods["profiles.configure"]("configure", {"name": name, "ui_meta": {"hermes-bots": block}})
    return result["result"]["applied"]


def test_a_valid_handle_is_stored_normalized(home):
    applied = _configure("default", {"shape": "cloud", "mentionHandle": "@Maia"})
    assert applied["ui_meta"] is True and "ui_meta_error" not in applied
    assert stored_default_handle(home) == "maia"


@pytest.mark.parametrize("handle, problem", [
    ("researcher", "name of a profile"), ("hermes", "reserved"), ("not valid", "lowercase letters"),
])
def test_a_changed_invalid_handle_refuses_the_whole_write(home, handle, problem):
    _configure("default", {"shape": "cloud", "mentionHandle": "maia"})

    applied = _configure("default", {"shape": "star", "mentionHandle": handle})

    assert applied["ui_meta"] is False and problem in applied["ui_meta_error"]
    assert stored_default_handle(home) == "maia"
    assert "shape: cloud" in (home / "profile.yaml").read_text(encoding="utf-8")


def test_an_unchanged_handle_is_not_rejudged_after_a_profile_takes_the_name(home):
    _configure("default", {"shape": "cloud", "mentionHandle": "maia"})
    (home / "profiles" / "maia").mkdir()
    (home / "profiles" / "maia" / "config.yaml").write_text("{}\n")

    applied = _configure("default", {"shape": "star", "mentionHandle": "maia"})

    assert applied["ui_meta"] is True
    assert "shape: star" in (home / "profile.yaml").read_text(encoding="utf-8")


def test_clearing_the_handle_is_always_allowed(home):
    _configure("default", {"shape": "cloud", "mentionHandle": "maia"})
    applied = _configure("default", {"shape": "cloud", "mentionHandle": ""})
    assert applied["ui_meta"] is True and stored_default_handle(home) == ""


def test_named_profiles_pass_through_untouched(home):
    applied = _configure("researcher", {"shape": "cloud", "mentionHandle": "hermes"})
    assert applied["ui_meta"] is True and "ui_meta_error" not in applied
