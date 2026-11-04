"""Fast mode on a custom endpoint that opts in with ``capabilities: {fast_mode: true}``.

Fast-mode params (``service_tier`` / Anthropic ``speed``) reach only the first-party endpoint that
bills for them. A ``providers:`` entry can declare that its proxy forwards them; nothing else may
receive them, and the model-family gate still applies.
"""

from pathlib import Path

import pytest

from hermes_cli.models import resolve_fast_mode_overrides

PROXY = "http://127.0.0.1:18080/v1"
OTHER = "http://127.0.0.1:18081/v1"


@pytest.fixture
def write_config(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    monkeypatch.setattr(Path, "home", lambda: tmp_path)

    def _write(text: str) -> None:
        (tmp_path / "config.yaml").write_text(text, encoding="utf-8")

    return _write


def _provider(key: str, url: str, fast_mode: str | None = None, *, name: str | None = None) -> str:
    block = f"  {key}:\n" + (f"    name: {name}\n" if name else "") + f"    api: {url}\n    api_key: sk-test\n"
    if fast_mode is not None:
        block += f"    capabilities:\n      fast_mode: {fast_mode}\n"
    return block


def test_opted_in_endpoint_gets_priority_and_ultrafast(write_config):
    write_config("providers:\n" + _provider("fast-proxy", PROXY, "true"))

    assert resolve_fast_mode_overrides("gpt-5.5", provider="custom:fast-proxy", base_url=PROXY) == {
        "service_tier": "priority"}
    assert resolve_fast_mode_overrides("gpt-5.5", provider="custom", base_url=PROXY + "/") == {
        "service_tier": "priority"}
    assert resolve_fast_mode_overrides(
        "gpt-6.1-sol", provider="custom:fast-proxy", base_url=PROXY, tier="ultrafast") == {
        "service_tier": "ultrafast"}
    assert resolve_fast_mode_overrides("claude-opus-4-8", provider="custom", base_url=PROXY) == {
        "speed": "fast"}


@pytest.mark.parametrize("flag", [None, "false", '"true"'])
def test_endpoint_without_boolean_opt_in_stays_gated(write_config, flag):
    write_config("providers:\n" + _provider("plain-proxy", PROXY, flag))

    assert resolve_fast_mode_overrides("gpt-5.5", provider="custom:plain-proxy", base_url=PROXY) is None
    assert resolve_fast_mode_overrides("claude-opus-4-8", provider="custom", base_url=PROXY) is None


def test_opt_in_is_scoped_to_its_own_url(write_config):
    write_config("providers:\n" + _provider("fast-proxy", PROXY, "true"))

    # Naming the opted-in provider never carries its flag to a different endpoint.
    assert resolve_fast_mode_overrides("gpt-5.5", provider="custom:fast-proxy", base_url=OTHER) is None
    assert resolve_fast_mode_overrides("gpt-5.5", provider="openai", base_url=OTHER) is None


def test_family_gate_still_applies_on_opted_in_endpoint(write_config):
    write_config("providers:\n" + _provider("fast-proxy", PROXY, "true"))

    assert resolve_fast_mode_overrides("gpt-5.3-codex", provider="custom", base_url=PROXY) is None
    assert resolve_fast_mode_overrides("claude-sonnet-4-6", provider="custom", base_url=PROXY) is None
    assert resolve_fast_mode_overrides("gpt-5.5", provider="custom", base_url=PROXY, tier="ultrafast") is None


@pytest.mark.parametrize("aliases", [
    # A second entry on the same URL without the flag keeps the endpoint gated for every label,
    _provider("fast-alias", PROXY, "true") + _provider("plain-alias", PROXY),
    # including one named "custom" (the generic runtime label must not select it),
    _provider("custom", PROXY, "true") + _provider("plain-alias", PROXY),
    # and one that list deduplication would otherwise hide behind a shared display name.
    _provider("fast-alias", PROXY, "true", name="Shared") + _provider("plain-alias", PROXY, name="Shared"),
], ids=["plain-alias", "entry-keyed-custom", "deduplicated-alias"])
def test_endpoint_shared_with_a_non_opted_entry_stays_gated(write_config, aliases):
    write_config("providers:\n" + aliases)

    for provider in ("custom", "custom:fast-alias", "custom:plain-alias", "custom:custom", None):
        assert resolve_fast_mode_overrides("gpt-5.5", provider=provider, base_url=PROXY) is None, provider


def test_named_provider_without_url_resolves_its_own_entry(write_config):
    from gateway.session_worker_construct import routing_agent_kwargs

    write_config("providers:\n" + _provider("fast-proxy", PROXY, "true") + _provider("plain-proxy", OTHER))

    assert resolve_fast_mode_overrides("gpt-5.5", provider="custom:fast-proxy") == {"service_tier": "priority"}
    assert resolve_fast_mode_overrides("gpt-5.5", provider="custom:plain-proxy") is None
    # A managed worker builds its static tier before the URL is resolved from the provider entry.
    worker = routing_agent_kwargs({"agent": {"service_tier": "fast"}}, "gpt-5.5", "custom:fast-proxy", None)
    assert worker["request_overrides"] == {"service_tier": "priority"}
    plain = routing_agent_kwargs({"agent": {"service_tier": "fast"}}, "gpt-5.5", "custom:plain-proxy", None)
    assert plain["request_overrides"] is None
    assert resolve_fast_mode_overrides("gpt-5.5", provider="custom") is None


def test_named_provider_without_url_follows_the_runtime_lookup(write_config):
    from gateway.session_worker_construct import routing_agent_kwargs

    # The runtime routes ``custom:proxy`` to the first entry whose display name matches (OTHER),
    # not to the later entry keyed ``proxy`` that opted in.
    write_config("providers:\n" + _provider("plain", OTHER, name="proxy") + _provider("proxy", PROXY, "true"))

    assert resolve_fast_mode_overrides("gpt-5.5", provider="custom:proxy") is None
    worker = routing_agent_kwargs({"agent": {"service_tier": "fast"}}, "gpt-5.5", "custom:proxy", None)
    assert worker["request_overrides"] is None


def test_model_picker_offers_fast_for_opted_in_endpoint_only(write_config):
    from hermes_cli.inventory import _apply_capabilities

    write_config("providers:\n" + _provider("fast-proxy", PROXY, "true") + _provider("plain-proxy", OTHER))
    rows = [
        {"slug": "custom:fast-proxy", "api_url": PROXY, "models": ["gpt-5.5", "gpt-6.1-sol"]},
        {"slug": "custom:plain-proxy", "api_url": OTHER, "models": ["gpt-5.5"]},
    ]
    _apply_capabilities(rows)

    fast_caps, plain_caps = rows[0]["capabilities"], rows[1]["capabilities"]
    assert fast_caps["gpt-5.5"]["fast"] is True
    assert fast_caps["gpt-6.1-sol"].get("ultrafast") is True
    assert plain_caps["gpt-5.5"]["fast"] is False


def test_anthropic_wire_sends_speed_only_to_opted_in_proxy(write_config):
    from agent.anthropic_adapter import build_anthropic_kwargs

    write_config("providers:\n" + _provider("fast-proxy", PROXY, "true") + _provider("plain-proxy", OTHER))

    def build(base_url):
        return build_anthropic_kwargs(
            model="claude-opus-4-8", messages=[{"role": "user", "content": [{"type": "text", "text": "hi"}]}],
            tools=None, max_tokens=None, reasoning_config=None, fast_mode=True, base_url=base_url)

    opted = build(PROXY)
    assert opted["extra_body"]["speed"] == "fast"
    assert "fast-mode" in opted["extra_headers"]["anthropic-beta"]

    plain = build(OTHER)
    assert plain.get("extra_body", {}).get("speed") is None
    assert "extra_headers" not in plain
