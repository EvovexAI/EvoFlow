"""Gateway Knowledge Global API tests (TestClient + mocked service layer).

Tests for:
- POST /api/knowledge/search (global semantic search)
- POST /api/knowledge/embed (text embedding)
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path
from unittest.mock import AsyncMock, patch

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient


def _load_knowledge_router():
    """Load backend/app router even if packages/harness/app shadows ``app`` on sys.path."""
    router_path = Path(__file__).resolve().parents[1] / "gateway" / "routers" / "knowledge.py"
    name = "evoflow_test_knowledge_router"
    if name in sys.modules:
        return sys.modules[name]
    spec = importlib.util.spec_from_file_location(name, router_path)
    assert spec and spec.loader
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


knowledge = _load_knowledge_router()


@pytest.fixture
def client():
    app = FastAPI()
    app.include_router(knowledge.router)
    return TestClient(app)


# ---------------------------------------------------------------------------
# POST /api/knowledge/search — global semantic search
# ---------------------------------------------------------------------------

def test_global_search_empty(client):
    """When no KBs exist, search returns empty results."""
    with patch.object(
        knowledge.kb_service,
        "search_knowledge_bases",
        new=AsyncMock(return_value=[]),
    ):
        r = client.post("/api/knowledge/search", json={"query": "test"})
        assert r.status_code == 200
        data = r.json()
        assert data["query"] == "test"
        assert data["total"] == 0
        assert data["items"] == []


def test_global_search_with_results(client):
    """Search returns matched items from KBs."""
    mock_results = [
        {
            "chunk_id": "abc123",
            "content": "Test content",
            "score": 0.95,
            "distance": 0.05,
            "file_name": "test.md",
            "file_id": "file_001",
            "seq": 0,
            "token_count": 50,
            "index_text": "",
            "heading_path": "",
            "match_kind": "section",
            "dataset_id": "kb_001",
            "dataset_name": "Test KB",
        }
    ]
    with patch.object(
        knowledge.kb_service,
        "search_knowledge_bases",
        new=AsyncMock(return_value=mock_results),
    ):
        r = client.post(
            "/api/knowledge/search",
            json={
                "query": "test query",
                "knowledge_base": "Test KB",
                "top_k": 3,
                "score_threshold": 0.5,
            },
        )
        assert r.status_code == 200
        data = r.json()
        assert data["query"] == "test query"
        assert data["total"] == 1
        assert len(data["items"]) == 1
        assert data["items"][0]["score"] == 0.95


def test_global_search_missing_query(client):
    """Search requires a non-empty query."""
    r = client.post("/api/knowledge/search", json={"query": ""})
    assert r.status_code == 422  # validation error


def test_global_search_exception(client):
    """Search handles service exceptions gracefully."""
    with patch.object(
        knowledge.kb_service,
        "search_knowledge_bases",
        new=AsyncMock(side_effect=RuntimeError("DB error")),
    ):
        r = client.post("/api/knowledge/search", json={"query": "test"})
        assert r.status_code == 500


# ---------------------------------------------------------------------------
# POST /api/knowledge/embed — text embedding
# ---------------------------------------------------------------------------

def test_embed_text_no_store(client):
    """Embed computes vector without storing."""
    mock_embedding = [0.1, 0.2, 0.3, 0.4, 0.5]
    with patch.object(
        knowledge.kb_service,
        "get_dataset",
        return_value=None,
    ):
        with patch(
            "evoflow.knowledge.embedding.get_embedding",
            new=AsyncMock(return_value=mock_embedding),
        ):
            r = client.post(
                "/api/knowledge/embed",
                json={"text": "hello world"},
            )
            assert r.status_code == 200
            data = r.json()
            assert data["text"] == "hello world"
            assert data["embedding"] == mock_embedding
            assert data["dim"] == 5
            assert data["chunk_id"] is None


def test_embed_text_with_dataset(client):
    """Embed uses dataset's model config when dataset_id provided."""
    mock_embedding = [0.1] * 1536
    mock_dataset = {
        "dataset_id": "kb_001",
        "name": "Test KB",
        "embedding_model": "bge-m3",
        "embedding_dim": 1536,
    }
    with patch.object(
        knowledge.kb_service,
        "get_dataset",
        return_value=mock_dataset,
    ):
        with patch(
            "evoflow.knowledge.embedding.get_embedding",
            new=AsyncMock(return_value=mock_embedding),
        ):
            with patch(
                "evoflow.knowledge.embedding.resolve_embedding_model_config",
                return_value={"model": "bge-m3", "vendor": "local"},
            ):
                r = client.post(
                    "/api/knowledge/embed",
                    json={"text": "hello", "dataset_id": "kb_001"},
                )
                assert r.status_code == 200
                data = r.json()
                assert data["dim"] == 1536


def test_embed_text_with_store(client):
    """Embed stores vector in sqlite-vec when store=True."""
    mock_embedding = [0.1] * 1536
    mock_dataset = {
        "dataset_id": "kb_001",
        "name": "Test KB",
        "embedding_model": "bge-m3",
        "embedding_dim": 1536,
    }
    with patch.object(
        knowledge.kb_service,
        "get_dataset",
        return_value=mock_dataset,
    ):
        with patch(
            "evoflow.knowledge.embedding.get_embedding",
            new=AsyncMock(return_value=mock_embedding),
        ):
            with patch(
                "evoflow.knowledge.embedding.resolve_embedding_model_config",
                return_value={"model": "bge-m3"},
            ):
                with patch(
                    "evoflow.knowledge.vector.sqlite_vec.VectorStore.insert",
                ) as mock_insert:
                    r = client.post(
                        "/api/knowledge/embed",
                        json={"text": "hello", "dataset_id": "kb_001", "store": True},
                    )
                    assert r.status_code == 200
                    data = r.json()
                    assert data["chunk_id"] is not None
                    assert data["chunk_id"].startswith("embed_")
                    mock_insert.assert_called_once()


def test_embed_text_store_without_dataset(client):
    """Store=True requires dataset_id."""
    r = client.post(
        "/api/knowledge/embed",
        json={"text": "hello", "store": True},
    )
    assert r.status_code == 400
    assert "dataset_id is required" in r.json()["detail"]


def test_embed_text_missing_dataset(client):
    """Embed with invalid dataset_id returns 404."""
    with patch.object(
        knowledge.kb_service,
        "get_dataset",
        return_value=None,
    ):
        r = client.post(
            "/api/knowledge/embed",
            json={"text": "hello", "dataset_id": "nonexistent"},
        )
        assert r.status_code == 404


def test_embed_text_missing_query(client):
    """Embed requires a non-empty text."""
    r = client.post("/api/knowledge/embed", json={"text": ""})
    assert r.status_code == 422  # validation error


def test_embed_text_exception(client):
    """Embed handles service exceptions gracefully."""
    with patch(
        "evoflow.knowledge.embedding.get_embedding",
        new=AsyncMock(side_effect=RuntimeError("Model load failed")),
    ):
        r = client.post("/api/knowledge/embed", json={"text": "hello"})
        assert r.status_code == 500
