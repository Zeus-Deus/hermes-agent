"""Repeated public CLI selections must not return to the configured old account."""

import shlex
import sys

import pytest

from agent.command_token_source import CommandTokenSource
from hermes_cli.config import atomic_config_write, get_compatible_custom_providers, load_config
from hermes_cli.cli_model_switch_mixin import _switch_model_from
from tests.hermes_cli import test_key_cmd_live_gateway_switch as live

endpoint = live.endpoint
old_endpoint = live.endpoint
make_agent = live.make_agent


def cli_for(old_endpoint, make_agent):
    from cli import HermesCLI

    agent, peer = make_agent([], model="fixture-old", provider="custom", base_url=old_endpoint.base_url)
    cli = HermesCLI.__new__(HermesCLI)
    fields = dict(agent=agent, _gateway_session_open=True, session_id=agent.session_id,
        model="fixture-old", provider="custom", requested_provider="custom",
        api_key=old_endpoint.token, _explicit_api_key=old_endpoint.token,
        base_url=old_endpoint.base_url, _explicit_base_url=old_endpoint.base_url,
        api_mode="chat_completions", acp_command=None, acp_args=[],
        reasoning_config=None, _credential_pool=None, _model_is_default=False)
    for name, value in fields.items():
        setattr(cli, name, value)
    return cli, agent.connection, peer


def stage_and_refresh(cli, result, connection):
    from hermes_cli.gateway_agent import GatewayAgent

    assert result.success, result.error_message
    assert not result.warning_message, result.warning_message
    assert cli._stage_and_swap_model(result, cli.model)
    assert cli._ensure_runtime_credentials()
    if cli.agent is None:
        cli.agent = GatewayAgent(connection=connection, session_id=cli.session_id,
            model=cli.model, provider=cli.provider, base_url=cli.base_url, api_mode=cli.api_mode)


def catalog_of_two(server):
    class Handler(server.RequestHandlerClass):
        def do_GET(self):
            headers = {k.lower(): v for k, v in self.headers.items()}
            self.server.calls.append((self.path, headers, None))
            if headers.get("authorization") != "Bearer " + self.server.token:
                return self.reply(401, {})
            self.reply(200, {"data": [{"id": "fixture-selected"}, {"id": "fixture-next"}]})
    server.RequestHandlerClass = Handler


@pytest.mark.platforms("posix")
@pytest.mark.parametrize("api_mode", ["chat_completions", "codex_responses", "anthropic_messages"])
@pytest.mark.parametrize("slug", ["relay", "deepseek", "anthropic", "openrouter", "MixedRelay"])
def test_second_selection_keeps_named_route(tmp_path, monkeypatch, endpoint, old_endpoint, make_agent, slug, api_mode):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    old_endpoint.token = "fixture-old-account"
    for server in (endpoint, old_endpoint):
        catalog_of_two(server)
    command = shlex.join([sys.executable, "-c", "print('fixture-token-one')"])
    atomic_config_write(tmp_path / "config.yaml", {
        "model": {"provider": "custom", "default": "fixture-old", "base_url": old_endpoint.base_url,
                  "api_key": old_endpoint.token},
        "providers": {slug: {"base_url": endpoint.base_url, "key_cmd": command, "transport": api_mode,
                             "api_key": "fixture-stale-key", "key_env": "FIXTURE_STALE_KEY"}}})
    monkeypatch.setenv("FIXTURE_STALE_KEY", "fixture-stale-env")
    cfg = load_config()
    cli, connection, peer = cli_for(old_endpoint, make_agent)
    for model, provider in [("fixture-selected", slug.lower()), ("fixture-next", "")]:
        result = _switch_model_from(cli, model, is_global=False, explicit_provider=provider,
            user_providers=cfg["providers"], custom_providers=get_compatible_custom_providers(cfg))
        stage_and_refresh(cli, result, connection)
    # Request before field assertions: a misroute is demonstrated on the wire too.
    client, request, expected, path = live.sdk_request(cli)
    with client:
        assert request() == expected
    assert old_endpoint.calls == []
    assert cli.requested_provider == "custom:" + slug.lower()
    assert cli.base_url == endpoint.base_url
    assert cli.api_mode == api_mode
    assert isinstance(cli.api_key, CommandTokenSource)
    assert [p for p, _, _ in endpoint.calls] == ["/v1/models", "/v1/models", path]
    assert all(h.get("authorization") == "Bearer fixture-token-one" for _, h, _ in endpoint.calls)
    mutations = [params for method, params in peer.calls if method == "session.mutate"]
    assert [p["payload"]["provider"] for p in mutations] == ["custom:" + slug.lower()] * 2


@pytest.mark.platforms("posix")
@pytest.mark.parametrize("path", ["picker", "reset", "once-restore"])
def test_named_route_in_picker_reset_and_once(tmp_path, monkeypatch, endpoint, old_endpoint, make_agent, path):
    from hermes_cli import cli_model_switch_mixin as switching

    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    catalog_of_two(endpoint)
    command = shlex.join([sys.executable, "-c", "print('fixture-token-one')"])
    atomic_config_write(tmp_path / "config.yaml", {
        "model": {"provider": "custom:relay", "default": "fixture-selected"},
        "providers": {"relay": {"base_url": endpoint.base_url, "key_cmd": command}}})
    cfg = load_config()
    cli, connection, peer = cli_for(old_endpoint, make_agent)
    picked = _switch_model_from(cli, "fixture-selected", is_global=False, explicit_provider="relay",
        user_providers=cfg["providers"], custom_providers=get_compatible_custom_providers(cfg))
    stage_and_refresh(cli, picked, connection)
    observed = []
    if path == "picker":
        monkeypatch.setattr(switching, "_show_model_picker", lambda owner, ctx, refresh: observed.append(ctx))
        cli._handle_model_switch("/model")
        assert observed[0].current_provider == "custom:relay"
    elif path == "reset":
        cli._confirm_and_apply_cli_model_switch = lambda *args: observed.append(args)
        cli._handle_model_switch("/model reset")
        assert observed == []  # Already on the configured route: no redundant mutation.
    else:
        snapshot = cli._snapshot_model_runtime()
        result = _switch_model_from(cli, "fixture-next", is_global=False, explicit_provider="",
            user_providers=cfg["providers"], custom_providers=get_compatible_custom_providers(cfg))
        cli._model_switch_one_turn = True
        stage_and_refresh(cli, result, connection)
        cli._restore_model_runtime_snapshot(snapshot)
        mutations = [params for method, params in peer.calls if method == "session.mutate"]
        assert len(mutations) == 1  # Once and restore never mutate the session.
        assert cli.requested_provider == "custom:relay"
        assert cli.agent.provider == "custom:relay"


@pytest.mark.parametrize("provider,requested", [("openai", "auto"), ("openai", "anthropic"),
                                               ("openai", "custom:relay")])
def test_live_builtin_is_not_overridden_by_stale_request(provider, requested):
    from types import SimpleNamespace
    from hermes_cli.cli_model_switch_mixin import _current_route_provider

    cli = SimpleNamespace(provider=provider, requested_provider=requested, base_url="https://api.openai.com/v1")
    assert _current_route_provider(cli) == provider
