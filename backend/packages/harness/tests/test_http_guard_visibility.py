"""HTTP resource visibility guards (anti-IDOR)."""

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
    with tempfile.TemporaryDirectory() as tmp:
        monkeypatch.setenv("EVOFLOW_HOME", tmp)
        monkeypatch.setenv("EVOFLOW_CONFIG_PATH", str(_EVOFLOW_ROOT / "config.yaml"))
        reset_db_for_tests()
        yield tmp
        reset_db_for_tests()
        gc.collect()


def _fake_request(principal_id: str, *, is_admin: bool = False):
    req = MagicMock()
    # resolve_request_authz reads request; we monkeypatch the resolver instead
    return req, principal_id, is_admin


def test_require_app_visible_blocks_other_user(sqlite_tmp: str, monkeypatch: pytest.MonkeyPatch) -> None:
    del sqlite_tmp
    from fastapi import HTTPException

    from evoflow.authz import http_guard, principals as principals_mod
    from evoflow.authz.scope import personal_scope
    from evoflow.persistence import app_repositories

    ensure_app_schema(get_db())
    alice = principals_mod.create_principal(display_name="Alice", principal_id="user:alice")
    bob = principals_mod.create_principal(display_name="Bob", principal_id="user:bob")
    assert alice and bob

    app_repositories.save_app(
        "App_secret",
        {"name": "Secret", "description": "", "parameters": [], "steps": [], "status": "draft"},
    )
    app_repositories.set_app_owner_scope(
        "App_secret",
        org_id="local",
        owner_scope_id=personal_scope("user:alice"),
        created_by="user:alice",
    )

    def _authz_alice(_req):
        return {
            "principal": alice,
            "principal_id": "user:alice",
            "is_admin": False,
            "personal_scope": personal_scope("user:alice"),
            "org_scope": "org:local",
            "org_id": "local",
        }

    def _authz_bob(_req):
        return {
            "principal": bob,
            "principal_id": "user:bob",
            "is_admin": False,
            "personal_scope": personal_scope("user:bob"),
            "org_scope": "org:local",
            "org_id": "local",
        }

    monkeypatch.setattr(http_guard, "resolve_authz_from_request", _authz_alice)
    http_guard.require_app_visible(MagicMock(), "App_secret")

    monkeypatch.setattr(http_guard, "resolve_authz_from_request", _authz_bob)
    with pytest.raises(HTTPException) as ei:
        http_guard.require_app_visible(MagicMock(), "App_secret")
    assert ei.value.status_code == 404


def test_require_session_visible_blocks_other_user(sqlite_tmp: str, monkeypatch: pytest.MonkeyPatch) -> None:
    del sqlite_tmp
    from fastapi import HTTPException

    from evoflow.authz import http_guard, principals as principals_mod
    from evoflow.authz.scope import personal_scope
    from evoflow.authz.session_ownership import stamp_session_ownership
    from evoflow.persistence import session_repositories as sess_repo

    ensure_app_schema(get_db())
    alice = principals_mod.create_principal(display_name="Alice", principal_id="user:alice")
    bob = principals_mod.create_principal(display_name="Bob", principal_id="user:bob")
    sess_repo.upsert_session_row("agent:main:alice-only", title="t", thread_id="tid-a")
    stamp_session_ownership("agent:main:alice-only", alice, force=True)

    monkeypatch.setattr(
        http_guard,
        "resolve_authz_from_request",
        lambda _r: {
            "principal": bob,
            "principal_id": "user:bob",
            "is_admin": False,
            "personal_scope": personal_scope("user:bob"),
            "org_scope": "org:local",
            "org_id": "local",
        },
    )
    with pytest.raises(HTTPException) as ei:
        http_guard.require_session_visible(MagicMock(), "agent:main:alice-only")
    assert ei.value.status_code == 404


def test_skills_prompt_accepts_principal_kw() -> None:
    from evoflow.agents.lead_agent.prompt import get_skills_prompt_section

    # Should not raise; principal without DB home still falls back safely
    section = get_skills_prompt_section(set(), principal_id="user:nobody")
    assert isinstance(section, str)
