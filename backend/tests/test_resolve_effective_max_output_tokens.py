"""Panel output budget: explicit output_context_length beats legacy 8192→64k remap."""

from __future__ import annotations

from evoflow.config.model_config import (
    DEFAULT_MODEL_MAX_OUTPUT_TOKENS,
    resolve_effective_max_output_tokens,
    resolve_model_max_output_tokens,
)
from evoflow.models.credential_sanitize import sanitize_model_document


def test_bare_legacy_8192_lifts_to_64k() -> None:
    assert resolve_model_max_output_tokens(8192) == DEFAULT_MODEL_MAX_OUTPUT_TOKENS
    assert resolve_effective_max_output_tokens(8192, None) == DEFAULT_MODEL_MAX_OUTPUT_TOKENS


def test_explicit_8k_output_window_kept() -> None:
    assert resolve_effective_max_output_tokens(8192, 8192) == 8192
    assert resolve_effective_max_output_tokens(65536, 8192) == 8192


def test_explicit_32k_and_64k_unchanged() -> None:
    assert resolve_effective_max_output_tokens(32768, 32768) == 32768
    assert resolve_effective_max_output_tokens(65536, 65536) == 65536
    assert resolve_effective_max_output_tokens(None, 32768) == 32768


def test_sanitize_preserves_intentional_8k() -> None:
    doc = sanitize_model_document(
        {
            "name": "m",
            "use": "langchain_openai:ChatOpenAI",
            "model": "gpt-4o",
            "max_tokens": 8192,
            "output_context_length": 8192,
        }
    )
    assert doc["max_tokens"] == 8192


def test_sanitize_lifts_bare_legacy_8192() -> None:
    doc = sanitize_model_document(
        {
            "name": "m",
            "use": "langchain_openai:ChatOpenAI",
            "model": "gpt-4o",
            "max_tokens": 8192,
        }
    )
    assert doc["max_tokens"] == DEFAULT_MODEL_MAX_OUTPUT_TOKENS
