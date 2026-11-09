"""Foreign catalogs reject native-only OAuth betas, like the actual SDK route."""

import pytest

from agent.anthropic_adapter import _OAUTH_ONLY_BETAS, build_anthropic_client
from hermes_cli import models
from tests.hermes_cli import test_key_cmd_model_switch_http as http_contract

endpoint = http_contract.endpoint


@pytest.mark.parametrize("route", ["generic", "native-fetch"])
def test_foreign_oauth_catalog_matches_sdk(tmp_path, monkeypatch, endpoint, route):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    endpoint.token = "sk-ant-oat01-fixture-foreign"
    parent = endpoint.RequestHandlerClass
    class Handler(parent):
        def do_GET(self):
            headers = {k.lower(): v for k, v in self.headers.items()}
            self.server.calls.append((self.path, headers, None))
            if headers.get("authorization") != "Bearer " + self.server.token:
                return self.reply(401, {})
            if set(headers.get("anthropic-beta", "").split(",")) & set(_OAUTH_ONLY_BETAS):
                return self.reply(403, {"error": "foreign catalog rejects native OAuth betas"})
            return self.reply(200, {"data": [{"id": "fixture-selected"}]})
    endpoint.RequestHandlerClass = Handler
    mints = []
    def source():
        mints.append(True)
        return endpoint.token
    with build_anthropic_client(source, endpoint.base_url) as client:
        assert client.messages.create(model="fixture-selected", max_tokens=8,
            messages=[{"role": "user", "content": "fixture"}]).stop_reason == "end_turn"
    sdk_headers = endpoint.calls[0][1]
    mints.clear()
    if route == "generic":
        catalog = models.probe_api_models(source, endpoint.base_url, api_mode="anthropic_messages")["models"]
    else:
        catalog = models._fetch_anthropic_models(api_key=source, base_url=endpoint.base_url)
    assert catalog == ["fixture-selected"]
    assert mints == [True]
    assert [path.split("?", 1)[0] for path, _, _ in endpoint.calls] == ["/v1/messages", "/v1/models"]
    for _, headers, _ in endpoint.calls:
        assert headers["authorization"] == sdk_headers["authorization"] == "Bearer " + endpoint.token
        assert "x-api-key" not in headers
        assert not (set(headers.get("anthropic-beta", "").split(",")) & set(_OAUTH_ONLY_BETAS))
