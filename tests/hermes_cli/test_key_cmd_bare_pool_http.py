"""Bare URL-owned commands must not borrow stale static pool rows."""

import shlex
import sys

import pytest
from openai import OpenAI

from agent.command_token_source import CommandTokenError, CommandTokenSource
from hermes_cli.config import atomic_config_write
from hermes_cli.runtime_provider import resolve_runtime_provider
from tests.hermes_cli import test_key_cmd_model_switch_http as http_contract

endpoint = http_contract.endpoint


@pytest.mark.platforms("posix")
@pytest.mark.parametrize("route", ["named", "bare-explicit-url", "bare-config-url"])
@pytest.mark.parametrize("outcome", ["success", "failure"])
@pytest.mark.parametrize("override", [None, "static", "callable"])
def test_owned_command_beats_pool_at_sdk_boundary(tmp_path, monkeypatch, endpoint, route, outcome, override):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    if outcome == "failure" and not override:
        endpoint.token = "fixture-stale-static"  # Borrowing the pool would incorrectly succeed.
    token_file, mint_log = tmp_path / "token", tmp_path / "mints"
    token_file.write_text(endpoint.token)
    program = ("import pathlib,sys; pathlib.Path(sys.argv[2]).write_text('mint'); "
               + ("print(pathlib.Path(sys.argv[1]).read_text())" if outcome == "success" else "raise SystemExit(1)"))
    command = shlex.join([sys.executable, "-c", program, str(token_file), str(mint_log)])
    atomic_config_write(tmp_path / "config.yaml", {
        "model": {"provider": "custom", "default": "fixture-selected", "base_url": endpoint.base_url},
        "providers": {"relay": {"base_url": endpoint.base_url, "api_key": "fixture-stale-static", "key_cmd": command}}})
    kwargs = {"requested": "relay" if route == "named" else "custom", "target_model": "fixture-selected"}
    if route == "bare-explicit-url":
        kwargs["explicit_base_url"] = endpoint.base_url
    if override:
        kwargs["explicit_api_key"] = (lambda: endpoint.token) if override == "callable" else endpoint.token
    runtime = resolve_runtime_provider(**kwargs)
    assert not mint_log.exists()  # Resolution must be lazy, including a failing command.
    with OpenAI(api_key=runtime["api_key"], base_url=runtime["base_url"], max_retries=0) as client:
        def request():
            return client.chat.completions.create(model="fixture-selected",
                messages=[{"role": "user", "content": "fixture"}]).choices[0].message.content
        if outcome == "failure" and not override:
            with pytest.raises(CommandTokenError, match="exited 1"):
                request()
            assert mint_log.read_text() == "mint"
            assert endpoint.calls == []
            assert isinstance(runtime["api_key"], CommandTokenSource)
            return
        assert request() == "fixture reply"
        if not override:
            source = runtime["api_key"]
            assert isinstance(source, CommandTokenSource)
            endpoint.token = "fixture-rotated-command"
            token_file.write_text(endpoint.token)
            with source._lock:
                source._expires_at = 0
            assert request() == "fixture reply"
    assert mint_log.exists() == (override is None)
    assert [h["authorization"] for _, h, _ in endpoint.calls] == (
        ["Bearer fixture-token-one", "Bearer fixture-rotated-command"] if not override else ["Bearer fixture-token-one"])
    assert "fixture-stale-static" not in repr(endpoint.calls)


@pytest.mark.platforms("posix")
@pytest.mark.parametrize("explicit_url", [False, True])
def test_foreign_entry_command_is_not_borrowed(tmp_path, monkeypatch, endpoint, explicit_url):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    mint_log = tmp_path / "mints"
    command = shlex.join([sys.executable, "-c", "import pathlib,sys; pathlib.Path(sys.argv[1]).write_text('mint'); print('foreign-key')", str(mint_log)])
    endpoint.token = "no-key-required"
    atomic_config_write(tmp_path / "config.yaml", {
        "model": {"provider": "custom", "default": "fixture-selected", "base_url": endpoint.base_url},
        "providers": {"foreign": {"base_url": "http://127.0.0.1:1/v1", "api_key": "foreign-static", "key_cmd": command}}})
    runtime = resolve_runtime_provider(requested="custom", **({"explicit_base_url": endpoint.base_url} if explicit_url else {}))
    with OpenAI(api_key=runtime["api_key"], base_url=runtime["base_url"], max_retries=0) as client:
        assert client.chat.completions.create(model="fixture-selected", messages=[{"role": "user", "content": "fixture"}]).choices[0].message.content == "fixture reply"
    assert not mint_log.exists()
    assert [h["authorization"] for _, h, _ in endpoint.calls] == ["Bearer no-key-required"]
