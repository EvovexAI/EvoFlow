"""Employee duty / heartbeat run index (``evoflow_duty_runs``).

SSOT for「上班记录」list entries: every scheduler / heartbeat / dispatch fire
inserts a row as soon as the role is selected to start — including skips —
so operators can see when automation triggered.
"""

from __future__ import annotations

import logging
import uuid
from typing import Any

from evoflow.persistence.db import get_db
from evoflow.timeutil import utc_now_iso_z

logger = logging.getLogger(__name__)

_COLS = """
    run_id, agent_code, round_id, session_key, trigger_source, trigger_reason,
    scheduled, status, skip_reason, msg_count, tool_count, primary_task_id,
    error, started_at, ended_at, created_at, updated_at
"""


def _new_run_id() -> str:
    return f"duty_{uuid.uuid4().hex[:16]}"


def _row_to_dict(row: Any) -> dict[str, Any]:
    if row is None:
        return {}
    keys = row.keys() if hasattr(row, "keys") else []
    if keys:
        return {str(k): row[k] for k in keys}
    return {}


def start_duty_run(
    *,
    agent_code: str,
    round_id: str = "",
    session_key: str = "",
    trigger_source: str = "",
    trigger_reason: str = "",
    scheduled: bool = False,
    status: str = "started",
    skip_reason: str = "",
    primary_task_id: str = "",
) -> dict[str, Any]:
    """Insert a duty-run row at trigger time. Returns the stored document."""
    code = str(agent_code or "").strip()
    if not code:
        return {}
    now = utc_now_iso_z()
    rid = str(round_id or "").strip() or f"round:{now}"
    run_id = _new_run_id()
    st = str(status or "started").strip() or "started"
    sk_reason = str(skip_reason or "").strip()
    ended = now if st in ("skipped", "busy", "failed", "completed") else None
    doc = {
        "run_id": run_id,
        "agent_code": code,
        "round_id": rid,
        "session_key": str(session_key or "").strip(),
        "trigger_source": str(trigger_source or "").strip(),
        "trigger_reason": str(trigger_reason or "").strip(),
        "scheduled": 1 if scheduled else 0,
        "status": st,
        "skip_reason": sk_reason,
        "msg_count": 0,
        "tool_count": 0,
        "primary_task_id": str(primary_task_id or "").strip(),
        "error": "",
        "started_at": now,
        "ended_at": ended,
        "created_at": now,
        "updated_at": now,
    }
    try:
        get_db().execute(
            f"""
            INSERT INTO evoflow_duty_runs ({_COLS.strip()})
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                doc["run_id"],
                doc["agent_code"],
                doc["round_id"],
                doc["session_key"],
                doc["trigger_source"],
                doc["trigger_reason"],
                doc["scheduled"],
                doc["status"],
                doc["skip_reason"],
                doc["msg_count"],
                doc["tool_count"],
                doc["primary_task_id"],
                doc["error"],
                doc["started_at"],
                doc["ended_at"],
                doc["created_at"],
                doc["updated_at"],
            ),
        )
        get_db().commit()
    except Exception:
        logger.warning(
            "duty_runs: start failed agent=%s round=%s",
            code,
            rid,
            exc_info=True,
        )
        return {}
    return doc


def update_duty_run(
    run_id: str,
    *,
    status: str | None = None,
    skip_reason: str | None = None,
    session_key: str | None = None,
    round_id: str | None = None,
    msg_count: int | None = None,
    tool_count: int | None = None,
    primary_task_id: str | None = None,
    error: str | None = None,
    ended: bool = False,
) -> None:
    """Patch fields on an existing duty run."""
    rid = str(run_id or "").strip()
    if not rid:
        return
    now = utc_now_iso_z()
    sets: list[str] = ["updated_at = ?"]
    args: list[Any] = [now]
    if status is not None:
        sets.append("status = ?")
        args.append(str(status).strip() or "started")
    if skip_reason is not None:
        sets.append("skip_reason = ?")
        args.append(str(skip_reason).strip())
    if session_key is not None:
        sets.append("session_key = ?")
        args.append(str(session_key).strip())
    if round_id is not None:
        sets.append("round_id = ?")
        args.append(str(round_id).strip())
    if msg_count is not None:
        sets.append("msg_count = ?")
        args.append(max(0, int(msg_count)))
    if tool_count is not None:
        sets.append("tool_count = ?")
        args.append(max(0, int(tool_count)))
    if primary_task_id is not None:
        sets.append("primary_task_id = ?")
        args.append(str(primary_task_id).strip())
    if error is not None:
        sets.append("error = ?")
        args.append(str(error).strip()[:2000])
    if ended or (status is not None and str(status).strip() in ("completed", "failed", "skipped", "busy")):
        sets.append("ended_at = ?")
        args.append(now)
    args.append(rid)
    try:
        get_db().execute(
            f"UPDATE evoflow_duty_runs SET {', '.join(sets)} WHERE run_id = ?",
            tuple(args),
        )
        get_db().commit()
    except Exception:
        logger.warning("duty_runs: update failed run_id=%s", rid, exc_info=True)


def get_duty_run(run_id: str) -> dict[str, Any] | None:
    rid = str(run_id or "").strip()
    if not rid:
        return None
    try:
        row = get_db().execute(
            f"SELECT {_COLS.strip()} FROM evoflow_duty_runs WHERE run_id = ?",
            (rid,),
        ).fetchone()
    except Exception:
        logger.debug("duty_runs: get failed run_id=%s", rid, exc_info=True)
        return None
    return _row_to_dict(row) if row else None


def get_duty_run_by_round(agent_code: str, round_id: str) -> dict[str, Any] | None:
    code = str(agent_code or "").strip()
    rid = str(round_id or "").strip()
    if not code or not rid:
        return None
    try:
        row = get_db().execute(
            f"""
            SELECT {_COLS.strip()} FROM evoflow_duty_runs
            WHERE agent_code = ? AND round_id = ?
            ORDER BY started_at DESC LIMIT 1
            """,
            (code, rid),
        ).fetchone()
    except Exception:
        logger.debug(
            "duty_runs: get_by_round failed agent=%s round=%s",
            code,
            rid,
            exc_info=True,
        )
        return None
    return _row_to_dict(row) if row else None


def list_duty_runs(
    agent_code: str,
    *,
    limit: int = 40,
) -> list[dict[str, Any]]:
    code = str(agent_code or "").strip()
    if not code:
        return []
    lim = max(1, min(int(limit or 40), 200))
    try:
        rows = get_db().execute(
            f"""
            SELECT {_COLS.strip()} FROM evoflow_duty_runs
            WHERE agent_code = ?
            ORDER BY started_at DESC
            LIMIT ?
            """,
            (code, lim),
        ).fetchall()
    except Exception:
        logger.debug("duty_runs: list failed agent=%s", code, exc_info=True)
        return []
    return [_row_to_dict(r) for r in rows]


def _trigger_label(row: dict[str, Any]) -> str:
    src = str(row.get("trigger_source") or "").strip()
    scheduled = bool(row.get("scheduled"))
    if src.startswith("dispatch"):
        return "派发上班"
    if src.startswith("api.heartbeat") or src == "manual":
        return "手动上班"
    if scheduled or src.startswith("scheduler"):
        return "定时上班"
    return "值班轮次"


def _status_outcome(row: dict[str, Any]) -> tuple[str, str | None, str]:
    """Return (status, result, outcome_text) for worklog / rounds UI."""
    st = str(row.get("status") or "").strip().lower()
    skip = str(row.get("skip_reason") or "").strip()
    reason = str(row.get("trigger_reason") or "").strip()
    msg_n = int(row.get("msg_count") or 0)
    tool_n = int(row.get("tool_count") or 0)
    err = str(row.get("error") or "").strip()

    if st in ("started", "running"):
        return "executing", None, reason or "上班中…"
    if st == "busy":
        return "completed", None, "到点触发，但员工忙碌中（本轮未开跑）"
    if st == "skipped":
        labels = {
            "xiaomi_idle_board": "到点触发 · 空板未开工",
            "daily_budget_exceeded": "到点触发 · 日预算已满，跳过",
            "langgraph_unreachable": "到点触发 · 引擎不可达，已改约",
        }
        return "completed", None, labels.get(skip) or (f"到点触发 · 已跳过（{skip or '未知原因'}）")
    if st == "failed":
        return "failed", "failure", err or reason or "本轮失败"
    # completed
    bits = []
    if msg_n or tool_n:
        bits.append(f"轨迹 {msg_n} 条 · 工具 {tool_n} 次")
    if reason:
        bits.append(reason)
    return "completed", "success", "；".join(bits) or "值班结束"


def duty_run_to_round_journal(row: dict[str, Any]) -> dict[str, Any]:
    """Map a duty_run row to the synthetic round_log shape used by work-board / Panel."""
    rid = str(row.get("round_id") or "").strip()
    code = str(row.get("agent_code") or "").strip()
    started = str(row.get("started_at") or "").strip()
    ended = str(row.get("ended_at") or "").strip() or started
    status, result, outcome = _status_outcome(row)
    title = _trigger_label(row)
    msg_n = int(row.get("msg_count") or 0)
    tool_n = int(row.get("tool_count") or 0)
    skip = str(row.get("skip_reason") or "").strip()
    sk = str(row.get("session_key") or "").strip()
    return {
        "id": f"duty-run:{row.get('run_id') or rid}",
        "role_agent_code": code,
        "title": title,
        "description": str(row.get("trigger_reason") or "").strip()
        or f"来源 {row.get('trigger_source') or '—'}",
        "rationale": "",
        "action_type": "report",
        "risk_level": "low",
        "action_plan": {
            "kind": "round_log",
            "phase": "check_in" if status == "executing" else "wrap_up",
            "synthetic": True,
            "source": "duty_run",
            "run_id": str(row.get("run_id") or ""),
            "session_key": sk,
            "trigger_source": str(row.get("trigger_source") or ""),
            "scheduled": bool(row.get("scheduled")),
            "skip_reason": skip,
            "msg_count": msg_n,
            "tool_count": tool_n,
        },
        "expected_outcome": "",
        "status": status,
        "result": result,
        "approval_id": None,
        "approved_by": None,
        "approved_at": None,
        "approval_timeout_minutes": 0,
        "execution_thread_id": None,
        "execution_result": "",
        "round_id": rid,
        "goal": title,
        "outcome": outcome,
        "created_at": started,
        "updated_at": ended,
        "session_key": sk,
    }


def list_duty_rounds_for_board(agent_code: str, *, limit: int = 40) -> list[dict[str, Any]]:
    """Board ``rounds[]`` from duty_runs (preferred SSOT)."""
    return [duty_run_to_round_journal(r) for r in list_duty_runs(agent_code, limit=limit)]


def count_messages_for_session(
    session_key: str,
    *,
    round_id: str | None = None,
) -> tuple[int, int]:
    """Return (msg_count, tool_count) for a duty/task session."""
    sk = str(session_key or "").strip()
    if not sk:
        return 0, 0
    rid = str(round_id or "").strip()
    try:
        if rid:
            row = get_db().execute(
                """
                SELECT COUNT(*) AS msg_n,
                       SUM(CASE WHEN role = 'tool' THEN 1 ELSE 0 END) AS tool_n
                FROM evoflow_chat_messages
                WHERE session_key = ? AND round_id = ?
                """,
                (sk, rid),
            ).fetchone()
        else:
            row = get_db().execute(
                """
                SELECT COUNT(*) AS msg_n,
                       SUM(CASE WHEN role = 'tool' THEN 1 ELSE 0 END) AS tool_n
                FROM evoflow_chat_messages
                WHERE session_key = ?
                """,
                (sk,),
            ).fetchone()
        if not row:
            return 0, 0
        return int(row["msg_n"] or 0), int(row["tool_n"] or 0)
    except Exception:
        logger.debug(
            "duty_runs: count messages failed session=%s",
            sk,
            exc_info=True,
        )
        return 0, 0
