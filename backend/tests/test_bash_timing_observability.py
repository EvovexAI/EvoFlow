"""Bash exec timing detail → observability timing_json (warm/cold triage)."""

from __future__ import annotations

import importlib
import json
import sqlite3
from pathlib import Path

from evoflow.observability.sqlite_store import ObservabilitySqliteStore, ObservabilityTable
from evoflow.observability.tool_timing import (
    note_tool_exec_detail,
    note_tool_queue_wait,
    pop_tool_exec_detail,
    pop_tool_queue_wait,
)

bt = importlib.import_module("evoflow.tools.zcode_port.bash_tool")
queries = importlib.import_module("evoflow.observability.queries")


def test_exec_detail_registry_merge_and_pop() -> None:
    note_tool_exec_detail("call-t1", {"kind": "bash", "path": "warm"})
    note_tool_exec_detail("call-t1", {"exec_ms": 12.5, "warm_reused": True})
    detail = pop_tool_exec_detail("call-t1")
    assert detail == {
        "kind": "bash",
        "path": "warm",
        "exec_ms": 12.5,
        "warm_reused": True,
    }
    assert pop_tool_exec_detail("call-t1") is None


def test_insert_timing_json_roundtrip(tmp_path: Path) -> None:
    store = ObservabilitySqliteStore(tmp_path / "obs.db")
    store.insert_tool_invocation(
        thread_id="thread-bash",
        run_id=None,
        tool_call_id="call-bash-1",
        tool_name="bash",
        started_at="2026-11-08T21:00:00+08:00",
        ended_at="2026-11-08T21:00:01+08:00",
        duration_ms=1200.0,
        status="success",
        input_obj={"command": "git status --short"},
        output_text="ok",
        collab_phase=None,
        invocation_source="tool_middleware",
        queue_wait_ms=1100.0,
        timing={
            "kind": "bash",
            "path": "warm",
            "dialect": "bash",
            "warm_reused": True,
            "exec_ms": 28.4,
            "command_preview": "git status --short",
            "probe": True,
        },
    )
    conn = sqlite3.connect(tmp_path / "obs.db")
    try:
        row = conn.execute(
            f"SELECT duration_ms, queue_wait_ms, timing_json FROM {ObservabilityTable.TOOL_INVOCATIONS}"
        ).fetchone()
    finally:
        conn.close()
    assert row[0] == 1200.0
    assert row[1] == 1100.0
    timing = json.loads(row[2])
    assert timing["path"] == "warm"
    assert timing["exec_ms"] == 28.4


def test_migration_adds_timing_json(tmp_path: Path) -> None:
    db = tmp_path / "obs-old.db"
    conn = sqlite3.connect(db)
    try:
        conn.execute("PRAGMA user_version = 11")
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
                queue_wait_ms REAL,
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
    store.insert_tool_invocation(
        thread_id="t",
        run_id=None,
        tool_call_id="c",
        tool_name="bash",
        started_at="2026-11-08T21:00:00+08:00",
        ended_at="2026-11-08T21:00:00+08:00",
        duration_ms=40.0,
        status="success",
        input_obj={"command": "echo hi"},
        output_text="hi",
        collab_phase=None,
        invocation_source="tool_middleware",
        timing={"kind": "bash", "path": "cold", "exec_ms": 40},
    )
    conn = sqlite3.connect(db)
    try:
        ver = conn.execute("PRAGMA user_version").fetchone()[0]
        cols = {str(r[1]) for r in conn.execute(f"PRAGMA table_info({ObservabilityTable.TOOL_INVOCATIONS})")}
        timing_raw = conn.execute(
            f"SELECT timing_json FROM {ObservabilityTable.TOOL_INVOCATIONS}"
        ).fetchone()[0]
    finally:
        conn.close()
    assert ver >= 12
    assert "timing_json" in cols
    assert json.loads(timing_raw)["path"] == "cold"


def test_slim_tool_row_exposes_queue_and_timing() -> None:
    slim = queries._slim_tool_row_for_insights(
        {
            "id": "1",
            "thread_id": "t",
            "tool_name": "bash",
            "tool_call_id": "c",
            "started_at": "a",
            "ended_at": "b",
            "duration_ms": 237200.0,
            "queue_wait_ms": 237000.0,
            "timing_json": json.dumps(
                {"kind": "bash", "path": "warm", "exec_ms": 30.0, "dialect": "bash"}
            ),
            "status": "success",
            "output_text": "ok",
            "invocation_source": "tool_middleware",
        }
    )
    assert slim["queue_wait_ms"] == 237000.0
    assert slim["exec_ms"] == 30.0
    assert slim["timing"]["path"] == "warm"


def test_bash_shell_latency_stats_playbook(tmp_path: Path, monkeypatch) -> None:
    store = ObservabilitySqliteStore(tmp_path / "obs.db")
    for i, (queue, exec_ms, path) in enumerate(
        [
            (2000.0, 25.0, "warm"),
            (0.0, 680.0, "cold"),
            (10.0, 28.0, "warm"),
        ]
    ):
        store.insert_tool_invocation(
            thread_id="t",
            run_id=None,
            tool_call_id=f"c{i}",
            tool_name="bash",
            started_at="2026-11-08T21:00:00+08:00",
            ended_at="2026-11-08T21:00:01+08:00",
            duration_ms=queue + exec_ms,
            status="success",
            input_obj={"command": f"echo {i}"},
            output_text="ok",
            collab_phase=None,
            invocation_source="tool_middleware",
            queue_wait_ms=queue,
            timing={"kind": "bash", "path": path, "dialect": "bash", "exec_ms": exec_ms},
        )

    monkeypatch.setattr(queries, "_store", lambda: store)
    stats = queries._bash_shell_latency_stats(store._connection(), since=None, limit=10)
    assert stats["sample_count"] == 3
    assert stats["warm_count"] == 2
    assert stats["cold_count"] == 1
    assert stats["high_queue_count"] == 1
    assert "playbook" in stats and len(stats["playbook"]) >= 3
    assert stats["slowest"][0]["queue_wait_ms"] == 2000.0


def test_note_bash_timing_writes_registry() -> None:
    bt._note_bash_timing(
        "call-note-1",
        path="warm",
        dialect="bash",
        warm_reused=True,
        exec_ms=27.0,
        command_preview="echo hi",
        probe=False,
    )
    detail = pop_tool_exec_detail("call-note-1")
    assert detail is not None
    assert detail["kind"] == "bash"
    assert detail["path"] == "warm"
    assert detail["exec_ms"] == 27.0
    # leftover queue wait must not leak into this test
    assert pop_tool_queue_wait("call-note-1") is None
    note_tool_queue_wait("call-note-1", 1.0)
    assert pop_tool_queue_wait("call-note-1") == 1.0
