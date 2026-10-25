"""Provider-cache snapshots, late-bound to the models facade's existing seams."""


def provider_cache_state(provider):
    from hermes_cli import models

    cache = models._load_provider_models_cache()
    fingerprint = models._credential_fingerprint(provider)
    entry = cache.get(provider)
    if provider == "openai-codex" and isinstance(entry, dict) and entry.get("fallback") is True:
        # Offline defaults are not account discovery; refresh only the returned view.
        from hermes_cli.codex_models import DEFAULT_CODEX_MODELS, _finalize_codex_models
        entry = {**entry, "models": _finalize_codex_models(DEFAULT_CODEX_MODELS)}
    return fingerprint, entry
