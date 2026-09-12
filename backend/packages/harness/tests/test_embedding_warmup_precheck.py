"""Tests for embedding warmup precheck (probe before delay)."""

from __future__ import annotations

from unittest.mock import patch

from app.gateway.background_startup import resolve_local_embedding_warmup_target


def test_resolve_local_embedding_warmup_skips_when_deps_missing():
    # DB must have a local model row so we reach the deps check.
    with patch(
        "evoflow.knowledge.embedding.local_provider.probe_local_embedding_deps",
        return_value="sentence-transformers not installed",
    ), patch(
        "evoflow.knowledge.owned.embedding_bind.list_embedding_model_rows",
        return_value=[{"vendor": "local", "model": "BAAI/bge-small-zh-v1.5"}],
    ):
        reason, model_id = resolve_local_embedding_warmup_target()
    assert reason == "runtime deps missing"
    assert model_id is None


def test_resolve_local_embedding_warmup_skips_when_no_local_model():
    with patch(
        "evoflow.knowledge.embedding.local_provider.probe_local_embedding_deps",
        return_value=None,
    ), patch(
        "evoflow.knowledge.owned.embedding_bind.list_embedding_model_rows",
        return_value=[{"vendor": "openai", "model": "text-embedding-3-small"}],
    ):
        reason, model_id = resolve_local_embedding_warmup_target()
    assert reason == "no local model configured"
    assert model_id is None


def test_resolve_local_embedding_warmup_returns_model_when_configured():
    with patch(
        "evoflow.knowledge.embedding.local_provider.probe_local_embedding_deps",
        return_value=None,
    ), patch(
        "evoflow.knowledge.owned.embedding_bind.list_embedding_model_rows",
        return_value=[{"vendor": "local", "model": "BAAI/bge-small-zh-v1.5"}],
    ):
        reason, model_id = resolve_local_embedding_warmup_target()
    assert reason is None
    assert model_id == "BAAI/bge-small-zh-v1.5"
