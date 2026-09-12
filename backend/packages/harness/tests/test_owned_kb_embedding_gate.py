"""Owned KB worker skips vectors when embedding runtime is unavailable (still parses)."""

from __future__ import annotations

import asyncio
from unittest.mock import MagicMock, patch

import pytest

from evoflow.knowledge.owned import jobs
from evoflow.knowledge.owned.embedding_bind import embedding_runtime_ready_for_base_row
from evoflow.knowledge.owned.worker import _dispatch


def test_embedding_runtime_ready_cloud_with_credentials(monkeypatch: pytest.MonkeyPatch):
    class _Mc:
        api_key = "sk-test"
        base_url = "https://api.example.com/v1"

    monkeypatch.setattr(
        "evoflow.knowledge.owned.embedding_bind.model_config_for_base_row",
        lambda _base: _Mc(),
    )
    monkeypatch.setattr(
        "evoflow.models.credential_sanitize.resolve_and_sanitize_api_key",
        lambda key: key,
    )
    ok, reason = embedding_runtime_ready_for_base_row({"embedding_mode": "cloud"})
    assert ok is True
    assert reason is None


def test_embedding_runtime_ready_cloud_missing_api_key(monkeypatch: pytest.MonkeyPatch):
    class _Mc:
        api_key = ""
        base_url = "https://api.example.com/v1"

    monkeypatch.setattr(
        "evoflow.knowledge.owned.embedding_bind.model_config_for_base_row",
        lambda _base: _Mc(),
    )
    monkeypatch.setattr(
        "evoflow.models.credential_sanitize.resolve_and_sanitize_api_key",
        lambda key: key,
    )
    ok, reason = embedding_runtime_ready_for_base_row({"embedding_mode": "cloud"})
    assert ok is False
    assert "missing API key" in (reason or "")


def test_embedding_runtime_ready_local_missing_deps(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(
        "evoflow.knowledge.embedding.local_provider.probe_local_embedding_deps",
        lambda: "local embedding not installed",
    )
    ok, reason = embedding_runtime_ready_for_base_row({"embedding_mode": "local"})
    assert ok is False
    assert "not installed" in (reason or "")


@pytest.mark.asyncio
async def test_dispatch_skips_vectors_when_local_embedding_unavailable(
    monkeypatch: pytest.MonkeyPatch,
):
    job = {"id": "job_test1", "type": "parse_index", "kb_id": "kb_test", "doc_id": "doc1"}
    base_row = {"id": "kb_test", "embedding_mode": "local", "embedding_model": "bge-small-zh"}

    monkeypatch.setattr(
        "evoflow.knowledge.owned.worker.embedding_runtime_ready_for_base_row",
        lambda _base: (False, "local embedding unavailable"),
    )

    class _Conn:
        def execute(self, sql: str, params=()):
            return self

        def fetchone(self):
            return base_row

    class _Db:
        def __enter__(self):
            return _Conn()

        def __exit__(self, *args):
            return False

    monkeypatch.setattr("evoflow.knowledge.owned.worker.db", lambda: _Db())
    complete = MagicMock()
    monkeypatch.setattr("evoflow.knowledge.owned.worker.jobs.complete", complete)
    run_parse = MagicMock()

    async def _fake_parse(job_arg, *, skip_embedding=False, skip_embedding_reason=None):
        run_parse(
            job_arg,
            skip_embedding=skip_embedding,
            skip_embedding_reason=skip_embedding_reason,
        )

    monkeypatch.setattr("evoflow.knowledge.owned.worker.run_parse_index", _fake_parse)

    await _dispatch(job)

    run_parse.assert_called_once()
    kwargs = run_parse.call_args.kwargs
    assert kwargs.get("skip_embedding") is True
    assert "unavailable" in str(kwargs.get("skip_embedding_reason") or "")
    complete.assert_called_once_with("job_test1")
