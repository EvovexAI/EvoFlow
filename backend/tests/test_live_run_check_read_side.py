"""`/live-run/check` 读取侧判据 —— 2026-11-22 第120轮。

【self-evolution-bot · 2026-11-22 · 第120轮 · 模型:deepseek-v4.1-flash-1017】
改了什么：新增本文件，锁住 `snapshot_completed_state()`。

为什么有这批用例（读侧调用链取证）：
  `install-visibility-reattach.ts:53-87` 只在 `/live-run/check` 回 `completed=true` 时
  才刷新消息并清快照；回 false 就走 `stale-run-refresh` 干等着。
  原判据只认 `status.startswith("completed_")`，于是「进程被杀 / 窗口关闭」留下的
  `running` 行永远回 false —— 要等 sweep 才清，而本机
  `EVOFLOW_ZOMBIE_SWEEP_INTERVAL_S=600`，即死回合最长被认成「还在跑」**10 分钟**。

判据（与 `sweep_stale_running_snapshots` 第二路逐字一致）：
  会话 run_status 已是终态 且 current_run_id 与快照 run_id 不对齐 → completed=true。
反向边界：真回合（会话 running / run_id 对齐）、会话行缺失、无快照 → 必须回 false，
否则会把正在跑的回合判死，前端提前放弃接续。
"""

from __future__ import annotations

import sqlite3

from evoflow.persistence.live_run_repositories import snapshot_completed_state

_DDL = """
CREATE TABLE evoflow_chat_live_runs (
    session_key TEXT PRIMARY KEY,
    thread_id TEXT,
    run_id TEXT,
    status TEXT,
    partial_text TEXT,
    partial_tools_json TEXT,
    display_segments_json TEXT,
    last_event_at TEXT,
    updated_at TEXT
)
"""

_SESSIONS_DDL = """
CREATE TABLE evoflow_chat_sessions (
    session_key TEXT PRIMARY KEY,
    run_status TEXT,
    current_run_id TEXT,
    is_deleted INTEGER DEFAULT 0
)
"""


def _conn(snapshot: dict | None, session: dict | None) -> sqlite3.Connection:
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    conn.execute(_DDL)
    conn.execute(_SESSIONS_DDL)
    if session:
        conn.execute(
            "INSERT INTO evoflow_chat_sessions (session_key, run_status, current_run_id, is_deleted)"
            " VALUES (?,?,?,?)",
            (
                session["session_key"],
                session.get("run_status", "running"),
                session.get("current_run_id"),
                session.get("is_deleted", 0),
            ),
        )
    if snapshot:
        conn.execute(
            "INSERT INTO evoflow_chat_live_runs (session_key, thread_id, run_id, status,"
            " partial_text, partial_tools_json, display_segments_json, last_event_at, updated_at)"
            " VALUES (?,?,?,?,?,?,?,?,?)",
            (
                snapshot["session_key"],
                "tid",
                snapshot.get("run_id", "run-1"),
                snapshot.get("status", "running"),
                "",
                None,
                None,
                None,
                None,
            ),
        )
    return conn


def test_orphan_running_snapshot_reads_as_completed():
    """会话已 done、current_run_id 空、快照还 running → 立刻报完成（别让前端等 10 分钟）。"""
    sk = "proactive:reviewer:chat:dept-a"
    conn = _conn(
        {"session_key": sk, "run_id": "run-602ec540ab79", "status": "running"},
        {"session_key": sk, "run_status": "done", "current_run_id": None},
    )

    out = snapshot_completed_state(sk, conn=conn)

    assert out["completed"] is True
    assert out["reason"] == "orphan_terminal_session"


def test_live_running_turn_is_not_completed():
    """会话仍在 running（真回合）→ 必须回 false，否则前端会放弃接续活着的流。"""
    sk = "proactive:reviewer:chat:dept-b"
    conn = _conn(
        {"session_key": sk, "run_id": "run-live", "status": "running"},
        {"session_key": sk, "run_status": "running", "current_run_id": "run-live"},
    )

    out = snapshot_completed_state(sk, conn=conn)

    assert out["completed"] is False
    assert out["reason"] == "live"


def test_aligned_run_id_protected_even_if_session_terminal():
    """会话 done 但 run_id 对齐（收尾瞬间/刚发新消息）→ 不许报完成。"""
    sk = "proactive:reviewer:chat:dept-c"
    conn = _conn(
        {"session_key": sk, "run_id": "run-abc", "status": "running"},
        {"session_key": sk, "run_status": "done", "current_run_id": "run-abc"},
    )

    assert snapshot_completed_state(sk, conn=conn)["completed"] is False


def test_terminal_snapshot_still_reads_completed():
    """快照本身已终态 → 照旧 true（保持原行为，前端依赖它）。"""
    sk = "proactive:reviewer:chat:dept-d"
    conn = _conn({"session_key": sk, "run_id": "run-x", "status": "completed_error"}, None)

    out = snapshot_completed_state(sk, conn=conn)

    assert out["completed"] is True
    assert out["reason"] == "terminal"


def test_missing_snapshot_reads_not_completed():
    """没有快照 → false（前端走原来的「无快照」分支）。"""
    out = snapshot_completed_state("proactive:none:chat:dept-e", conn=_conn(None, None))
    assert out["completed"] is False
    assert out["reason"] == "no_snapshot"


def test_missing_session_row_falls_back_to_live():
    """会话行缺失（快照先写、会话后插的竞态窗口）→ 不许判完成。"""
    sk = "proactive:new:chat:dept-f"
    conn = _conn({"session_key": sk, "run_id": "run-new", "status": "running"}, None)

    out = snapshot_completed_state(sk, conn=conn)

    assert out["completed"] is False
    assert out["reason"] == "no_session_row"


def test_deleted_session_is_not_treated_as_orphan():
    """is_deleted=1 的会话不参与终态判定（sweep 同样排除）→ 回 false。"""
    sk = "proactive:gone:chat:dept-g"
    conn = _conn(
        {"session_key": sk, "run_id": "run-g", "status": "running"},
        {"session_key": sk, "run_status": "done", "current_run_id": None, "is_deleted": 1},
    )

    out = snapshot_completed_state(sk, conn=conn)

    assert out["completed"] is False
    assert out["reason"] == "no_session_row"
