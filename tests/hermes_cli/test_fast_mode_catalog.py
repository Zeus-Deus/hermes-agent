"""A trusted Responses proxy advertises model speeds on its own authenticated catalog."""
import json
from types import SimpleNamespace

import httpx
import pytest
import yaml
from openai import OpenAI

from agent.fast_mode import effective_request_overrides
from agent.transports.codex import ResponsesApiTransport
from hermes_cli.inventory import _apply_capabilities
from hermes_cli.models import clear_provider_models_cache, model_supports_fast_mode, resolve_fast_mode_overrides
from hermes_constants import get_hermes_home

BASE = "https://proxy.example.com/tenant/v1"
BOTH = [{"id": "priority"}, {"id": "ultrafast"}]


def configure(**changes):
    entry = {"api": BASE, "name": "Example Endpoint", "api_key": "test-endpoint-key",
             "transport": "responses", "extra_headers": {"X-Tenant": "example"},
             "capabilities": {"fast_mode": "catalog"}, **changes}
    (get_hermes_home() / "config.yaml").write_text(yaml.safe_dump({"providers": {"example": entry}}))


@pytest.fixture
def proxy(monkeypatch):
    catalog = [
        {"slug": "gpt-6.2-sol", "service_tiers": BOTH},
        {"slug": "gpt-6.2-astra", "service_tiers": BOTH[:1]},
        {"slug": "gpt-6.1-sol", "service_tiers": [], "additional_speed_tiers": ["fast", "ultrafast"]},
        {"slug": "future-model", "service_tiers": BOTH},
        {"slug": "claude-sonnet-4-6", "service_tiers": BOTH},
        {"slug": "grok-4.6", "service_tiers": BOTH},
        {"slug": "malformed", "service_tiers": {}, "additional_speed_tiers": ["fast"]},
    ]
    state = SimpleNamespace(catalog=catalog, status=200, probes=[], bodies=[])

    def respond(self, request):
        if request.method == "POST":
            assert str(request.url) == BASE + "/responses"
            state.bodies.append(json.loads(request.content))
            return httpx.Response(200, json={"id": "resp_test", "object": "response"})
        state.probes.append(request)
        if (request.headers.get("authorization") != "Bearer test-endpoint-key"
                or request.headers.get("X-Tenant") != "example"):
            return httpx.Response(401)
        if state.status == 307:
            return httpx.Response(307, headers={"location": "https://elsewhere.example/models"})
        return httpx.Response(state.status, json={"models": state.catalog})

    monkeypatch.setattr(httpx.HTTPTransport, "handle_request", respond)
    configure()
    return state


def test_picker_and_interactive_checks_follow_exact_advertised_models(proxy):
    models = [item["slug"] for item in proxy.catalog] + ["vendor/future-model", "gpt-5.5"]
    rows = [{"slug": "example", "api_url": BASE, "models": models}]
    _apply_capabilities(rows)
    for model in models:
        fast = model in {"gpt-6.2-sol", "gpt-6.2-astra", "future-model"}
        ultra = model in {"gpt-6.2-sol", "future-model"}
        caps = rows[0]["capabilities"][model]
        assert caps["fast"] is fast, model
        assert bool(caps.get("ultrafast")) is ultra, model
        assert model_supports_fast_mode(model, provider="custom", base_url=BASE) is fast
        overrides = resolve_fast_mode_overrides(model, provider="custom:example", tier="ultrafast")
        assert overrides == ({"service_tier": "ultrafast"} if ultra else None)
    assert len(proxy.probes) == 1
    assert str(proxy.probes[0].url).startswith(BASE + "/models?client_version=")


def test_responses_sdk_omits_unavailable_pinned_tier_and_preserves_other_options(proxy):
    agent = SimpleNamespace(provider="custom:example", base_url=BASE, api_mode="codex_responses",
                            api_key="test-endpoint-key", model="gpt-6.2-sol")
    messages = [{"role": "user", "content": "hello"}]
    with OpenAI(api_key=agent.api_key, base_url=BASE) as sdk:
        for model, preference, expected in [
            ("gpt-6.2-sol", "ultrafast", "ultrafast"), ("gpt-6.2-astra", "ultrafast", None),
            ("gpt-6.2-astra", "priority", "priority"), ("gpt-6.1-sol", "priority", None),
            ("future-model", None, None),
        ]:
            agent.request_overrides = {"model": model, "max_output_tokens": 37}
            if preference:
                agent.request_overrides["service_tier"] = preference
            kwargs = ResponsesApiTransport().build_kwargs(
                model=agent.model, messages=messages, tools=[], provider=agent.provider, base_url=BASE,
                request_overrides=effective_request_overrides(agent))
            sdk.responses.create(**kwargs)
            body = proxy.bodies[-1]
            assert body["model"] == model and body["max_output_tokens"] == 37
            assert body.get("service_tier") == expected
            assert ("service_tier" in body) == bool(expected)
            assert agent.request_overrides.get("service_tier") == preference


@pytest.mark.parametrize("status", [503, 307])
def test_failed_discovery_stays_normal_until_refresh(proxy, status):
    proxy.status = status
    route = {"provider": "custom", "base_url": BASE}
    assert resolve_fast_mode_overrides("gpt-6.2-sol", **route) is None
    count = len(proxy.probes)
    assert count and all(str(r.url).startswith(BASE + "/models?") for r in proxy.probes)
    proxy.status = 200
    assert resolve_fast_mode_overrides("gpt-6.2-sol", **route) is None
    assert len(proxy.probes) == count
    clear_provider_models_cache()
    assert resolve_fast_mode_overrides("gpt-6.2-sol", **route) == {"service_tier": "priority"}


def test_wrong_route_and_unrelated_models_never_probe(proxy):
    for provider, url, model in [
        ("custom:example", BASE + "/other", "gpt-6.2-sol"),
        ("another-provider", BASE, "gpt-6.2-sol"),
        ("custom:example", BASE, "anthropic/claude-opus-4-8"),
        ("custom:example", BASE, "x-ai/grok-4.6"),
    ]:
        assert resolve_fast_mode_overrides(model, provider=provider, base_url=url) is None
    configure(transport="chat_completions")
    assert resolve_fast_mode_overrides("gpt-6.2-sol", provider="custom", base_url=BASE) is None
    assert not proxy.probes


def test_named_catalog_uses_runtime_url_precedence(proxy):
    # The named runtime uses api before base_url. A conflicting compatibility field
    # must never receive the key, even when the picker supplies its URL explicitly.
    alternate = "https://other.example.com/v1"
    configure(base_url=alternate)
    route = {"provider": "custom:example"}
    assert resolve_fast_mode_overrides("future-model", base_url=alternate, **route) is None
    assert not proxy.probes
    assert resolve_fast_mode_overrides("future-model", **route) == {"service_tier": "priority"}
    assert str(proxy.probes[0].url).startswith(BASE + "/models?")


def test_headers_key_and_profile_scope_cached_results(proxy, tmp_path):
    from hermes_constants import reset_hermes_home_override, set_hermes_home_override

    route = {"provider": "custom:example-endpoint", "base_url": BASE}
    assert resolve_fast_mode_overrides("future-model", **route) == {"service_tier": "priority"}
    for changes in [{"extra_headers": {"X-Tenant": "different"}}, {"api_key": "different-key"}]:
        configure(**changes)
        assert resolve_fast_mode_overrides("future-model", **route) is None
    configure()
    assert resolve_fast_mode_overrides("future-model", **route) == {"service_tier": "priority"}
    second_home = tmp_path / "second"
    second_home.mkdir()
    token = set_hermes_home_override(second_home)
    try:
        configure()
        proxy.status = 401
        assert resolve_fast_mode_overrides("future-model", **route) is None
    finally:
        reset_hermes_home_override(token)
    assert resolve_fast_mode_overrides("future-model", **route) == {"service_tier": "priority"}


def test_failed_key_cmd_does_not_probe_anonymously(proxy, monkeypatch):
    from agent import command_token_source

    monkeypatch.setattr(command_token_source, "_mint", lambda *args: ("", None))
    configure(key_cmd="example-token-helper")
    assert resolve_fast_mode_overrides("future-model", provider="example", base_url=BASE) is None
    assert not proxy.probes


def test_catalog_key_cmd_and_request_share_the_runtime_token_source(proxy, monkeypatch):
    from agent import command_token_source

    minted = iter(["test-endpoint-key", "separate-token"])
    monkeypatch.setattr(command_token_source, "_mint", lambda *args: (next(minted), 3600))
    configure(key_cmd="example-token-helper")
    source = command_token_source.build_command_token_provider("example-token-helper", "example")
    agent = SimpleNamespace(provider="custom", requested_provider="example", base_url=BASE,
                            api_mode="codex_responses", api_key=source, model="future-model",
                            request_overrides={"service_tier": "ultrafast"})
    assert source() == "test-endpoint-key"
    assert effective_request_overrides(agent) == {"service_tier": "ultrafast"}
    assert len(proxy.probes) == 1


def test_shared_url_uses_the_named_tenant_for_picker_and_cli_turn(proxy):
    from cli import HermesCLI
    from hermes_cli.runtime_provider import resolve_runtime_provider

    path = get_hermes_home() / "config.yaml"
    entry = yaml.safe_load(path.read_text())["providers"]["example"]
    path.write_text(yaml.safe_dump({"providers": {
        "a": {**entry, "name": "First", "extra_headers": {"X-Tenant": "other"}},
        "b": {**entry, "name": "Second"},
    }}))
    model = "future-model"
    assert resolve_fast_mode_overrides(model, provider="custom:a", base_url=BASE) is None
    runtime = resolve_runtime_provider(requested="custom:second", target_model=model)
    assert runtime["provider"] == "custom" and runtime["api_mode"] == "codex_responses"
    shell = SimpleNamespace(model=model, agent=None, service_tier="ultrafast", acp_command=None, acp_args=[],
                            **{k: runtime[k] for k in ("provider", "requested_provider", "base_url", "api_mode", "api_key")})
    assert HermesCLI._fast_command_available(shell)
    assert HermesCLI._resolve_turn_agent_config(shell, "hello")["request_overrides"] == {"service_tier": "ultrafast"}


def test_lazy_session_rejects_ultrafast_for_priority_only_proxy_model(proxy, monkeypatch):
    from tui_gateway import server

    session = {"agent": None, "model_override": {"model": "gpt-6.2-astra", "provider": "example", "base_url": BASE}}
    monkeypatch.setitem(server._sessions, "draft", session)
    def select(mode):
        return server._methods["config.set"]("rid", {"key": "fast", "session_id": "draft", "value": mode})
    assert select("ultrafast").get("error")
    assert select("fast")["result"]["value"] == "fast"
    session["model_override"]["model"] = "future-model"
    assert select("ultrafast")["result"]["value"] == "ultrafast"


def test_deferred_agent_uses_catalog_preference_on_the_wire(proxy):
    from run_agent import AIAgent

    agent = AIAgent(model="future-model", provider="custom", requested_provider="custom:example", base_url=BASE,
                    api_mode="codex_responses", api_key="test-endpoint-key", quiet_mode=True, skip_memory=True,
                    skip_context_files=True, enabled_toolsets=[], service_tier="ultrafast")
    try:
        for preference, expected in [("ultrafast", "ultrafast"), (None, None)]:
            agent.service_tier = preference
            kwargs = agent._build_api_kwargs([{"role": "user", "content": "hello"}], [])
            agent.client.responses.create(**kwargs)
            assert proxy.bodies[-1].get("service_tier") == expected
    finally:
        agent.client.close()


def test_sdk_body_model_and_bound_client_url_determine_catalog_ceiling(proxy):
    agent = SimpleNamespace(provider="custom", base_url=BASE, api_mode="codex_responses",
                            model="future-model", api_key="test-endpoint-key",
                            _client_kwargs={"base_url": BASE, "default_headers": {"X-Tenant": "example"}},
                            request_overrides={"service_tier": "ultrafast", "extra_body": {"model": "gpt-6.2-astra"}})
    assert effective_request_overrides(agent) == {"extra_body": {"model": "gpt-6.2-astra"}}
    proxy.probes.clear()
    clear_provider_models_cache()
    agent._client_kwargs["base_url"] = "https://other.example/v1"
    agent.request_overrides = {"service_tier": "ultrafast"}
    assert effective_request_overrides(agent) == {}
    assert not proxy.probes
