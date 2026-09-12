"""Share / session-notification / thread visibility isolation."""

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


def test_session_notifications_filter_by_created_by(sqlite_tmp: str) -> None:
    del sqlite_tmp
    from evoflow.persistence import session_notification_repositories as ntf

    ensure_app_schema(get_db())
    assert ntf.push_session_notification(
        session_key="sess-a",
        body="alice note unique",
        created_by="user:alice",
        notification_id="ntf-alice-1",
    )
    assert ntf.push_session_notification(
        session_key="sess-b",
        body="bob note unique",
        created_by="user:bob",
        notification_id="ntf-bob-1",
    )
    alice = ntf.list_session_notifications(created_by="user:alice", is_admin=False)
    assert len(alice) == 1
    assert alice[0]["body"] == "alice note unique"
    assert ntf.get_unread_count(created_by="user:alice", is_admin=False) == 1
    admin = ntf.list_session_notifications(is_admin=True)
    assert len(admin) == 2


def test_require_thread_visible_blocks_other_user(sqlite_tmp: str, monkeypatch: pytest.MonkeyPatch) -> None:
    del sqlite_tmp
    from fastapi import HTTPException

    from evoflow.authz import http_guard, principals as principals_mod
    from evoflow.authz.scope import personal_scope
    from evoflow.persistence import session_repositories as sess_repo
    from evoflow.persistence.db import get_db

    ensure_app_schema(get_db())
    alice = principals_mod.create_principal(display_name="Alice", principal_id="user:alice")
    bob = principals_mod.create_principal(display_name="Bob", principal_id="user:bob")
    assert alice and bob

    # Minimal session row owned by alice
    db = get_db()
    cols = {str(r[1]) for r in db.execute("PRAGMA table_info(evoflow_chat_sessions)").fetchall()}
    if "created_by" not in cols:
        pytest.skip("sessions table missing created_by")
    db.execute(
        """
        INSERT INTO evoflow_chat_sessions (
            session_key, title, created_at, updated_at, created_by, scope_id, is_deleted
        ) VALUES (?, ?, datetime('now'), datetime('now'), ?, ?, 0)
        """,
        ("sk-alice", "Alice chat", "user:alice", personal_scope("user:alice")),
    )
    # thread binding if column exists
    if "thread_id" in cols:
        db.execute(
            "UPDATE evoflow_chat_sessions SET thread_id = ? WHERE session_key = ?",
            ("thread-alice", "sk-alice"),
        )
    db.commit()

    monkeypatch.setattr(
        sess_repo,
        "find_session_key_by_thread_id",
        lambda tid: "sk-alice" if tid == "thread-alice" else None,
    )

    def _authz_bob(_req):
        return {
            "principal": bob,
            "principal_id": "user:bob",
            "is_admin": False,
            "personal_scope": personal_scope("user:bob"),
            "org_scope": "org:local",
            "org_id": "local",
        }

    def _authz_alice(_req):
        return {
            "principal": alice,
            "principal_id": "user:alice",
            "is_admin": False,
            "personal_scope": personal_scope("user:alice"),
            "org_scope": "org:local",
            "org_id": "local",
        }

    monkeypatch.setattr(http_guard, "resolve_authz_from_request", _authz_alice)
    http_guard.require_thread_visible(MagicMock(), "thread-alice")

    monkeypatch.setattr(http_guard, "resolve_authz_from_request", _authz_bob)
    with pytest.raises(HTTPException) as ei:
        http_guard.require_thread_visible(MagicMock(), "thread-alice")
    assert ei.value.status_code == 404
