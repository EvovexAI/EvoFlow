"""A keyword-only knowledge base is a healthy library, not a broken one.

Regression for the 2026-11-07 workflow verification run: the builtin user guide has
no embedding model bound (``embedding_dim`` NULL), which is a supported config
(lean installs publish via ``skip_embedding``). ``search()`` nevertheless marked
hybrid as ``degraded`` and the tool printed「向量索引未就绪」, so the worker logged a
fabricated gap in its deliverable and kept re-checking files that were fine.
"""

from __future__ import annotations

import importlib
from pathlib import Path
from unittest.mock import patch

import pytest

kt = importlib.import_module("evoflow.tools.builtins.knowledge_tool")

KB_ID = "kb_kw_only_test"


@pytest.fixture()
def owned_root(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    root = tmp_path / "knowledge"
    root.mkdir(parents=True, exist_ok=True)
    monkeypatch.setenv("EVOFLOW_KNOWLEDGE_ROOT", str(root))
    monkeypatch.setenv("EVOFLOW_HOME", str(tmp_path))
    monkeypatch.setenv("EVOFLOW_OWNED_KB_WORKER", "0")
    from evoflow.knowledge.owned.db import reset_db_state_for_tests
    from evoflow.knowledge.owned.worker import stop_owned_kb_worker_for_tests

    stop_owned_kb_worker_for_tests()
    reset_db_state_for_tests()
    yield root
    stop_owned_kb_worker_for_tests()
    reset_db_state_for_tests()


@pytest.mark.asyncio
async def test_hybrid_on_keyword_only_kb_is_not_degraded(owned_root: Path):
    """Real pipeline: skip_embedding publish, then hybrid search must come back clean."""
    from evoflow.knowledge.owned import blob_store, service
    from evoflow.knowledge.owned.db import db
    from evoflow.knowledge.owned.ids import new_id, utc_now
    from evoflow.knowledge.owned.kb_conn import db_for_kb
    from evoflow.knowledge.owned.pipeline import run_parse_index

    doc_id = new_id("doc_")
    now = utc_now()
    body = "# 智能体员工\n\n如何雇佣第一个智能体员工，并配置知识库检索。\n"

    with db() as conn:
        conn.execute(
            """
            INSERT INTO kb_bases(
              id, name, chunk_size, chunk_overlap, chunk_strategy,
              embedding_mode, embedding_model, vector_enabled, keyword_enabled,
              created_at, updated_at
            ) VALUES (?,?,512,80,'auto','cloud','text-embedding-3-small',1,1,?,?)
            """,
            (KB_ID, "关键词库", now, now),
        )

    blob_path = blob_store.put_bytes(KB_ID, doc_id, "guide.md", body.encode("utf-8"))
    with db_for_kb(KB_ID) as conn:
        conn.execute(
            """
            INSERT INTO kb_documents(
              id, kb_id, title, source_type, file_name, mime, size_bytes, content_hash,
              blob_path, folder_path, source_rel_path, parse_status, created_at, updated_at
            ) VALUES (?,?,?,?,?,?,?,?,?,?,?,'pending',?,?)
            """,
            (
                doc_id,
                KB_ID,
                "guide",
                "upload",
                "guide.md",
                "text/markdown",
                len(body.encode("utf-8")),
                "x",
                blob_path,
                "",
                "guide.md",
                now,
                now,
            ),
        )

    await run_parse_index(
        {"id": "job_kw", "kb_id": KB_ID, "doc_id": doc_id, "type": "parse_index"},
        skip_embedding=True,
        skip_embedding_reason="test: no embedding model",
    )

    res = await service.search(KB_ID, "智能体员工", mode="hybrid", top_k=5, record_activity=False)
    assert res["items"], "keyword-only KB must still return hits"
    assert res["degraded"] is False, "no vector configured ≠ degraded"
    assert res["vectorConfigured"] is False

    # an explicit semantic request genuinely cannot be served → that one is degraded
    sem = await service.search(KB_ID, "智能体员工", mode="semantic", top_k=5, record_activity=False)
    assert sem["degraded"] is True


@pytest.mark.asyncio
async def test_tool_does_not_claim_not_ready_for_keyword_only_kb():
    hits = [{"title": "guide", "docId": "doc_1", "content": "片段", "rrfScore": 0.8}]
    with (
        patch.object(kt, "resolve_knowledge_tool_scope", return_value=(True, [])),
        patch.object(kt, "_resolve_bound_kb_id", return_value=KB_ID),
        patch.object(kt.owned_service, "get_base", return_value={"id": KB_ID, "name": "关键词库"}),
        patch.object(
            kt.owned_service,
            "search",
            new=lambda *a, **k: _fake({"items": hits, "degraded": False, "vectorConfigured": False}),
        ),
    ):
        out = await kt.knowledge_tool.coroutine(
            action="search",
            query="智能体员工",
            knowledge_base=KB_ID,
            runtime=_runtime("main"),
        )
    assert "未就绪" not in out
    assert "降级" not in out
    assert "不是故障" in out            # healthy library, no fabricated gap
    assert "重建索引" not in out        # hybrid had nothing to rebuild
    assert "docId: doc_1" in out


@pytest.mark.asyncio
async def test_tool_still_warns_when_vector_actually_failed():
    hits = [{"title": "guide", "docId": "doc_1", "content": "片段", "rrfScore": 0.8}]
    with (
        patch.object(kt, "resolve_knowledge_tool_scope", return_value=(True, [])),
        patch.object(kt, "_resolve_bound_kb_id", return_value=KB_ID),
        patch.object(kt.owned_service, "get_base", return_value={"id": KB_ID, "name": "向量库"}),
        patch.object(
            kt.owned_service,
            "search",
            new=lambda *a, **k: _fake({"items": hits, "degraded": True, "vectorConfigured": True}),
        ),
    ):
        out = await kt.knowledge_tool.coroutine(
            action="search", query="x", knowledge_base=KB_ID, runtime=_runtime("main")
        )
    assert "无向量召回" in out and "关键词检索" in out


@pytest.mark.asyncio
async def test_tool_tells_how_to_enable_vectors_for_semantic_requests():
    """A semantic query against a keyword-only KB needs the actionable next step."""
    hits = [{"title": "guide", "docId": "doc_1", "content": "片段", "rrfScore": 0.8}]
    with (
        patch.object(kt, "resolve_knowledge_tool_scope", return_value=(True, [])),
        patch.object(kt, "_resolve_bound_kb_id", return_value=KB_ID),
        patch.object(kt.owned_service, "get_base", return_value={"id": KB_ID, "name": "关键词库"}),
        patch.object(
            kt.owned_service,
            "search",
            new=lambda *a, **k: _fake({"items": hits, "degraded": True, "vectorConfigured": False}),
        ),
    ):
        out = await kt.knowledge_tool.coroutine(
            action="search", query="x", knowledge_base=KB_ID, mode="semantic", runtime=_runtime("main")
        )
    assert "绑定 embedding 模型" in out
    assert "不是故障" in out


def _runtime(agent: str):
    from types import SimpleNamespace

    return SimpleNamespace(context={"agent_name": agent}, config={})


async def _fake(payload):
    return payload
