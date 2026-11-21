"""重启后「卡住/叫不醒」的真因：live 快照永远停在 running。

【self-evolution-bot · 2026-11-20 · 第96轮 · 模型:deepseek-v4.1-flash-1017】
为什么有这批用例：`evoflow_chat_live_runs` 里进程被杀后留下的 `status='running'` 行
**没有任何回收路径**——`delete_live_run_snapshot()` 只有两个调用点（前端主动 DELETE /
stream 正常 flush），重启=taskkill 两者都不会发生。现网实测 118 条 running、其中 116 条
心跳早于当天 17:00（最旧停在 11-18）。

后果链条：`GET /{sk}/live-run/check` 用 `status.startswith("completed_")` 判完成 →
这些行永远回 completed=False → 前端 `install-visibility-reattach` 认为「run 还没结束、
只是没在流」，于是一直等着接续一条早已死掉的 run。用户看到的就是重启后卡住。

判据：过期心跳的 running 行标 `completed_error`（不是删除——删了会退化成「没有快照」
那条旧分支，仍要等超时）；新鲜心跳一个都不许动。
"""

from __future__ import annotations

import sqlite3

import pytest

from evoflow.persistence.live_run_repositories import sweep_stale_running_snapshots
from evoflow.persistence.timestamps import now_iso_z

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

# 【self-evolution-bot · 2026-11-20 · 第99轮 · 模型:deepseek-v4.1-flash-1017】
# 改了什么：夹具补 `evoflow_chat_sessions` 表（原来只有 live_runs）。
# 为什么：第99轮给 sweep 加了「会话已终态 ⇒ 孤儿」判据，夹具若无该表，
# 新判据每次都走 except 降级分支——测试全绿却一行新逻辑都没执行（假绿）。
_SESSIONS_DDL = """
CREATE TABLE evoflow_chat_sessions (
    session_key TEXT PRIMARY KEY,
    run_status TEXT,
    session_status TEXT,
    current_run_id TEXT,
    is_deleted INTEGER DEFAULT 0,
    updated_at TEXT
)
"""


def _seed(rows: list[dict], sessions: list[dict] | None = None) -> sqlite3.Connection:
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    conn.execute(_DDL)
    conn.execute(_SESSIONS_DDL)
    for s in sessions or []:
        conn.execute(
            """
            INSERT INTO evoflow_chat_sessions
                (session_key, run_status, session_status, current_run_id, is_deleted, updated_at)
            VALUES (?,?,?,?,?,?)
            """,
            (
                s["session_key"],
                s.get("run_status", "running"),
                s.get("session_status", "active"),
                s.get("current_run_id"),
                s.get("is_deleted", 0),
                s.get("updated_at"),
            ),
        )
    for r in rows:
        conn.execute(
            """
            INSERT INTO evoflow_chat_live_runs
                (session_key, thread_id, run_id, status, partial_text,
                 partial_tools_json, display_segments_json, last_event_at, updated_at)
            VALUES (?,?,?,?,?,?,?,?,?)
            """,
            (
                r["session_key"],
                r.get("thread_id", "tid"),
                r.get("run_id", "run-1"),
                r.get("status", "running"),
                "",
                None,
                None,
                r.get("last_event_at"),
                r.get("updated_at", r.get("last_event_at")),
            ),
        )
    return conn


def _status(conn: sqlite3.Connection, sk: str) -> str:
    return str(
        conn.execute(
            "SELECT status FROM evoflow_chat_live_runs WHERE session_key = ?", (sk,)
        ).fetchone()[0]
    )


def test_stale_running_snapshot_becomes_terminal():
    """心跳停在 4 小时前的 running 行 → completed_error（前端 /live-run/check 才认完成）。"""
    conn = _seed(
        [
            {"session_key": "s-very-old", "last_event_at": "2026-11-18T20:56:25+08:00"},
            {"session_key": "s-old", "last_event_at": "2026-11-20T13:00:00+08:00"},
        ]
    )
    stats = sweep_stale_running_snapshots(max_age_s=180, conn=conn)

    assert stats == {"scanned": 2, "swept": 2}
    for sk in ("s-very-old", "s-old"):
        st = _status(conn, sk)
        assert st == "completed_error", f"{sk} 仍是 {st} —— /live-run/check 会永远回 completed=False"
        assert st.startswith("completed_")


def test_fresh_heartbeat_is_untouched():
    """心跳是新的（当前时刻）→ 一个都不许动，否则会把正在跑的回合误判成终态。"""
    conn = _seed([{"session_key": "s-live", "last_event_at": now_iso_z()}])
    stats = sweep_stale_running_snapshots(max_age_s=180, conn=conn)

    assert stats == {"scanned": 1, "swept": 0}
    assert _status(conn, "s-live") == "running"


def test_terminal_rows_are_not_rescanned():
    """已经是终态的行不在清扫范围（幂等：重复调用不再改动）。"""
    conn = _seed(
        [
            {"session_key": "s-done", "status": "completed_success", "last_event_at": "2026-11-01T00:00:00Z"},
            {"session_key": "s-err", "status": "completed_error", "last_event_at": "2026-11-01T00:00:00Z"},
        ]
    )
    stats = sweep_stale_running_snapshots(max_age_s=180, conn=conn)

    assert stats == {"scanned": 0, "swept": 0}
    assert _status(conn, "s-done") == "completed_success"
    assert _status(conn, "s-err") == "completed_error"


def test_running_row_without_heartbeat_is_swept():
    """running 行连心跳都没有（半写/旧版本遗留）→ 也该清扫：它自己不会变新鲜。"""
    conn = _seed([{"session_key": "s-no-beat", "last_event_at": None, "updated_at": None}])
    stats = sweep_stale_running_snapshots(max_age_s=180, conn=conn)

    assert stats == {"scanned": 1, "swept": 1}
    assert _status(conn, "s-no-beat") == "completed_error"


def test_disabled_switch_is_noop():
    """`max_age_s<=0` = 关闭清扫（保留旧行为），一行都不许改。"""
    conn = _seed([{"session_key": "s-old", "last_event_at": "2026-11-18T20:56:25+08:00"}])
    stats = sweep_stale_running_snapshots(max_age_s=0, conn=conn)

    assert stats == {"scanned": 0, "swept": 0}
    assert _status(conn, "s-old") == "running"


@pytest.mark.parametrize("age_s,expect_swept", [(60, 0), (600, 1)])
def test_threshold_boundary(age_s: int, expect_swept: int):
    """阈值两侧各一发：窗口内保留，窗口外清扫。"""
    import datetime

    beat = datetime.datetime.now(datetime.UTC) - datetime.timedelta(seconds=age_s)
    conn = _seed([{"session_key": "s-x", "last_event_at": beat.strftime("%Y-%m-%dT%H:%M:%SZ")}])

    stats = sweep_stale_running_snapshots(max_age_s=180, conn=conn)

    assert stats["swept"] == expect_swept
    assert _status(conn, "s-x") == ("running" if expect_swept == 0 else "completed_error")


# 【self-evolution-bot · 2026-11-20 · 第99轮 · 模型:deepseek-v4.1-flash-1017】
# 这 4 条针对第99轮新增判据：会话已终态 ⇒ 快照按孤儿回收，**不看心跳**。
# 现网取证：23:29 两条 running 快照心跳是当秒的（前端每 ~5s 刷），启动 sweep 只扫到 1 条，
# 纯心跳判据永远抓不到它们。
def test_terminal_session_sweeps_despite_fresh_heartbeat():
    """会话 run_status=done 而快照还 running，心跳是当秒的 → 必须回收。"""
    conn = _seed(
        [{"session_key": "s-stuck", "last_event_at": now_iso_z()}],
        sessions=[{"session_key": "s-stuck", "run_status": "done"}],
    )
    stats = sweep_stale_running_snapshots(max_age_s=180, conn=conn)

    assert stats == {"scanned": 1, "swept": 1}
    assert _status(conn, "s-stuck") == "completed_error"


def test_active_session_keeps_fresh_snapshot():
    """会话仍在 running + 心跳新鲜 → 一行都不许动（正在跑的真回合）。"""
    conn = _seed(
        [{"session_key": "s-real", "last_event_at": now_iso_z()}],
        sessions=[{"session_key": "s-real", "run_status": "running"}],
    )
    stats = sweep_stale_running_snapshots(max_age_s=180, conn=conn)

    assert stats == {"scanned": 1, "swept": 0}
    assert _status(conn, "s-real") == "running"


def test_missing_session_row_falls_back_to_heartbeat():
    """没有会话行 → 不按孤儿处理（可能是快照先写、会话行后插的竞态窗口）。"""
    conn = _seed([{"session_key": "s-orphan-no-row", "last_event_at": now_iso_z()}])
    stats = sweep_stale_running_snapshots(max_age_s=180, conn=conn)

    assert stats == {"scanned": 1, "swept": 0}, "无会话行时须退回心跳判据；心跳新鲜不得清扫"


# 【self-evolution-bot · 2026-11-21 · 第100轮 · 模型:deepseek-v4.1-flash-1017】
# run_id 对齐保护：会话声称的 current_run_id 正是这条快照时必须放行。
# 现网实证据（00:39 两条 running 快照）：…05-07-10.588Z 两边 run_id 完全一致且都 running
# （真在跑）；…16-15-39.290Z 会话 current_run_id 为空、快照 run_id 是前端占位符
# `run-964e7593228f`（真孤儿）。没有这条保护，前者会在「会话还写着上一轮 done、
# 新回合快照已写入」的窗口里被误清。
def test_aligned_run_id_is_protected_even_if_session_terminal():
    """会话 done 但 current_run_id 与快照 run_id 对齐 + 心跳新鲜 → 不许清。"""
    conn = _seed(
        [
            {
                "session_key": "s-align",
                "run_id": "run-abc",
                "last_event_at": now_iso_z(),
            }
        ],
        sessions=[
            {"session_key": "s-align", "run_status": "done", "current_run_id": "run-abc"}
        ],
    )
    stats = sweep_stale_running_snapshots(max_age_s=180, conn=conn)

    assert stats == {"scanned": 1, "swept": 0}, "run_id 对齐即视为当前轮，不得误清"
    assert _status(conn, "s-align") == "running"


def test_unaligned_run_id_with_terminal_session_is_orphan():
    """会话 done 且 current_run_id 与快照 run_id 不对齐 → 真孤儿，必须清（现网 16-15 形态）。"""
    conn = _seed(
        [{"session_key": "s-orphan", "run_id": "run-964e7593228f", "last_event_at": now_iso_z()}],
        sessions=[{"session_key": "s-orphan", "run_status": "done", "current_run_id": None}],
    )
    stats = sweep_stale_running_snapshots(max_age_s=180, conn=conn)

    assert stats == {"scanned": 1, "swept": 1}
    assert _status(conn, "s-orphan") == "completed_error"
