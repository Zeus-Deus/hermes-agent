"""Command credentials outrank stale credentials while selecting an endpoint."""

import shlex
import sys

import pytest

from tests.hermes_cli import test_key_cmd_model_switch_http as http_contract
from agent.command_token_source import CommandTokenSource
from hermes_cli.config import atomic_config_write, load_config
from hermes_cli.model_switch import switch_model


endpoint = http_contract.endpoint

@pytest.mark.platforms("posix")
@pytest.mark.parametrize("fallback", ["api_key", "key_env"])
@pytest.mark.parametrize("api_mode", ["chat_completions", "codex_responses", "anthropic_messages"])
@pytest.mark.parametrize("provider_key", ["relay", "MixedRelay"])
def test_switch_command_precedes_stale_entry_key(tmp_path, monkeypatch, endpoint, fallback, api_mode, provider_key):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    monkeypatch.setenv("FIXTURE_GATEWAY_KEY", "fixture-stale-config-key")
    entry = {"base_url": endpoint.base_url,
             "key_cmd": shlex.join([sys.executable, "-c", "print('fixture-token-one')"]),
             "api_mode": api_mode}
    entry[fallback] = "fixture-stale-config-key" if fallback == "api_key" else "FIXTURE_GATEWAY_KEY"
    atomic_config_write(tmp_path / "config.yaml", {
        "model": {"provider": "custom", "default": "fixture-old"}, "providers": {provider_key: entry}})
    result = switch_model("fixture-selected", "custom", "fixture-old",
        current_base_url="http://127.0.0.1:1/v1", current_api_key="fixture-old-route-key",
        explicit_provider=provider_key.lower(), user_providers=load_config()["providers"])
    assert result.success, result.error_message
    assert not result.warning_message, result.warning_message
    assert isinstance(result.api_key, CommandTokenSource)
    assert endpoint.calls
    assert all(headers.get("authorization") == "Bearer fixture-token-one" for _, headers, _ in endpoint.calls)
    assert "fixture-stale-config-key" not in repr(endpoint.calls)


@pytest.mark.platforms("posix")
@pytest.mark.parametrize("api_mode", ["chat_completions", "codex_responses", "anthropic_messages"])
@pytest.mark.parametrize("fallback", ["api_key", "key_env"])
@pytest.mark.parametrize("outcome", ["raises", "empty"])
def test_failed_command_does_not_borrow_static_key(tmp_path, monkeypatch, endpoint, api_mode, fallback, outcome):
    from hermes_cli.runtime_provider import resolve_runtime_provider

    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    monkeypatch.setenv("FIXTURE_GATEWAY_KEY", endpoint.token)
    monkeypatch.setenv("OPENAI_API_KEY", "fixture-unrelated-account")
    command = shlex.join([sys.executable, "-c", "raise SystemExit(1)" if outcome == "raises" else "print('')"])
    entry = {"base_url": endpoint.base_url, "key_cmd": command, "api_mode": api_mode}
    entry[fallback] = endpoint.token if fallback == "api_key" else "FIXTURE_GATEWAY_KEY"
    atomic_config_write(tmp_path / "config.yaml", {"model": {"provider": "custom"}, "providers": {"relay": entry}})
    result = switch_model("fixture-selected", "custom", "fixture-old",
        current_base_url="http://127.0.0.1:1/v1", current_api_key="fixture-old-route-key",
        explicit_provider="relay", user_providers=load_config()["providers"])
    assert result.success == (api_mode != "codex_responses")
    assert result.warning_message or result.error_message
    runtime = resolve_runtime_provider(requested="custom:relay", target_model="fixture-selected")
    assert isinstance(runtime["api_key"], CommandTokenSource)
    assert endpoint.calls
    assert all("authorization" not in headers and "x-api-key" not in headers for _, headers, _ in endpoint.calls)
    assert "fixture-unrelated-account" not in repr(endpoint.calls)
    assert "fixture-old-route-key" not in repr(endpoint.calls)
