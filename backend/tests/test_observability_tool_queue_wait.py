"""Observability ``queue_wait_ms``: fresh schema, old-DB migration, round-trip.

2026-11-07 排队口径修复回归：duration_ms 含 bash 执行通道排队，导致并行批次里
被排队的 `git show` 记成 237s。queue_wait_ms 单独落列后，分析时可拆分
exec = duration_ms - queue_wait_ms。
"""

from __future__ import annotations

import sqlite3
from pathlib import Path

from evoflow.observability.sqlite_store import ObservabilitySqliteStore, ObservabilityTable


def _insert_invocation(store: ObservabilitySqliteStore, *, queue_wait_ms: float | None) -> None:
    store.insert_tool_invocation(
        thread_id="thread-q",
        run_id=None,
        tool_call_id="call-q",
        tool_name="bash",
        started_at="2026-11-07T12:00:00+08:00",
        ended_at="2026-11-07T12:04:00+08:00",
        duration_ms=240_000.0,
        status="success",
        input_obj={"command": "git show HEAD"},
        output_text="ok",
        collab_phase=None,
        invocation_source="tool_middleware",
        queue_wait_ms=queue_wait_ms,
    )


def test_insert_and_read_queue_wait_ms(tmp_path: Path) -> None:
    store = ObservabilitySqliteStore(tmp_path / "obs.db")
    _insert_invocation(store, queue_wait_ms=237_200.5)
    _insert_invocation(store, queue_wait_ms=None)  # 非 bash / 无等待 → NULL

    conn = sqlite3.connect(tmp_path / "obs.db")
    try:
        rows = conn.execute(
            f"SELECT duration_ms, queue_wait_ms FROM {ObservabilityTable.TOOL_INVOCATIONS} ORDER BY rowid"
        ).fetchall()
    finally:
        conn.close()
    assert rows[0] == (240_000.0, 237_200.5)
    assert rows[1][1] is None


def test_migration_adds_queue_wait_ms_to_preexisting_db(tmp_path: Path) -> None:
    """老库（user_version=10，无该列）升级后可写入 queue_wait_ms，数据保留。"""
    db = tmp_path / "obs-old.db"
    conn = sqlite3.connect(db)
    try:
        conn.execute(f"PRAGMA user_version = 10")
        conn.execute(
            f"""
            CREATE TABLE {ObservabilityTable.TOOL_INVOCATIONS} (
                id TEXT PRIMARY KEY,
                thread_id TEXT NOT NULL,
                run_id TEXT,
                tool_call_id TEXT NOT NULL,
                tool_name TEXT NOT NULL,
                started_at TEXT NOT NULL,
                ended_at TEXT NOT NULL,
                duration_ms REAL NOT NULL,
                status TEXT NOT NULL,
                input_json TEXT,
                output_text TEXT,
                collab_phase TEXT,
                invocation_source TEXT NOT NULL DEFAULT 'tool_middleware',
                error_type TEXT,
                error_message TEXT,
                error_detail_json TEXT,
                agent_code TEXT,
                position_code TEXT
            )
            """
        )
        conn.commit()
    finally:
        conn.close()

    store = ObservabilitySqliteStore(db)
    _insert_invocation(store, queue_wait_ms=1_500.0)

    conn = sqlite3.connect(db)
    try:
        ver = conn.execute("PRAGMA user_version").fetchone()[0]
        row = conn.execute(
            f"SELECT duration_ms, queue_wait_ms FROM {ObservabilityTable.TOOL_INVOCATIONS}"
        ).fetchone()
    finally:
        conn.close()
    assert ver >= 11
    assert row == (240_000.0, 1_500.0)
