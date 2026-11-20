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


def _seed(rows: list[dict]) -> sqlite3.Connection:
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    conn.execute(_DDL)
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
