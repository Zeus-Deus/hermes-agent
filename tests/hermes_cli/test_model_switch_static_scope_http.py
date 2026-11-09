"""Static switch credentials retain profile scope through CLI refresh and SDK I/O."""

import shlex
import sys

import pytest

from agent import secret_scope
from hermes_cli.config import atomic_config_write, invalidate_env_cache, read_user_config_raw
from hermes_cli.model_switch import switch_model
from tests.hermes_cli import test_key_cmd_live_gateway_switch as live
from tests.hermes_cli import test_key_cmd_repeated_switch as switching

endpoint = live.endpoint
old_endpoint = live.endpoint
make_agent = live.make_agent


@pytest.mark.platforms("posix")
@pytest.mark.parametrize("origin", ["dotenv-only", "dotenv-over-process", "installed-scope"])
@pytest.mark.parametrize("reference", ["key-env", "api-reference", "both", "literal"])
@pytest.mark.parametrize("command", [False, True])
def test_static_scope_survives_switch_refresh_sdk(
        tmp_path, monkeypatch, endpoint, old_endpoint, make_agent, origin, reference, command):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    dotenv_key = "fixture-other-profile" if origin == "installed-scope" else endpoint.token
    (tmp_path / ".env").write_text("FIXTURE_SCOPED_KEY=" + dotenv_key + "\n")
    invalidate_env_cache()
    monkeypatch.delenv("FIXTURE_SCOPED_KEY", raising=False)
    if origin != "dotenv-only":
        monkeypatch.setenv("FIXTURE_SCOPED_KEY", "fixture-stale-process")
    entry = {"base_url": endpoint.base_url, "api_mode": "chat_completions"}
    if reference in ("key-env", "both"):
        entry["key_env"] = "FIXTURE_SCOPED_KEY"
    if reference in ("api-reference", "both"):
        entry["api_key"] = "${FIXTURE_SCOPED_KEY}"
    if reference == "literal":
        entry["api_key"] = endpoint.token
    if command:
        entry["key_cmd"] = shlex.join([sys.executable, "-c", "print('fixture-command-key')"])
        endpoint.token = "fixture-command-key"
    atomic_config_write(tmp_path / "config.yaml", {
        "model": {"provider": "custom", "default": "fixture-old"}, "providers": {"relay": entry}})
    scope = secret_scope.set_secret_scope({"FIXTURE_SCOPED_KEY": "fixture-token-one"}) if origin == "installed-scope" else None
    try:
        result = switch_model("fixture-selected", "custom", "fixture-old",
            current_base_url=old_endpoint.base_url, explicit_provider="relay",
            user_providers=read_user_config_raw(tmp_path / "config.yaml")["providers"])
        cli, connection, peer = switching.cli_for(old_endpoint, make_agent)
        switching.stage_and_refresh(cli, result, connection)
        client, request, expected, path = live.sdk_request(cli)
        with client:
            assert request() == expected
        assert callable(cli.api_key) == command
        if not command:
            assert result.api_key == cli.api_key == cli._explicit_api_key == endpoint.token
        assert [p for p, _, _ in endpoint.calls] == ["/v1/models", path]
        assert all(h.get("authorization") == "Bearer " + endpoint.token for _, h, _ in endpoint.calls)
        assert old_endpoint.calls == []
        assert [params["payload"]["provider"] for method, params in peer.calls
                if method == "session.mutate"] == ["custom:relay"]
    finally:
        if scope is not None:
            secret_scope.reset_secret_scope(scope)
