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


def update_live_run_heartbeat(session_key: str) -> int:
    """R2-1: Update last_event_at to current time for frontend heartbeat.

    Returns last_event_at as milliseconds timestamp for frontend use.
    Silently returns 0 if no live run exists for the session.
    """
    sk = str(session_key or "").strip()
    if not sk:
        return 0

    from evoflow.utils.timeutil import iso_z_to_ms, now_iso_z

    def _tx(db: Any) -> int:
        current_time = now_iso_z()
        db.execute(
            """
            UPDATE evoflow_chat_live_runs
            SET last_event_at = ?, updated_at = ?
            WHERE session_key = ?
            """,
            (current_time, current_time, sk),
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
        completion_status = status_raw[len("completed_"):]

    return {
        "run_id": run_id,
        "status": completion_status,
    }
