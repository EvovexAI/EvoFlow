"""P0 authz: models mask + owned doc guard + org_admin helpers."""

from __future__ import annotations

import gc
import tempfile
from pathlib import Path
from unittest.mock import MagicMock

import pytest

from evoflow.persistence.db import get_db, reset_db_for_tests
from evoflow.persistence.schema import ensure_app_schema

_EVOFLOW_ROOT = Path(__file__).resolve().parents[4]


@pytest.fixture
def sqlite_tmp(monkeypatch: pytest.MonkeyPatch):
    with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
        monkeypatch.setenv("EVOFLOW_HOME", tmp)
        monkeypatch.setenv("EVOFLOW_CONFIG_PATH", str(_EVOFLOW_ROOT / "config.yaml"))
        reset_db_for_tests()
        yield tmp
        reset_db_for_tests()
        gc.collect()


def test_model_api_key_always_masked() -> None:
    from app.gateway.routers.models import _mask_api_key

    assert _mask_api_key(None) is None
    assert _mask_api_key("abcd") == "****"
    assert _mask_api_key("sk-live-secret-key-9999") == "****9999"


def test_require_org_admin_blocks_non_admin(monkeypatch: pytest.MonkeyPatch) -> None:
    from fastapi import HTTPException

    from evoflow.authz import http_guard

    monkeypatch.setattr(
        http_guard,
        "resolve_authz_from_request",
        lambda _r: {
            "principal": {"principal_id": "user:bob"},
            "principal_id": "user:bob",
            "is_admin": False,
            "personal_scope": "personal:user:bob",
            "org_scope": "org:local",
            "org_id": "local",
        },
    )
    with pytest.raises(HTTPException) as ei:
        http_guard.require_org_admin(MagicMock())
    assert ei.value.status_code == 403


def test_require_owned_doc_visible(sqlite_tmp: str, monkeypatch: pytest.MonkeyPatch) -> None:
    del sqlite_tmp
    from fastapi import HTTPException

    from evoflow.authz import http_guard, principals as principals_mod
    from evoflow.authz.scope import personal_scope
    from evoflow.knowledge.owned import service as owned_service

    ensure_app_schema(get_db())
    alice = principals_mod.create_principal(display_name="Alice", principal_id="user:alice")
    bob = principals_mod.create_principal(display_name="Bob", principal_id="user:bob")
    assert alice and bob

    base = owned_service.create_base({"name": "Alice KB"})
    kid = str(base["id"])
    owned_service.set_kb_owner_scope(
        kid,
        org_id="local",
        owner_scope_id=personal_scope("user:alice"),
        created_by="user:alice",
    )
    doc = owned_service.upload_manual_markdown(kid, title="secret", content="x")
    did = str(doc["id"])

    def _authz(pid: str, principal):
        return {
            "principal": principal,
            "principal_id": pid,
            "is_admin": False,
            "personal_scope": personal_scope(pid),
            "org_scope": "org:local",
            "org_id": "local",
        }

    monkeypatch.setattr(http_guard, "resolve_authz_from_request", lambda _r: _authz("user:alice", alice))
    http_guard.require_owned_doc_visible(MagicMock(), did)

    monkeypatch.setattr(http_guard, "resolve_authz_from_request", lambda _r: _authz("user:bob", bob))
    with pytest.raises(HTTPException) as ei:
        http_guard.require_owned_doc_visible(MagicMock(), did)
    assert ei.value.status_code == 404
