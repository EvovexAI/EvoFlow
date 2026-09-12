"""Gateway Knowledge Vault API tests (TestClient + mocked service layer)."""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path
from unittest.mock import AsyncMock, patch

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient


def _load_knowledge_vaults_router():
    """Load backend/app router even if packages/harness/app shadows ``app`` on sys.path."""
    router_path = Path(__file__).resolve().parents[1] / "gateway" / "routers" / "knowledge_vaults.py"
    # Prefer in-memory module to avoid colliding with harness stub package
    name = "evoflow_test_knowledge_vaults_router"
    if name in sys.modules:
        return sys.modules[name]
    spec = importlib.util.spec_from_file_location(name, router_path)
    assert spec and spec.loader
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


knowledge_vaults = _load_knowledge_vaults_router()


@pytest.fixture
def client():
    app = FastAPI()
    app.include_router(knowledge_vaults.router)
    return TestClient(app)


def test_list_vaults_empty(client):
    with patch.object(knowledge_vaults.vault_service, "list_vaults", return_value=[]):
        r = client.get("/api/knowledge/vaults")
        assert r.status_code == 200
        assert r.json()["items"] == []


def test_get_missing_vault(client):
    from evoflow.knowledge.vault.errors import VaultNotFoundError

    with patch.object(
        knowledge_vaults.vault_service,
        "get_vault",
        side_effect=VaultNotFoundError("missing"),
    ):
        r = client.get("/api/knowledge/vaults/nope")
        assert r.status_code == 404
        body = r.json()["detail"]
        assert body["error"] == "vault_not_found"


def test_create_does_not_echo_secret(client):
    public = {
        "id": "personal",
        "name": "personal",
        "vaultPath": "C:/vault",
        "hasObsidianApiKey": True,
        "accessMode": "read_write",
    }
    with patch.object(knowledge_vaults.vault_service, "create_vault", return_value=public):
        r = client.post(
            "/api/knowledge/vaults",
            json={
                "name": "personal",
                "vaultPath": "C:/vault",
                "accessMode": "read_write",
                "obsidianApiKey": "super-secret-key",
            },
        )
        assert r.status_code == 200
        data = r.json()
        assert "super-secret-key" not in str(data)
        assert data.get("hasObsidianApiKey") is True


def test_readonly_write_rejected(client):
    from evoflow.knowledge.vault.errors import WriteDisabledError

    with patch.object(
        knowledge_vaults.vault_service,
        "ingest_vault",
        AsyncMock(side_effect=WriteDisabledError("read only")),
    ):
        r = client.post(
            "/api/knowledge/vaults/personal/ingest",
            json={"title": "t", "content": "c"},
        )
        assert r.status_code == 403


def test_save_note_endpoint(client):
    with patch.object(
        knowledge_vaults.vault_service,
        "save_vault",
        AsyncMock(return_value={"vaultId": "personal", "item": {"path": "a.md", "content": "hi"}}),
    ):
        r = client.post(
            "/api/knowledge/vaults/personal/save",
            json={"path": "a.md", "content": "hi"},
        )
        assert r.status_code == 200
        assert r.json()["item"]["path"] == "a.md"


def test_delete_config_only_message(client):
    with patch.object(
        knowledge_vaults.vault_service,
        "delete_vault",
        AsyncMock(
            return_value={
                "success": True,
                "vaultId": "personal",
                "deletedConfigOnly": True,
                "message": "已删除 EvoFlow 中的知识库连接配置，未删除 Obsidian Vault 内任何文件。",
            }
        ),
    ):
        r = client.delete("/api/knowledge/vaults/personal")
        assert r.status_code == 200
        assert r.json()["deletedConfigOnly"] is True


def test_illegal_path_on_read(client):
    from evoflow.knowledge.vault.errors import PathEscapeDetectedError

    with patch.object(
        knowledge_vaults.vault_service,
        "read_vault",
        AsyncMock(side_effect=PathEscapeDetectedError("bad")),
    ):
        r = client.post(
            "/api/knowledge/vaults/personal/read",
            json={"paths": ["../escape.md"]},
        )
        assert r.status_code == 400
        assert r.json()["detail"]["error"] == "path_escape_detected"
