"""Authenticated model HTTP probes behind the public ``hermes_cli.models`` facade.

Read facade seams at call time so catalog transport, cache and TLS patches still apply.
"""

from __future__ import annotations

import time
import urllib.error
import urllib.parse
from typing import Any, Optional

def probe_api_models(
    api_key: Any, base_url: Optional[str], timeout: float = 5.0,
    api_mode: Optional[str] = None, request_headers: Optional[dict[str, str]] = None,
) -> dict[str, Any]:
    """Probe a ``/models`` endpoint with light URL heuristics (``base`` then ``base±/v1``).
    ``anthropic_messages`` uses ``x-api-key`` for static keys and command-minted native
    Console keys, Bearer for other callable credentials (matching runtime), and
    ``anthropic-version``; ``models`` is None when no candidate answered."""
    from hermes_cli import models as _m

    normalized = (base_url or "").strip().rstrip("/")
    if not normalized:
        return _m._probe_result(None, None, "")
    from providers import profile_for_host
    from agent.command_token_source import materialize_probe_api_key

    bearer_provider = callable(api_key)
    owner = profile_for_host(normalized, metadata=True)
    from providers.base import ProviderProfile

    if owner is not None and type(owner).probe_models is not ProviderProfile.probe_models:
        api_key = materialize_probe_api_key(api_key)
        owned = owner.probe_models(base_url=normalized, api_key=api_key, timeout=timeout)
        if owned is not None:
            return _m._probe_result(*owned)

    alternate_base = normalized[:-3].rstrip("/") if normalized.endswith("/v1") else normalized + "/v1"
    candidates: list[tuple[str, bool]] = [(normalized, False)]
    if alternate_base and alternate_base != normalized:
        candidates.append((alternate_base, True))

    tried: list[str] = []
    _neg_key = _m._probe_neg_key(normalized)
    if _neg_key is not None:
        _neg_seen = _m._probe_neg_cache.get(_neg_key)
        if _neg_seen is not None and (time.monotonic() - _neg_seen) < _m._PROBE_NEG_TTL:
            return _m._probe_result(
                None, normalized.rstrip("/") + "/models", normalized,
                alternate_base if alternate_base != normalized else None)
    api_key = materialize_probe_api_key(api_key)
    headers: dict[str, str] = {"User-Agent": _m.hermes_user_agent()}
    if urllib.parse.urlparse(normalized).hostname == "generativelanguage.googleapis.com":
        headers["X-Goog-Api-Client"] = _m.hermes_user_agent("hermes-agent")
    if api_mode == "anthropic_messages":
        headers["anthropic-version"] = "2023-06-01"
    if api_mode == "anthropic_messages" and bearer_provider:
        from agent.anthropic_credentials import _is_oauth_token, is_native_anthropic_host
        bearer_provider = not is_native_anthropic_host(normalized) or _is_oauth_token(api_key)
        if is_native_anthropic_host(normalized) and _is_oauth_token(api_key):
            from agent.anthropic_adapter import _COMMON_BETAS, _OAUTH_ONLY_BETAS
            headers["anthropic-beta"] = ",".join(_COMMON_BETAS + _OAUTH_ONLY_BETAS)
    if api_key and api_mode == "anthropic_messages" and not bearer_provider:
        headers["x-api-key"] = api_key
    elif api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    if isinstance(request_headers, dict):
        # Per-provider custom headers can contain secrets: merge last so endpoint config wins; never log.
        from hermes_cli.config import normalize_extra_headers

        headers.update(normalize_extra_headers(request_headers))

    # Only thread ssl_context when a per-provider TLS override applies; public endpoints keep the
    # original 2-arg call so existing call-seam mocks stay valid.
    _open_kwargs: dict[str, Any] = {}
    _ssl_context = _m._custom_provider_ssl_context(normalized)
    if _ssl_context is not None:
        _open_kwargs["ssl_context"] = _ssl_context
    all_timed_out = True
    for candidate_base, is_fallback in candidates:
        url = candidate_base.rstrip("/") + "/models"
        tried.append(url)
        try:
            data = _m._get_json(url, timeout=timeout, headers=headers, **_open_kwargs)
        except Exception as exc:
            # TLS, authentication and parsing failures must not hide corrected settings.
            cause = exc.reason if isinstance(exc, urllib.error.URLError) else exc
            all_timed_out = all_timed_out and isinstance(cause, TimeoutError)
            continue
        if _neg_key is not None:
            _m._probe_neg_cache.pop(_neg_key, None)
        from hermes_cli.chat_catalog import note_catalog_item

        probed = []
        for item in data.get("data", []):
            if isinstance(item, dict) and note_catalog_item(item):
                continue
            probed.append(item.get("id", ""))
        return _m._probe_result(
            probed, url, candidate_base.rstrip("/"),
            alternate_base if alternate_base != candidate_base else normalized, is_fallback)

    if _neg_key is not None and all_timed_out:
        _m._probe_neg_cache[_neg_key] = time.monotonic()
    return _m._probe_result(
        None, tried[0] if tried else normalized.rstrip("/") + "/models", normalized,
        alternate_base if alternate_base != normalized else None)
