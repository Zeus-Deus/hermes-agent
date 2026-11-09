"""Real CLI stand-in switches, next-turn refresh and SDK HTTP with synthetic auth.

The GatewayAgent/connection are real; only their RPC peer is scripted. No provider
network or live gateway service is used.
"""

import json
import shlex
import sys

import pytest

from agent.command_token_source import CommandTokenSource
from hermes_cli.config import atomic_config_write, load_config, read_user_config_raw
from hermes_cli.model_switch import persist_model_selection, switch_model
from tests.hermes_cli import test_gateway_agent as gateway_contract
from tests.hermes_cli import test_key_cmd_model_switch_http as http_contract


endpoint = http_contract.endpoint
make_agent = gateway_contract.make_agent

def sdk_request(cli):
    from openai import OpenAI
    from agent.anthropic_adapter import build_anthropic_client

    if cli.api_mode == "anthropic_messages":
        client = build_anthropic_client(cli.api_key, cli.base_url)
        def request():
            return client.messages.create(model=cli.model, max_tokens=8,
                messages=[{"role": "user", "content": "fixture"}]).stop_reason
        return client, request, "end_turn", "/v1/messages"
    client = OpenAI(api_key=cli.api_key, base_url=cli.base_url, max_retries=0)
    if cli.api_mode == "codex_responses":
        def request():
            return client.responses.create(model=cli.model, input="fixture").status
        return client, request, "completed", "/v1/responses"
    def request():
        return client.chat.completions.create(model=cli.model,
            messages=[{"role": "user", "content": "fixture"}]).choices[0].message.content
    return client, request, "fixture reply", "/v1/chat/completions"


@pytest.mark.platforms("posix")
@pytest.mark.parametrize("api_mode", ["chat_completions", "codex_responses", "anthropic_messages"])
@pytest.mark.parametrize("slug", ["relay", "deepseek", "anthropic", "openrouter", "MixedRelay"])
def test_live_agent_switch_refresh_and_token_rotation(tmp_path, monkeypatch, endpoint, make_agent, slug, api_mode):
    from cli import HermesCLI
    from hermes_cli.gateway_agent import GatewayAgent

    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    token_file = tmp_path / "token"
    token_file.write_text(endpoint.token)
    command = shlex.join([sys.executable, "-c",
        "import pathlib,sys; print(pathlib.Path(sys.argv[1]).read_text())", str(token_file)])
    config_path = tmp_path / "config.yaml"
    atomic_config_write(config_path, {
        "model": {"provider": "custom", "default": "fixture-old"},
        "providers": {slug: {"name": "Fixture Relay", "base_url": endpoint.base_url,
                            "key_cmd": command, "api_mode": api_mode,
                            "extra_headers": {"X-Fixture-Route": "retained"}}}})
    picked = switch_model("fixture-selected", "custom", "fixture-old",
        current_base_url="http://127.0.0.1:1/v1", current_api_key="fixture-old-route-key",
        explicit_provider=slug.lower(), user_providers=load_config()["providers"])
    assert picked.success, picked.error_message
    assert not picked.warning_message, picked.warning_message
    assert picked.target_provider == "custom:" + slug.lower()
    assert picked.provider_label == "Fixture Relay"
    assert picked.api_mode == api_mode
    source = picked.api_key
    assert isinstance(source, CommandTokenSource)
    agent, peer = make_agent([], model="fixture-old", provider="custom", base_url="http://127.0.0.1:1/v1")
    connection = agent.connection
    cli = HermesCLI.__new__(HermesCLI)
    fields = dict(agent=agent, _gateway_session_open=True, session_id=agent.session_id,
        model="fixture-old", provider="custom", requested_provider="custom",
        api_key="fixture-old-route-key", _explicit_api_key="fixture-old-route-key",
        base_url="http://127.0.0.1:1/v1", _explicit_base_url="http://127.0.0.1:1/v1",
        api_mode="chat_completions", acp_command=None, acp_args=[],
        reasoning_config=None, _credential_pool=None, _model_is_default=False)
    for name, value in fields.items():
        setattr(cli, name, value)
    assert cli._stage_and_swap_model(picked, cli.model)
    assert cli.agent is agent
    mutations = [params for method, params in peer.calls if method == "session.mutate"]
    assert len(mutations) == 1
    assert mutations[0]["payload"] == {"model": "fixture-selected", "provider": picked.target_provider}
    assert "fixture-token-one" not in json.dumps(peer.calls)
    assert command not in json.dumps(peer.calls)
    assert agent._primary_runtime is None
    assert cli._ensure_runtime_credentials()
    # Named identities resolve to the custom runtime class. The CLI may retire
    # the stand-in on that change; rebuild it on the same session, as production does.
    if cli.agent is None:
        cli.agent = GatewayAgent(connection=connection, session_id=cli.session_id,
            model=cli.model, provider=cli.provider, base_url=cli.base_url, api_mode=cli.api_mode)
    refreshed = cli.agent
    assert cli.api_key is cli._explicit_api_key is source
    assert cli.base_url == endpoint.base_url
    assert cli.api_mode == api_mode
    from hermes_cli.runtime_provider import resolve_runtime_provider
    runtime = resolve_runtime_provider(requested=cli.requested_provider,
        explicit_api_key=cli._explicit_api_key, explicit_base_url=cli._explicit_base_url, target_model=cli.model)
    assert runtime["api_key"] is source
    assert runtime["extra_headers"] == {"X-Fixture-Route": "retained"}
    client, request, expected, path = sdk_request(cli)
    with client:
        assert request() == expected
        endpoint.token = "fixture-token-two"
        token_file.write_text(endpoint.token)
        with source._lock:
            source._expires_at = 0
        assert cli._ensure_runtime_credentials()
        assert cli.agent is refreshed
        assert cli.api_key is source
        assert request() == expected
    persist_model_selection(picked)
    raw = read_user_config_raw(config_path)
    assert raw["providers"][slug]["key_cmd"] == command
    assert raw["model"]["provider"] == picked.target_provider
    assert "api_key" not in raw["model"]
    saved = config_path.read_text()
    assert "fixture-token-one" not in saved and "fixture-token-two" not in saved
    assert [p for p, _, _ in endpoint.calls] == ["/v1/models", path, path]
    assert [h.get("authorization") for _, h, _ in endpoint.calls] == [
        "Bearer fixture-token-one", "Bearer fixture-token-one", "Bearer fixture-token-two"]
    assert endpoint.calls[0][1]["x-fixture-route"] == "retained"
    assert all(body["model"] == "fixture-selected" for _, _, body in endpoint.calls if body)
    assert "fixture-old-route-key" not in repr(endpoint.calls)


@pytest.mark.platforms("posix")
@pytest.mark.parametrize("slug", ["deepseek", "MixedRelay"])
def test_saved_custom_identity_can_be_selected_without_compat_projection(tmp_path, monkeypatch, endpoint, slug):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    command = shlex.join([sys.executable, "-c", "print('fixture-token-one')"])
    atomic_config_write(tmp_path / "config.yaml", {
        "model": {"provider": "custom", "default": "fixture-old"},
        "providers": {slug: {"name": "Fixture Relay", "base_url": endpoint.base_url,
                            "key_cmd": command, "api_mode": "chat_completions"}}})
    result = switch_model("fixture-selected", "custom", "fixture-old",
        current_base_url="http://127.0.0.1:1/v1", explicit_provider="custom:" + slug.lower(),
        user_providers=load_config()["providers"])
    assert result.success, result.error_message
    assert not result.warning_message
    assert result.target_provider == "custom:" + slug.lower()
    assert result.provider_label == "Fixture Relay"
    assert isinstance(result.api_key, CommandTokenSource)
    assert [path for path, _, _ in endpoint.calls] == ["/v1/models"]
