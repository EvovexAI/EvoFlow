"""回合收尾后「迟到心跳」把快照写回 running —— 2026-11-22 第119轮现网实证。

【self-evolution-bot · 2026-11-22 · 第119轮 · 模型:deepseek-v4.1-flash-1017】
改了什么：新增本文件，锁住 `upsert_live_run_snapshot` 的迟到心跳闸。

为什么有这批用例（现网取证，09:35 三员工真实成功回合）：
  assistant 行 09:35:46.9～47.9 已落库（真答完了），10 秒后（09:35:56.9～57.9）
  同一个 session_key 又被 PUT 回 `status=running`；
  `updated_at - last_event_at` 恰为 **10.004～10.009s**，与前端
  `LIVE_RUN_PUT_BACKGROUND_MS=10000` 完全吻合 —— debounce 定时器在回合收尾后才触发。
后果链：`/live-run/check` 用 `status.startswith("completed_")` 判完成 → 已答完的回合
被认成「还在跑」，前端要等到 sweep（本机 interval=600s）把它标成 `completed_error`
才解开；成功轮因此被记进 error 桶（现网 125 error / 12 success）。

判据（与 `sweep_stale_running_snapshots` 第二路一致，不许两处各说一套）：
  要写 `running` 且「会话已终态」且「current_run_id 与该 run_id 不对齐」→ 丢弃写入。
反向边界必须逐条覆盖，否则闸门会误杀真回合。
"""

from __future__ import annotations

import sqlite3

from evoflow.persistence.live_run_repositories import upsert_live_run_snapshot

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


def _conn(session: dict | None) -> sqlite3.Connection:
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
    return conn


def _row(conn: sqlite3.Connection, sk: str) -> dict | None:
    cur = conn.execute(
        "SELECT run_id, status, partial_text FROM evoflow_chat_live_runs WHERE session_key = ?",
        (sk,),
    ).fetchone()
    return dict(cur) if cur else None


def test_late_running_heartbeat_after_terminal_session_is_dropped():
    """现网形态：会话已 done、current_run_id 空 → running 心跳必须被丢弃，不许写回。"""
    sk = "proactive:reviewer:chat:dept-x"
    conn = _conn({"session_key": sk, "run_status": "done", "current_run_id": None})

    out = upsert_live_run_snapshot(
        sk, run_id="run-602ec540ab79", status="running", partial_text="RV30", conn=conn
    )

    assert _row(conn, sk) is None, "终态会话的迟到 running 心跳被写进库了 —— 前端会误判回合未完"
    assert not (out or {}).get("status") == "running"


def test_first_heartbeat_while_running_is_allowed():
    """会话仍在 running（真回合）→ 心跳必须放行，否则会把活着的回合判死。"""
    sk = "proactive:reviewer:chat:dept-y"
    conn = _conn({"session_key": sk, "run_status": "running", "current_run_id": None})

    upsert_live_run_snapshot(
        sk, run_id="run-live", status="running", partial_text="流式中", conn=conn
    )

    row = _row(conn, sk)
    assert row is not None and row["status"] == "running", "真回合的 running 心跳被误挡"


def test_aligned_current_run_id_is_allowed_even_if_session_terminal():
    """会话 done 但 current_run_id 正是这条 run（收尾瞬间/刚发新消息）→ 放行。"""
    sk = "proactive:reviewer:chat:dept-z"
    conn = _conn({"session_key": sk, "run_status": "done", "current_run_id": "run-abc"})

    upsert_live_run_snapshot(sk, run_id="run-abc", status="running", partial_text="x", conn=conn)

    row = _row(conn, sk)
    assert row is not None and row["run_id"] == "run-abc" and row["status"] == "running"


def test_terminal_status_write_is_never_blocked():
    """终态写入永远放行（成功/失败都要能落库），否则成功轮记不下来。"""
    sk = "proactive:reviewer:chat:dept-w"
    conn = _conn({"session_key": sk, "run_status": "done", "current_run_id": None})

    upsert_live_run_snapshot(
        sk, run_id="run-done", status="completed_success", partial_text="RV30", conn=conn
    )

    row = _row(conn, sk)
    assert row is not None and row["status"] == "completed_success"


def test_missing_session_row_does_not_block():
    """会话行缺失（快照先写、会话后插的竞态窗口）→ 不许拦。"""
    sk = "proactive:new:chat:dept-v"
    conn = _conn(None)

    upsert_live_run_snapshot(sk, run_id="run-new", status="running", partial_text="", conn=conn)

    row = _row(conn, sk)
    assert row is not None and row["status"] == "running"


def test_dropped_heartbeat_keeps_previous_snapshot():
    """已被 sweep 标成 completed_error 的行，迟到的 running 不许把它翻回去。"""
    sk = "proactive:image-designer:chat:dept-u"
    conn = _conn({"session_key": sk, "run_status": "done", "current_run_id": None})
    upsert_live_run_snapshot(
        sk, run_id="run-old", status="completed_error", partial_text="ID30", conn=conn
    )

    upsert_live_run_snapshot(
        sk, run_id="run-old", status="running", partial_text="ID3", conn=conn
    )

    row = _row(conn, sk)
    assert row is not None
    assert row["status"] == "completed_error", "终态被迟到心跳翻回 running —— 前端会重新等一个死回合"
    assert row["partial_text"] == "ID30", "内容也被迟到心跳覆盖了"
