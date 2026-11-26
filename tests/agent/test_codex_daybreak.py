"""Daybreak follows the signed-in account's Codex catalog, per model and per request (no live accounts)."""
import base64
import json
from types import SimpleNamespace

import pytest

from agent import codex_service_tiers as tiers
from agent import model_metadata as mm
from agent.fast_mode import effective_request_overrides
from agent.transports.codex import ResponsesApiTransport

BASE = "https://chatgpt.com/backend-api/codex"
# Shapes taken from the live ChatGPT Codex /models catalog.
CATALOG = {
    "A": [  # Daybreak Blue account
        {"slug": "gpt-6-sol", "context_window": 272000,
         "available_access_programs": {"cyber": ["standard", "daybreak_blue"]}},
        {"slug": "gpt-6.1-sol", "context_window": 272000,
         "available_access_programs": {"cyber": ["standard"]}},
        {"slug": "gpt-6-luna", "context_window": 272000},  # field absent: unknown
    ],
    "B": [  # same model, account without Daybreak
        {"slug": "gpt-6-sol", "context_window": 272000,
         "available_access_programs": {"cyber": ["standard"]}},
    ],
}


def token(account):
    payload = {"https://api.openai.com/auth": {"chatgpt_account_id": account}}
    return "test." + base64.urlsafe_b64encode(json.dumps(payload).encode()).decode().rstrip("=") + ".test"


@pytest.fixture
def catalog(monkeypatch):
    monkeypatch.setattr(mm, "_codex_oauth_context_cache", {})
    monkeypatch.setattr(tiers, "_catalogs", {})
    calls = []

    def get(url, **kwargs):
        account = kwargs["headers"]["ChatGPT-Account-ID"]
        calls.append(account)
        return SimpleNamespace(status_code=200, json=lambda: {"models": CATALOG[account]})

    monkeypatch.setattr(mm.model_metadata_http, "get", get)
    return calls


def agent(account="A", model="gpt-6-sol", daybreak=True, **overrides):
    values = dict(provider="openai-codex", api_mode="codex_responses", base_url=BASE, api_key=token(account),
                  model=model, daybreak=daybreak, request_overrides={})
    values.update(overrides)
    return SimpleNamespace(**values)


def wire(a):
    return ResponsesApiTransport().build_kwargs(
        model=a.model, messages=[{"role": "user", "content": "hello"}], tools=[],
        request_overrides=effective_request_overrides(a), provider=a.provider, base_url=a.base_url,
        is_codex_backend=True,
    )


def test_enabled_on_a_listed_model_sends_daybreak_blue(catalog):
    a = agent(request_overrides={"extra_body": {"kept": 1}})
    assert wire(a)["extra_body"] == {"kept": 1, "access_programs": {"cyber": "daybreak_blue"}}
    assert a.request_overrides == {"extra_body": {"kept": 1}}  # the user's overrides are never mutated


@pytest.mark.parametrize("change", [
    {"daybreak": False},  # switch off (the default)
    {"model": "gpt-6.1-sol"},  # model lists only standard
    {"model": "gpt-6-luna"},  # catalog silent: unknown is never Daybreak
    {"api_key": token("B")},  # same model, account without the program
    {"provider": "openai-api", "base_url": "https://api.openai.com/v1"},  # not the subscription route
    {"base_url": "https://proxy.example/codex"},
])
def test_daybreak_is_never_sent_without_an_explicit_catalog_listing(catalog, change):
    assert "access_programs" not in (wire(agent(**change)).get("extra_body") or {})


def test_checked_per_request_so_a_model_switch_drops_it(catalog):
    a = agent()
    assert "access_programs" in wire(a)["extra_body"]
    a.model = "gpt-6.1-sol"
    assert "access_programs" not in (wire(a).get("extra_body") or {})
    a.model = "gpt-6-sol"
    assert "access_programs" in wire(a)["extra_body"]
    assert catalog == ["A"]  # one catalog read, then the cache


def test_unreachable_catalog_hides_and_never_sends(monkeypatch):
    monkeypatch.setattr(mm, "_codex_oauth_context_cache", {})
    monkeypatch.setattr(tiers, "_catalogs", {})
    monkeypatch.setattr(mm.model_metadata_http, "get", lambda url, **kw: SimpleNamespace(status_code=503, json=dict))
    assert not tiers.daybreak_offered("gpt-6-sol", provider="openai-codex", base_url=BASE, access_token=token("A"))
    assert "access_programs" not in (wire(agent()).get("extra_body") or {})


def test_offered_only_where_the_account_lists_it(catalog):
    codex = {"provider": "openai-codex", "base_url": BASE}
    assert tiers.daybreak_offered("gpt-6-sol", **codex, access_token=token("A"))
    assert not tiers.daybreak_offered("gpt-6.1-sol", **codex, access_token=token("A"))
    assert not tiers.daybreak_offered("gpt-6-sol", **codex, access_token=token("B"))
    assert not tiers.daybreak_offered("gpt-6-sol", provider="openai-api", base_url="https://api.openai.com/v1",
                                      access_token=token("A"))


def _owner_policies(home, monkeypatch):
    """Real launch policies, built the way each producer builds them (build_policy, then the hosted-room and
    A2A rewrites in gateway/session_hosted_rpc.py and gateway/session_a2a.py), keyed by a LOCAL chat id."""
    from dataclasses import replace
    from gateway import run as gateway_run
    from gateway import session_policy
    monkeypatch.setenv("HERMES_HOME", str(home))
    monkeypatch.setattr(gateway_run, "_hermes_home", home)  # frozen at import by an earlier test
    policies = {label: session_policy.build_policy({"source": label}, {}, private_secrets={})
                for label in ("gui", "cli", "tui", "oneshot", "tool", "acp")}
    policies["bot_room"] = replace(policies["gui"], source="bot_room", platform="bot_room")
    policies["a2a"] = replace(policies["cli"], source="a2a", platform="a2a")

    def policy_for_source(runner, source):
        if source.chat_id == "unreadable":
            raise RuntimeError("storage_unavailable")
        return policies[source.chat_id]
    monkeypatch.setattr(session_policy, "policy_for_source", policy_for_source)
    return policies


def _load(platform, chat_id="gui", check="_load_daybreak"):
    from gateway.run_config_loaders import GatewayConfigLoadersMixin
    runner = type("Runner", (GatewayConfigLoadersMixin,), {})()
    return getattr(runner, check)(SimpleNamespace(platform=platform, chat_id=chat_id))


def test_gateway_reads_the_profile_switch_each_turn(tmp_path, monkeypatch):
    """The owner's chat turns (Desktop, TUI, ``hermes chat``: ``Platform.LOCAL``) run in the gateway, which copies
    the switch onto the turn's agent from the profile's config.yaml, so a flip reaches the next turn of a running chat."""
    from gateway.config import Platform
    home = tmp_path / ".hermes"
    home.mkdir()
    _owner_policies(home, monkeypatch)
    seen = {}
    for value in ("true", "false", '"yes"', None):
        (home / "config.yaml").write_text("model: {}\n" if value is None else f"agent:\n  daybreak: {value}\n",
                                          encoding="utf-8")
        seen[value] = _load(Platform.LOCAL)
    assert seen == {"true": True, "false": False, '"yes"': False, None: False}


def test_only_the_owners_own_chats_carry_daybreak(tmp_path, monkeypatch):
    """Daybreak is the approved account's own access (OpenAI: no third-party or downstream use). Messaging
    chats, hosted rooms, A2A peers, third-party ``tool`` integrations and editor clients can be other people,
    so with the switch on only the owner's Desktop, TUI and CLI chats carry it."""
    from gateway.config import Platform
    home = tmp_path / ".hermes"
    home.mkdir()
    policies = _owner_policies(home, monkeypatch)
    (home / "config.yaml").write_text("agent:\n  daybreak: true\n", encoding="utf-8")

    platforms = {platform: _load(platform) for platform in (Platform.TELEGRAM, Platform.DISCORD, Platform.API_SERVER)}
    assert platforms == {Platform.TELEGRAM: False, Platform.DISCORD: False, Platform.API_SERVER: False}
    local = {label: _load(Platform.LOCAL, label) for label in [*policies, "unreadable"]}
    assert local == {"gui": True, "cli": True, "tui": True, "oneshot": True, "tool": False, "acp": False,
                     "bot_room": False, "a2a": False, "unreadable": False}


def test_delegation_sees_the_owners_gateway_chat_with_the_switch_off(tmp_path, monkeypatch):
    """A Daybreak delegation route is chosen per task, not by the switch, so a gateway-hosted chat records
    whether it is the owner's own (its launch policy) apart from ``agent.daybreak``, and delegation reads that."""
    from agent.session_source import turn_daybreak_surface
    from agent.subagent_lifecycle import bind_subagent_parent
    from gateway.config import Platform
    home = tmp_path / ".hermes"
    home.mkdir()
    policies = _owner_policies(home, monkeypatch)
    (home / "config.yaml").write_text("agent:\n  daybreak: false\n", encoding="utf-8")

    surface = {label: _load(Platform.LOCAL, label, "_daybreak_surface") for label in [*policies, "unreadable"]}
    assert surface == {"gui": True, "cli": True, "tui": True, "oneshot": True, "tool": False, "acp": False,
                       "bot_room": False, "a2a": False, "unreadable": False}
    assert _load(Platform.TELEGRAM, "gui", "_daybreak_surface") is False

    def seen(**agent):
        with bind_subagent_parent(SimpleNamespace(**agent)):
            return turn_daybreak_surface()
    # Only the gateway's explicit verdict counts, and False stays apart from unjudged (None): a ``/bg`` task binds no
    # session, so its chat's False is the only thing that can refuse it.
    assert [seen(platform="local", daybreak_surface=True), seen(platform="local", daybreak_surface=False),
            seen(platform="local"), seen(platform="cli"), seen(platform="local", daybreak_surface="yes")] == [
        True, False, None, None, None]
    assert turn_daybreak_surface() is None


def test_model_menu_capability_marks_only_listed_subscription_models(catalog, monkeypatch):
    from hermes_cli import auth_codex
    from hermes_cli.inventory import _apply_capabilities

    monkeypatch.setattr(auth_codex, "resolve_codex_runtime_credentials", lambda **kw: {"api_key": token("A")})

    def caps(metadata_config=None):
        rows = [{"slug": "openai-codex", "models": ["gpt-6-sol", "gpt-6.1-sol", "gpt-6-luna"]},
                {"slug": "openrouter", "models": ["openai/gpt-6-sol"]}]
        _apply_capabilities(rows, metadata_config=metadata_config)
        return {m: c.get("daybreak", False) for row in rows for m, c in row["capabilities"].items()}

    assert caps() == {"gpt-6-sol": True, "gpt-6.1-sol": False, "gpt-6-luna": False, "openai/gpt-6-sol": False}
    # The opt-in codex app-server runtime never sends the Responses field, so it never offers the switch.
    assert not any(caps({"model": {"openai_runtime": "codex_app_server"}}).values())


def test_a_refreshed_catalog_publishes_programs_with_its_timestamp(catalog):
    """One record per credential: a revoked listing can never be read next to a fresh timestamp."""
    assert "access_programs" in wire(agent())["extra_body"]
    (key,) = tiers._catalogs
    tiers.remember_catalog(key, [{"slug": "gpt-6-sol", "available_access_programs": {"cyber": ["standard"]}}])
    _tiers, _fetched_at, programs = tiers._catalogs[key]
    assert programs == {"gpt-6-sol": frozenset({"standard"})}
    assert "access_programs" not in (wire(agent()).get("extra_body") or {})


# --- an opted-in ``codex_responses`` relay (providers.<name>.capabilities.cyber_access_programs) ---------------------

RELAY = "https://relay.example/v1"
RELAY_KEY = "relay-key-not-a-jwt"
LOGIN = {"api_key": token("A"), "base_url": BASE, "source": "hermes-auth-store"}  # the OAuth flow's own store


def _relay_config(home, *, opt_in=True, transport="codex_responses", extra=""):
    caps = "    capabilities: {cyber_access_programs: true}\n" if opt_in else ""
    (home / "config.yaml").write_text(
        f"agent:\n  daybreak: true\nproviders:\n  my-relay:\n    api: {RELAY}\n    api_key: {RELAY_KEY}\n"
        f"    transport: {transport}\n{caps}{extra}", encoding="utf-8")


@pytest.fixture
def relay(catalog, monkeypatch, tmp_path):
    """A profile with its own Codex login (account A) and a relay entry; records every catalog request."""
    from hermes_cli import auth_codex
    home = tmp_path / ".hermes"
    home.mkdir()
    monkeypatch.setenv("HERMES_HOME", str(home))
    _relay_config(home)
    state = SimpleNamespace(home=home, requests=[], login=dict(LOGIN),
                            real_login=auth_codex.resolve_codex_runtime_credentials)

    def login(**kw):
        assert kw.get("read_only") is True  # never refreshes or writes the login
        if isinstance(state.login, Exception):
            raise state.login
        return state.login
    monkeypatch.setattr(auth_codex, "resolve_codex_runtime_credentials", login)

    def get(url, **kwargs):
        state.requests.append((url, kwargs["headers"]))
        account = kwargs["headers"]["ChatGPT-Account-ID"]
        return SimpleNamespace(status_code=200, json=lambda: {"models": CATALOG[account]})
    monkeypatch.setattr(mm.model_metadata_http, "get", get)
    return state


def relay_agent(model="gpt-6-sol", **overrides):
    values = dict(provider="custom", requested_provider="custom:my-relay", api_mode="codex_responses",
                  base_url=RELAY, api_key=RELAY_KEY, model=model, daybreak=True, request_overrides={})
    values.update(overrides)
    return SimpleNamespace(**values)


def resolved_agent(requested, **overrides):
    """An agent on the route the real runtime resolver picks for ``requested``."""
    from hermes_cli.runtime_provider import resolve_runtime_provider
    rt = resolve_runtime_provider(requested=requested)
    return relay_agent(provider=rt["provider"], requested_provider=rt.get("requested_provider"),
                       base_url=rt["base_url"], api_key=rt["api_key"], api_mode=rt["api_mode"], **overrides)


def relay_wire(a):
    return ResponsesApiTransport().build_kwargs(
        model=a.model, messages=[{"role": "user", "content": "hello"}], tools=[],
        request_overrides=effective_request_overrides(a), provider=a.provider, base_url=a.base_url,
    )


def relay_sends_daybreak(a):
    return "access_programs" in (relay_wire(a).get("extra_body") or {})


def _send_to_relay(kwargs):
    """The HTTP request the OpenAI client sends to the relay for ``kwargs`` (answered with a 400, never sent)."""
    import httpx
    import openai
    seen = []

    def handler(request):
        seen.append(request)
        return httpx.Response(400, json={"error": {"message": "stop"}})
    client = openai.OpenAI(api_key=RELAY_KEY, base_url=RELAY, max_retries=0,
                           http_client=httpx.Client(transport=httpx.MockTransport(handler)))
    with pytest.raises(openai.BadRequestError):
        client.responses.create(**kwargs)
    (request,) = seen
    return request


def test_opted_in_relay_sends_daybreak_from_the_official_catalog_of_the_profiles_login(relay):
    request = _send_to_relay(relay_wire(relay_agent()))
    body = json.loads(request.content)
    assert body["access_programs"] == {"cyber": "daybreak_blue"} and body["model"] == "gpt-6-sol"
    # The relay gets its own key and never the Codex login ...
    assert str(request.url).startswith(RELAY) and request.headers["authorization"] == f"Bearer {RELAY_KEY}"
    assert token("A") not in str(dict(request.headers)) + request.content.decode()
    # ... and the lookup reads the official catalog with that login, never the relay or its key.
    assert relay.requests and all(url.startswith(BASE + "/") and headers["Authorization"] == f"Bearer {token('A')}"
                                  for url, headers in relay.requests)


@pytest.mark.parametrize("change", [
    {"opt_in": False},  # no opt-in: the existing proxy rule holds
    {"transport": "chat_completions"},  # opt-in is for codex_responses relays only
])
def test_relay_without_a_codex_responses_opt_in_never_gets_it(relay, change):
    _relay_config(relay.home, **change)
    assert not relay_sends_daybreak(relay_agent(api_mode="chat_completions" if "transport" in change else "codex_responses"))
    assert not tiers.daybreak_offered("gpt-6-sol", provider="custom:my-relay", base_url=RELAY)
    assert relay.requests == []


@pytest.mark.parametrize("change", [
    {"daybreak": False},  # switch off; also every non-owner surface (messaging, cron never set it)
    {"model": "gpt-6.1-sol"},  # listed standard only
    {"model": "gpt-6-luna"},  # catalog silent
    {"request_overrides": {"extra_body": {"model": "gpt-6.1-sol"}}},  # a body override decides the model sent
    {"request_overrides": {"extra_body": {"model": "gpt-6-sol"}}},  # even an equal one skips wire normalization
    {"_delegate_depth": 1},  # a delegated child, whatever its route says
    {"platform": "subagent"},
    {"requested_provider": "custom:other"},  # a sibling entry on the same URL that did not opt in
    {"base_url": "https://elsewhere.example/v1"},  # the entry's key on another URL
])
def test_opted_in_relay_still_needs_the_switch_a_listed_model_and_its_own_entry(relay, change):
    _relay_config(relay.home, extra=f"  other:\n    api: {RELAY}\n    transport: codex_responses\n")
    assert not relay_sends_daybreak(relay_agent(**change))


@pytest.mark.parametrize("requested", ["custom:my-relay", "my-relay", "custom:My-Relay"])
def test_the_opted_in_entry_is_found_under_each_of_its_route_identities(relay, requested):
    assert relay_sends_daybreak(relay_agent(requested_provider=requested))
    assert relay_sends_daybreak(relay_agent(provider=requested, requested_provider=requested))  # a picker switch


@pytest.mark.parametrize("requested", ["custom:unknown", "custom"])
def test_the_relay_url_alone_never_inherits_an_entrys_opt_in(relay, requested):
    assert not relay_sends_daybreak(relay_agent(requested_provider=requested))
    assert not tiers.daybreak_offered("gpt-6-sol", provider=requested, base_url=RELAY)


def test_daybreak_follows_the_entry_the_runtime_resolver_selects(relay):
    """Two entries at one URL with their own credentials and defaults: the request spelling only counts
    through the entry the real resolver routes it to, and a spelling two entries answer to is ambiguous."""
    entry = "    api: {url}\n    api_key: {key}\n    default_model: {model}\n    transport: codex_responses\n"
    opted = "    capabilities: {cyber_access_programs: true}\n"
    (relay.home / "config.yaml").write_text(
        "providers:\n  plain:\n" + entry.format(url=RELAY, key="plain-key", model="gpt-6.1-sol")
        + "  approved:\n" + entry.format(url=RELAY, key="approved-key", model="gpt-6-sol") + opted, encoding="utf-8")
    assert resolved_agent("custom:approved").api_key == "approved-key"
    assert relay_sends_daybreak(resolved_agent("custom:approved"))
    assert not relay_sends_daybreak(resolved_agent("custom:plain"))
    # ``plain`` now also answers to ``approved`` (its display name) and comes first: the resolver hands out its key.
    (relay.home / "config.yaml").write_text(
        "providers:\n  plain:\n    name: approved\n" + entry.format(url=RELAY, key="plain-key", model="gpt-6.1-sol")
        + "  approved:\n" + entry.format(url=RELAY, key="approved-key", model="gpt-6-sol") + opted, encoding="utf-8")
    a = resolved_agent("custom:approved")
    assert a.api_key == "plain-key" and not relay_sends_daybreak(a)


def test_a_built_in_route_never_matches_a_relay_entry_by_display_name(relay):
    _relay_config(relay.home, extra="    name: azure-foundry\n")
    assert not relay_sends_daybreak(relay_agent(provider="azure-foundry", requested_provider="azure-foundry"))


def test_only_a_providers_entry_opts_a_relay_in(relay):
    (relay.home / "config.yaml").write_text(
        f"custom_providers:\n  - name: my-relay\n    base_url: {RELAY}\n    api_mode: codex_responses\n"
        f"    capabilities: {{cyber_access_programs: true}}\n", encoding="utf-8")
    assert not relay_sends_daybreak(relay_agent())


def test_unreadable_config_never_opts_in(relay, monkeypatch):
    """A config read that fails serves defaults or the last good file: neither may turn Daybreak on."""
    from hermes_cli import config as config_module
    from hermes_cli.config_backend import ConfigBackendUnavailable
    from hermes_cli.config_read_errors import FailedConfigRead
    last_good = config_module.load_config_readonly()
    for outcome in (FailedConfigRead(last_good, error=OSError("EIO")), ConfigBackendUnavailable("down"),
                    PermissionError("config.yaml")):
        def load(outcome=outcome):
            if isinstance(outcome, BaseException):
                raise outcome
            return outcome
        monkeypatch.setattr(config_module, "load_config_readonly", load)
        assert not relay_sends_daybreak(relay_agent())
    # The picker reads the same fallback from its payload snapshot: no switch and no catalog lookup.
    from hermes_cli.inventory import _apply_capabilities
    rows = [{"slug": "my-relay", "is_user_defined": True, "api_url": RELAY, "models": ["gpt-6-sol"]}]
    _apply_capabilities(rows, metadata_config=FailedConfigRead(last_good, error=OSError("EIO")), relay_daybreak=True)
    assert rows[0]["capabilities"]["gpt-6-sol"].get("daybreak", False) is False and relay.requests == []


def test_relay_model_switch_or_revoked_opt_in_drops_it_on_the_next_request(relay):
    a = relay_agent()
    assert relay_sends_daybreak(a)
    a.model = "gpt-6.2-sol"  # absent from this account's catalog
    assert not relay_sends_daybreak(a)
    a.model = "gpt-6-sol"
    assert relay_sends_daybreak(a)
    _relay_config(relay.home, opt_in=False)  # same running agent, opt-in removed from config.yaml
    assert not relay_sends_daybreak(a)


@pytest.mark.parametrize("login", [
    "missing",  # no Codex login on this profile
    "unreadable",  # the auth store can't be read
    {**LOGIN, "base_url": "https://gateway.example/codex"},  # a login routed elsewhere
    {**LOGIN, "base_url": None},  # no route binding at all
    {**LOGIN, "api_key": RELAY_KEY},  # not a ChatGPT token at all
    {**LOGIN, "source": "credential_pool"},  # a pooled token with no OAuth row behind it
    {**LOGIN, "source": "env"},
])
def test_relay_without_an_oauth_login_hides_and_never_sends(relay, login):
    from hermes_cli.auth_constants import AuthError
    errors = {"missing": AuthError("not logged in", provider="openai-codex", code="codex_auth_missing"),
              "unreadable": PermissionError("auth.json")}
    relay.login = errors[login] if isinstance(login, str) else login
    assert not tiers.daybreak_offered("gpt-6-sol", provider="custom:my-relay", base_url=RELAY)
    assert not relay_sends_daybreak(relay_agent())
    assert relay.requests == []  # nothing else is tried in its place


@pytest.mark.parametrize("auth_type, sends", [("api_key", False), ("oauth", True)])
def test_only_an_oauth_pool_row_reads_the_catalog(relay, monkeypatch, auth_type, sends):
    """A profile with no Codex login but a JWT-shaped pool row (e.g. left over from a proxied ``openai-codex``
    route): only a row the OAuth flow stored may read the catalog, through the real resolver."""
    from hermes_cli import auth_codex
    monkeypatch.setattr(auth_codex, "resolve_codex_runtime_credentials", relay.real_login)
    row = {"id": "row", "source": "manual", "auth_type": auth_type, "access_token": token("A"),
           "base_url": BASE, "last_status": "ok", **({"refresh_token": "r"} if auth_type == "oauth" else {})}
    (relay.home / "auth.json").write_text(json.dumps(
        {"version": 1, "providers": {}, "credential_pool": {"openai-codex": [row]}}), encoding="utf-8")
    assert tiers.daybreak_offered("gpt-6-sol", provider="custom:my-relay", base_url=RELAY) is sends
    assert relay_sends_daybreak(relay_agent()) is sends
    assert bool(relay.requests) is sends


def test_relay_unreadable_catalog_never_sends(relay, monkeypatch):
    monkeypatch.setattr(mm.model_metadata_http, "get", lambda url, **kw: SimpleNamespace(status_code=401, json=dict))
    assert not relay_sends_daybreak(relay_agent())


def test_relay_is_owner_gated_like_the_subscription(relay, monkeypatch):
    """Only the gateway's owner check turns ``agent.daybreak`` on; a messaging chat on the relay stays standard."""
    from gateway.config import Platform
    _owner_policies(relay.home, monkeypatch)
    for platform, chat_id in ((Platform.TELEGRAM, "gui"), (Platform.LOCAL, "tool"), (Platform.LOCAL, "acp")):
        assert not relay_sends_daybreak(relay_agent(daybreak=_load(platform, chat_id)))
    assert relay_sends_daybreak(relay_agent(daybreak=_load(Platform.LOCAL, "gui")))


def _menu(home, relay_daybreak):
    from hermes_cli.inventory import build_models_payload, load_picker_context
    payload = build_models_payload(load_picker_context(), capabilities=True, probe_custom_providers=False,
                                   relay_daybreak=relay_daybreak)
    return {(r["slug"], m): c.get("daybreak", False) for r in payload["providers"] if r.get("is_user_defined")
            for m, c in r["capabilities"].items()}


MODELS = "    discover_models: false\n    models: [gpt-6-sol, gpt-6.1-sol]\n"


def test_chat_menu_marks_listed_models_on_the_opted_in_relay_only(relay):
    """The real picker payload from the documented YAML: rows carry the bare ``providers:`` key as their slug."""
    (relay.home / "config.yaml").write_text(
        f"providers:\n  my-relay:\n    api: {RELAY}\n    api_key: {RELAY_KEY}\n    transport: codex_responses\n"
        f"    capabilities: {{cyber_access_programs: true}}\n{MODELS}"
        f"  plain:\n    api: https://other.example/v1\n    api_key: other-key\n    transport: codex_responses\n{MODELS}",
        encoding="utf-8")
    assert _menu(relay.home, True) == {("my-relay", "gpt-6-sol"): True, ("my-relay", "gpt-6.1-sol"): False,
                                       ("plain", "gpt-6-sol"): False, ("plain", "gpt-6.1-sol"): False}
    # Settings editors (the delegation route editor, fallback and default pickers) read the REST payload,
    # which never offers a relay's Daybreak.
    assert not any(_menu(relay.home, False).values())


def test_only_the_chat_menu_rpc_offers_relay_daybreak(relay, monkeypatch):
    """Both ``model.options`` RPCs behind the chat model menu (the gateway's ``/api/ws`` handler and a standalone
    backend) opt in; the REST payload behind settings editors does not."""
    import asyncio
    import inspect

    from gateway import session_config
    from hermes_cli.inventory import build_model_options_payload
    from tui_gateway import server
    assert inspect.signature(build_model_options_payload).parameters["relay_daybreak"].default is False
    seen = []
    monkeypatch.setattr("hermes_cli.inventory.build_model_options_payload",
                        lambda ctx, **kw: seen.append(kw.get("relay_daybreak")) or {"providers": []})
    monkeypatch.setattr(server, "_model_picker_context", lambda agent: object())
    server._methods["model.options"](1, {})
    agent = SimpleNamespace(model="gpt-6-sol", provider="custom", requested_provider="custom:my-relay", base_url=RELAY)
    connection = SimpleNamespace(authority=SimpleNamespace(profile_id=str(relay.home), agent=lambda ref: agent))
    monkeypatch.setattr(session_config, "_authorize", lambda connection, ref, params: None)
    asyncio.run(session_config.model_options(connection, SimpleNamespace(session_id="s"), {}))
    assert seen == [True, True]


def test_an_opted_in_sibling_keeps_its_own_picker_row(relay):
    """Same URL and credential source, opposite opt-ins: two rows, so the opted-in entry stays selectable."""
    (relay.home / "config.yaml").write_text(
        f"providers:\n  plain:\n    api: {RELAY}\n    transport: codex_responses\n{MODELS}"
        f"  my-relay:\n    api: {RELAY}\n    transport: codex_responses\n"
        f"    capabilities: {{cyber_access_programs: true}}\n{MODELS}", encoding="utf-8")
    assert _menu(relay.home, True) == {("plain", "gpt-6-sol"): False, ("plain", "gpt-6.1-sol"): False,
                                       ("my-relay", "gpt-6-sol"): True, ("my-relay", "gpt-6.1-sol"): False}


# --- ``hermes doctor`` names the opt-in; it never sets it ------------------------------------------------------------

def _doctor_hint(capsys):
    from hermes_cli.doctor_config import _check_daybreak_relay_hint
    finding = _check_daybreak_relay_hint(False)
    assert not finding.issues and not finding.manual_issues  # a note, never an issue or a non-zero exit
    return capsys.readouterr().out


def test_doctor_notes_a_relay_without_the_opt_in_when_the_login_has_daybreak(relay, capsys):
    _relay_config(relay.home, opt_in=False)
    before = (relay.home / "config.yaml").read_text(encoding="utf-8")
    out = _doctor_hint(capsys)
    assert "providers.my-relay" in out and "gpt-6-sol" in out and "cyber_access_programs: true" in out
    assert "gpt-6.1-sol" not in out  # only models the catalog lists for daybreak_blue
    assert (relay.home / "config.yaml").read_text(encoding="utf-8") == before  # never written
    assert all(url.startswith(BASE + "/") for url, _ in relay.requests)  # official catalog, never the relay


@pytest.mark.parametrize("case", ["opted_in", "chat_completions", "no_login", "account_without_daybreak"])
def test_doctor_stays_silent_when_the_hint_does_not_apply(relay, capsys, case):
    from hermes_cli.auth_constants import AuthError
    _relay_config(relay.home, opt_in=case == "opted_in",
                  transport="chat_completions" if case == "chat_completions" else "codex_responses")
    if case == "no_login":
        relay.login = AuthError("not logged in")
    if case == "account_without_daybreak":
        relay.login = {**LOGIN, "api_key": token("B")}
    assert _doctor_hint(capsys) == ""
    if case in ("opted_in", "chat_completions", "no_login"):
        assert relay.requests == []  # no catalog read without a candidate relay and a login
