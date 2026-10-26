"""E-1 hard layer: terminal-row protection in save_task_bundle.

A stale whole-bundle rewrite (classic cross-process race: worker completed the
subtask while the gateway held an older copy with it still ``executing``) must
not resurrect the terminal row. The protection decision lives in
``_protect_terminal_subtask_rows`` and is exercised here against an in-memory
SQLite table.
"""

from __future__ import annotations

import sqlite3
from typing import Any

from evoflow.persistence.task_repositories import _protect_terminal_subtask_rows


def _conn() -> sqlite3.Connection:
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    conn.execute(
        """
        CREATE TABLE evoflow_collab_subtasks (
            main_task_id TEXT,
            subtask_id TEXT,
            status TEXT,
            updated_at TEXT,
            extra_json TEXT
        )
        """
    )
    return conn


def _db_row(conn: sqlite3.Connection, sid: str, status: str, updated_at: str, extra: str = "{}") -> None:
    conn.execute(
        "INSERT INTO evoflow_collab_subtasks VALUES (?, ?, ?, ?, ?)",
        ("m1", sid, status, updated_at, extra),
    )


def _incoming(sid: str, status: str, updated_at: str) -> dict[str, Any]:
    return {"subtask_id": sid, "status": status, "updated_at": updated_at, "extra_json": "{}"}


def test_stale_non_terminal_rewrite_is_replaced_by_db_terminal_row():
    conn = _conn()
    _db_row(conn, "s1", "completed", "2026-10-25T12:00:00Z", extra='{"task_report": "done text"}')
    rows = [_incoming("s1", "executing", "2026-10-25T11:00:00Z")]
    _protect_terminal_subtask_rows(conn, "m1", {"subtasks": rows})
    assert rows[0]["status"] == "completed"
    assert "done text" in rows[0]["extra_json"]


def test_newer_reopen_write_passes_through():
    conn = _conn()
    _db_row(conn, "s1", "failed", "2026-10-25T12:00:00Z")
    rows = [_incoming("s1", "pending", "2026-10-25T13:00:00Z")]  # reconciler requeue, newer stamp
    _protect_terminal_subtask_rows(conn, "m1", {"subtasks": rows})
    assert rows[0]["status"] == "pending"


def test_terminal_to_terminal_transitions_pass_through():
    conn = _conn()
    _db_row(conn, "s1", "completed", "2026-10-25T12:00:00Z")
    rows = [_incoming("s1", "cancelled", "2026-10-25T11:00:00Z")]  # cancel wins even with older stamp
    _protect_terminal_subtask_rows(conn, "m1", {"subtasks": rows})
    assert rows[0]["status"] == "cancelled"


def test_unknown_subtask_untouched():
    conn = _conn()
    _db_row(conn, "other", "completed", "2026-10-25T12:00:00Z")
    rows = [_incoming("s-new", "executing", "2026-10-25T11:00:00Z")]
    _protect_terminal_subtask_rows(conn, "m1", {"subtasks": rows})
    assert rows[0]["status"] == "executing"


def test_equal_timestamps_protect():
    # Equal stamps mean we cannot prove the incoming write is newer — keep terminal.
    conn = _conn()
    _db_row(conn, "s1", "completed", "2026-10-25T12:00:00Z")
    rows = [_incoming("s1", "executing", "2026-10-25T12:00:00Z")]
    _protect_terminal_subtask_rows(conn, "m1", {"subtasks": rows})
    assert rows[0]["status"] == "completed"
