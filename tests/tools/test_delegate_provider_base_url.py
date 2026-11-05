"""A configured custom provider keeps its key, transport and identity when a route also sets base_url.

The desktop app saves an auxiliary slot as the provider AND that provider's own URL; ``/review`` and
``delegation.*`` resolve that shape through ``_resolve_delegation_credentials``. The base_url branch
used to win outright: the route came back as anonymous ``custom`` with a URL-guessed api_mode and no
key, so the child sent the PARENT's key to the endpoint on the wrong wire. Real config, key_cmd and
key_env resolution against the temp HERMES_HOME.
"""

import os
from pathlib import Path
from types import SimpleNamespace

import pytest

import hermes_yaml as yaml
from tools.delegate_tool import _resolve_delegation_credentials
from tools.delegate_tool_config import _resolve_child_runtime

PROXY_URL = "https://proxy.example/v1"
KEYED_URL = "https://keyed.example/anthropic"


@pytest.fixture
def providers_config():
    home = Path(os.environ["HERMES_HOME"])
    home.mkdir(parents=True, exist_ok=True)
    key_file = home / "proxy.key"
    key_file.write_text("cmd-secret\n")

    def write(**extra):
        (home / "config.yaml").write_text(yaml.safe_dump({
            "providers": {
                "cliproxy": {"name": "cliproxy", "api": PROXY_URL, "transport": "codex_responses",
                             "key_cmd": f"cat {key_file}", "extra_headers": {"X-Route-Tag": "alpha"}},
                "keyed": {"api": KEYED_URL, "api_mode": "anthropic_messages", "key_env": "KEYED_API_KEY"},
            },
            **extra,
        }))
    write()
    return write


@pytest.fixture(autouse=True)
def _keyed_env(monkeypatch):
    monkeypatch.setenv("KEYED_API_KEY", "env-secret")


def _key(creds):
    key = creds["api_key"]
    return key() if callable(key) else key


@pytest.mark.parametrize("base_url", [PROXY_URL, PROXY_URL + "/"])
def test_provider_with_its_own_base_url_keeps_key_cmd_transport_and_identity(providers_config, base_url):
    creds = _resolve_delegation_credentials(
        {"provider": "custom:cliproxy", "model": "m", "base_url": base_url}, parent_agent=None)
    assert (creds["provider"], creds["api_mode"], _key(creds)) == ("custom:cliproxy", "codex_responses", "cmd-secret")
    assert creds["base_url"].rstrip("/") == PROXY_URL


def test_key_env_provider_with_its_own_base_url_keeps_its_key_and_dialect(providers_config):
    creds = _resolve_delegation_credentials({"provider": "keyed", "model": "m", "base_url": KEYED_URL}, None)
    assert (creds["provider"], creds["api_mode"], _key(creds)) == ("keyed", "anthropic_messages", "env-secret")


def test_inline_api_key_wins_without_dropping_the_providers_transport_or_identity(providers_config):
    creds = _resolve_delegation_credentials(
        {"provider": "cliproxy", "model": "m", "base_url": PROXY_URL, "api_key": "inline-key"}, None)
    assert (creds["provider"], creds["api_mode"], _key(creds)) == ("cliproxy", "codex_responses", "inline-key")


def test_explicit_api_mode_still_wins_over_the_providers(providers_config):
    creds = _resolve_delegation_credentials(
        {"provider": "custom:cliproxy", "model": "m", "base_url": PROXY_URL, "api_mode": "chat_completions"}, None)
    assert (creds["api_mode"], _key(creds)) == ("chat_completions", "cmd-secret")


def test_same_origin_path_keeps_the_entry_key(providers_config):
    creds = _resolve_delegation_credentials(
        {"provider": "custom:cliproxy", "model": "m", "base_url": "https://proxy.example/alt/v1"}, None)
    assert (creds["api_mode"], _key(creds)) == ("codex_responses", "cmd-secret")


def test_another_host_gets_neither_the_entry_key_nor_the_parents(providers_config):
    """A stale or foreign base_url (or one a delegation backend chose) must not receive the provider's
    key, and the route must not fall back to the parent's key either: it fails with a message naming
    the fix. Another scheme or port on the same host is another origin too."""
    with pytest.raises(ValueError, match="not sent to https://other.example"):
        _resolve_delegation_credentials({"provider": "cliproxy", "model": "m", "base_url": "https://other.example/v1"}, None)
    with pytest.raises(ValueError, match="not sent to"):
        _resolve_delegation_credentials({"provider": "cliproxy", "model": "m", "base_url": "http://proxy.example/v1"}, None)
    # A placeholder is no key of its own: the resolver would swap the entry's back in.
    with pytest.raises(ValueError, match="not sent to"):
        _resolve_delegation_credentials(
            {"provider": "cliproxy", "model": "m", "base_url": "https://other.example/v1", "api_key": "dummy"}, None)
    creds = _resolve_delegation_credentials(
        {"provider": "cliproxy", "model": "m", "base_url": "https://other.example/v1", "api_key": "own-key"}, None)
    assert (creds["api_mode"], _key(creds)) == ("codex_responses", "own-key")


def test_review_slot_child_runs_on_the_provider_never_the_parents_key(providers_config):
    """/review reads ``auxiliary.review`` in the shape the desktop app saves; the child it builds must
    carry the provider's key and wire, not the parent's."""
    providers_config(auxiliary={"review": {"provider": "custom:cliproxy", "model": "m", "base_url": PROXY_URL}})
    from agent.review_engine import _load_review_credentials_cfg
    from tools.delegate_tool_routes import route_for_config

    parent = SimpleNamespace(provider="openrouter", model="parent/model", base_url="https://openrouter.ai/api/v1",
                             api_key="parent-secret", api_mode="chat_completions")
    creds = route_for_config(_load_review_credentials_cfg(), parent).creds
    child = _resolve_child_runtime(
        parent, {}, "parent-secret", model=creds["model"], override_provider=creds["provider"],
        override_base_url=creds["base_url"], override_api_key=creds["api_key"], override_api_mode=creds["api_mode"],
        override_acp_command=None, override_acp_args=None)
    assert (child["provider"], child["api_mode"]) == ("custom:cliproxy", "codex_responses")
    assert _key(child) == "cmd-secret"


def test_unknown_or_disabled_provider_is_refused_rather_than_borrowing_the_parents_key(providers_config):
    with pytest.raises(ValueError, match="custom:missing"):
        _resolve_delegation_credentials({"provider": "custom:missing", "model": "m", "base_url": PROXY_URL}, None)
    providers_config()
    home = Path(os.environ["HERMES_HOME"])
    config = yaml.safe_load((home / "config.yaml").read_text())
    config["providers"]["cliproxy"]["enabled"] = False
    (home / "config.yaml").write_text(yaml.safe_dump(config))
    for name in ("cliproxy", "CLIPROXY"):
        with pytest.raises(ValueError, match="disabled"):
            _resolve_delegation_credentials({"provider": name, "model": "m", "base_url": PROXY_URL}, None)
    # A disabled entry calling itself after a built-in never blocks the built-in.
    config["providers"]["cliproxy"]["name"] = "OpenRouter"
    (home / "config.yaml").write_text(yaml.safe_dump(config))
    creds = _resolve_delegation_credentials({"provider": "openrouter", "model": "m", "base_url": PROXY_URL}, None)
    assert creds["base_url"] == PROXY_URL


def test_base_url_without_provider_is_still_a_direct_endpoint(providers_config):
    creds = _resolve_delegation_credentials({"model": "m", "base_url": PROXY_URL}, None)
    assert (creds["provider"], creds["api_key"]) == ("custom", None)
