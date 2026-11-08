"""Session child-work registry + inject receipt dedup."""

from __future__ import annotations

import uuid

import pytest


@pytest.fixture()
def runtime_db(tmp_path, monkeypatch):
    db_path = tmp_path / f"runtime_{uuid.uuid4().hex[:8]}.db"
    monkeypatch.setenv("EVOFLOW_DB_PATH", str(db_path))
    from evoflow.persistence.db import get_db, reset_db_for_tests
    from evoflow.persistence.schema import ensure_app_schema

    reset_db_for_tests()
    conn = get_db()
    ensure_app_schema(conn)
    yield conn
    reset_db_for_tests()
    monkeypatch.delenv("EVOFLOW_DB_PATH", raising=False)


def test_schema_creates_session_runtime_tables(runtime_db):
    tables = {
        r[0]
        for r in runtime_db.execute(
            "SELECT name FROM sqlite_master WHERE type='table'"
        ).fetchall()
    }
    assert "evoflow_session_child_works" in tables
    assert "evoflow_session_inject_receipts" in tables


def test_child_work_register_complete_and_list(runtime_db):
    from evoflow.persistence.session_runtime_repository import (
        KIND_SUBAGENT,
        complete_child_work,
        list_child_works,
        list_uninjected_completed_child_works,
        upsert_child_work,
    )

    sk = f"sess_{uuid.uuid4().hex[:8]}"
    row = upsert_child_work(
        session_key=sk,
        kind=KIND_SUBAGENT,
        ref_id="task-1",
        status="running",
        thread_id="tid-child",
        parent_thread_id="tid-lead",
        title="general-purpose",
    )
    assert row is not None
    assert row["status"] == "running"
    assert row["work_id"] == "subagent:task-1"

    active = list_child_works(sk, active_only=True)
    assert len(active) == 1
    assert active[0]["ref_id"] == "task-1"

    complete_child_work(
        session_key=sk,
        kind=KIND_SUBAGENT,
        ref_id="task-1",
        status="completed",
    )
    active = list_child_works(sk, active_only=True)
    assert active == []
    pending = list_uninjected_completed_child_works(sk)
    assert len(pending) == 1
    assert pending[0]["status"] == "completed"


def test_inject_receipt_claim_is_one_shot(runtime_db):
    from evoflow.persistence.session_runtime_repository import (
        SOURCE_CHILD_WORK_COMPLETE,
        SOURCE_PENDING_INJECT,
        has_inject_receipt,
        list_uninjected_completed_child_works,
        record_inject_receipt,
        try_claim_inject,
        upsert_child_work,
        complete_child_work,
        KIND_SUBAGENT,
    )

    sk = f"sess_{uuid.uuid4().hex[:8]}"
    assert try_claim_inject(sk, SOURCE_PENDING_INJECT, "msg-1") is True
    assert try_claim_inject(sk, SOURCE_PENDING_INJECT, "msg-1") is False
    assert has_inject_receipt(sk, SOURCE_PENDING_INJECT, "msg-1") is True

    upsert_child_work(session_key=sk, kind=KIND_SUBAGENT, ref_id="t2", status="running")
    complete_child_work(session_key=sk, kind=KIND_SUBAGENT, ref_id="t2", status="completed")
    pending = list_uninjected_completed_child_works(sk)
    assert len(pending) == 1
    wid = pending[0]["work_id"]
    assert try_claim_inject(sk, SOURCE_CHILD_WORK_COMPLETE, wid) is True
    assert list_uninjected_completed_child_works(sk) == []
    # Idempotent record path
    again = record_inject_receipt(sk, SOURCE_CHILD_WORK_COMPLETE, wid)
    assert again is not None
    assert again["source_ref"] == wid


def test_pending_inject_skips_when_receipt_exists(runtime_db):
    from evoflow.persistence.pending_inject_repository import (
        clear_pending_inject_store_for_tests,
        enqueue_pending_inject,
    )
    from evoflow.persistence.session_runtime_repository import (
        SOURCE_PENDING_INJECT,
        record_inject_receipt,
    )

    clear_pending_inject_store_for_tests()
    sk = f"sess_{uuid.uuid4().hex[:8]}"
    mid = f"msg_{uuid.uuid4().hex[:8]}"
    first = enqueue_pending_inject(sk, message_id=mid, content="hello")
    assert first is not None
    record_inject_receipt(sk, SOURCE_PENDING_INJECT, mid)
    clear_pending_inject_store_for_tests()
    second = enqueue_pending_inject(sk, message_id=mid, content="hello again")
    assert second is None


def test_ensure_on_already_current_db(tmp_path):
    """Post-baseline ensure creates tables on a DB already stamped current."""
    import sqlite3

    from evoflow.persistence.schema import APP_SCHEMA_VERSION, ensure_app_schema

    path = tmp_path / f"stamped_{uuid.uuid4().hex[:8]}.db"
    conn = sqlite3.connect(str(path))
    conn.execute("CREATE TABLE IF NOT EXISTS evoflow_chat_sessions (session_key TEXT PRIMARY KEY)")
    conn.execute(f"PRAGMA user_version = {APP_SCHEMA_VERSION}")
    conn.commit()
    ensure_app_schema(conn)
    tables = {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()}
    assert "evoflow_session_child_works" in tables
    assert "evoflow_session_inject_receipts" in tables
    conn.close()
