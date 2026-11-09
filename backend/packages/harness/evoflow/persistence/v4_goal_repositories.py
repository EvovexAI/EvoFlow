"""Repository for ZCode-style v4 session goals (SQLite).

Table: ``evoflow_v4_session_goals`` (one row per LangGraph thread / v4 session).

ZCode 式目标模式（objective + turn 末 verifier + 自动续跑）的持久层。状态机、
verifier 与 v4 投影在 ``app/gateway/v4/goal_engine.py``；本模块只做存储
（harness 层，禁止 import app.*）。与 hosted goal 的 ``evoflow_goal_sessions``
（planner + 步进语义）互不复用。

``status`` 值域对齐 vendored ``goalStateSchema``：
active / paused / verifying / verified / notSatisfied / failed
（verified / notSatisfied / failed 为终态；paused 可经 resume 回 active）。
"""

from __future__ import annotations

import json
import logging
import time
from typing import Any

from evoflow.persistence.db import get_db, run_db_transaction
from evoflow.persistence.timestamps import now_iso_z

logger = logging.getLogger(__name__)

GOAL_STATUSES = ("active", "paused", "verifying", "verified", "notSatisfied", "failed")
TERMINAL_GOAL_STATUSES = ("verified", "notSatisfied", "failed")
LIVE_GOAL_STATUSES = ("active", "paused", "verifying")

_SELECT_COLS = """
    SELECT
        session_key, target_id, objective, summary_title,
        status, iteration, verifications_json,
        time_used_seconds, active_run_started_at_ms,
        last_next_action, continuation_count, last_verify_reason,
        created_at, updated_at
"""


def _safe_int(value: Any, default: int = 0) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _safe_str(value: Any, default: str = "") -> str:
    if value is None:
        return default
    return str(value)


def _now_ms() -> int:
    return int(time.time() * 1000)


def _row_to_dict(row: Any) -> dict[str, Any]:
    try:
        verifications = json.loads(_safe_str(row[6], "[]") or "[]")
    except ValueError:
        verifications = []
    if not isinstance(verifications, list):
        verifications = []
    return {
        "session_key": _safe_str(row[0]),
        "target_id": _safe_str(row[1]),
        "objective": _safe_str(row[2]),
        "summary_title": _safe_str(row[3]),
        "status": _safe_str(row[4], "active"),
        "iteration": _safe_int(row[5], 0),
        "verifications": verifications,
        "time_used_seconds": _safe_int(row[7], 0),
        "active_run_started_at_ms": row[8] if row[8] is not None else None,
        "last_next_action": _safe_str(row[9]),
        "continuation_count": _safe_int(row[10], 0),
        "last_verify_reason": _safe_str(row[11]),
        "created_at": _safe_str(row[12]),
        "updated_at": _safe_str(row[13]),
    }


def load_v4_session_goal(session_key: str) -> dict[str, Any] | None:
    """按 thread/session key 读取目标行；不存在返回 None。"""
    sk = (session_key or "").strip()
    if not sk:
        return None
    try:
        row = get_db().execute(
            f"{_SELECT_COLS} FROM evoflow_v4_session_goals WHERE session_key = ?",
            (sk,),
        ).fetchone()
    except Exception:
        logger.debug("load_v4_session_goal failed session=%s", sk, exc_info=True)
        return None
    return _row_to_dict(row) if row is not None else None


def upsert_v4_session_goal(
    session_key: str,
    *,
    objective: str,
    status: str = "active",
    summary_title: str = "",
    target_id: str | None = None,
    reset_verifications: bool = True,
) -> dict[str, Any]:
    """设定/替换目标（新目标 = 新 target_id，历史验证记录默认清零）。"""
    sk = (session_key or "").strip()
    tid = (target_id or "").strip() or f"goal-{sk[:24]}-{_now_ms()}"
    now_iso = now_iso_z()

    def _do(db: Any) -> dict[str, Any]:
        existing = db.execute(
            "SELECT created_at FROM evoflow_v4_session_goals WHERE session_key = ?",
            (sk,),
        ).fetchone()
        created_at = _safe_str(existing[0]) if existing is not None else now_iso
        verifications = "[]" if reset_verifications else "[]"
        db.execute(
            """
            INSERT INTO evoflow_v4_session_goals (
                session_key, target_id, objective, summary_title,
                status, iteration, verifications_json,
                time_used_seconds, active_run_started_at_ms,
                last_next_action, continuation_count, last_verify_reason,
                created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, 0, ?, 0, NULL, '', 0, '', ?, ?)
            ON CONFLICT(session_key) DO UPDATE SET
                target_id = excluded.target_id,
                objective = excluded.objective,
                summary_title = excluded.summary_title,
                status = excluded.status,
                iteration = 0,
                verifications_json = ?,
                time_used_seconds = 0,
                active_run_started_at_ms = NULL,
                last_next_action = '',
                continuation_count = 0,
                last_verify_reason = '',
                updated_at = excluded.updated_at
            """,
            (
                sk, tid, objective, summary_title,
                status, verifications, created_at, now_iso,
                verifications,
            ),
        )
        db.commit()
        row = db.execute(
            f"{_SELECT_COLS} FROM evoflow_v4_session_goals WHERE session_key = ?",
            (sk,),
        ).fetchone()
        return _row_to_dict(row)

    return run_db_transaction(_do)


def patch_v4_goal_atomic(
    session_key: str,
    *,
    fields: dict[str, Any],
    where_status_in: tuple[str, ...] | None = None,
) -> int:
    """单条 ``UPDATE ... WHERE`` 原子补丁（SQLite WAL + 进程锁下无丢失更新）。

    ``where_status_in`` 竞态护栏：默认仅活跃态（active/paused/verifying）可写，
    终态（verified/notSatisfied/failed）天然免疫迟到写入。

    Returns:
        受影响行数（0 = 护栏拦下，调用方应重读状态）。
    """
    sk = (session_key or "").strip()
    if not sk or not fields:
        return 0
    allowed = {
        "target_id",
        "objective",
        "summary_title",
        "status",
        "iteration",
        "verifications_json",
        "time_used_seconds",
        "active_run_started_at_ms",
        "last_next_action",
        "continuation_count",
        "last_verify_reason",
    }
    sets: list[str] = []
    params: list[Any] = []
    for key, value in fields.items():
        if key not in allowed:
            continue
        if key == "active_run_started_at_ms":
            params.append(None if value is None else _safe_int(value))
        elif key in ("iteration", "time_used_seconds", "continuation_count"):
            params.append(_safe_int(value))
        elif key == "verifications_json":
            params.append(_safe_str(value, "[]"))
        else:
            params.append(_safe_str(value))
        sets.append(f"{key} = ?")
    if not sets:
        return 0
    sets.append("updated_at = ?")
    params.append(now_iso_z())
    sql = f"UPDATE evoflow_v4_session_goals SET {', '.join(sets)} WHERE session_key = ?"
    params.append(sk)
    statuses = tuple(where_status_in) if where_status_in is not None else LIVE_GOAL_STATUSES
    if statuses:
        placeholders = ", ".join("?" for _ in statuses)
        sql += f" AND status IN ({placeholders})"
        params.extend(statuses)

    def _do(db: Any) -> int:
        cur = db.execute(sql, tuple(params))
        db.commit()
        return int(cur.rowcount or 0)

    return run_db_transaction(_do)


def append_v4_goal_verification(
    session_key: str,
    verification: dict[str, Any],
    *,
    bump_iteration: bool = True,
) -> dict[str, Any] | None:
    """追加一条验证记录（事务内 read-modify-write），可选迭代号自增。

    ``verification`` 形状对齐 vendored ``goalStateSchema.verifications[]``：
    ``{iteration, outcome, at, anchorRowId, reason?, nextAction?}``。
    """
    sk = (session_key or "").strip()
    if not sk:
        return None

    def _do(db: Any) -> dict[str, Any] | None:
        row = db.execute(
            f"{_SELECT_COLS} FROM evoflow_v4_session_goals WHERE session_key = ?",
            (sk,),
        ).fetchone()
        if row is None:
            return None
        current = _row_to_dict(row)
        entries = list(current.get("verifications") or [])
        entry = dict(verification)
        entry.setdefault("at", _now_ms())
        entries.append(entry)
        iteration = current["iteration"] + (1 if bump_iteration else 0)
        db.execute(
            """
            UPDATE evoflow_v4_session_goals
            SET verifications_json = ?, iteration = ?, updated_at = ?
            WHERE session_key = ?
            """,
            (json.dumps(entries, ensure_ascii=False), iteration, now_iso_z(), sk),
        )
        db.commit()
        fresh = db.execute(
            f"{_SELECT_COLS} FROM evoflow_v4_session_goals WHERE session_key = ?",
            (sk,),
        ).fetchone()
        return _row_to_dict(fresh) if fresh is not None else None

    return run_db_transaction(_do)


def clear_v4_session_goal(session_key: str) -> bool:
    """删除目标行（/goal clear 类语义预留）。"""
    sk = (session_key or "").strip()
    if not sk:
        return False

    def _do(db: Any) -> bool:
        cur = db.execute(
            "DELETE FROM evoflow_v4_session_goals WHERE session_key = ?",
            (sk,),
        )
        db.commit()
        return int(cur.rowcount or 0) > 0

    return run_db_transaction(_do)
