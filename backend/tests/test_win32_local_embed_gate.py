"""Windows Gateway 禁止进程内加载本地向量模型。

2026-11-19 15:03 hang：``/api/models/embedding-probe`` 在 anyio 线程里
``local_provider._build`` → sentence_transformers → sklearn → scipy，
GIL 卡住整进程 130s+；``asyncio.wait_for`` 无法取消该导入。
"""

from __future__ import annotations

import sys

import pytest

from evoflow.knowledge.embedding import local_provider as lp


def test_inprocess_local_embed_blocked_on_win32(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(lp.sys, "platform", "win32")
    monkeypatch.delenv("EVOFLOW_EMBEDDING_WARMUP", raising=False)
    monkeypatch.delenv("EVOFLOW_CODE_INDEX_BUILD_WORKER", raising=False)
    assert lp.inprocess_local_embed_allowed() is False


def test_inprocess_local_embed_allowed_with_warmup_flag(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(lp.sys, "platform", "win32")
    monkeypatch.setenv("EVOFLOW_EMBEDDING_WARMUP", "1")
    monkeypatch.delenv("EVOFLOW_CODE_INDEX_BUILD_WORKER", raising=False)
    assert lp.inprocess_local_embed_allowed() is True


def test_inprocess_local_embed_allowed_in_build_worker(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(lp.sys, "platform", "win32")
    monkeypatch.delenv("EVOFLOW_EMBEDDING_WARMUP", raising=False)
    monkeypatch.setenv("EVOFLOW_CODE_INDEX_BUILD_WORKER", "1")
    assert lp.inprocess_local_embed_allowed() is True


def test_load_model_sync_raises_when_blocked(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(lp, "inprocess_local_embed_allowed", lambda: False)
    lp.clear_local_model_cache()
    with pytest.raises(lp.EmbeddingError, match="禁止进程内加载"):
        lp._load_model_sync("BAAI/bge-small-zh-v1.5", "cpu")


@pytest.mark.skipif(sys.platform != "win32", reason="win32 soft-fail path")
def test_embedding_probe_soft_fails_local_on_win32(monkeypatch: pytest.MonkeyPatch) -> None:
    """Probe must not start ST import; return ok=False with the gate message."""
    import asyncio
    from types import SimpleNamespace

    from app.gateway.routers import models as models_router

    monkeypatch.delenv("EVOFLOW_EMBEDDING_WARMUP", raising=False)
    monkeypatch.delenv("EVOFLOW_CODE_INDEX_BUILD_WORKER", raising=False)

    class _Req:
        model_name = "bge-local"

    monkeypatch.setattr(models_router, "require_org_admin", lambda *_a, **_k: None)
    monkeypatch.setattr(
        "evoflow.config.get_app_config",
        lambda: SimpleNamespace(
            get_model_config=lambda _n: SimpleNamespace(vendor="local", name="bge-local")
        ),
    )

    out = asyncio.run(models_router.probe_embedding_model(http_request=object(), request=_Req()))
    assert out["ok"] is False
    assert "禁止进程内加载" in out["message"]
