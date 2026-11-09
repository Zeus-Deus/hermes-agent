"""Native Console command keys use the same auth for discovery and the real SDK."""

import shlex
import sys
import urllib.parse

import httpx
import pytest

from agent.command_token_source import CommandTokenSource
from hermes_cli.config import atomic_config_write, load_config
from tests.hermes_cli import test_key_cmd_model_switch_http as http_contract


endpoint = http_contract.endpoint

@pytest.mark.platforms("posix")
@pytest.mark.parametrize("route", ["probe", "fetch", "native", "cached", "picker", "switch"])
@pytest.mark.parametrize("credential", ["static", "callable"])
@pytest.mark.parametrize("family", ["api03", "usr", "svc", "admin"])
def test_native_console_catalog_matches_sdk(tmp_path, monkeypatch, endpoint, route, credential, family):
    _catalog_matches_sdk(tmp_path, monkeypatch, endpoint, route, credential,
                         "sk-ant-" + family + "-fixture-console", "https://api.anthropic.com/v1", False)


@pytest.mark.platforms("posix")
@pytest.mark.parametrize("route", ["probe", "fetch", "native", "cached", "picker", "switch"])
@pytest.mark.parametrize("token,base", [
    ("sk-ant-oat01-fixture", "https://api.anthropic.com/v1"),
    ("sk-ant-api03-fixture-console", "https://api.anthropic.com.fixture.invalid/v1"),
    ("sk-ant-oat01-fixture", "https://api.anthropic.com.fixture.invalid/v1"),
])
def test_callable_oauth_and_foreign_routes_keep_bearer(tmp_path, monkeypatch, endpoint, route, token, base):
    _catalog_matches_sdk(tmp_path, monkeypatch, endpoint, route, "callable", token, base, True)


def _catalog_matches_sdk(tmp_path, monkeypatch, endpoint, route, credential, token, base, bearer):
    from agent.anthropic_adapter import build_anthropic_client
    from hermes_cli import models
    from hermes_cli.model_switch import switch_model
    from hermes_cli.model_switch_providers import _fetch_picker_live_models

    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    endpoint.token = token
    endpoint.auth_header, endpoint.auth_prefix = ("authorization", "Bearer ") if bearer else ("x-api-key", "")
    expected_header, other_header = ("authorization", "x-api-key") if bearer else ("x-api-key", "authorization")
    expected_value = endpoint.auth_prefix + token
    command = shlex.join([sys.executable, "-c", "print(" + repr(token) + ")"])
    source = CommandTokenSource(command, "Fixture") if credential == "callable" else token
    original_get = models._get_json
    def loopback_get(url, **kwargs):
        parsed = urllib.parse.urlsplit(url)
        assert parsed.hostname == urllib.parse.urlsplit(base).hostname
        return original_get(endpoint.base_url.removesuffix("/v1") + parsed.path, **kwargs)
    monkeypatch.setattr(models, "_get_json", loopback_get)
    sdk_calls = []
    def receive(transport, request):
        assert request.url.host == urllib.parse.urlsplit(base).hostname
        sdk_calls.append(dict(request.headers))
        return httpx.Response(200, json={"id": "msg_fixture", "type": "message", "role": "assistant",
            "model": "fixture-selected", "content": [], "stop_reason": "end_turn",
            "usage": {"input_tokens": 1, "output_tokens": 1}})
    # Intercept only the HTTP transport: the real SDK and runtime request hook still run.
    monkeypatch.setattr(httpx.HTTPTransport, "handle_request", receive)
    with build_anthropic_client(source, base) as client:
        assert client.messages.create(model="fixture-selected", max_tokens=8,
            messages=[{"role": "user", "content": "fixture"}]).stop_reason == "end_turn"
    assert len(sdk_calls) == 1
    assert sdk_calls[0].get(expected_header) == expected_value
    assert other_header not in sdk_calls[0]
    if route == "switch":
        entry = {"name": "Fixture", "base_url": base, "api_mode": "anthropic_messages"}
        entry.update({"key_cmd": command} if credential == "callable" else {"api_key": token})
        atomic_config_write(tmp_path / "config.yaml", {
            "model": {"provider": "custom", "default": "fixture-old"}, "providers": {"relay": entry}})
        result = switch_model("fixture-selected", "custom", "fixture-old",
            current_base_url="http://127.0.0.1:1/v1", explicit_provider="relay",
            user_providers=load_config()["providers"])
        assert result.success, result.error_message
        assert not result.warning_message, result.warning_message
        assert callable(result.api_key) == (credential == "callable")
    else:
        result = {
            "probe": lambda: models.probe_api_models(source, base, api_mode="anthropic_messages")["models"],
            "fetch": lambda: models.fetch_api_models(source, base, api_mode="anthropic_messages"),
            "native": lambda: models._fetch_anthropic_models(api_key=source, base_url=base),
            "cached": lambda: models.cached_fetch_api_models(source, base, api_mode="anthropic_messages"),
            "picker": lambda: _fetch_picker_live_models(source, base, "anthropic", False, api_mode="anthropic_messages"),
        }[route]()
        assert result == ["fixture-selected"], endpoint.calls
    assert endpoint.calls
    assert all(headers.get(expected_header) == sdk_calls[0][expected_header] for _, headers, _ in endpoint.calls)
    assert all(other_header not in headers for _, headers, _ in endpoint.calls)
    from agent.anthropic_adapter import _OAUTH_ONLY_BETAS
    for _, headers, _ in endpoint.calls:
        assert (set(headers.get("anthropic-beta", "").split(",")) & set(_OAUTH_ONLY_BETAS)) == (
            set(sdk_calls[0].get("anthropic-beta", "").split(",")) & set(_OAUTH_ONLY_BETAS))
    assert all(headers.get("anthropic-version") == "2023-06-01" for _, headers, _ in endpoint.calls)
