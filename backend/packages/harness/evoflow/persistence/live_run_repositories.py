"""Lightweight live snapshot persistence for in-progress chat runs."""

from __future__ import annotations

import json
from typing import Any

from evoflow.persistence.db import get_db, run_db_transaction
from evoflow.persistence.timestamps import iso_z_to_ms, ms_to_iso_z, now_iso_z


def _dumps(obj: Any) -> str:
    return json.dumps(obj, ensure_ascii=False, separators=(",", ":"))


def _loads(raw: str | None) -> Any:
    if not raw:
        return None
    return json.loads(raw)


def upsert_live_run_snapshot(
    session_key: str,
    *,
    run_id: str,
    thread_id: str | None = None,
    status: str = "running",
    partial_text: str = "",
    partial_tools: list[dict[str, Any]] | None = None,
    partial_display_segments: list[dict[str, Any]] | None = None,
    last_event_at_ms: int | None = None,
    conn: Any | None = None,
) -> dict[str, Any]:
    sk = str(session_key or "").strip()
    rid = str(run_id or "").strip()
    if not sk or not rid:
        raise ValueError("session_key and run_id required")
    tid = str(thread_id or "").strip() or None
    st = str(status or "running").strip().lower() or "running"
    text = str(partial_text or "")
    tools = partial_tools if isinstance(partial_tools, list) else []
    display_segments = partial_display_segments if isinstance(partial_display_segments, list) else []
    event_at_ms = int(last_event_at_ms or 0)
    event_at = ms_to_iso_z(event_at_ms) if event_at_ms > 0 else ""
    updated_at = now_iso_z()

    def _tx(db: Any) -> dict[str, Any]:
        db.execute(
            """
            INSERT INTO evoflow_chat_live_runs (
                session_key, thread_id, run_id, status,
                partial_text, partial_tools_json, display_segments_json, last_event_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(session_key) DO UPDATE SET
                thread_id = excluded.thread_id,
                run_id = excluded.run_id,
                status = excluded.status,
                partial_text = excluded.partial_text,
                partial_tools_json = excluded.partial_tools_json,
                display_segments_json = excluded.display_segments_json,
                last_event_at = excluded.last_event_at,
                updated_at = excluded.updated_at
            """,
            (sk, tid, rid, st, text, _dumps(tools), _dumps(display_segments), event_at, updated_at),
        )
        row = db.execute(
            """
            SELECT session_key, thread_id, run_id, status,
                   partial_text, partial_tools_json, display_segments_json, last_event_at, updated_at
            FROM evoflow_chat_live_runs
            WHERE session_key = ?
            LIMIT 1
            """,
            (sk,),
        ).fetchone()
        return _row_to_dict(row)

    if conn is not None:
        return _tx(conn)
    return run_db_transaction(_tx)


def get_live_run_snapshot(session_key: str, *, conn: Any | None = None) -> dict[str, Any] | None:
    sk = str(session_key or "").strip()
    if not sk:
        return None
    db = conn or get_db()
    row = db.execute(
        """
        SELECT session_key, thread_id, run_id, status,
               partial_text, partial_tools_json, display_segments_json, last_event_at, updated_at
        FROM evoflow_chat_live_runs
        WHERE session_key = ?
        LIMIT 1
        """,
        (sk,),
    ).fetchone()
    return _row_to_dict(row)


def delete_live_run_snapshot(session_key: str, *, conn: Any | None = None) -> bool:
    sk = str(session_key or "").strip()
    if not sk:
        return False

    def _tx(db: Any) -> bool:
        cur = db.execute("DELETE FROM evoflow_chat_live_runs WHERE session_key = ?", (sk,))
        return int(cur.rowcount or 0) > 0

    if conn is not None:
        return _tx(conn)
    return run_db_transaction(_tx)


def update_live_run_heartbeat(
    session_key: str,
    *,
    thread_id: str | None = None,
    run_id: str | None = None,
) -> int:
    """Keep live-run + session activity fresh (frontend or TaskOutput wait pulse).

    Returns last_event_at as milliseconds. If no live-run row exists yet (common
    during long silent tool waits when the UI stopped PUTting snapshots), upsert
    a minimal ``running`` row and bump ``evoflow_chat_sessions.updated_at`` so
    Gateway reconcile does not false-cancel an active LangGraph run as
    ``updatedAt timeout, no live snapshot``.
    """
    sk = str(session_key or "").strip()
    if not sk:
        return 0

    from evoflow.persistence.timestamps import iso_z_to_ms, now_iso_z

    def _tx(db: Any) -> int:
        current_time = now_iso_z()
        cur = db.execute(
            """
            UPDATE evoflow_chat_live_runs
            SET last_event_at = ?, updated_at = ?
            WHERE session_key = ?
            """,
            (current_time, current_time, sk),
        )
        if int(cur.rowcount or 0) <= 0:
            # Seed from session row when callers omit ids (TaskOutput pulse).
            tid = str(thread_id or "").strip()
            rid = str(run_id or "").strip()
            if not tid or not rid:
                row = db.execute(
                    """
                    SELECT thread_id, current_run_id
                    FROM evoflow_chat_sessions
                    WHERE session_key = ?
                    LIMIT 1
                    """,
                    (sk,),
                ).fetchone()
                if row:
                    tid = tid or str(row["thread_id"] or "").strip()
                    rid = rid or str(row["current_run_id"] or "").strip()
            if rid:
                db.execute(
                    """
                    INSERT INTO evoflow_chat_live_runs (
                        session_key, thread_id, run_id, status,
                        partial_text, partial_tools_json, display_segments_json,
                        last_event_at, updated_at
                    ) VALUES (?, ?, ?, 'running', '', '[]', '[]', ?, ?)
                    ON CONFLICT(session_key) DO UPDATE SET
                        last_event_at = excluded.last_event_at,
                        updated_at = excluded.updated_at,
                        status = 'running',
                        run_id = COALESCE(NULLIF(excluded.run_id, ''), evoflow_chat_live_runs.run_id),
                        thread_id = COALESCE(NULLIF(excluded.thread_id, ''), evoflow_chat_live_runs.thread_id)
                    """,
                    (sk, tid or None, rid, current_time, current_time),
                )
        # Session updatedAt is the reconcile fallback when no snapshot existed.
        db.execute(
            """
            UPDATE evoflow_chat_sessions
            SET updated_at = ?
            WHERE session_key = ?
            """,
            (current_time, sk),
        )
        return iso_z_to_ms(current_time)

    try:
        return run_db_transaction(_tx)
    except Exception:
        # Silent failure: heartbeat is best-effort
        return 0


def _row_to_dict(row: Any) -> dict[str, Any] | None:
    if row is None:
        return None
    d = dict(row)
    last_event_at = str(d.get("last_event_at") or "").strip()
    return {
        "sessionKey": str(d.get("session_key") or "").strip(),
        "threadId": str(d.get("thread_id") or "").strip() or None,
        "runId": str(d.get("run_id") or "").strip() or None,
        "status": str(d.get("status") or "running").strip().lower() or "running",
        "partialText": str(d.get("partial_text") or ""),
        "partialTools": _loads(d.get("partial_tools_json")) or [],
        "partialDisplaySegments": _loads(d.get("display_segments_json")) or [],
        "lastEventAt": last_event_at,
        "lastEventAtMs": iso_z_to_ms(last_event_at) if last_event_at else 0,
        "updatedAt": str(d.get("updated_at") or ""),
    }


def mark_run_completed(
    thread_id: str,
    run_id: str | None,
    *,
    status: str = "success",
    conn: Any | None = None,
) -> bool:
    """标记 run 已完成，供前端重连时发现。

    幂等操作：多次调用不报错。
    使用降级方案：更新 evoflow_chat_live_runs 表的 status 为终端状态。
    """
    tid = str(thread_id or "").strip()
    rid = str(run_id or "").strip() if run_id else None
    if not tid and not rid:
        return False

    # 将 status 映射为终端状态标识
    terminal_status = f"completed_{status}" if status in ("success", "error", "cancelled") else "completed_success"

    def _tx(db: Any) -> bool:
        # 优先通过 thread_id 更新
        if tid:
            cur = db.execute(
                """
                UPDATE evoflow_chat_live_runs
                SET status = ?, updated_at = ?
                WHERE thread_id = ? AND status NOT LIKE 'completed_%'
                """,
                (terminal_status, now_iso_z(), tid),
            )
            if int(cur.rowcount or 0) > 0:
                return True

        # 如果 thread_id 没找到，尝试通过 run_id 更新
        if rid:
            cur = db.execute(
                """
                UPDATE evoflow_chat_live_runs
                SET status = ?, updated_at = ?
                WHERE run_id = ? AND status NOT LIKE 'completed_%'
                """,
                (terminal_status, now_iso_z(), rid),
            )
            if int(cur.rowcount or 0) > 0:
                return True

        return False

    try:
        if conn is not None:
            return _tx(conn)
        return run_db_transaction(_tx)
    except Exception:
        # 静默失败，不影响主流程
        return False


def check_run_completed(thread_id: str, *, conn: Any | None = None) -> dict[str, Any] | None:
    """检查指定 thread 是否有已完成的 run。

    返回包含 run_id 和 completion status 的字典，如果没有则返回 None。
    """
    tid = str(thread_id or "").strip()
    if not tid:
        return None

    db = conn or get_db()
    row = db.execute(
        """
        SELECT run_id, status
        FROM evoflow_chat_live_runs
        WHERE thread_id = ? AND status LIKE 'completed_%'
        ORDER BY updated_at DESC
        LIMIT 1
        """,
        (tid,),
    ).fetchone()

    if row is None:
        return None

    d = dict(row)
    run_id = str(d.get("run_id") or "").strip() or None
    status_raw = str(d.get("status") or "").strip()

    # 从 completed_success / completed_error 中提取原始状态
    completion_status = "success"
    if status_raw.startswith("completed_"):
        completion_status = status_raw[len("completed_") :]

    return {
        "run_id": run_id,
        "status": completion_status,
    }


# 【self-evolution-bot · 2026-11-20 · 第96轮 · 模型:deepseek-v4.1-flash-1017】
# 改了什么：新增 `sweep_stale_running_snapshots()`——把「心跳早就停了但状态仍是
# running」的快照就地标成 `completed_error`。
# 为什么（本轮现网取证）：`evoflow_chat_live_runs` 里进程被杀后留下的 running 行
# **没有任何回收路径**。`delete_live_run_snapshot()` 只有两个调用点：前端主动 DELETE，
# 或 stream 正常收尾 flush。重启=tokill，两者都不会发生。实测现网 118 条 running，
# 其中 **116 条心跳早于当天 17:00**，最早停在 11-18。
# 后果链条：`GET /{sk}/live-run/check` 用 `status.startswith("completed_")` 判完成 →
# 这些行永远返回 completed=False → 前端 `install-visibility-reattach` 认为「run 还没结束、
# 只是没在流」，于是一直等着接续一条早已死掉的 run，表现就是重启后卡住、叫不醒。
# 为什么不直接 DELETE：标 `completed_error` 才能让 `/live-run/check` 返回 completed=True，
# 前端据此刷新消息并自行清快照；直接删会让它退化成「没有快照」的旧分支，仍要等超时。
def sweep_stale_running_snapshots(*, max_age_s: float, conn: Any | None = None) -> dict[str, int]:
    """Mark ``running`` snapshots whose heartbeat is older than ``max_age_s`` as terminal.

    ``max_age_s <= 0`` disables the sweep (returns zeros). Rows without any
    ``last_event_at`` are treated as stale too — a running row with no heartbeat
    can never become fresh again on its own.
    """
    stats = {"scanned": 0, "swept": 0}
    if max_age_s is None or float(max_age_s) <= 0:
        return stats
    import time as _time

    # 用 epoch 毫秒比较，避免手搓 ISO 串时区/格式差异（库里既有 +08:00 也有 Z 结尾）。
    cutoff_ms = (_time.time() - float(max_age_s)) * 1000.0

    def _tx(db: Any) -> dict[str, int]:
        rows = db.execute(
            """
            SELECT session_key, run_id, last_event_at, updated_at
            FROM evoflow_chat_live_runs
            WHERE lower(status) = 'running'
            """
        ).fetchall()
        current_time = now_iso_z()
        local: dict[str, int] = {"scanned": 0, "swept": 0}
        for row in rows:
            d = dict(row)
            local["scanned"] += 1
            beat = str(d.get("last_event_at") or d.get("updated_at") or "").strip()
            beat_ms = iso_z_to_ms(beat) if beat else 0
            if beat_ms and beat_ms >= cutoff_ms:
                continue
            cur = db.execute(
                """
                UPDATE evoflow_chat_live_runs
                SET status = 'completed_error', updated_at = ?
                WHERE session_key = ? AND lower(status) = 'running'
                """,
                (current_time, str(d.get("session_key") or "")),
            )
            if int(cur.rowcount or 0) > 0:
                local["swept"] += 1
        return local

    if conn is not None:
        return _tx(conn)
    return run_db_transaction(_tx)
