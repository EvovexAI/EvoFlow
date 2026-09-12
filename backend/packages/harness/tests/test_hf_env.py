"""Tests for Hugging Face hub env bootstrap."""

from __future__ import annotations

from evoflow.knowledge.embedding.hf_env import ensure_hf_hub_env


def test_ensure_hf_hub_env_uses_mirror_when_unset(monkeypatch) -> None:
    monkeypatch.delenv("HF_ENDPOINT", raising=False)
    monkeypatch.delenv("HUGGINGFACE_HUB_ENDPOINT", raising=False)
    assert ensure_hf_hub_env() == "https://hf-mirror.com"


def test_ensure_hf_hub_env_replaces_default_hub(monkeypatch) -> None:
    monkeypatch.setenv("HF_ENDPOINT", "https://huggingface.co")
    assert ensure_hf_hub_env() == "https://hf-mirror.com"


def test_ensure_hf_hub_env_respects_custom_endpoint(monkeypatch) -> None:
    monkeypatch.setenv("HF_ENDPOINT", "https://my-hub.example.com")
    assert ensure_hf_hub_env() == "https://my-hub.example.com"


def test_ensure_hf_hub_env_patches_already_imported_constants(monkeypatch) -> None:
    """Gateway often imports huggingface_hub before ensure runs — must patch ENDPOINT."""
    import huggingface_hub.constants as hf_constants

    monkeypatch.setenv("HF_ENDPOINT", "https://huggingface.co")
    # Simulate late bootstrap after hub import locked official endpoint.
    hf_constants.ENDPOINT = "https://huggingface.co"
    assert ensure_hf_hub_env() == "https://hf-mirror.com"
    assert hf_constants.ENDPOINT == "https://hf-mirror.com"
    assert hf_constants.HUGGINGFACE_CO_URL_TEMPLATE.startswith("https://hf-mirror.com/")
