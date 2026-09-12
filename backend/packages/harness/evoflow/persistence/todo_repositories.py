"""SQLite CRUD for ``evoflow_todos`` (independent of checkpoint)."""

from __future__ import annotations

import json
from typing import Any

from evoflow.persistence.db import get_db
from evoflow.timeutil import utc_now_iso_z


def _dumps(obj: Any) -> str:
    return json.dumps(obj, ensure_ascii=False, separators=(",", ":"))


def _loads(raw: str | None) -> Any:
    if not raw:
        return None
    return json.loads(raw)


def save_todos(session_key: str, thread_id: str, todos: list[dict[str, Any]]) -> None:
    """Upsert todos for a session/thread pair."""
    sk = str(session_key or "").strip()
    tid = str(thread_id or "").strip()
    if not sk or not tid:
        return
    now = utc_now_iso_z()
    get_db().execute(
        """INSERT INTO evoflow_todos (session_key, thread_id, todos_json, updated_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(session_key, thread_id) DO UPDATE SET
             todos_json = excluded.todos_json,
             updated_at = excluded.updated_at""",
        (sk, tid, _dumps(todos), now),
    )
    get_db().commit()


def load_todos(session_key: str, thread_id: str) -> list[dict[str, Any]]:
    """Load todos for a session/thread pair; returns [] if none."""
    sk = str(session_key or "").strip()
    tid = str(thread_id or "").strip()
    if not sk or not tid:
        return []
    row = get_db().execute(
        "SELECT todos_json FROM evoflow_todos WHERE session_key = ? AND thread_id = ?",
        (sk, tid),
    ).fetchone()
    if not row:
        return []
    todos = _loads(str(row[0] or ""))
    return todos if isinstance(todos, list) else []


def delete_todos(session_key: str, thread_id: str) -> None:
    """Remove todos for a session/thread pair."""
    sk = str(session_key or "").strip()
    tid = str(thread_id or "").strip()
    if not sk or not tid:
        return
    get_db().execute(
        "DELETE FROM evoflow_todos WHERE session_key = ? AND thread_id = ?",
        (sk, tid),
    )
    get_db().commit()
