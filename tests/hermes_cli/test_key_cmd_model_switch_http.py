"""Callable credentials survive catalog verification, CLI application and SDK refresh."""

import json
import shlex
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Thread

import pytest

from agent.command_token_source import CommandTokenSource
from hermes_cli.config import atomic_config_write, load_config, read_user_config_raw
from hermes_cli.model_switch import persist_model_selection, switch_model
from hermes_cli.runtime_provider import resolve_runtime_provider


@pytest.fixture
def endpoint():
    class Server(ThreadingHTTPServer):
        token = "fixture-token-one"
        calls = None
        native = False
        auth_header = "authorization"
        auth_prefix = "Bearer "

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def reply(self, status, body):
            data = json.dumps(body).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_GET(self):
            self.server.calls.append((self.path, dict((key.lower(), value) for key, value in self.headers.items()), None))
            if self.headers.get(self.server.auth_header) != self.server.auth_prefix + self.server.token:
                return self.reply(401, {"error": "fixture authentication required"})
            if self.path == "/api/tags" and self.server.native:
                return self.reply(200, {"models": [{"name": "fixture-selected"}]})
            if self.path.split("?", 1)[0] == "/v1/models":
                return self.reply(200, {"data": [{"id": "fixture-selected"}]})
            self.reply(404, {})

        def do_POST(self):
            body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            self.server.calls.append((self.path, dict((key.lower(), value) for key, value in self.headers.items()), body))
            if self.headers.get(self.server.auth_header) != self.server.auth_prefix + self.server.token:
                return self.reply(401, {"error": {"message": "fixture authentication required"}})
            if self.path == "/v1/messages":
                return self.reply(200, {"id": "msg_fixture", "type": "message", "role": "assistant",
                                       "model": body["model"], "content": [], "stop_reason": "end_turn",
                                       "usage": {"input_tokens": 1, "output_tokens": 1}})
            if self.path == "/v1/chat/completions":
                return self.reply(200, {"id": "chatcmpl_fixture", "object": "chat.completion",
                    "created": 1, "model": body["model"], "choices": [{"index": 0,
                    "message": {"role": "assistant", "content": "fixture reply"}, "finish_reason": "stop"}]})
            self.reply(200, {"id": "resp_fixture", "object": "response", "created_at": 1,
                             "model": body["model"], "status": "completed", "output": []})

    with Server(("127.0.0.1", 0), Handler) as server:
        server.calls = []
        server.base_url = f"http://127.0.0.1:{server.server_port}/v1"
        worker = Thread(target=server.serve_forever)
        worker.start()
        try:
            yield server
        finally:
            server.shutdown()
            worker.join()


@pytest.mark.platforms("posix")
@pytest.mark.parametrize("api_mode", ["codex_responses", "chat_completions", "anthropic_messages"])
def test_key_cmd_switch_next_sdk_request_rotates(tmp_path, monkeypatch, endpoint, api_mode):
    from cli import HermesCLI
    from openai import OpenAI
    from agent.anthropic_adapter import build_anthropic_client

    home = tmp_path / "home"
    home.mkdir()
    monkeypatch.setenv("HERMES_HOME", str(home))
    token_file = tmp_path / "token"
    token_file.write_text(endpoint.token)
    command = shlex.join([sys.executable, "-c", "import pathlib,sys; print(pathlib.Path(sys.argv[1]).read_text())", str(token_file)])
    config_path = home / "config.yaml"
    atomic_config_write(config_path, {
        "model": {"provider": "custom", "default": "fixture-old",
                  "base_url": "http://127.0.0.1:1/v1", "api_key": "fixture-old-route-key"},
        "providers": {"relay": {"name": "Relay", "base_url": endpoint.base_url,
                                  "key_cmd": command, "api_mode": api_mode}},
    })
    config = load_config()
    assert "models" not in config["providers"]["relay"]
    result = switch_model("fixture-selected", "custom", "fixture-old",
                          current_base_url="http://127.0.0.1:1/v1",
                          current_api_key="fixture-old-route-key", explicit_provider="relay",
                          user_providers=config["providers"])
    assert result.success, result.error_message
    assert not result.warning_message
    assert result.api_mode == api_mode
    source = result.api_key
    assert isinstance(source, CommandTokenSource)
    assert [path for path, _, _ in endpoint.calls] == ["/v1/models"]

    cli = HermesCLI.__new__(HermesCLI)
    cli.agent = None
    cli.model, cli.provider = "fixture-old", "custom"
    cli.api_key = cli._explicit_api_key = "fixture-old-route-key"
    cli.base_url = cli._explicit_base_url = "http://127.0.0.1:1/v1"
    assert cli._stage_and_swap_model(result, cli.model)
    assert cli._explicit_api_key is source
    assert cli.api_key is source
    runtime = resolve_runtime_provider(requested=cli.requested_provider,
                                       explicit_api_key=cli._explicit_api_key,
                                       explicit_base_url=cli._explicit_base_url, target_model=cli.model)
    assert runtime["api_key"] is source
    assert runtime["api_mode"] == result.api_mode
    assert runtime["base_url"] == endpoint.base_url
    if api_mode == "anthropic_messages":
        client = build_anthropic_client(source, runtime["base_url"])
        def request():
            return client.messages.create(model=cli.model, max_tokens=8,
                                          messages=[{"role": "user", "content": "fixture"}]).stop_reason
        expected = "end_turn"
        request_path = "/v1/messages"
    else:
        client = OpenAI(api_key=source, base_url=runtime["base_url"], max_retries=0)
        if api_mode == "codex_responses":
            def request():
                return client.responses.create(model=cli.model, input="fixture").status
            expected, request_path = "completed", "/v1/responses"
        else:
            def request():
                return client.chat.completions.create(model=cli.model,
                    messages=[{"role": "user", "content": "fixture"}]).choices[0].message.content
            expected, request_path = "fixture reply", "/v1/chat/completions"
    with client:
        assert request() == expected
        endpoint.token = "fixture-token-two"
        token_file.write_text(endpoint.token)
        with source._lock:
            source._expires_at = 0
        assert request() == expected
    persist_model_selection(result)
    raw = read_user_config_raw(config_path)
    assert raw["providers"]["relay"]["key_cmd"] == command
    assert raw["model"]["default"] == "fixture-selected"
    assert "api_key" not in raw["model"]
    saved = config_path.read_text()
    assert "fixture-token-one" not in saved and "fixture-token-two" not in saved
    assert [path for path, _, _ in endpoint.calls] == ["/v1/models", request_path, request_path]
    assert [headers.get("authorization") for _, headers, _ in endpoint.calls] == [
        "Bearer fixture-token-one", "Bearer fixture-token-one", "Bearer fixture-token-two"]
    assert all(body["model"] == "fixture-selected" for _, _, body in endpoint.calls if body)
    assert "fixture-old-route-key" not in repr(endpoint.calls)


@pytest.mark.parametrize("route", ["native", "native-fallback", "detect-native", "detect-fallback", "static"])
def test_probe_credential_snapshot_is_lazy(tmp_path, monkeypatch, endpoint, route):
    from hermes_cli.models_validate import validate_requested_model

    calls = []
    def source():
        calls.append(True)
        return endpoint.token if len(calls) == 1 else "fixture-duplicate-mint"

    if route == "static":
        verdict = validate_requested_model("MiniMax-M2.7", "minimax", api_key=source)
        assert verdict["recognized"], verdict
        assert calls == []
        assert endpoint.calls == []
        return

    endpoint.native = route in ("native", "detect-native")
    detecting = route.startswith("detect-")
    headers = None if detecting else {"X-Fixture": "present"}
    config_path = tmp_path / "config.yaml"
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    atomic_config_write(config_path, {"providers": {"ollama": {
        "base_url": "http://127.0.0.1:1/v1" if detecting else endpoint.base_url,
        "extra_headers": {"Authorization": "Bearer fixture-config-key"}}}})
    verdict = validate_requested_model("fixture-selected", "ollama", api_key=source,
                                       base_url=endpoint.base_url, headers=headers)
    assert verdict["recognized"], verdict
    assert calls == [True]
    paths = [path for path, _, _ in endpoint.calls]
    assert paths == (["/api/tags"] if endpoint.native else ["/api/tags", "/v1/models"])
    assert all(headers.get("authorization") == "Bearer " + endpoint.token for _, headers, _ in endpoint.calls)
    if headers:
        assert all(recorded.get("x-fixture") == "present" for _, recorded, _ in endpoint.calls)


@pytest.mark.platforms("posix")
@pytest.mark.parametrize("route", ["probe", "fetch", "cached", "picker", "anthropic-native", "owned", "custom", "generic"])
@pytest.mark.parametrize("credential", ["static", "callable"])
def test_catalog_auth_snapshot(tmp_path, monkeypatch, endpoint, route, credential):
    from hermes_cli import models
    from hermes_cli.models_validate import validate_requested_model
    from hermes_cli.model_switch_providers import _fetch_picker_live_models

    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    calls = []
    def source():
        calls.append(True)
        return endpoint.token if len(calls) == 1 else "fixture-duplicate-mint"

    key = source if credential == "callable" else endpoint.token
    mint_log = tmp_path / "mints"
    if credential == "callable" and route in ("cached", "picker"):
        command = shlex.join([sys.executable, "-c",
            "import pathlib,sys; p=pathlib.Path(sys.argv[1]); p.write_text(p.read_text()+'mint\\n' if p.exists() else 'mint\\n'); print(sys.argv[2])",
            str(mint_log), endpoint.token])
        key = CommandTokenSource(command, "Fixture")
    anthropic = route not in ("owned", "generic")
    if anthropic and credential == "static":
        endpoint.auth_header, endpoint.auth_prefix = "x-api-key", ""
    mode = "anthropic_messages" if anthropic else "chat_completions"
    # Exercise the URL fallback with the SAME snapshot, not a second mint.
    base = endpoint.base_url.removesuffix("/v1")
    def cached():
        assert models.cached_fetch_api_models(key, base, api_mode=mode, cache_only=True) is None
        assert calls == [] and not mint_log.exists()
        result = models.cached_fetch_api_models(key, base, api_mode=mode)
        before = len(endpoint.calls)
        assert models.cached_fetch_api_models(key, base, api_mode=mode) == result
        assert models.cached_fetch_api_models(key, base, api_mode=mode, cache_only=True) == result
        assert len(endpoint.calls) == before
        return result

    def picker():
        result = _fetch_picker_live_models(key, base, "custom", False, api_mode=mode)
        before = len(endpoint.calls)
        assert _fetch_picker_live_models(key, base, "custom", False, api_mode=mode) == result
        assert len(endpoint.calls) == before
        return result

    def owned():
        class Owner:
            def probe_models(self, *, base_url, api_key, timeout):
                data = models._get_json(base_url + "/models", timeout=timeout,
                                        headers={"Authorization": f"Bearer {api_key}"})
                return [row["id"] for row in data["data"]], base_url + "/models", base_url
        monkeypatch.setattr("providers.profile_for_host", lambda *args, **kwargs: Owner())
        return models.probe_api_models(key, endpoint.base_url)["models"]

    def validated(provider):
        verdict = validate_requested_model("fixture-selected", provider, api_key=key, base_url=base, api_mode=mode)
        assert verdict["recognized"], verdict
        return ["fixture-selected"]

    result = {
        "probe": lambda: models.probe_api_models(key, base, api_mode=mode)["models"],
        "fetch": lambda: models.fetch_api_models(key, base, api_mode=mode),
        "cached": cached,
        "picker": picker,
        "anthropic-native": lambda: models._fetch_anthropic_models(api_key=key, base_url=endpoint.base_url),
        "owned": owned,
        "custom": lambda: validated("custom"),
        "generic": lambda: validated("fixture-provider"),
    }[route]()
    assert result == ["fixture-selected"]
    if isinstance(key, CommandTokenSource):
        calls = [True] * mint_log.read_text().count("mint")
    assert calls == ([True] if credential == "callable" else [])
    assert all(headers.get(endpoint.auth_header) == endpoint.auth_prefix + endpoint.token
               for _, headers, _ in endpoint.calls)
    if anthropic:
        assert all(headers.get("anthropic-version") == "2023-06-01" for _, headers, _ in endpoint.calls)
        other = "x-api-key" if credential == "callable" else "Authorization"
        assert all(other.lower() not in {key.lower() for key in headers} for _, headers, _ in endpoint.calls)
    if route not in ("anthropic-native", "owned"):
        assert [path for path, _, _ in endpoint.calls] == ["/models", "/v1/models"]


@pytest.mark.parametrize("route", ["probe", "native", "anthropic-native"])
@pytest.mark.parametrize("outcome", ["raises", "empty", "non-string", "override"])
def test_probe_bad_credentials_never_leak_or_borrow(tmp_path, monkeypatch, endpoint, caplog, route, outcome):
    import logging
    from hermes_cli import models
    from hermes_cli.models_validate import validate_requested_model

    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    atomic_config_write(tmp_path / "config.yaml", {"providers": {"ollama": {
        "base_url": endpoint.base_url, "extra_headers": {"Authorization": "Bearer fixture-config-key"}}}})
    caplog.set_level(logging.DEBUG)
    calls = []
    def source():
        calls.append(True)
        if outcome == "raises":
            raise RuntimeError("fixture-secret-do-not-log")
        return {"empty": "  ", "non-string": object(), "override": "fixture-source-key"}[outcome]

    headers = {"authorization": "Bearer " + endpoint.token} if outcome == "override" else None
    if route == "native":
        endpoint.native = True
        result = validate_requested_model("fixture-selected", "ollama", api_key=source,
                                          base_url=endpoint.base_url, headers=headers)
        assert result["recognized"] == (outcome == "override")
    elif route == "anthropic-native":
        # This API has no extra-header override; a callable's token uses Bearer directly.
        if outcome == "override":
            endpoint.token = "fixture-source-key"
        result = models._fetch_anthropic_models(api_key=source, base_url=endpoint.base_url)
        assert bool(result) == (outcome == "override")
    else:
        result = models.probe_api_models(source, endpoint.base_url, request_headers=headers)
        assert bool(result["models"]) == (outcome == "override")
    assert calls == [True]
    assert "fixture-secret-do-not-log" not in caplog.text
    assert models._probe_neg_key(endpoint.base_url) not in models._probe_neg_cache
    recorded = repr(endpoint.calls)
    assert "fixture-config-key" not in recorded
    assert "fixture-source-key" not in recorded or route == "anthropic-native"
    assert "<function" not in recorded and "object at" not in recorded
    if outcome != "override":
        assert all("authorization" not in headers and "x-api-key" not in headers
                   for _, headers, _ in endpoint.calls)


@pytest.mark.parametrize("generic_owner", [False, True])
def test_probe_fast_exits_do_not_mint(monkeypatch, endpoint, generic_owner):
    import time
    from hermes_cli import models
    from providers.base import ProviderProfile

    if generic_owner:
        monkeypatch.setattr("providers.profile_for_host", lambda *args, **kwargs: ProviderProfile(name="fixture"))

    calls = []
    def source():
        calls.append(True)
        return endpoint.token

    assert models.probe_api_models(source, "")["models"] is None
    monkeypatch.setattr(models, "_probe_neg_cache", {
        models._probe_neg_key(endpoint.base_url): time.monotonic()})
    assert models.probe_api_models(source, endpoint.base_url)["models"] is None
    assert calls == [] and endpoint.calls == []
