"""A configured entry named like a local-server alias keeps its settings on an explicit base_url.

``provider: ollama`` (or vllm, lmstudio, ...) with a ``base_url`` resolved as the bare ``ollama`` alias
even when config defines ``providers.ollama``: the entry's transport was replaced by a URL guess and its
own key by whatever credential owns the URL. Without a base_url the same name already resolved to the
entry.
"""

import os
from pathlib import Path

import hermes_yaml as yaml
from hermes_cli.runtime_provider import resolve_runtime_provider

ENTRY_URL = "http://10.0.0.9:11434/v1"


def test_entry_under_an_alias_name_keeps_its_key_and_transport(monkeypatch):
    home = Path(os.environ["HERMES_HOME"])
    home.mkdir(parents=True, exist_ok=True)
    (home / "config.yaml").write_text(yaml.safe_dump({"providers": {
        "ollama": {"api": ENTRY_URL, "api_mode": "anthropic_messages", "key_env": "OLLAMA_ENTRY_KEY"},
    }}))
    monkeypatch.setenv("OLLAMA_ENTRY_KEY", "ollama-entry-secret")
    runtime = resolve_runtime_provider(requested="ollama", explicit_base_url=ENTRY_URL)
    assert (runtime["api_key"], runtime["api_mode"]) == ("ollama-entry-secret", "anthropic_messages")


def test_bare_alias_without_an_entry_is_still_a_direct_endpoint():
    home = Path(os.environ["HERMES_HOME"])
    home.mkdir(parents=True, exist_ok=True)
    (home / "config.yaml").write_text(yaml.safe_dump({"model": {"provider": "openrouter", "default": "m"}}))
    runtime = resolve_runtime_provider(requested="ollama", explicit_base_url="http://10.0.0.9:11434/v1")
    assert (runtime["provider"], runtime["base_url"]) == ("custom", "http://10.0.0.9:11434/v1")
