"""Native OAuth catalogs and SDK calls agree on auth and beta headers on real HTTP."""

import shlex
import sys
import urllib.parse

import httpx
import pytest

from agent.command_token_source import CommandTokenSource
from hermes_cli.config import atomic_config_write, load_config
from tests.hermes_cli import test_key_cmd_live_gateway_switch as live
from tests.hermes_cli.test_key_cmd_repeated_switch import cli_for, stage_and_refresh

endpoint = live.endpoint
old_endpoint = live.endpoint
make_agent = live.make_agent
NATIVE_BASE = "https://api.anthropic.com/v1"
OAUTH_TOKEN = "sk-ant-oat01-fixture-synthetic"


def forward_native(monkeypatch, endpoint):
    from hermes_cli import models

    original_get = models._get_json
    def get(url, **kwargs):
        parsed = urllib.parse.urlsplit(url)
        assert parsed.hostname == "api.anthropic.com"
        return original_get(endpoint.base_url.removesuffix("/v1") + parsed.path, **kwargs)
    monkeypatch.setattr(models, "_get_json", get)
    original_send = httpx.HTTPTransport.handle_request
    def send(transport, request):
        assert request.url.host == "api.anthropic.com"
        request.url = httpx.URL(endpoint.base_url.removesuffix("/v1") + request.url.path)
        return original_send(transport, request)
    monkeypatch.setattr(httpx.HTTPTransport, "handle_request", send)


@pytest.mark.platforms("posix")
@pytest.mark.parametrize("route", ["probe", "fetch", "cached", "picker", "switch", "native"])
def test_native_oauth_catalog_matches_sdk(tmp_path, monkeypatch, endpoint, old_endpoint, make_agent, route):
    from agent.anthropic_adapter import build_anthropic_client
    from hermes_cli import models
    from hermes_cli.model_switch import switch_model
    from hermes_cli.model_switch_providers import _fetch_picker_live_models

    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    endpoint.token = OAUTH_TOKEN
    class Handler(endpoint.RequestHandlerClass):
        def do_GET(self):
            headers = {k.lower(): v for k, v in self.headers.items()}
            self.server.calls.append((self.path, headers, None))
            if (headers.get("authorization") != "Bearer " + OAUTH_TOKEN or
                    "oauth-2025-04-20" not in headers.get("anthropic-beta", "")):
                return self.reply(401, {"error": "native OAuth beta required"})
            self.reply(200, {"data": [{"id": "fixture-selected"}]})
    endpoint.RequestHandlerClass = Handler
    forward_native(monkeypatch, endpoint)
    mint_log = tmp_path / "mints"
    command = shlex.join([sys.executable, "-c",
        "import pathlib,sys; p=pathlib.Path(sys.argv[1]); p.write_text(p.read_text()+'mint' if p.exists() else 'mint'); print(sys.argv[2])",
        str(mint_log), OAUTH_TOKEN])
    source = CommandTokenSource(command, "Fixture OAuth")
    if route == "switch":
        atomic_config_write(tmp_path / "config.yaml", {
            "model": {"provider": "custom", "default": "fixture-old"},
            "providers": {"relay": {"base_url": NATIVE_BASE, "key_cmd": command,
                                    "api_mode": "anthropic_messages"}}})
        picked = switch_model("fixture-selected", "custom", "fixture-old",
            current_base_url=old_endpoint.base_url, explicit_provider="relay", user_providers=load_config()["providers"])
        cli, connection, _ = cli_for(old_endpoint, make_agent)
        stage_and_refresh(cli, picked, connection)
        assert isinstance(cli.api_key, CommandTokenSource)
        assert cli.base_url == NATIVE_BASE
        source = cli.api_key
    else:
        result = {
            "probe": lambda: models.probe_api_models(source, NATIVE_BASE, api_mode="anthropic_messages")["models"],
            "fetch": lambda: models.fetch_api_models(source, NATIVE_BASE, api_mode="anthropic_messages"),
            "cached": lambda: models.cached_fetch_api_models(source, NATIVE_BASE, api_mode="anthropic_messages"),
            "picker": lambda: _fetch_picker_live_models(source, NATIVE_BASE, "anthropic", False, api_mode="anthropic_messages"),
            "native": lambda: models._fetch_anthropic_models(api_key=source, base_url=NATIVE_BASE),
        }[route]()
        assert result == ["fixture-selected"], endpoint.calls
    with build_anthropic_client(source, NATIVE_BASE) as client:
        reply = client.messages.create(model="fixture-selected", max_tokens=8,
            messages=[{"role": "user", "content": "fixture"}])
        assert reply.stop_reason == "end_turn"
    assert mint_log.read_text() == "mint"
    assert [p for p, _, _ in endpoint.calls] == ["/v1/models", "/v1/messages"]
    catalog_headers, sdk_headers = [h for _, h, _ in endpoint.calls]
    assert set(catalog_headers["anthropic-beta"].split(",")) == set(sdk_headers["anthropic-beta"].split(","))
    assert catalog_headers["authorization"] == sdk_headers["authorization"] == "Bearer " + OAUTH_TOKEN
    assert "x-api-key" not in catalog_headers and "x-api-key" not in sdk_headers
    assert old_endpoint.calls == []


@pytest.mark.parametrize("credential", ["native-oauth", "static-console", "callable-console", "foreign-oauth",
                                        "failed", "empty", "non-string", "override"])
def test_probe_beta_scope_override_and_single_snapshot(tmp_path, monkeypatch, endpoint, credential):
    from hermes_cli import models

    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    calls = []
    token = "sk-ant-api03-fixture" if "console" in credential else OAUTH_TOKEN
    endpoint.token = token
    if "console" in credential:
        endpoint.auth_header, endpoint.auth_prefix = "x-api-key", ""
    def source():
        calls.append(True)
        if credential == "failed":
            raise RuntimeError("fixture-secret-not-for-wire")
        return {"empty": "", "non-string": object()}.get(credential, token) if len(calls) == 1 else "fixture-second-mint"

    native = credential != "foreign-oauth"
    base = NATIVE_BASE.removesuffix("/v1") if native else endpoint.base_url.removesuffix("/v1")
    if native:
        forward_native(monkeypatch, endpoint)
    headers = {"anthropic-beta": "fixture-caller-beta", "authorization": "Bearer " + token} if credential == "override" else None
    key = token if credential == "static-console" else source
    result = models.probe_api_models(key, base, api_mode="anthropic_messages", request_headers=headers)
    invalid = credential in ("failed", "empty", "non-string")
    assert result["models"] == (None if invalid else ["fixture-selected"])
    assert calls == ([] if credential == "static-console" else [True])
    assert [p for p, _, _ in endpoint.calls] == ["/models", "/v1/models"]
    for _, recorded, _ in endpoint.calls:
        assert recorded["anthropic-version"] == "2023-06-01"
        if invalid:
            assert "authorization" not in recorded and "x-api-key" not in recorded
        else:
            assert recorded[endpoint.auth_header] == endpoint.auth_prefix + token
        if credential == "native-oauth":
            assert "oauth-2025-04-20" in recorded["anthropic-beta"]
        elif credential == "override":
            assert recorded["anthropic-beta"] == "fixture-caller-beta"
        else:
            assert "anthropic-beta" not in recorded
