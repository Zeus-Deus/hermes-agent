"""Explicit callable credentials keep their identity and precedence at public seams."""

import pytest

from hermes_cli.config import atomic_config_write
from hermes_cli.runtime_provider import resolve_runtime_provider
from tests.hermes_cli import test_key_cmd_model_switch_http as http_contract


endpoint = http_contract.endpoint

@pytest.mark.parametrize("slug", ["deepseek", "anthropic", "openrouter"])
@pytest.mark.parametrize("credential", ["static", "callable"])
def test_explicit_provider_key_is_lazy_and_wins(tmp_path, monkeypatch, endpoint, slug, credential):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    atomic_config_write(tmp_path / "config.yaml", {"model": {"provider": "custom"},
        "providers": {slug: {"base_url": endpoint.base_url, "api_key": "fixture-stale-key"}}})
    calls = []
    def source():
        calls.append(True)
        return endpoint.token
    key = source if credential == "callable" else endpoint.token
    runtime = resolve_runtime_provider(requested=slug, explicit_api_key=key,
        explicit_base_url=endpoint.base_url, target_model="fixture-selected")
    assert runtime["api_key"] is key
    assert runtime["base_url"] == endpoint.base_url
    assert calls == []
    from openai import OpenAI
    from agent.anthropic_adapter import build_anthropic_client
    if runtime["api_mode"] == "anthropic_messages":
        if credential == "static":
            endpoint.auth_header, endpoint.auth_prefix = "x-api-key", ""
        with build_anthropic_client(runtime["api_key"], runtime["base_url"]) as client:
            assert client.messages.create(model="fixture-selected", max_tokens=8,
                messages=[{"role": "user", "content": "fixture"}]).stop_reason == "end_turn"
    else:
        with OpenAI(api_key=runtime["api_key"], base_url=runtime["base_url"], max_retries=0) as client:
            assert client.chat.completions.create(model="fixture-selected",
                messages=[{"role": "user", "content": "fixture"}]).choices[0].message.content == "fixture reply"
    assert calls == ([True] if credential == "callable" else [])
    assert len(endpoint.calls) == 1
    assert "fixture-stale-key" not in repr(endpoint.calls)


@pytest.mark.parametrize("credential", ["static", "callable"])
def test_bare_custom_explicit_key_beats_pool_without_mint(tmp_path, monkeypatch, endpoint, credential):
    from hermes_cli import runtime_provider

    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    atomic_config_write(tmp_path / "config.yaml", {"model": {
        "provider": "custom", "base_url": endpoint.base_url, "api_key": "fixture-config-key"}})
    calls = []
    def source():
        calls.append(True)
        return endpoint.token
    pool_calls = []
    def pool(*args, **kwargs):
        pool_calls.append(True)
        return {"provider": "custom", "api_mode": "chat_completions",
                "base_url": endpoint.base_url, "api_key": "fixture-pool-key"}
    monkeypatch.setattr(runtime_provider, "_try_resolve_from_custom_pool", pool)
    key = source if credential == "callable" else endpoint.token
    runtime = resolve_runtime_provider(requested="custom", explicit_api_key=key, target_model="fixture-selected")
    assert runtime["api_key"] is key
    assert runtime["base_url"] == endpoint.base_url
    assert calls == []
    assert pool_calls == []
