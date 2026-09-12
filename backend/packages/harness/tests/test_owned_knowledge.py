"""Smoke tests for owned knowledge base (local sqlite, no Redis)."""

from __future__ import annotations

import asyncio
from pathlib import Path

import pytest


@pytest.fixture()
def owned_home(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    home = tmp_path / "evoflow-home"
    home.mkdir()
    monkeypatch.setenv("EVOFLOW_HOME", str(home))
    monkeypatch.setenv("EVOFLOW_KNOWLEDGE_ROOT", str(home / "knowledge"))
    from evoflow.knowledge.owned import db as owned_db
    from evoflow.knowledge.owned import worker as owned_worker
    from evoflow.knowledge.owned.worker import stop_owned_kb_worker_for_tests

    stop_owned_kb_worker_for_tests()
    # Unit tests run pipelines synchronously; avoid background worker races.
    monkeypatch.setattr(owned_worker, "ensure_owned_kb_worker_started", lambda: None)
    owned_db.reset_db_state_for_tests()
    yield home
    stop_owned_kb_worker_for_tests()


def test_chunking_protects_table():
    from evoflow.knowledge.owned.chunking import split_text

    text = """前言段落。

| A | B |
|---|---|
| 1 | 2 |
| 3 | 4 |

结尾。"""
    pieces = split_text(text, chunk_size=80, chunk_overlap=10)
    assert pieces
    joined = "\n".join(p.content for p in pieces)
    assert "| A | B |" in joined


def test_create_upload_and_keyword_search(owned_home: Path, monkeypatch: pytest.MonkeyPatch):
    from evoflow.knowledge.owned import jobs
    from evoflow.knowledge.owned import pipeline as pipeline_mod
    from evoflow.knowledge.owned import service as owned_service
    from evoflow.knowledge.owned.pipeline import run_parse_index

    async def _fake_embeddings(texts, model_config=None, **kwargs):
        return [[0.1] * 8 for _ in texts]

    monkeypatch.setattr(pipeline_mod, "get_embeddings", _fake_embeddings)

    base = owned_service.create_base(
        {
            "name": "测试库",
            "embeddingMode": "local",
            "embeddingModel": "BAAI/bge-small-zh-v1.5",
            "summaryEnabled": False,
        }
    )
    doc = owned_service.upload_manual_markdown(
        base["id"],
        title="产品说明",
        content="# 产品说明\n\nEvoFlow 自有知识库支持本地检索与分块。\n\n第二段：混合检索使用 RRF。\n",
    )
    job = jobs.get_job(doc["latestJobId"])
    assert job is not None

    asyncio.run(run_parse_index(job))

    doc2 = owned_service.get_document(doc["id"])
    assert doc2 is not None
    assert doc2["parseStatus"] == "completed"
    assert doc2["chunkCount"] >= 1

    result = asyncio.run(owned_service.search(base["id"], "混合检索", mode="keyword", top_k=5))
    assert result["total"] >= 1

    resolved = owned_service.resolve_document(base["id"], doc["id"])
    assert resolved is not None
    text = owned_service.get_document_text(doc["id"], max_chars=2000)
    assert "RRF" in text or "混合" in text


def test_ask_returns_citations_when_llm_unavailable(owned_home: Path, monkeypatch: pytest.MonkeyPatch):
    """ask() must still return answer + citations structure under LLM failure."""
    from evoflow.knowledge.owned import jobs
    from evoflow.knowledge.owned import pipeline as pipeline_mod
    from evoflow.knowledge.owned import service as owned_service
    from evoflow.knowledge.owned.pipeline import run_parse_index

    async def _fake_embeddings(texts, model_config=None, **kwargs):
        return [[0.1] * 8 for _ in texts]

    monkeypatch.setattr(pipeline_mod, "get_embeddings", _fake_embeddings)

    base = owned_service.create_base(
        {
            "name": "问答库",
            "embeddingMode": "local",
            "embeddingModel": "BAAI/bge-small-zh-v1.5",
            "summaryEnabled": False,
        }
    )
    doc = owned_service.upload_manual_markdown(
        base["id"],
        title="检索说明",
        content="# 检索\n\n自有知识库支持混合检索与引用问答。关键词：柠檬茶。\n",
    )
    job = jobs.get_job(doc["latestJobId"])
    assert job is not None
    asyncio.run(run_parse_index(job))
    chunks = owned_service.list_chunks(doc["id"])
    assert chunks

    async def _fake_search(kb_id, query, *, mode="hybrid", top_k=8):
        assert kb_id == base["id"]
        return {
            "items": [
                {
                    "chunkId": chunks[0]["id"],
                    "docId": doc["id"],
                    "title": "检索说明",
                    "fileName": "检索说明.md",
                    "content": chunks[0]["content"],
                    "contextHeader": "",
                }
            ],
            "total": 1,
            "mode": mode,
            "degraded": True,
        }

    monkeypatch.setattr(owned_service, "search", _fake_search)

    async def _boom_model(*_a, **_k):
        raise RuntimeError("Model not found")

    monkeypatch.setattr(
        "evoflow.context.internal_model_invoke.ainvoke_internal_chat_model",
        _boom_model,
    )
    monkeypatch.setattr("evoflow.models.create_chat_model", lambda **_k: object())

    out = asyncio.run(
        owned_service.ask(base["id"], "柠檬茶是什么检索？", doc_id=doc["id"], top_k=4)
    )
    assert isinstance(out.get("answer"), str) and out["answer"]
    assert isinstance(out.get("citations"), list)
    assert out["citations"], "expected at least one citation from keyword hits"
    cite = out["citations"][0]
    assert cite.get("docId") == doc["id"]
    assert cite.get("chunkId")
    assert "title" in cite and "snippet" in cite
    assert out.get("degraded") is True

    file_meta = owned_service.resolve_document_file(doc["id"])
    assert file_meta is not None
    assert file_meta["path"].is_file()


def test_ask_keyword_fallback_when_hybrid_empty(owned_home: Path, monkeypatch: pytest.MonkeyPatch):
    from evoflow.knowledge.owned import service as owned_service

    base = owned_service.create_base({"name": "降级问答", "summaryEnabled": False})
    calls: list[str] = []

    async def _search(kb_id, query, *, mode="hybrid", top_k=8):
        calls.append(mode)
        if mode == "hybrid":
            return {"items": [], "total": 0, "mode": mode, "degraded": True}
        return {
            "items": [
                {
                    "chunkId": "chk_1",
                    "docId": "doc_1",
                    "title": "片段",
                    "content": "关键词命中柠檬茶",
                    "contextHeader": "",
                }
            ],
            "total": 1,
            "mode": mode,
            "degraded": False,
        }

    monkeypatch.setattr(owned_service, "search", _search)

    async def _boom(*_a, **_k):
        raise RuntimeError("no model")

    monkeypatch.setattr(
        "evoflow.context.internal_model_invoke.ainvoke_internal_chat_model",
        _boom,
    )
    monkeypatch.setattr("evoflow.models.create_chat_model", lambda **_k: object())

    out = asyncio.run(owned_service.ask(base["id"], "柠檬茶", top_k=3))
    assert "hybrid" in calls and "keyword" in calls
    assert out["citations"] and out["citations"][0]["chunkId"] == "chk_1"
    assert out["degraded"] is True
    assert out["answer"]


def test_enqueue_document_summary_force(owned_home: Path, monkeypatch: pytest.MonkeyPatch):
    from evoflow.knowledge.owned import jobs
    from evoflow.knowledge.owned import pipeline as pipeline_mod
    from evoflow.knowledge.owned import service as owned_service
    from evoflow.knowledge.owned.pipeline import run_parse_index

    async def _fake_embeddings(texts, model_config=None, **kwargs):
        return [[0.1] * 8 for _ in texts]

    monkeypatch.setattr(pipeline_mod, "get_embeddings", _fake_embeddings)

    base = owned_service.create_base(
        {
            "name": "摘要库",
            "embeddingMode": "local",
            "embeddingModel": "BAAI/bge-small-zh-v1.5",
            "summaryEnabled": True,
        }
    )
    doc = owned_service.upload_manual_markdown(
        base["id"],
        title="概览文档",
        content="# 概览\n\n这段正文用于触发摘要任务。\n",
    )
    job = jobs.get_job(doc["latestJobId"])
    assert job is not None
    asyncio.run(run_parse_index(job))

    # Seed an existing summary, then force rebuild.
    from evoflow.knowledge.owned.db import db
    from evoflow.knowledge.owned.ids import utc_now

    with db() as conn:
        conn.execute(
            "UPDATE kb_documents SET summary_status='completed', summary_text=?, updated_at=? WHERE id=?",
            ("旧摘要", utc_now(), doc["id"]),
        )

    kept = owned_service.enqueue_document_summary(doc["id"], force=False)
    assert kept.get("queued") is False
    assert "旧摘要" in str(kept.get("summaryText") or "")

    forced = owned_service.enqueue_document_summary(doc["id"], force=True)
    assert forced.get("queued") is True
    assert forced.get("jobId")
    refreshed = owned_service.get_document(doc["id"])
    assert refreshed is not None
    assert refreshed["summaryStatus"] == "pending"
    assert not str(refreshed.get("summaryText") or "").strip()


def test_owned_gateway_p0_routes_smoke(owned_home: Path, monkeypatch: pytest.MonkeyPatch):
    """Smoke: /file /summary /ask routes are wired and return expected shapes."""
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from app.gateway.routers import knowledge_owned
    from evoflow.knowledge.owned import jobs
    from evoflow.knowledge.owned import pipeline as pipeline_mod
    from evoflow.knowledge.owned import service as owned_service
    from evoflow.knowledge.owned.pipeline import run_parse_index

    async def _fake_embeddings(texts, model_config=None, **kwargs):
        return [[0.1] * 8 for _ in texts]

    monkeypatch.setattr(pipeline_mod, "get_embeddings", _fake_embeddings)

    base = owned_service.create_base({"name": "路由冒烟", "summaryEnabled": True})
    doc = owned_service.upload_manual_markdown(
        base["id"],
        title="冒烟文档",
        content="# Hello\n\n正文含关键词蓝莓派。\n",
    )
    job = jobs.get_job(doc["latestJobId"])
    assert job
    asyncio.run(run_parse_index(job))

    async def _fake_ask(kb_id, query, *, doc_id=None, top_k=6):
        return {
            "answer": "蓝莓派在文档中出现。",
            "citations": [
                {
                    "docId": doc["id"],
                    "title": "冒烟文档",
                    "chunkId": "chk_x",
                    "snippet": "蓝莓派",
                }
            ],
            "degraded": True,
        }

    monkeypatch.setattr(owned_service, "ask", _fake_ask)

    app = FastAPI()
    app.include_router(knowledge_owned.router)
    client = TestClient(app)

    file_resp = client.get(f"/api/knowledge/owned/documents/{doc['id']}/file")
    assert file_resp.status_code == 200
    assert "inline" in (file_resp.headers.get("content-disposition") or "").lower()
    assert file_resp.content

    content_resp = client.get(f"/api/knowledge/owned/documents/{doc['id']}/content")
    assert content_resp.status_code == 200
    assert "蓝莓" in (content_resp.json().get("content") or "")

    sum_resp = client.post(
        f"/api/knowledge/owned/documents/{doc['id']}/summary",
        json={"force": False},
    )
    assert sum_resp.status_code == 200
    assert sum_resp.json().get("ok") is True

    ask_resp = client.post(
        f"/api/knowledge/owned/bases/{base['id']}/ask",
        json={"query": "蓝莓派是什么", "docId": doc["id"], "topK": 4},
    )
    assert ask_resp.status_code == 200
    body = ask_resp.json()
    assert body.get("answer")
    assert body.get("citations")


def test_import_vault_missing_returns_404(owned_home: Path):
    """Missing vault must be 404, not an unhandled 500 from VaultNotFoundError."""
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from app.gateway.routers import knowledge_owned
    from evoflow.knowledge.owned import service as owned_service

    base = owned_service.create_base({"name": "导入 vault", "summaryEnabled": False})
    app = FastAPI()
    app.include_router(knowledge_owned.router)
    client = TestClient(app)

    resp = client.post(
        f"/api/knowledge/owned/bases/{base['id']}/import-vault",
        json={"vaultId": "vault_nonexistent_xyz"},
    )
    assert resp.status_code == 404
    assert "vault not found" in str(resp.json().get("detail") or "").lower()


def test_owned_a_group_boundary_guards(owned_home: Path):
    """A-group: missing deletes 404, chunkSize bounds, folderPath traversal reject."""
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from app.gateway.routers import knowledge_owned
    from evoflow.knowledge.owned import service as owned_service

    base = owned_service.create_base({"name": "边界库", "summaryEnabled": False})
    app = FastAPI()
    app.include_router(knowledge_owned.router)
    client = TestClient(app)

    missing = client.delete("/api/knowledge/owned/documents/doc_nonexistent_xyz")
    assert missing.status_code == 404

    zero_create = client.post(
        "/api/knowledge/owned/bases",
        json={"name": "zero-chunk", "chunkSize": 0, "summaryEnabled": False},
    )
    assert zero_create.status_code == 422

    zero_patch = client.patch(
        f"/api/knowledge/owned/bases/{base['id']}",
        json={"chunkSize": 0},
    )
    assert zero_patch.status_code == 422

    evil = client.post(
        f"/api/knowledge/owned/bases/{base['id']}/documents/manual",
        json={"title": "pathtest", "content": "hello world", "folderPath": "../evil"},
    )
    assert evil.status_code == 400
    assert "invalid folder path" in str(evil.json().get("detail") or "").lower()

    import pytest

    with pytest.raises(ValueError, match="chunkSize"):
        owned_service.create_base({"name": "svc-zero", "chunkSize": 0})
    with pytest.raises(ValueError, match="invalid folder path"):
        owned_service.upload_manual_markdown(
            base["id"], title="x", content="y", folder_path="../evil"
        )


def test_folder_crud(owned_home: Path):
    from evoflow.knowledge.owned import service as owned_service

    base = owned_service.create_base({"name": "目录库", "summaryEnabled": False})
    kb = base["id"]
    created = owned_service.create_folder(kb, "笔记/项目A")
    assert created["path"] == "笔记/项目A"
    paths = {f["path"] for f in owned_service.list_folders(kb)}
    assert "笔记" in paths and "笔记/项目A" in paths

    doc = owned_service.upload_manual_markdown(
        kb, title="说明", content="# hi\n", folder_path="笔记/项目A"
    )
    moved = owned_service.move_document(doc["id"], "归档")
    assert moved["folderPath"] == "归档"

    renamed = owned_service.rename_folder(kb, "归档", "资料库")
    assert renamed["movedDocs"] == 1
    doc2 = owned_service.get_document(doc["id"])
    assert doc2["folderPath"] == "资料库"

    owned_service.delete_folder(kb, "资料库", mode="move_up")
    doc3 = owned_service.get_document(doc["id"])
    assert doc3["folderPath"] == ""


def test_move_folder_nest_and_root(owned_home: Path):
    from evoflow.knowledge.owned import service as owned_service

    base = owned_service.create_base({"name": "嵌套移动", "summaryEnabled": False})
    kb = base["id"]
    owned_service.create_folder(kb, "A")
    owned_service.create_folder(kb, "B")
    owned_service.create_folder(kb, "B/子")
    doc = owned_service.upload_manual_markdown(
        kb, title="在B", content="# x\n", folder_path="B"
    )

    # Nest A under B → A becomes B/A
    moved = owned_service.move_folder(kb, "A", "B")
    assert moved["toPath"] == "B/A"
    assert moved["parentPath"] == "B"
    paths = {f["path"] for f in owned_service.list_folders(kb)}
    assert "B/A" in paths and "A" not in paths

    # Cannot move into self/descendant
    with pytest.raises(ValueError, match="itself or its child"):
        owned_service.move_folder(kb, "B", "B/A")

    # Move B (with children + doc) to root under new parent C
    owned_service.create_folder(kb, "C")
    moved2 = owned_service.move_folder(kb, "B", "C")
    assert moved2["toPath"] == "C/B"
    doc2 = owned_service.get_document(doc["id"])
    assert doc2["folderPath"] == "C/B"
    paths2 = {f["path"] for f in owned_service.list_folders(kb)}
    assert "C/B" in paths2 and "C/B/A" in paths2 and "C/B/子" in paths2

    # Back to root
    moved3 = owned_service.move_folder(kb, "C/B", "")
    assert moved3["toPath"] == "B"
    assert moved3["parentPath"] == ""
    doc3 = owned_service.get_document(doc["id"])
    assert doc3["folderPath"] == "B"


def test_document_drag_reorder(owned_home: Path):
    from evoflow.knowledge.owned import service as owned_service

    base = owned_service.create_base({"name": "排序库", "summaryEnabled": False})
    kb = base["id"]
    a = owned_service.upload_manual_markdown(kb, title="A", content="a", folder_path="")
    b = owned_service.upload_manual_markdown(kb, title="B", content="b", folder_path="")
    c = owned_service.upload_manual_markdown(kb, title="C", content="c", folder_path="")
    # Move C before A
    owned_service.move_document(c["id"], before_doc_id=a["id"])
    items = owned_service.list_documents(kb)
    root = [d for d in items if not d.get("folderPath")]
    assert [d["title"] for d in root[:3]] == ["C", "A", "B"]
    # Move B into folder
    owned_service.create_folder(kb, "箱")
    owned_service.move_document(b["id"], "箱")
    b2 = owned_service.get_document(b["id"])
    assert b2["folderPath"] == "箱"


def test_replace_document_content_reindexes(owned_home: Path, monkeypatch: pytest.MonkeyPatch):
    from evoflow.knowledge.owned import jobs
    from evoflow.knowledge.owned import pipeline as pipeline_mod
    from evoflow.knowledge.owned import service as owned_service
    from evoflow.knowledge.owned.pipeline import run_parse_index

    async def _fake_embeddings(texts, model_config=None, **kwargs):
        return [[0.1] * 8 for _ in texts]

    monkeypatch.setattr(pipeline_mod, "get_embeddings", _fake_embeddings)

    base = owned_service.create_base({"name": "可写库", "summaryEnabled": False})
    doc = owned_service.upload_manual_markdown(
        base["id"], title="草稿", content="# v1\n\n旧内容\n"
    )
    job = jobs.get_job(doc["latestJobId"])
    assert job
    asyncio.run(run_parse_index(job))

    updated = owned_service.replace_document_content(doc["id"], "# v2\n\n新内容含关键词火锅\n")
    assert updated["parseStatus"] == "pending"
    job2 = jobs.get_job(updated["latestJobId"])
    assert job2
    asyncio.run(run_parse_index(job2))
    text = owned_service.get_document_text(doc["id"])
    assert "火锅" in text


def test_knowledge_tool_prefers_owned(owned_home: Path, monkeypatch: pytest.MonkeyPatch):
    from evoflow.knowledge.owned import service as owned_service
    from evoflow.tools.builtins import knowledge_vault_tools as kvt

    base = owned_service.create_base({"name": "agent-kb", "summaryEnabled": False})
    owned_service.upload_manual_markdown(
        base["id"],
        title="笔记A",
        content="自有库关键词苹果香蕉",
    )
    # Prefer owned even without vault
    assert kvt._prefer_owned(None) is True
    assert kvt._prefer_owned(base["id"]) is True

    out = asyncio.run(kvt._action_list(vault_id=None, prefix="", limit=20))
    data = __import__("json").loads(out)
    assert data.get("provider") == "owned"
    assert data.get("count", 0) >= 1


def test_wiki_ingest_and_graph(owned_home: Path, monkeypatch: pytest.MonkeyPatch):
    from evoflow.knowledge.owned import jobs
    from evoflow.knowledge.owned import pipeline as pipeline_mod
    from evoflow.knowledge.owned import service as owned_service
    from evoflow.knowledge.owned import wiki as wiki_mod
    from evoflow.knowledge.owned.pipeline import run_parse_index
    from evoflow.knowledge.owned.wiki_pipeline import run_wiki_finalize, run_wiki_ingest

    async def _fake_embeddings(texts, model_config=None, **kwargs):
        return [[0.2] * 8 for _ in texts]

    monkeypatch.setattr(pipeline_mod, "get_embeddings", _fake_embeddings)

    base = owned_service.create_base({"name": "wiki-kb", "summaryEnabled": False})
    doc = owned_service.upload_manual_markdown(
        base["id"],
        title="图谱说明",
        content="# 图谱说明\n\n## 链接图\n\n正文提到 Wiki 与 G1。\n",
    )
    job = jobs.get_job(doc["latestJobId"])
    asyncio.run(run_parse_index(job))

    ingest = jobs.enqueue(kb_id=base["id"], type="wiki_ingest", priority=220)
    asyncio.run(run_wiki_ingest(ingest))
    fin = jobs.enqueue(kb_id=base["id"], type="wiki_finalize", priority=250)
    # wiki_ingest already enqueues finalize; run the one we created for determinism
    asyncio.run(run_wiki_finalize(fin))

    pages = wiki_mod.list_pages(base["id"])
    assert any(p["slug"] == "index" for p in pages)
    assert any(p["pageType"] == "summary" for p in pages)
    g = wiki_mod.graph_payload(base["id"], center_slug="index", depth=2)
    assert g["nodeCount"] >= 1
    assert g["edgeCount"] >= 1

    from evoflow.tools.builtins import knowledge_vault_tools as kvt
    import json

    out = asyncio.run(kvt._action_graph(path="index", vault_id=base["id"], depth=2, direction="both"))
    data = json.loads(out)
    assert data.get("provider") == "owned"
    assert data.get("nodeCount", 0) >= 1


def test_kg_extract_and_search_boost(owned_home: Path, monkeypatch: pytest.MonkeyPatch):
    from evoflow.knowledge.owned import jobs
    from evoflow.knowledge.owned import kg as kg_mod
    from evoflow.knowledge.owned import pipeline as pipeline_mod
    from evoflow.knowledge.owned import service as owned_service
    from evoflow.knowledge.owned.kg_pipeline import run_kg_extract
    from evoflow.knowledge.owned.pipeline import run_parse_index

    async def _fake_embeddings(texts, model_config=None, **kwargs):
        return [[0.3] * 8 for _ in texts]

    monkeypatch.setattr(pipeline_mod, "get_embeddings", _fake_embeddings)

    base = owned_service.create_base({"name": "kg-kb", "summaryEnabled": False})
    doc = owned_service.upload_manual_markdown(
        base["id"],
        title="关系样例",
        content="# 总览\n\nEvoFlow是知识库平台。\n\n「混合检索」与「实体图」相关。\n\n## 实体图\n\n实体图依赖分块。\n",
    )
    job = jobs.get_job(doc["latestJobId"])
    asyncio.run(run_parse_index(job))

    extract = jobs.enqueue(
        kb_id=base["id"],
        type="kg_extract",
        priority=240,
        payload={"heuristicOnly": True},
    )
    asyncio.run(run_kg_extract(extract))

    st = kg_mod.stats(base["id"])
    assert st["nodeCount"] >= 2
    assert st["edgeCount"] >= 1

    g = kg_mod.graph_payload(base["id"])
    assert g["kind"] == "entity"
    assert g["nodeCount"] >= 2

    # Force graphEnabled for boost path
    from evoflow.knowledge.owned.db import db
    from evoflow.knowledge.owned.ids import utc_now

    with db() as conn:
        conn.execute(
            "UPDATE kb_bases SET graph_enabled=1, updated_at=? WHERE id=?",
            (utc_now(), base["id"]),
        )

    result = asyncio.run(owned_service.search(base["id"], "实体图", mode="keyword", top_k=8))
    assert result["total"] >= 1
    assert result.get("kgBoosted") in (True, False)  # may or may not boost depending on names


def test_extract_data_uri_assets_and_search(owned_home: Path, monkeypatch: pytest.MonkeyPatch):
    import base64

    from evoflow.knowledge.owned import jobs
    from evoflow.knowledge.owned import pipeline as pipeline_mod
    from evoflow.knowledge.owned import service as owned_service
    from evoflow.knowledge.owned.assets import get_asset
    from evoflow.knowledge.owned.db import db
    from evoflow.knowledge.owned.pipeline import run_parse_index

    async def _fake_embeddings(texts, model_config=None, **kwargs):
        return [[0.05] * 8 for _ in texts]

    monkeypatch.setattr(pipeline_mod, "get_embeddings", _fake_embeddings)

    # 1x1 PNG
    png = base64.b64decode(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
    )
    b64 = base64.b64encode(png).decode("ascii")
    md = f"# 图文\n\n说明文字含关键词星辰大海。\n\n![小图](data:image/png;base64,{b64})\n"

    base = owned_service.create_base({"name": "img-kb", "summaryEnabled": False})
    doc = owned_service.upload_manual_markdown(base["id"], title="带图笔记", content=md)
    job = jobs.get_job(doc["latestJobId"])
    assert job
    asyncio.run(run_parse_index(job))

    with db() as conn:
        assets = conn.execute(
            "SELECT * FROM kb_assets WHERE doc_id=?", (doc["id"],)
        ).fetchall()
    assert len(assets) == 1
    aid = assets[0]["id"]
    assert assets[0]["chunk_id"]
    meta = get_asset(aid)
    assert meta is not None
    assert meta["url"].endswith(aid)

    text = owned_service.get_document_text(doc["id"])
    assert "asset://" in text
    assert len(assets) >= 1

    result = asyncio.run(owned_service.search(base["id"], "星辰大海", mode="keyword", top_k=5))
    assert result["total"] >= 1
    assert any((h.get("assets") or []) for h in result["items"])


def test_owned_write_and_ingest(owned_home: Path):
    import json

    from evoflow.knowledge.owned import service as owned_service
    from evoflow.tools.builtins import knowledge_vault_tools as kvt

    base = owned_service.create_base({"name": "write-kb", "summaryEnabled": False})
    create_out = asyncio.run(
        kvt._action_write(
            operation="create",
            path="hello.md",
            vault_id=base["id"],
            content="第一版内容",
            target="",
            section=None,
            key="",
            value="",
            add_tags=None,
            remove_tags=None,
        )
    )
    created = json.loads(create_out)
    assert created.get("ok") is True
    assert created.get("provider") == "owned"
    assert created.get("folderPath") == "Agent Notes"
    assert created.get("jobId")
    assert created.get("parseStatus") == "pending"
    doc_id = created["docId"]

    append_out = asyncio.run(
        kvt._action_write(
            operation="append",
            path=doc_id,
            vault_id=base["id"],
            content="追加段落",
            target="",
            section="续写",
            key="",
            value="",
            add_tags=None,
            remove_tags=None,
        )
    )
    appended = json.loads(append_out)
    assert appended.get("ok") is True
    assert appended.get("jobId")

    replace_out = asyncio.run(
        kvt._action_write(
            operation="replace",
            path=doc_id,
            vault_id=base["id"],
            content="整篇覆盖后的正文含关键词菠萝",
            target="",
            section=None,
            key="",
            value="",
            add_tags=None,
            remove_tags=None,
        )
    )
    replaced = json.loads(replace_out)
    assert replaced.get("ok") is True
    assert replaced.get("operation") == "replace"
    assert replaced.get("jobId")
    view = owned_service.get_document_content(doc_id)
    assert view and "菠萝" in str(view.get("content") or "")

    ingest_out = asyncio.run(
        kvt._action_ingest(
            title="入库笔记",
            content="ingest 正文",
            vault_id=None,
            summary="短摘要",
            source="test",
            source_description="",
            confidence=0.8,
            tags=None,
            related_paths=None,
        )
    )
    ingested = json.loads(ingest_out)
    assert ingested.get("provider") == "owned"
    assert ingested.get("folderPath") == "Inbox"


def test_owned_write_delete_purges_index(owned_home: Path, monkeypatch: pytest.MonkeyPatch):
    import json

    from evoflow.knowledge.owned import db as owned_db
    from evoflow.knowledge.owned import jobs
    from evoflow.knowledge.owned import pipeline as pipeline_mod
    from evoflow.knowledge.owned import service as owned_service
    from evoflow.knowledge.owned.pipeline import run_parse_index
    from evoflow.tools.builtins import knowledge_vault_tools as kvt

    async def _fake_embeddings(texts, model_config=None, **kwargs):
        return [[0.1] * 8 for _ in texts]

    monkeypatch.setattr(pipeline_mod, "get_embeddings", _fake_embeddings)

    base = owned_service.create_base({"name": "delete-kb", "summaryEnabled": False})
    create_out = asyncio.run(
        kvt._action_write(
            operation="create",
            path="Notes/temp-note.md",
            vault_id=base["id"],
            content="# 临时\n\n可检索关键词：紫水晶索引测试\n",
            target="",
            section=None,
            key="",
            value="",
            add_tags=None,
            remove_tags=None,
        )
    )
    created = json.loads(create_out)
    doc_id = created["docId"]
    assert created.get("folderPath") == "Notes"
    job = jobs.get_job(created["jobId"])
    assert job
    asyncio.run(run_parse_index(job))

    with owned_db.db() as conn:
        chunks = conn.execute("SELECT COUNT(*) AS n FROM kb_chunks WHERE doc_id=?", (doc_id,)).fetchone()
        assert chunks["n"] >= 1

    hit = asyncio.run(owned_service.search(base["id"], "紫水晶", mode="keyword", top_k=5))
    assert any(h.get("docId") == doc_id for h in hit.get("items") or [])

    delete_out = asyncio.run(
        kvt._action_write(
            operation="delete",
            path=doc_id,
            vault_id=base["id"],
            content="",
            target="",
            section=None,
            key="",
            value="",
            add_tags=None,
            remove_tags=None,
        )
    )
    deleted = json.loads(delete_out)
    assert deleted.get("ok") is True
    assert deleted.get("operation") == "delete"

    assert owned_service.get_document(doc_id) is None
    with owned_db.db() as conn:
        chunks_after = conn.execute(
            "SELECT COUNT(*) AS n FROM kb_chunks WHERE doc_id=?", (doc_id,)
        ).fetchone()
        assert chunks_after["n"] == 0
        fts_after = conn.execute(
            "SELECT COUNT(*) AS n FROM kb_chunks_fts WHERE doc_id=?", (doc_id,)
        ).fetchone()
        assert fts_after["n"] == 0

    miss = asyncio.run(owned_service.search(base["id"], "紫水晶", mode="keyword", top_k=5))
    assert not any(h.get("docId") == doc_id for h in miss.get("items") or [])
