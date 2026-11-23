"""Account-scoped speed and Daybreak metadata from the existing authenticated Codex catalogue.

Unknown discovery preserves the requested tier. Only an explicit advertised tier
list permits a downgrade; response echoes never drive selection or retries.
Daybreak is the opposite: it is requested only when the catalog explicitly lists it.
"""
from __future__ import annotations

import hashlib
import json
import logging
import threading
import time
from typing import Any
from urllib.parse import urlsplit

import httpx

logger = logging.getLogger(__name__)
# Token fingerprints include the origin; token refresh/account changes cannot reuse
# an old entitlement. No raw credentials or identities are retained in this cache.
# Value: (speed tiers per model, fetched-at, ``available_access_programs.cyber`` per model). One
# record, published by one assignment, so a reader never pairs a fresh timestamp with stale programs.
_catalogs: dict[str, tuple[dict[str, frozenset[str]], float, dict[str, frozenset[str]]]] = {}
_TTL = 3600
_MAX_CATALOGS = 128
DAYBREAK_PROGRAM = "daybreak_blue"


def _advertised_tiers(entry: dict[str, Any], *, explicit_service_tiers: bool = False) -> frozenset[str] | None:
    tiers = entry.get("service_tiers")
    if explicit_service_tiers and "service_tiers" in entry and not isinstance(tiers, list):
        return None
    if isinstance(tiers, list):
        if any(not isinstance(item, dict) or not isinstance(item.get("id"), str) for item in tiers):
            return None
        if tiers or explicit_service_tiers:
            return frozenset(item["id"] for item in tiers)
    speeds = entry.get("additional_speed_tiers")
    if isinstance(speeds, list) and all(isinstance(item, str) for item in speeds):
        return frozenset({"fast": "priority"}.get(item, item) for item in speeds)
    return frozenset() if tiers == [] else None


# Custom catalogs describe endpoint software. Keep these records separate from OAuth entitlements.
_custom_catalogs: dict[tuple[str, str], tuple[float, dict[str, frozenset[str]]]] = {}
_custom_lock = threading.Lock()


def clear_custom_catalogs() -> None:
    from hermes_constants import hermes_home_key
    home = hermes_home_key()
    with _custom_lock:
        for key in [key for key in _custom_catalogs if key[0] == home]:
            del _custom_catalogs[key]


def _custom_catalog(base: str, headers: dict[str, str], entry: dict) -> dict[str, frozenset[str]]:
    from agent import model_metadata_http
    from agent.model_metadata import fetch_codex_catalog_entries
    from agent.ssl_verify import resolve_httpx_verify

    verify = resolve_httpx_verify(ca_bundle=entry.get("ssl_ca_cert"), ssl_verify=entry.get("ssl_verify"), base_url=base)
    entries, _ = fetch_codex_catalog_entries(
        lambda url: model_metadata_http.get(url, headers=headers, timeout=1.5, verify=verify,
                                            follow_redirects=False, deadline=2.0), base_url=base)
    catalog: dict[str, frozenset[str]] = {}
    seen: set[str] = set()
    for row in entries:
        if not isinstance(row, dict) or not isinstance(slug := row.get("slug"), str):
            continue
        if slug in seen:
            catalog.pop(slug, None)  # Ambiguous duplicate rows cannot grant a paid tier.
            continue
        seen.add(slug)
        if (tiers := _advertised_tiers(row, explicit_service_tiers=True)) is not None:
            catalog[slug] = tiers
    return catalog


def _custom_catalog_headers(entry: dict, runtime_key: Any,
                            runtime_headers: dict[str, str] | None) -> dict[str, str] | None:
    from agent.command_token_source import CommandTokenSource, materialize_probe_api_key
    from agent.secret_scope import get_secret_str
    from hermes_cli.auth_declared_providers import declared_command_probe_key

    command = entry.get("key_cmd")
    if command and isinstance(runtime_key, CommandTokenSource) and runtime_key.cache_identity == f"cmd:{command}":
        token = materialize_probe_api_key(runtime_key)
    else:
        if command:
            token = declared_command_probe_key(command, entry["name"])
        else:
            env_key = get_secret_str(entry["key_env"], "").strip() if entry.get("key_env") else ""
            token = env_key or entry.get("api_key", "")
        if runtime_key is not None and runtime_key != (token or "no-key-required"):
            return None
    if not token and (command or entry.get("key_env")):
        return None
    headers = {"authorization": f"Bearer {token}"} if token else {}
    headers.update(runtime_headers if runtime_headers is not None else {
        key.lower(): value for key, value in (entry.get("extra_headers") or {}).items()})
    return headers


def custom_catalog_tiers(entry: dict, model: str, *, runtime_key: Any = None,
                         runtime_headers: dict[str, str] | None = None) -> frozenset[str]:
    """Tiers explicitly offered for the wire slug by this configured Responses endpoint."""
    from agent.cache_bounds import publish_lru
    from hermes_cli.models_fast_regions import first_party_fast_host
    from agent.model_metadata import strip_codex_context_variant_suffix
    from hermes_constants import hermes_home_key

    slug = strip_codex_context_variant_suffix(model)
    family = slug.lower()
    if (not slug or family.startswith(("anthropic/", "x-ai/", "xai/"))
            or "claude" in family or family.rsplit("/", 1)[-1].startswith("grok")):
        return frozenset()
    base = entry["base_url"].rstrip("/")
    url = urlsplit(base)
    if (url.scheme not in {"http", "https"} or not url.hostname or url.username is not None or url.query or url.fragment
            or first_party_fast_host(base)):
        return frozenset()
    headers = _custom_catalog_headers(entry, runtime_key, runtime_headers)
    if headers is None:
        return frozenset()
    identity = json.dumps([base, headers, entry.get("ssl_verify"), entry.get("ssl_ca_cert")], sort_keys=True)
    key = hermes_home_key(), hashlib.sha256(identity.encode()).hexdigest()
    with _custom_lock:
        cached = _custom_catalogs.get(key)
        if cached and cached[0] > time.monotonic():
            return cached[1].get(slug, frozenset())
    try:
        models = _custom_catalog(base, headers, entry)
    except (OSError, ValueError, httpx.HTTPError):
        models = {}
    with _custom_lock:
        publish_lru(_custom_catalogs, key, (time.monotonic() + (300 if models else 15), models), _MAX_CATALOGS)
    return models.get(slug, frozenset())


def _advertised_cyber_programs(entry: dict[str, Any]) -> frozenset[str] | None:
    programs = entry.get("available_access_programs")
    cyber = programs.get("cyber") if isinstance(programs, dict) else None
    if isinstance(cyber, list) and all(isinstance(item, str) for item in cyber):
        return frozenset(cyber)
    return None


def remember_catalog(cache_key: str, entries: list[Any]) -> None:
    """Retain only speed and access-program metadata, even when a model omits its context window."""
    models, programs = {}, {}
    for entry in entries:
        if not isinstance(entry, dict) or not isinstance(entry.get("slug"), str):
            continue
        slug = entry["slug"].strip()
        tiers = _advertised_tiers(entry)
        if tiers is not None:
            models[slug] = tiers
        cyber = _advertised_cyber_programs(entry)
        if cyber is not None:
            programs[slug] = cyber
    if cache_key not in _catalogs and len(_catalogs) >= _MAX_CATALOGS:
        del _catalogs[min(_catalogs, key=lambda key: _catalogs[key][1])]
    _catalogs[cache_key] = (models, time.time(), programs)


def _fresh_catalog(access_token: str, base_url: str) -> tuple | None:
    """This credential's catalog record once it is fresh, else None."""
    from agent import model_metadata as metadata
    key = metadata._codex_oauth_token_fingerprint(access_token, base_url)
    cached = _catalogs.get(key)
    if cached is None or time.time() - cached[1] >= _TTL:
        # Uses the established route/auth guards, headers, positive and negative
        # TTLs. A failed refresh must never consume expired entitlement metadata.
        metadata._fetch_codex_oauth_context_lengths_with_source(access_token, base_url)
        cached = _catalogs.get(key)
    if cached is None or time.time() - cached[1] >= _TTL:
        return None
    return cached


def _tiers_for_model(access_token: str, base_url: str, model: str) -> frozenset[str] | None:
    from agent import model_metadata as metadata
    cached = _fresh_catalog(access_token, base_url)
    return None if cached is None else cached[0].get(metadata.strip_codex_context_variant_suffix(model))


def _cyber_programs_for_model(access_token: str, base_url: str, model: str) -> frozenset[str] | None:
    from agent import model_metadata as metadata
    cached = _fresh_catalog(access_token, base_url)
    return None if cached is None else cached[2].get(metadata.strip_codex_context_variant_suffix(model))


def _account_catalog_token(access_token: Any) -> str | None:
    """The ChatGPT OAuth JWT that reads this account's Codex catalog, or None."""
    from hermes_cli.auth_constants import AuthError, _decode_jwt_claims
    # Only a ChatGPT OAuth JWT reads this catalog; a caller's pre-init key (an OpenAI API key on a
    # profile that also has one) is not this account's credential, so use the stored Codex login.
    token = access_token if isinstance(access_token, str) and _decode_jwt_claims(access_token) else None
    if not token:
        try:
            from hermes_cli.auth_codex import resolve_codex_runtime_credentials
            token = resolve_codex_runtime_credentials(read_only=True).get("api_key")
        except AuthError:  # no Codex login on this profile: unknown, never a refusal
            return None
    return token if isinstance(token, str) and token else None


def codex_account_offers_tier(
    model: Any, tier: str, *, base_url: Any = None, access_token: Any = None,
) -> bool | None:
    """Whether the signed-in ChatGPT account's Codex catalog lists ``tier`` for ``model``.

    ``None`` when unknown (no usable token, catalog unreachable, model absent) so callers never refuse
    on a failed lookup. ``access_token`` defaults to the profile's stored Codex OAuth token."""
    from agent.codex_headers import CODEX_AUX_BASE_URL, is_official_codex_base_url
    base = str(base_url or "").strip() or CODEX_AUX_BASE_URL
    if not is_official_codex_base_url(base):
        return None
    token = _account_catalog_token(access_token)
    if token is None:
        return None
    from agent.model_metadata import _bare_codex_slug
    supported = _tiers_for_model(token, base, _bare_codex_slug(str(model or "")))
    return None if supported is None else tier in supported


def daybreak_offered(model: Any, *, provider: Any = None, base_url: Any = None, access_token: Any = None) -> bool:
    """Whether the Daybreak switch is offered for ``model``: the ChatGPT/Codex subscription route, and
    this account's own Codex catalog lists ``daybreak_blue`` for the model. Unknown is False, so the
    switch stays hidden rather than offering something the account may not have."""
    from agent.codex_headers import CODEX_AUX_BASE_URL, is_official_codex_base_url
    from hermes_cli.models import normalize_provider
    if not provider or normalize_provider(provider) != "openai-codex":
        return False
    base = str(base_url or "").strip() or CODEX_AUX_BASE_URL
    if not is_official_codex_base_url(base):
        return False
    token = _account_catalog_token(access_token)
    if token is None:
        return False
    from agent.model_metadata import _bare_codex_slug
    programs = _cyber_programs_for_model(token, base, _bare_codex_slug(str(model or "")))
    return bool(programs) and DAYBREAK_PROGRAM in programs


def apply_daybreak(agent: Any, overrides: dict[str, Any]) -> None:
    """Add ``access_programs.cyber: daybreak_blue`` when the user turned Daybreak on and this request's
    credential and model are listed for it. Checked per request, so a model switch, credential rotation
    or expired catalog never carries the program to a model or account without it."""
    from agent.codex_headers import is_official_codex_base_url
    base_url = str(getattr(agent, "base_url", "") or "")
    if (getattr(agent, "daybreak", False) is not True
            or getattr(agent, "api_mode", None) != "codex_responses"
            or getattr(agent, "provider", None) != "openai-codex"
            or not is_official_codex_base_url(base_url)):
        return
    token = getattr(agent, "api_key", None)
    if not isinstance(token, str) or not token:
        return
    programs = _cyber_programs_for_model(token, base_url, overrides.get("model", getattr(agent, "model", "")))
    if not programs or DAYBREAK_PROGRAM not in programs:
        return
    extra_body = dict(overrides.get("extra_body") or {})
    extra_body["access_programs"] = {**dict(extra_body.get("access_programs") or {}), "cyber": DAYBREAK_PROGRAM}
    overrides["extra_body"] = extra_body


def ultrafast_offered(model: Any, *, provider: Any = None, base_url: Any = None, access_token: Any = None,
                      api_mode: Any = None, config: dict[str, Any] | None = None) -> bool:
    """Whether ``/fast ultrafast`` (and the Ultrafast picker row) is offered on this route: the route
    gate plus, on the ChatGPT/Codex subscription, the account's own Codex catalog. That backend accepts
    ``service_tier: "ultrafast"`` from a plan without the entitlement and silently serves the default
    tier, so the catalog the official client reads is the authority. An unreadable catalog never
    blocks (request-time negotiation still clamps per credential)."""
    from urllib.parse import urlparse

    from hermes_cli.models import normalize_provider, resolve_fast_mode_overrides
    if resolve_fast_mode_overrides(model, provider=provider, base_url=base_url, tier="ultrafast",
                                   access_token=access_token, api_mode=api_mode, config=config) is None:
        return False
    on_codex_sub = (provider and normalize_provider(provider) == "openai-codex") or (
        (urlparse(str(base_url or "")).hostname or "").lower() == "chatgpt.com")
    return not on_codex_sub or codex_account_offers_tier(
        model, "ultrafast", base_url=base_url, access_token=access_token) is not False


def ultrafast_offered_for(cli: Any, model: Any) -> bool:
    """:func:`ultrafast_offered` on a CLI shell's resolved route (attributes absent before setup)."""
    from agent.fast_mode import fast_mode_route
    agent = getattr(cli, "agent", None)
    return ultrafast_offered(model, **fast_mode_route(agent if isinstance(getattr(agent, "provider", None), str) else cli))


_PAID_TIERS = frozenset({"priority", "ultrafast"})


def _negotiate_custom_tier(agent: Any, overrides: dict[str, Any], model: str) -> None:
    from agent.fast_mode import BOUNDED_MODES, fast_mode_route
    from hermes_cli.config_providers import custom_fast_mode_entry, normalize_extra_headers
    from hermes_cli.models import resolve_fast_mode_overrides

    route = fast_mode_route(agent)
    base_url = route["base_url"]
    entry = custom_fast_mode_entry(route["provider"], base_url) if base_url else None
    body = overrides.get("extra_body")
    requested = overrides.get("service_tier")
    tier = getattr(agent, "service_tier", None)
    if entry and entry["capabilities"]["fast_mode"] == "catalog":
        # A deferred session may carry only the chosen tier until its first request.
        if "service_tier" not in overrides and not (isinstance(body, dict) and "service_tier" in body):
            requested = tier
        if isinstance(body, dict):  # The SDK merges extra_body after typed request fields.
            requested = body.get("service_tier", requested)
            model = body.get("model", model)
        if requested not in _PAID_TIERS:
            return
        client_kwargs = getattr(agent, "_client_kwargs", None) or {}
        client = getattr(agent, "client", None)
        bound_headers = getattr(client, "_custom_headers", client_kwargs.get("default_headers"))
        headers: dict[str, str] = {}
        for source in (bound_headers, overrides.get("extra_headers")):
            headers.update({key.lower(): value for key, value in normalize_extra_headers(source).items()})
        client_url = str(getattr(client, "base_url", None) or client_kwargs.get("base_url") or base_url).rstrip("/")
        allowed = (route["api_mode"] == "codex_responses" and client_url == base_url.rstrip("/")
                   and isinstance(model, str) and requested in custom_catalog_tiers(
                       entry, model, runtime_key=route["access_token"] or "no-key-required", runtime_headers=headers))
        if allowed:
            if not (isinstance(body, dict) and "service_tier" in body):
                overrides["service_tier"] = requested
        else:
            if isinstance(body, dict) and "service_tier" in body:
                overrides["extra_body"] = {key: value for key, value in body.items() if key != "service_tier"}
            overrides.pop("service_tier", None)
    elif requested in _PAID_TIERS and (tier == requested or tier in BOUNDED_MODES):
        # Explicit low-level overrides outside catalog mode retain their previous behavior.
        allowed = base_url and resolve_fast_mode_overrides(model, tier=requested, **route)
        if not allowed or allowed.get("service_tier") != requested:
            overrides.pop("service_tier", None)


def negotiate_request_tier(agent: Any, overrides: dict[str, Any]) -> None:
    """Resolve the current credential on each build without mutating user preference."""
    from agent.codex_headers import is_official_codex_base_url

    requested = overrides.get("service_tier")
    body = overrides.get("extra_body")
    nested = body.get("service_tier") if isinstance(body, dict) else None
    provider = getattr(agent, "provider", None)
    custom = str(provider or "").split(":")[0] == "custom"
    if (requested not in _PAID_TIERS and nested not in _PAID_TIERS
            and not (custom and getattr(agent, "service_tier", None) in _PAID_TIERS)):
        return
    model = overrides.get("model", getattr(agent, "model", ""))
    if custom:
        _negotiate_custom_tier(agent, overrides, model)
        return
    if (requested not in _PAID_TIERS or getattr(agent, "api_mode", None) != "codex_responses"
            or provider != "openai-codex"
            or not is_official_codex_base_url(str(getattr(agent, "base_url", "") or ""))):
        return
    base_url = str(getattr(agent, "base_url", "") or "")
    token = getattr(agent, "api_key", None)
    if not isinstance(token, str) or not token:
        return
    supported = _tiers_for_model(token, base_url, model)
    if supported is None:
        return
    candidates = ("ultrafast", "priority") if requested == "ultrafast" else ("priority",)
    effective = next((tier for tier in candidates if tier in supported), "default")
    if effective == "default":
        overrides.pop("service_tier", None)  # Codex represents Standard by omission.
    else:
        overrides["service_tier"] = effective
    if effective != requested:
        logger.debug("Codex service tier %s -> %s: not advertised for selected credential", requested, effective)
