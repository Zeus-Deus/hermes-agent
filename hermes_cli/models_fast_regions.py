"""OpenAI data-residency hosts that may receive a fast ``service_tier``.

Regional support is published per region and per model, so ``*.api.openai.com`` is not a license:
au/jp/in serve "Standard pay-as-you-go only", ca/sg/kr/gb have no regional processing, and EU Fast
excludes GPT-6 Astra and GPT-6 Sol. Ultrafast needs no second table: only Ultrafast models get that
tier. GPT-6.2 adds EU Fast, but its Ultrafast tier remains US-only.
https://developers.openai.com/api/docs/guides/data-residency
https://developers.openai.com/api/docs/guides/fast-mode#is-fast-mode-compatible-with-data-residency-zero-data-retention-and-a-baa
"""

from typing import Optional
from urllib.parse import urlparse

from utils import base_url_hostname

# Host -> documented Fast models; None = every model the global endpoint accepts.
_FAST_REGION_MODELS: dict[str, Optional[frozenset[str]]] = {
    "us.api.openai.com": None,
    "eu.api.openai.com": frozenset({"gpt-6.2-astra", "gpt-6.2-sol", "gpt-6.1-sol", "gpt-6.1-terra", "gpt-6-luna"}),
}


def openai_fast_region_allows(base_url: Optional[str], model_id: Optional[str], tier: Optional[str] = None) -> bool:
    """True when a regional OpenAI host documents fast tiers for this model."""
    from agent.model_metadata import strip_codex_context_variant_suffix
    from hermes_cli.models import _strip_vendor_prefix

    host = base_url_hostname(str(base_url or ""))
    if host not in _FAST_REGION_MODELS:
        return False
    models = _FAST_REGION_MODELS[host]
    base = _strip_vendor_prefix(strip_codex_context_variant_suffix(str(model_id or ""))).split(":")[0]
    # GPT-6.2 Fast supports EU residency, but Ultrafast supports US residency only.
    if host == "eu.api.openai.com" and tier == "ultrafast" and base in {"gpt-6.2-astra", "gpt-6.2-sol"}:
        return False
    return models is None or base in models


def first_party_fast_mode_route(
    model_id: Optional[str], provider: Optional[str], base_url: Optional[str], tier: Optional[str] = None) -> bool:
    """Check the provider, host and region of a first-party route."""
    from agent.model_metadata import is_anthropic_fast_mode_model, is_grok_46_family
    from hermes_cli.models import normalize_provider

    host = (urlparse(str(base_url or "")).hostname or "").lower()
    if is_anthropic_fast_mode_model(model_id):
        allowed = {"anthropic": "api.anthropic.com"}
    elif is_grok_46_family(str(model_id or "")):
        allowed = {"xai": "api.x.ai"}
    else:
        if openai_fast_region_allows(base_url, model_id, tier):
            host = "api.openai.com"  # Eligibility only; custom matching still gets the actual URL.
        allowed = {"openai": "api.openai.com", "openai-api": "api.openai.com", "openai-codex": "chatgpt.com"}
    return (not provider or normalize_provider(provider) in allowed) and (not host or host in allowed.values())


def first_party_fast_host(base_url: Optional[str]) -> bool:
    """A custom declaration cannot reopen a first-party model or region denial."""
    host = base_url_hostname(base_url or "")
    return host in {"api.openai.com", "chatgpt.com", "api.anthropic.com", "api.x.ai"} or host.endswith(".api.openai.com")
