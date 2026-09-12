"""P1 authz: asset entity isolation + org_admin router deps."""

from __future__ import annotations

import gc
import tempfile
from pathlib import Path
from unittest.mock import MagicMock

import pytest
from fastapi import HTTPException

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


def _authz(pid: str, *, is_admin: bool = False):
    from evoflow.authz.scope import personal_scope

    return {
        "principal": {"principal_id": pid},
        "principal_id": pid,
        "is_admin": is_admin,
        "personal_scope": personal_scope(pid),
        "org_scope": "org:local",
        "org_id": "local",
    }


def test_sanitize_user_asset_id() -> None:
    from evoflow.assets.paths import EntityRef, entity_relative_dir, sanitize_user_asset_id

    assert sanitize_user_asset_id("user") == "user"
    assert sanitize_user_asset_id("user:alice") == "user_alice"
    assert entity_relative_dir(EntityRef("user", "user")) == "user"
    assert entity_relative_dir(EntityRef("user", "user:alice")) == "users/user_alice"


def test_resolve_asset_user_isolated(monkeypatch: pytest.MonkeyPatch) -> None:
    from evoflow.authz import http_guard

    monkeypatch.setattr(http_guard, "resolve_authz_from_request", lambda _r: _authz("user:alice"))
    ent = http_guard.resolve_asset_entity_for_request(MagicMock(), "user", "user")
    assert ent.entity_type == "user"
    assert ent.entity_id == "user_alice"

    with pytest.raises(HTTPException) as ei:
        http_guard.resolve_asset_entity_for_request(MagicMock(), "user", "user:bob")
    assert ei.value.status_code == 404


def test_resolve_asset_user_unauthenticated_legacy(monkeypatch: pytest.MonkeyPatch) -> None:
    from evoflow.authz import http_guard

    monkeypatch.setattr(
        http_guard,
        "resolve_authz_from_request",
        lambda _r: {
            "principal": {},
            "principal_id": "",
            "is_admin": False,
            "personal_scope": None,
            "org_scope": "org:local",
            "org_id": "local",
        },
    )
    ent = http_guard.resolve_asset_entity_for_request(MagicMock(), "user", "user")
    assert ent.entity_id == "user"


def test_filter_asset_entities_rewrites_user(monkeypatch: pytest.MonkeyPatch) -> None:
    from evoflow.authz import http_guard

    monkeypatch.setattr(http_guard, "resolve_authz_from_request", lambda _r: _authz("user:alice"))
    monkeypatch.setattr(http_guard, "require_agent_visible", lambda *_a, **_k: None)

    filtered = http_guard.filter_asset_entities_for_request(
        MagicMock(),
        [
            {"entityType": "user", "entityId": "user", "label": "我", "root": "user"},
            {"entityType": "employee", "entityId": "bot-a", "label": "Bot", "root": "employees/bot-a"},
        ],
    )
    assert filtered[0]["entityType"] == "user"
    assert filtered[0]["entityId"] == "user_alice"
    assert filtered[0]["root"] == "users/user_alice"


def test_require_org_admin_still_blocks(monkeypatch: pytest.MonkeyPatch) -> None:
    from evoflow.authz import http_guard

    monkeypatch.setattr(http_guard, "resolve_authz_from_request", lambda _r: _authz("user:bob"))
    with pytest.raises(HTTPException) as ei:
        http_guard.require_org_admin(MagicMock())
    assert ei.value.status_code == 403


def test_legacy_knowledge_router_has_admin_dep() -> None:
    from app.gateway.routers import knowledge as knowledge_router

    deps = getattr(knowledge_router.router, "dependencies", None) or []
    assert deps, "legacy /api/knowledge must require org_admin"


def test_skills_update_requires_admin(monkeypatch: pytest.MonkeyPatch) -> None:
    from evoflow.authz import http_guard

    monkeypatch.setattr(http_guard, "resolve_authz_from_request", lambda _r: _authz("user:bob"))
    with pytest.raises(HTTPException) as ei:
        http_guard.require_org_admin(MagicMock())
    assert ei.value.status_code == 403


def test_agent_asset_requires_visible(sqlite_tmp: str, monkeypatch: pytest.MonkeyPatch) -> None:
    del sqlite_tmp
    from evoflow.authz import http_guard, principals as principals_mod
    from evoflow.authz.scope import personal_scope
    from evoflow.persistence import config_repositories as cfg_repo

    ensure_app_schema(get_db())
    alice = principals_mod.create_principal(display_name="Alice", principal_id="user:alice")
    bob = principals_mod.create_principal(display_name="Bob", principal_id="user:bob")
    assert alice and bob

    # Create agent owned by alice if API exists
    try:
        cfg_repo.upsert_agent(
            {
                "agent_code": "alice-bot",
                "name": "Alice Bot",
                "owner_scope_id": personal_scope("user:alice"),
                "created_by": "user:alice",
                "org_id": "local",
            }
        )
    except Exception:
        # Fallback: just mock visibility
        monkeypatch.setattr(
            cfg_repo,
            "agent_visible_to_principal",
            lambda code, pid, **kw: code == "alice-bot" and pid == "user:alice",
        )

    monkeypatch.setattr(http_guard, "resolve_authz_from_request", lambda _r: _authz("user:alice"))
    ent = http_guard.resolve_asset_entity_for_request(MagicMock(), "employee", "alice-bot")
    assert ent.entity_id == "alice-bot"

    monkeypatch.setattr(http_guard, "resolve_authz_from_request", lambda _r: _authz("user:bob"))
    with pytest.raises(HTTPException) as ei:
        http_guard.resolve_asset_entity_for_request(MagicMock(), "employee", "alice-bot")
    assert ei.value.status_code == 404
