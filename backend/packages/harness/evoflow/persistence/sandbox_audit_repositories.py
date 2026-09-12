"""Lightweight structured audit logging for sandbox security interceptions.

Records interception events (path traversal, path denied, denylist blocked)
into ``evoflow_sandbox_audit``.  All writes are best-effort and must never
raise — the interception itself has already succeeded by the time we log.
"""

from __future__ import annotations

import logging
from typing import Any

from evoflow.persistence.db import get_db
from evoflow.persistence.session_repositories import find_session_key_by_thread_id
from evoflow.timeutil import utc_now_iso_z

logger = logging.getLogger(__name__)

# Event type constants — kept in sync with frontend sandbox-blocked-card.js
EVENT_PATH_TRAVERSAL = "path_traversal"
EVENT_PATH_DENIED = "path_denied"
EVENT_DENYLIST_BLOCKED = "denylist_blocked"


def _safe_str(value: Any, *, default: str = "") -> str:
    try:
        s = str(value).strip()
        return s if s else default
    except Exception:
        return default


def write_sandbox_audit_log(
    *,
    event_type: str,
    path: str = "",
    tool_name: str = "",
    tool_call_id: str = "",
    reason: str = "",
    session_key: str = "",
    thread_id: str = "",
) -> None:
    """Write a single sandbox interception audit record.

    Best-effort: any DB error is swallowed and logged at debug level so the
    interception path is never affected.  When *session_key* is empty but
    *thread_id* is known, the session key is resolved lazily (also best-effort).

    Args:
        event_type: One of ``path_traversal`` / ``path_denied`` / ``denylist_blocked``.
        path: The (virtual) path that was intercepted, if applicable.
        tool_name: Tool that triggered the interception (denylist / file tool).
        tool_call_id: Associated tool call id, when available.
        reason: Human-readable reason (mirrors the message shown to the user).
        session_key: Chat session key (best-effort resolution when empty).
        thread_id: LangGraph thread id.
    """
    et = _safe_str(event_type)
    if not et:
        return
    tid = _safe_str(thread_id)
    sk = _safe_str(session_key)
    if not sk and tid:
        try:
            sk = find_session_key_by_thread_id(tid) or ""
        except Exception:
            sk = ""
    try:
        get_db().execute(
            """
            INSERT INTO evoflow_sandbox_audit
                (event_type, path, tool_name, tool_call_id, reason,
                 session_key, thread_id, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                et,
                _safe_str(path),
                _safe_str(tool_name),
                _safe_str(tool_call_id),
                _safe_str(reason),
                sk,
                tid,
                utc_now_iso_z(),
            ),
        )
        get_db().commit()
    except Exception:
        # Never let audit logging break the interception flow.
        logger.debug(
            "sandbox audit log write failed (event=%s path=%s tid=%s)",
            et,
            _safe_str(path),
            tid,
            exc_info=True,
        )


def list_all_sandbox_audit(
    *,
    limit: int = 200,
    offset: int = 0,
    event_type: str | None = None,
) -> list[dict[str, Any]]:
    """Return recent sandbox interception records across all threads (newest first).

    Used by the security-center audit page. Supports optional ``event_type`` filter
    and pagination via ``offset``.
    """
    try:
        if event_type:
            rows = (
                get_db()
                .execute(
                    """
                    SELECT id, event_type, path, tool_name, tool_call_id, reason,
                           session_key, thread_id, created_at
                    FROM evoflow_sandbox_audit
                    WHERE event_type = ?
                    ORDER BY id DESC
                    LIMIT ? OFFSET ?
                    """,
                    (event_type, max(1, int(limit)), max(0, int(offset))),
                )
                .fetchall()
            )
        else:
            rows = (
                get_db()
                .execute(
                    """
                    SELECT id, event_type, path, tool_name, tool_call_id, reason,
                           session_key, thread_id, created_at
                    FROM evoflow_sandbox_audit
                    ORDER BY id DESC
                    LIMIT ? OFFSET ?
                    """,
                    (max(1, int(limit)), max(0, int(offset))),
                )
                .fetchall()
            )
    except Exception:
        return []
    out: list[dict[str, Any]] = []
    for r in rows:
        d = dict(r)
        out.append(
            {
                "id": _safe_str(d.get("id")),
                "event_type": _safe_str(d.get("event_type")),
                "path": _safe_str(d.get("path")),
                "tool_name": _safe_str(d.get("tool_name")),
                "tool_call_id": _safe_str(d.get("tool_call_id")),
                "reason": _safe_str(d.get("reason")),
                "session_key": _safe_str(d.get("session_key")),
                "thread_id": _safe_str(d.get("thread_id")),
                "created_at": _safe_str(d.get("created_at")),
            }
        )
    return out


def clear_all_sandbox_audit() -> int:
    """Delete all sandbox audit records. Returns the number of deleted rows."""
    try:
        cur = get_db().execute("DELETE FROM evoflow_sandbox_audit")
        get_db().commit()
        return cur.rowcount if cur.rowcount is not None else 0
    except Exception:
        logger.debug("clear_all_sandbox_audit failed", exc_info=True)
        return 0


def list_sandbox_audit_for_thread(thread_id: str, *, limit: int = 200) -> list[dict[str, Any]]:
    """Return recent sandbox interception records for a thread (newest first)."""
    tid = _safe_str(thread_id)
    if not tid:
        return []
    try:
        rows = (
            get_db()
            .execute(
                """
                SELECT event_type, path, tool_name, tool_call_id, reason,
                       session_key, thread_id, created_at
                FROM evoflow_sandbox_audit
                WHERE thread_id = ?
                ORDER BY id DESC
                LIMIT ?
                """,
                (tid, max(1, int(limit))),
            )
            .fetchall()
        )
    except Exception:
        return []
    out: list[dict[str, Any]] = []
    for r in rows:
        d = dict(r)
        out.append(
            {
                "event_type": _safe_str(d.get("event_type")),
                "path": _safe_str(d.get("path")),
                "tool_name": _safe_str(d.get("tool_name")),
                "tool_call_id": _safe_str(d.get("tool_call_id")),
                "reason": _safe_str(d.get("reason")),
                "session_key": _safe_str(d.get("session_key")),
                "thread_id": _safe_str(d.get("thread_id")),
                "created_at": _safe_str(d.get("created_at")),
            }
        )
    return out
