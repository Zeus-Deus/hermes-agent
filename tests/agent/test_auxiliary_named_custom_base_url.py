"""Auxiliary routes naming a configured custom provider AND a base_url keep the provider's settings.

An inline ``api_key`` on the task, or a caller passing ``provider="custom:<name>"`` with a base_url,
used to collapse the route to anonymous ``custom``: the provider's transport was dropped (chat
completions sent to a Responses-only endpoint) and, without an inline key, the ambient
``OPENAI_API_KEY`` was sent instead of the provider's own key. A local endpoint that serves only
``/v1/responses`` records what actually arrives.
"""

import json
import os
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

import hermes_yaml as yaml


class _ResponsesOnly(BaseHTTPRequestHandler):
    seen: list = []
    reject = False

    def log_message(self, *_args):
        pass

    def do_POST(self):
        self.rfile.read(int(self.headers.get("Content-Length") or 0))
        type(self).seen.append((self.path, self.headers.get("Authorization"), self.headers.get("X-Route-Tag")))
        if type(self).reject:
            self._send(401, "application/json", b'{"error": {"message": "invalid key"}}')
            return
        if self.path != "/v1/responses":
            self._send(404, "application/json", b'{"error": {"message": "not found"}}')
            return
        response = {"id": "resp_1", "object": "response", "created_at": 1, "status": "completed", "model": "m",
                    "output": [{"id": "msg_1", "type": "message", "role": "assistant", "status": "completed",
                                "content": [{"type": "output_text", "text": "ok", "annotations": []}]}],
                    "usage": {"input_tokens": 1, "output_tokens": 1, "total_tokens": 2}}
        events = [{"type": "response.created", "response": dict(response, status="in_progress", output=[]),
                   "sequence_number": 0},
                  {"type": "response.output_item.done", "item": response["output"][0], "output_index": 0,
                   "sequence_number": 1},
                  {"type": "response.completed", "response": response, "sequence_number": 2}]
        self._send(200, "text/event-stream", "".join(f"data: {json.dumps(e)}\n\n" for e in events).encode())

    def _send(self, status, content_type, raw):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)


@pytest.fixture
def endpoint():
    _ResponsesOnly.seen, _ResponsesOnly.reject = [], False
    server = ThreadingHTTPServer(("127.0.0.1", 0), _ResponsesOnly)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    yield f"http://127.0.0.1:{server.server_port}/v1"
    server.shutdown()
    server.server_close()
    thread.join()


@pytest.fixture
def write_config(endpoint, monkeypatch):
    home = Path(os.environ["HERMES_HOME"])
    home.mkdir(parents=True, exist_ok=True)
    key_file = home / "proxy.key"
    key_file.write_text("cmd-secret\n")
    monkeypatch.setenv("OPENAI_API_KEY", "ambient-openai-key")

    def write(auxiliary=None, providers=None, pool=None):
        (home / "config.yaml").write_text(yaml.safe_dump({
            "model": {"provider": "openrouter", "default": "parent/model"},
            "providers": providers or {"cliproxy": {
                "name": "cliproxy", "api": endpoint, "transport": "codex_responses",
                "key_cmd": f"cat {key_file}", "extra_headers": {"X-Route-Tag": "alpha"}}},
            "auxiliary": auxiliary or {},
        }))
        (home / "auth.json").write_text(json.dumps({"version": 1, "providers": {}, "credential_pool": pool or {}}))
    return write


def _ask(**kwargs):
    from agent.auxiliary_client import call_llm
    return call_llm(messages=[{"role": "user", "content": "hi"}], max_tokens=16, **kwargs)


def test_task_with_inline_key_keeps_the_providers_responses_transport(write_config, endpoint):
    write_config({"compression": {"provider": "custom:cliproxy", "model": "m", "base_url": endpoint,
                                  "api_key": "inline-key"}})
    _ask(task="compression")
    assert _ResponsesOnly.seen == [("/v1/responses", "Bearer inline-key", "alpha")]


def test_named_provider_with_base_url_sends_its_own_key_not_the_ambient_one(write_config, endpoint):
    write_config()
    _ask(provider="custom:cliproxy", model="m", base_url=endpoint)
    assert _ResponsesOnly.seen == [("/v1/responses", "Bearer cmd-secret", "alpha")]


def test_entry_named_like_a_builtin_keeps_its_own_key(write_config, endpoint, monkeypatch):
    """``custom:openrouter`` is the user's entry, never the built-in OpenRouter branch and its key."""
    monkeypatch.setenv("OPENROUTER_API_KEY", "builtin-openrouter-key")
    monkeypatch.setenv("PROXY_KEY", "entry-env-key")
    write_config(providers={"openrouter": {"api": endpoint, "transport": "codex_responses", "key_env": "PROXY_KEY"}})
    _ask(provider="custom:openrouter", model="m", base_url=endpoint)
    assert _ResponsesOnly.seen == [("/v1/responses", "Bearer entry-env-key", None)]


def test_entry_pool_key_stays_on_the_entrys_endpoint(write_config, endpoint):
    """A route moved to another endpoint must not borrow the entry's ``hermes auth add`` pool row: the
    pool holds credentials for the entry's own URL, like on every other pool lookup."""
    row = {"id": "m1", "label": "manual", "auth_type": "api_key", "priority": 0, "source": "manual",
           "access_token": "pooled-entry-key-0123"}
    write_config(auxiliary={"compression": {"provider": "custom:pooled", "model": "m", "base_url": endpoint}},
                 providers={"pooled": {"api": "https://proxy.example/v1", "transport": "codex_responses"}},
                 pool={"pooled": [row]})
    _ask(task="compression")
    assert [auth for _path, auth, _tag in _ResponsesOnly.seen] == ["Bearer no-key-required"]


@pytest.mark.parametrize("provider", ["or", "custom:or"])
def test_entry_named_like_a_builtin_alias_never_borrows_the_builtins_key_or_pool(write_config, endpoint, monkeypatch,
                                                                             provider):
    """``or`` normalizes to ``openrouter``; a ``providers.or`` entry is still the user's endpoint, so neither
    the built-in branch's key nor a row of the ``openrouter`` pool may stand in for the entry's own."""
    monkeypatch.setenv("OPENROUTER_API_KEY", "builtin-openrouter-key")
    monkeypatch.setenv("PROXY_KEY", "entry-env-key")
    row = {"id": "o1", "label": "manual", "auth_type": "api_key", "priority": 0, "source": "manual",
           "access_token": "openrouter-pool-key-0123"}
    write_config(providers={"or": {"api": endpoint, "transport": "codex_responses", "key_env": "PROXY_KEY"}},
                 pool={"openrouter": [row]})
    _ask(provider=provider, model="m", base_url=endpoint)
    assert _ResponsesOnly.seen == [("/v1/responses", "Bearer entry-env-key", None)]


def test_vision_route_keeps_the_entry_named_like_a_builtin(write_config, endpoint, monkeypatch):
    from agent.auxiliary_client import resolve_vision_provider_client
    monkeypatch.setenv("OPENROUTER_API_KEY", "builtin-openrouter-key")
    monkeypatch.setenv("PROXY_KEY", "entry-env-key")
    write_config(providers={"openrouter": {"api": endpoint, "transport": "codex_responses", "key_env": "PROXY_KEY"}})
    _provider, client, _model = resolve_vision_provider_client("custom:openrouter", "m", base_url=endpoint)
    client.chat.completions.create(model="m", messages=[{"role": "user", "content": "hi"}], max_tokens=16)
    assert _ResponsesOnly.seen == [("/v1/responses", "Bearer entry-env-key", None)]


def test_rejected_entry_key_never_refreshes_or_rotates_a_builtins_credentials(write_config, endpoint, monkeypatch):
    """A 401 from ``custom:nous`` / ``or`` is the entry's own key failing: no built-in OAuth grant is
    refreshed and retried, and no row of the built-in's pool is marked exhausted."""
    import agent.auxiliary_client as aux
    from agent.credential_pool import load_pool
    refreshed = []
    monkeypatch.setattr(aux, "_refresh_provider_credentials", lambda provider, **_kw: refreshed.append(provider) or True)
    monkeypatch.setenv("PROXY_KEY", "entry-env-key")
    row = {"id": "o1", "label": "manual", "auth_type": "api_key", "priority": 0, "source": "manual",
           "access_token": "openrouter-pool-key-0123"}
    entry = {"api": endpoint, "transport": "codex_responses", "key_env": "PROXY_KEY"}
    write_config(providers={"nous": entry, "or": entry}, pool={"openrouter": [row]})
    _ResponsesOnly.reject = True
    for provider in ("custom:nous", "or"):
        with pytest.raises(Exception):
            _ask(provider=provider, model="m", base_url=endpoint)
    assert refreshed == []
    assert {auth for _path, auth, _tag in _ResponsesOnly.seen} == {"Bearer entry-env-key"}
    assert [e.last_status for e in load_pool("openrouter").entries()] == [None]


def test_entry_on_a_builtins_host_does_not_refresh_or_rotate_the_builtins_credentials(write_config, monkeypatch):
    """Host inference must not pick a built-in's grant or pool for a configured entry either
    (``custom:xai-oauth`` or ``ollama`` pointed at api.x.ai): its rejected key is its own."""
    from types import SimpleNamespace
    import agent.auxiliary_client as aux
    monkeypatch.setenv("PROXY_KEY", "entry-env-key")
    entry = {"api": "https://api.x.ai/v1", "key_env": "PROXY_KEY"}
    write_config(providers={"xai-oauth": entry, "ollama": entry})
    assert aux._auth_refresh_provider_for_route("custom:xai-oauth", "https://api.x.ai/v1") == ""
    client = SimpleNamespace(base_url="https://api.x.ai/v1", api_key="entry-env-key")
    for name in ("custom:xai-oauth", "ollama"):
        pool_provider = aux._recoverable_pool_provider(name, client)
        assert pool_provider == name and aux._recover_provider_pool(pool_provider, Exception("401")) is False
