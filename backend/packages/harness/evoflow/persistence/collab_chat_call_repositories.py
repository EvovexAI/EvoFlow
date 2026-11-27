"""Audit trail for collab chat callbacks (initiator ← target run complete).

Table ``evoflow_collab_chat_calls`` + append-only ``evoflow_collab_chat_call_events``.
"""

from __future__ import annotations

import json
import logging
import uuid
from typing import Any

from evoflow.persistence.db import get_db
from evoflow.timeutil import utc_now_iso_z

logger = logging.getLogger(__name__)

_CALL_COLS = (
    "call_id, target_agent, target_session_key, target_duty_run_id, "
    "initiator_agent, initiator_session_key, initiator_principal_id, "
    "notify_on_complete, auto_resume, source, goal_preview, status, "
    "run_status, summary, error, desktop_notified_at, session_injected_at, "
    "resume_woke_at, processed_at, processed_by, created_at, updated_at, finished_at"
)


def _new_call_id() -> str:
    return f"ccc_{uuid.uuid4().hex[:16]}"


def _row_to_dict(row: Any) -> dict[str, Any]:
    if row is None:
        return {}
    keys = row.keys() if hasattr(row, "keys") else []
    if not keys:
        return {}
    out = {str(k): row[k] for k in keys}
    out["notify_on_complete"] = bool(out.get("notify_on_complete"))
    out["auto_resume"] = bool(out.get("auto_resume"))
    return out


def append_call_event(
    call_id: str,
    kind: str,
    *,
    detail: dict[str, Any] | None = None,
    actor: str = "",
) -> None:
    cid = str(call_id or "").strip()
    k = str(kind or "").strip()
    if not cid or not k:
        return
    try:
        get_db().execute(
            """
            INSERT INTO evoflow_collab_chat_call_events (call_id, at, kind, detail_json, actor)
            VALUES (?, ?, ?, ?, ?)
            """,
            (
                cid,
                utc_now_iso_z(),
                k[:80],
                json.dumps(detail or {}, ensure_ascii=False)[:8000],
                str(actor or "")[:120],
            ),
        )
        get_db().commit()
    except Exception:
        logger.debug("collab_chat_call: append event failed call=%s kind=%s", cid, k, exc_info=True)


def create_call(
    *,
    target_agent: str,
    target_session_key: str = "",
    target_duty_run_id: str = "",
    initiator_agent: str = "",
    initiator_session_key: str = "",
    initiator_principal_id: str = "",
    notify_on_complete: bool = True,
    auto_resume: bool = True,
    source: str = "chat_send",
    goal_preview: str = "",
    status: str = "open",
) -> dict[str, Any]:
    code = str(target_agent or "").strip()
    if not code:
        return {}
    now = utc_now_iso_z()
    call_id = _new_call_id()
    st = str(status or "open").strip() or "open"
    doc = {
        "call_id": call_id,
        "target_agent": code,
        "target_session_key": str(target_session_key or "").strip(),
        "target_duty_run_id": str(target_duty_run_id or "").strip(),
        "initiator_agent": str(initiator_agent or "").strip(),
        "initiator_session_key": str(initiator_session_key or "").strip(),
        "initiator_principal_id": str(initiator_principal_id or "").strip(),
        "notify_on_complete": 1 if notify_on_complete else 0,
        "auto_resume": 1 if auto_resume else 0,
        "source": str(source or "chat_send").strip()[:40] or "chat_send",
        "goal_preview": str(goal_preview or "").strip()[:500],
        "status": st,
        "run_status": "",
        "summary": "",
        "error": "",
        "desktop_notified_at": None,
        "session_injected_at": None,
        "resume_woke_at": None,
        "processed_at": None,
        "processed_by": "",
        "created_at": now,
        "updated_at": now,
        "finished_at": None,
    }
    try:
        get_db().execute(
            f"""
            INSERT INTO evoflow_collab_chat_calls ({_CALL_COLS})
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                doc["call_id"],
                doc["target_agent"],
                doc["target_session_key"],
                doc["target_duty_run_id"],
                doc["initiator_agent"],
                doc["initiator_session_key"],
                doc["initiator_principal_id"],
                doc["notify_on_complete"],
                doc["auto_resume"],
                doc["source"],
                doc["goal_preview"],
                doc["status"],
                doc["run_status"],
                doc["summary"],
                doc["error"],
                doc["desktop_notified_at"],
                doc["session_injected_at"],
                doc["resume_woke_at"],
                doc["processed_at"],
                doc["processed_by"],
                doc["created_at"],
                doc["updated_at"],
                doc["finished_at"],
            ),
        )
        get_db().commit()
    except Exception:
        logger.warning("collab_chat_call: create failed target=%s", code, exc_info=True)
        return {}
    append_call_event(
        call_id,
        "registered",
        detail={
            "target_agent": code,
            "target_session_key": doc["target_session_key"],
            "initiator_agent": doc["initiator_agent"],
            "initiator_session_key": doc["initiator_session_key"],
            "notify_on_complete": bool(notify_on_complete),
            "auto_resume": bool(auto_resume),
            "source": doc["source"],
        },
        actor=doc["initiator_agent"] or "system",
    )
    return get_call(call_id) or {**doc, "notify_on_complete": bool(notify_on_complete), "auto_resume": bool(auto_resume)}


def get_call(call_id: str) -> dict[str, Any] | None:
    cid = str(call_id or "").strip()
    if not cid:
        return None
    try:
        row = get_db().execute(
            f"SELECT {_CALL_COLS} FROM evoflow_collab_chat_calls WHERE call_id = ?",
            (cid,),
        ).fetchone()
    except Exception:
        logger.debug("collab_chat_call: get failed call=%s", cid, exc_info=True)
        return None
    return _row_to_dict(row) or None


def list_events(call_id: str, *, limit: int = 100) -> list[dict[str, Any]]:
    cid = str(call_id or "").strip()
    if not cid:
        return []
    try:
        rows = get_db().execute(
            """
            SELECT id, call_id, at, kind, detail_json, actor
            FROM evoflow_collab_chat_call_events
            WHERE call_id = ?
            ORDER BY id ASC
            LIMIT ?
            """,
            (cid, max(1, min(int(limit or 100), 500)),),
        ).fetchall()
    except Exception:
        logger.debug("collab_chat_call: list_events failed call=%s", cid, exc_info=True)
        return []
    out: list[dict[str, Any]] = []
    for row in rows or []:
        d = _row_to_dict(row)
        raw = d.get("detail_json")
        try:
            d["detail"] = json.loads(raw) if isinstance(raw, str) and raw.strip() else {}
        except Exception:
            d["detail"] = {}
        d.pop("detail_json", None)
        out.append(d)
    return out


def patch_call(call_id: str, **fields: Any) -> dict[str, Any] | None:
    cid = str(call_id or "").strip()
    if not cid:
        return None
    allowed = {
        "target_session_key",
        "target_duty_run_id",
        "initiator_agent",
        "initiator_session_key",
        "initiator_principal_id",
        "notify_on_complete",
        "auto_resume",
        "status",
        "run_status",
        "summary",
        "error",
        "desktop_notified_at",
        "session_injected_at",
        "resume_woke_at",
        "processed_at",
        "processed_by",
        "finished_at",
        "goal_preview",
    }
    sets: list[str] = []
    vals: list[Any] = []
    for k, v in fields.items():
        if k not in allowed:
            continue
        if k in {"notify_on_complete", "auto_resume"}:
            v = 1 if v else 0
        sets.append(f"{k} = ?")
        vals.append(v)
    if not sets:
        return get_call(cid)
    now = utc_now_iso_z()
    sets.append("updated_at = ?")
    vals.append(now)
    vals.append(cid)
    try:
        get_db().execute(
            f"UPDATE evoflow_collab_chat_calls SET {', '.join(sets)} WHERE call_id = ?",
            tuple(vals),
        )
        get_db().commit()
    except Exception:
        logger.warning("collab_chat_call: patch failed call=%s", cid, exc_info=True)
        return None
    return get_call(cid)


def find_open_by_duty_run(duty_run_id: str) -> list[dict[str, Any]]:
    rid = str(duty_run_id or "").strip()
    if not rid:
        return []
    try:
        rows = get_db().execute(
            f"""
            SELECT {_CALL_COLS} FROM evoflow_collab_chat_calls
            WHERE target_duty_run_id = ?
              AND status IN ('open', 'bound', 'running')
            ORDER BY created_at ASC
            """,
            (rid,),
        ).fetchall()
    except Exception:
        logger.debug("collab_chat_call: find by duty_run failed", exc_info=True)
        return []
    return [_row_to_dict(r) for r in rows or [] if r]


def find_open_by_target_session(session_key: str) -> list[dict[str, Any]]:
    sk = str(session_key or "").strip()
    if not sk:
        return []
    try:
        rows = get_db().execute(
            f"""
            SELECT {_CALL_COLS} FROM evoflow_collab_chat_calls
            WHERE target_session_key = ?
              AND status IN ('open', 'bound', 'running')
            ORDER BY created_at ASC
            """,
            (sk,),
        ).fetchall()
    except Exception:
        logger.debug("collab_chat_call: find by session failed", exc_info=True)
        return []
    return [_row_to_dict(r) for r in rows or [] if r]


def find_open_by_target_agent(agent_code: str, *, unbound_only: bool = True) -> list[dict[str, Any]]:
    """Open calls for a target agent (task_create often registers before duty_run_id exists)."""
    code = str(agent_code or "").strip()
    if not code:
        return []
    try:
        if unbound_only:
            rows = get_db().execute(
                f"""
                SELECT {_CALL_COLS} FROM evoflow_collab_chat_calls
                WHERE target_agent = ?
                  AND status IN ('open', 'bound', 'running')
                  AND TRIM(COALESCE(target_duty_run_id, '')) = ''
                ORDER BY created_at ASC
                """,
                (code,),
            ).fetchall()
        else:
            rows = get_db().execute(
                f"""
                SELECT {_CALL_COLS} FROM evoflow_collab_chat_calls
                WHERE target_agent = ?
                  AND status IN ('open', 'bound', 'running')
                ORDER BY created_at ASC
                """,
                (code,),
            ).fetchall()
    except Exception:
        logger.debug("collab_chat_call: find by target_agent failed", exc_info=True)
        return []
    return [_row_to_dict(r) for r in rows or [] if r]


def find_pending_resume_by_initiator_session(session_key: str) -> list[dict[str, Any]]:
    """Calls that notified initiator but still need a soft-wake on this session."""
    sk = str(session_key or "").strip()
    if not sk:
        return []
    try:
        rows = get_db().execute(
            f"""
            SELECT {_CALL_COLS} FROM evoflow_collab_chat_calls
            WHERE initiator_session_key = ?
              AND auto_resume = 1
              AND TRIM(COALESCE(resume_woke_at, '')) = ''
              AND status IN ('awaiting_resume', 'delivered')
            ORDER BY finished_at ASC, created_at ASC
            """,
            (sk,),
        ).fetchall()
    except Exception:
        logger.debug("collab_chat_call: find pending resume failed", exc_info=True)
        return []
    return [_row_to_dict(r) for r in rows or [] if r]


def list_calls(
    *,
    initiator_agent: str = "",
    target_agent: str = "",
    status: str = "",
    limit: int = 50,
) -> list[dict[str, Any]]:
    clauses: list[str] = []
    args: list[Any] = []
    ia = str(initiator_agent or "").strip()
    ta = str(target_agent or "").strip()
    st = str(status or "").strip()
    if ia:
        clauses.append("initiator_agent = ?")
        args.append(ia)
    if ta:
        clauses.append("target_agent = ?")
        args.append(ta)
    if st:
        clauses.append("status = ?")
        args.append(st)
    where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
    lim = max(1, min(int(limit or 50), 200))
    try:
        rows = get_db().execute(
            f"""
            SELECT {_CALL_COLS} FROM evoflow_collab_chat_calls
            {where}
            ORDER BY created_at DESC
            LIMIT ?
            """,
            (*args, lim),
        ).fetchall()
    except Exception:
        logger.debug("collab_chat_call: list failed", exc_info=True)
        return []
    return [_row_to_dict(r) for r in rows or [] if r]
