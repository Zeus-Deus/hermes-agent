"""Unrelated proxy requests and first-party rules do not acquire catalog policy."""
from types import SimpleNamespace

import pytest
import yaml

from agent.fast_mode import effective_request_overrides
from hermes_cli.models import resolve_fast_mode_overrides
from hermes_constants import get_hermes_home


@pytest.mark.parametrize("api_mode", ["chat_completions", "codex_responses"])
def test_custom_endpoint_without_catalog_preserves_explicit_request_override(api_mode):
    agent = SimpleNamespace(provider="custom", base_url="https://proxy.example/v1", api_mode=api_mode,
                            model="custom-model", request_overrides={"service_tier": "priority"})
    assert effective_request_overrides(agent) == {"service_tier": "priority"}


def test_custom_flag_cannot_enable_ultrafast_on_first_party_eu_openai():
    url = "https://eu.api.openai.com/v1"
    config = {"providers": {"eu-test": {"api": url, "capabilities": {"fast_mode": True}}}}
    (get_hermes_home() / "config.yaml").write_text(yaml.safe_dump(config))
    assert resolve_fast_mode_overrides("gpt-6.2-sol", provider="openai-api", base_url=url) == {
        "service_tier": "priority"}
    assert resolve_fast_mode_overrides("gpt-6.2-sol", provider="openai-api", base_url=url, tier="ultrafast") is None


def test_catalog_request_reuses_the_bound_runtime_command_token(monkeypatch):
    import httpx

    from agent import command_token_source

    url, command = "https://proxy.example/v1", "mint-catalog-test-token"
    config = {"providers": {"catalog-test": {"api": url, "transport": "responses", "key_cmd": command,
                                             "capabilities": {"fast_mode": "catalog"}}}}
    (get_hermes_home() / "config.yaml").write_text(yaml.safe_dump(config))
    minted, received = [], []

    def mint(cmd, _label):
        minted.append(cmd)
        return f"test-token-{len(minted)}", 300

    def respond(_self, request):
        received.append(request.headers["Authorization"])
        return httpx.Response(200, json={"models": [{"slug": "gpt-6.2-sol", "service_tiers": [{"id": "ultrafast"}]}]})

    monkeypatch.setattr(command_token_source, "_mint", mint)
    monkeypatch.setattr(httpx.HTTPTransport, "handle_request", respond)
    source = command_token_source.build_command_token_provider(command, "catalog-test")
    agent = SimpleNamespace(provider="custom", requested_provider="custom:catalog-test", base_url=url,
                            api_mode="codex_responses", api_key=source, model="gpt-6.2-sol",
                            request_overrides={"service_tier": "ultrafast"})
    assert effective_request_overrides(agent) == {"service_tier": "ultrafast"}
    assert source() == "test-token-1"
    assert minted == [command]
    assert received == ["Bearer test-token-1"]


def test_catalog_paid_tier_checks_the_effective_body_and_headers(monkeypatch):
    import httpx

    url = "https://proxy.example/v1"
    entry = {"api": url, "transport": "responses", "api_key": "test-key", "extra_headers": {"X-Tenant": "a"},
             "capabilities": {"fast_mode": "catalog"}}
    (get_hermes_home() / "config.yaml").write_text(yaml.safe_dump({"providers": {"catalog-test": entry}}))
    tenants = []

    def respond(_self, request):
        tenant = request.headers["X-Tenant"]
        tenants.append(tenant)
        tiers = [{"id": "ultrafast"}] if tenant == "a" else []
        return httpx.Response(200, json={"models": [{"slug": "gpt-6.2-sol", "service_tiers": tiers}]})

    monkeypatch.setattr(httpx.HTTPTransport, "handle_request", respond)
    agent = SimpleNamespace(provider="custom:catalog-test", base_url=url, api_mode="codex_responses",
                            model="gpt-6.2-sol", api_key="test-key", _client_kwargs={"default_headers": {"X-Tenant": "a"}},
                            request_overrides={"service_tier": "ultrafast"})
    assert effective_request_overrides(agent)["service_tier"] == "ultrafast"
    agent.request_overrides = {"extra_headers": {"x-tenant": "b"},
                               "extra_body": {"service_tier": "ultrafast", "example": 42}}
    assert effective_request_overrides(agent)["extra_body"] == {"example": 42}
    assert tenants == ["a", "b"]
    assert agent.request_overrides["extra_body"]["service_tier"] == "ultrafast"


def test_duplicate_catalog_rows_do_not_grant_a_paid_tier(monkeypatch):
    import httpx

    url = "https://proxy.example/v1"
    entry = {"api": url, "transport": "responses", "capabilities": {"fast_mode": "catalog"}}
    (get_hermes_home() / "config.yaml").write_text(yaml.safe_dump({"providers": {"catalog-test": entry}}))

    def respond(_self, _request):
        return httpx.Response(200, json={"models": [
            {"slug": "gpt-6.2-astra", "service_tiers": []},
            {"slug": "gpt-6.2-astra", "service_tiers": [{"id": "ultrafast"}]},
            {"slug": "gpt-6.2-sol", "service_tiers": [{"id": "priority"}]},
        ]})

    monkeypatch.setattr(httpx.HTTPTransport, "handle_request", respond)
    route = {"provider": "custom:catalog-test", "base_url": url}
    assert resolve_fast_mode_overrides("gpt-6.2-astra", tier="ultrafast", **route) is None
    assert resolve_fast_mode_overrides("gpt-6.2-sol", **route) == {"service_tier": "priority"}
