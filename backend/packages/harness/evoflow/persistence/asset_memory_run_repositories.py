"""Asset Hub Phase1 / Phase2 processing run log.

Records each consolidate/extract attempt so Asset Center can verify whether
employee (or user) dialogue memory actually ran — independent of log files.
Writes are best-effort and must never break the memory pipeline.

``principal_id`` is the **操作人** (runtime human identity that triggered the
run — dialogue caller / Asset Center actor). Append-only log: no separate
created_by vs updated_by.
"""

from __future__ import annotations

import json
import logging
import uuid
from typing import Any

from evoflow.persistence.db import get_db
from evoflow.timeutil import utc_now_iso_z

logger = logging.getLogger(__name__)

_VALID_PHASES = frozenset({"phase1", "phase2"})
_VALID_TRIGGERS = frozenset({"queue", "startup_scan", "manual"})
_VALID_STATUSES = frozenset({"ok", "skipped", "error"})


def _safe_str(value: Any, *, default: str = "", max_len: int = 512) -> str:
    try:
        s = str(value if value is not None else "").strip()
    except Exception:
        return default
    if not s:
        return default
    return s[:max_len] if max_len > 0 else s


def _paths_json(paths: Any) -> str:
    if not isinstance(paths, list):
        return "[]"
    cleaned: list[str] = []
    for p in paths:
        s = _safe_str(p, max_len=512)
        if s:
            cleaned.append(s)
        if len(cleaned) >= 64:
            break
    try:
        return json.dumps(cleaned, ensure_ascii=False)
    except Exception:
        return "[]"


def _detail_json(detail: Any) -> str:
    if detail is None:
        return "{}"
    if not isinstance(detail, dict):
        return "{}"
    try:
        return json.dumps(detail, ensure_ascii=False, default=str)[:4000]
    except Exception:
        return "{}"


def insert_asset_memory_run(
    *,
    phase: str,
    trigger: str,
    status: str,
    entity_type: str = "",
    entity_id: str = "",
    thread_id: str = "",
    agent_name: str = "",
    principal_id: str = "",
    skip_reason: str = "",
    error_message: str = "",
    paths: list[str] | None = None,
    detail: dict[str, Any] | None = None,
    run_id: str | None = None,
    created_at: str | None = None,
    finished_at: str | None = None,
) -> str | None:
    """Insert one run row. Returns run id, or ``None`` on failure."""
    ph = _safe_str(phase, max_len=32).lower()
    tr = _safe_str(trigger, max_len=32).lower()
    st = _safe_str(status, max_len=32).lower()
    if ph not in _VALID_PHASES or tr not in _VALID_TRIGGERS or st not in _VALID_STATUSES:
        logger.debug(
            "asset memory run skipped invalid fields phase=%s trigger=%s status=%s",
            ph,
            tr,
            st,
        )
        return None
    now = utc_now_iso_z()
    rid = _safe_str(run_id, max_len=64) or str(uuid.uuid4())
    try:
        get_db().execute(
            """
            INSERT INTO evoflow_asset_memory_runs(
                id, created_at, finished_at, phase, trigger,
                thread_id, agent_name, principal_id,
                entity_type, entity_id, status,
                skip_reason, error_message, paths_json, detail_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                rid,
                _safe_str(created_at, default=now, max_len=64),
                _safe_str(finished_at, default=now, max_len=64),
                ph,
                tr,
                _safe_str(thread_id, max_len=128),
                _safe_str(agent_name, max_len=128),
                _safe_str(principal_id, max_len=128),
                _safe_str(entity_type, max_len=32).lower(),
                _safe_str(entity_id, max_len=256),
                st,
                _safe_str(skip_reason, max_len=256),
                _safe_str(error_message, max_len=1000),
                _paths_json(paths),
                _detail_json(detail),
            ),
        )
        get_db().commit()
        return rid
    except Exception:
        logger.debug(
            "asset memory run insert failed phase=%s entity=%s:%s",
            ph,
            entity_type,
            entity_id,
            exc_info=True,
        )
        return None


def record_phase_result(
    *,
    phase: str,
    trigger: str,
    result: dict[str, Any] | None,
    entity_type: str = "",
    entity_id: str = "",
    thread_id: str = "",
    agent_name: str = "",
    principal_id: str = "",
    error: str | None = None,
    detail: dict[str, Any] | None = None,
) -> str | None:
    """Map a Phase1/Phase2 return dict (or exception string) into a run row."""
    res = result if isinstance(result, dict) else {}
    err = _safe_str(error or res.get("error"), max_len=1000)
    skipped = _safe_str(res.get("skipped"), max_len=256)
    if err:
        status = "error"
    elif skipped:
        status = "skipped"
    elif res.get("ok"):
        status = "ok"
    else:
        status = "error"
        if not err:
            err = "unknown_failure"
    paths = res.get("paths") if isinstance(res.get("paths"), list) else []
    return insert_asset_memory_run(
        phase=phase,
        trigger=trigger,
        status=status,
        entity_type=entity_type,
        entity_id=entity_id,
        thread_id=thread_id,
        agent_name=agent_name,
        principal_id=principal_id,
        skip_reason=skipped if status == "skipped" else "",
        error_message=err if status == "error" else "",
        paths=[str(p) for p in paths if p],
        detail=detail,
    )


def list_asset_memory_runs(
    *,
    entity_type: str = "",
    entity_id: str = "",
    thread_id: str = "",
    phase: str = "",
    limit: int = 30,
) -> list[dict[str, Any]]:
    """List recent runs, newest first. Filters are AND-combined when set."""
    lim = max(1, min(int(limit or 30), 100))
    clauses: list[str] = []
    params: list[Any] = []
    et = _safe_str(entity_type, max_len=32).lower()
    eid = _safe_str(entity_id, max_len=256)
    tid = _safe_str(thread_id, max_len=128)
    ph = _safe_str(phase, max_len=32).lower()
    if et:
        clauses.append("entity_type = ?")
        params.append(et)
    if eid:
        clauses.append("entity_id = ?")
        params.append(eid)
    if tid:
        clauses.append("thread_id = ?")
        params.append(tid)
    if ph:
        clauses.append("phase = ?")
        params.append(ph)
    where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
    sql = f"""
        SELECT id, created_at, finished_at, phase, trigger,
               thread_id, agent_name, principal_id,
               entity_type, entity_id, status,
               skip_reason, error_message, paths_json, detail_json
        FROM evoflow_asset_memory_runs
        {where}
        ORDER BY created_at DESC
        LIMIT ?
    """
    params.append(lim)
    try:
        rows = get_db().execute(sql, tuple(params)).fetchall()
    except Exception:
        logger.debug("list_asset_memory_runs failed", exc_info=True)
        return []
    out: list[dict[str, Any]] = []
    for row in rows:
        try:
            d = dict(row)
        except Exception:
            continue
        paths_raw = d.get("paths_json") or "[]"
        detail_raw = d.get("detail_json") or "{}"
        try:
            paths = json.loads(paths_raw) if isinstance(paths_raw, str) else []
        except Exception:
            paths = []
        try:
            detail = json.loads(detail_raw) if isinstance(detail_raw, str) else {}
        except Exception:
            detail = {}
        pid = d.get("principal_id") or ""
        out.append(
            {
                "id": d.get("id") or "",
                "createdAt": d.get("created_at") or "",
                "finishedAt": d.get("finished_at") or "",
                "phase": d.get("phase") or "",
                "trigger": d.get("trigger") or "",
                "threadId": d.get("thread_id") or "",
                "agentName": d.get("agent_name") or "",
                # 操作人 = 运行时身份（对话入队 / 面板点击的人）
                "principalId": pid,
                "operatorId": pid,
                "entityType": d.get("entity_type") or "",
                "entityId": d.get("entity_id") or "",
                "status": d.get("status") or "",
                "skipReason": d.get("skip_reason") or "",
                "errorMessage": d.get("error_message") or "",
                "paths": paths if isinstance(paths, list) else [],
                "detail": detail if isinstance(detail, dict) else {},
            }
        )
    return out
