"""Past chat session search (evoflow.db) — replaces built-in ``session_search`` tool."""

from __future__ import annotations

import time
from typing import Any

from evoflow.admin.errors import ValidationError
from evoflow.persistence.timestamps import iso_z_to_ms, ms_to_iso_z

_DEFAULT_MAX_AGE_DAYS = 90
_MAX_ROWS_SCAN = 5000


def _cutoff_iso(max_age_days: int) -> str:
    cutoff_ms = int((time.time() - max_age_days * 86400) * 1000)
    return ms_to_iso_z(cutoff_ms)


def _get_db():
    try:
        from evoflow.persistence import get_db

        return get_db()
    except Exception:
        return None


def _search_messages(
    db,
    query: str,
    max_results: int,
    max_age_days: int,
) -> list[dict[str, Any]]:
    import sqlite3

    like_pattern = f"%{query}%"
    cutoff_iso = _cutoff_iso(max_age_days)

    try:
        rows = db.execute(
            """
            SELECT
                m.session_key,
                COALESCE(s.title, ''),
                m.seq,
                m.role,
                COALESCE(m.content_json, ''),
                COALESCE(m.tool_name, ''),
                COALESCE(m.model_name, ''),
                COALESCE(s.created_at, '') AS session_created
            FROM evoflow_chat_messages m
            LEFT JOIN evoflow_chat_sessions s ON m.session_key = s.session_key
            WHERE m.created_at >= ?
              AND (m.content_json LIKE ? OR m.tool_name LIKE ?)
            ORDER BY m.created_at DESC
            LIMIT ?
            """,
            (cutoff_iso, like_pattern, like_pattern, _MAX_ROWS_SCAN),
        ).fetchall()
    except sqlite3.OperationalError:
        return []

    sessions: dict[str, dict[str, Any]] = {}
    for row in rows:
        sk = row[0] or ""
        if not sk:
            continue
        if sk not in sessions:
            sessions[sk] = {
                "session_key": sk,
                "title": row[1] or "",
                "session_created": iso_z_to_ms(str(row[7] or "")),
                "matches": [],
            }
        if len(sessions[sk]["matches"]) >= 3:
            continue
        sessions[sk]["matches"].append(
            {
                "seq": row[2],
                "role": row[3],
                "snippet": (row[4] or "")[:500],
                "tool": row[5],
                "model": row[6],
            }
        )

    result = sorted(sessions.values(), key=lambda s: s.get("session_created", 0), reverse=True)
    for s in result:
        s["match_count"] = len(s["matches"])
    return result[:max_results]


def _search_sessions(
    db,
    query: str,
    max_results: int,
    max_age_days: int,
) -> list[dict[str, Any]]:
    import sqlite3

    like_pattern = f"%{query}%"
    cutoff_iso = _cutoff_iso(max_age_days)

    try:
        rows = db.execute(
            """
            SELECT session_key, title, message_count, created_at
            FROM evoflow_chat_sessions
            WHERE created_at >= ?
              AND title LIKE ?
              AND is_deleted = 0
            ORDER BY created_at DESC
            LIMIT ?
            """,
            (cutoff_iso, like_pattern, max_results),
        ).fetchall()
    except sqlite3.OperationalError:
        return []

    return [
        {
            "session_key": r[0],
            "title": r[1] or "",
            "message_count": r[2] or 0,
            "created_at": iso_z_to_ms(str(r[3] or "")),
        }
        for r in rows
    ]


def search_sessions(
    query: str,
    *,
    search_titles: bool = False,
    max_results: int = 5,
    max_age_days: int = _DEFAULT_MAX_AGE_DAYS,
) -> dict[str, Any]:
    """Search past conversations by keyword (same semantics as retired ``session_search`` tool)."""
    q = str(query or "").strip()
    if not q:
        raise ValidationError("query is required")

    db = _get_db()
    if db is None:
        return {"results": [], "note": "Database not available."}

    effective_max_age = max_age_days if max_age_days > 0 else 3650

    results = _search_messages(db, q, max_results, effective_max_age)
    if search_titles and not results:
        results = _search_sessions(db, q, max_results, effective_max_age)

    if not results:
        return {
            "query": q,
            "total_results": 0,
            "max_age_days": effective_max_age,
            "note": f"No matching sessions found in the last {effective_max_age} days.",
        }

    return {
        "query": q,
        "total_results": len(results),
        "max_age_days": effective_max_age,
        "sessions": results,
    }
