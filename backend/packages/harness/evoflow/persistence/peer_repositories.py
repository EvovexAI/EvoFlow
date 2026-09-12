"""SQLite persistence for collab peer messages."""

from __future__ import annotations

import json
from typing import Any
from uuid import uuid4

from evoflow.persistence.db import get_db
from evoflow.timeutil import utc_now_iso_z


def _row_dict(cursor_row: Any) -> dict[str, Any]:
    if cursor_row is None:
        return {}
    if hasattr(cursor_row, "keys"):
        return dict(cursor_row)
    cols = [d[0] for d in cursor_row.description] if hasattr(cursor_row, "description") else []
    return dict(zip(cols, cursor_row, strict=False))


def new_message_id() -> str:
    return f"PeerMsg_{uuid4().hex[:16]}"


def insert_peer_message(row: dict[str, Any]) -> str:
    mid = str(row.get("message_id") or new_message_id()).strip()
    now = utc_now_iso_z()
    conn = get_db()
    conn.execute(
        """
        INSERT INTO evoflow_collab_peer_messages (
            message_id, main_task_id, thread_key, from_party, to_subtask_id,
            direction, body, in_reply_to, status, visibility_json,
            wake_scheduled, wake_round_id, created_at, answered_at, expires_at, extra_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            mid,
            str(row["main_task_id"]),
            str(row["thread_key"]),
            str(row["from_party"]),
            str(row["to_subtask_id"]),
            str(row.get("direction") or "question"),
            str(row.get("body") or ""),
            row.get("in_reply_to"),
            str(row.get("status") or "pending"),
            json.dumps(row.get("visibility_json") or [], ensure_ascii=False),
            int(bool(row.get("wake_scheduled"))),
            row.get("wake_round_id"),
            str(row.get("created_at") or now),
            row.get("answered_at"),
            row.get("expires_at"),
            json.dumps(row.get("extra_json") or {}, ensure_ascii=False),
        ),
    )
    conn.commit()
    return mid


def get_peer_message(message_id: str) -> dict[str, Any] | None:
    conn = get_db()
    row = conn.execute(
        "SELECT * FROM evoflow_collab_peer_messages WHERE message_id = ? LIMIT 1",
        (str(message_id).strip(),),
    ).fetchone()
    if not row:
        return None
    out = _row_dict(row)
    try:
        out["visibility_json"] = json.loads(out.get("visibility_json") or "[]")
    except json.JSONDecodeError:
        out["visibility_json"] = []
    try:
        out["extra_json"] = json.loads(out.get("extra_json") or "{}")
    except json.JSONDecodeError:
        out["extra_json"] = {}
    return out


def update_peer_message(message_id: str, patch: dict[str, Any]) -> None:
    allowed = {
        "status",
        "answered_at",
        "wake_scheduled",
        "wake_round_id",
        "extra_json",
    }
    sets: list[str] = []
    vals: list[Any] = []
    for key, val in patch.items():
        if key not in allowed:
            continue
        if key == "extra_json" and not isinstance(val, str):
            val = json.dumps(val or {}, ensure_ascii=False)
        sets.append(f"{key} = ?")
        vals.append(val)
    if not sets:
        return
    vals.append(str(message_id).strip())
    conn = get_db()
    conn.execute(
        f"UPDATE evoflow_collab_peer_messages SET {', '.join(sets)} WHERE message_id = ?",
        tuple(vals),
    )
    conn.commit()


def list_peer_messages(
    main_task_id: str,
    *,
    thread_key: str | None = None,
    limit: int = 50,
) -> list[dict[str, Any]]:
    conn = get_db()
    mid = str(main_task_id).strip()
    if thread_key:
        rows = conn.execute(
            """
            SELECT * FROM evoflow_collab_peer_messages
            WHERE main_task_id = ? AND thread_key = ?
            ORDER BY created_at ASC
            LIMIT ?
            """,
            (mid, str(thread_key).strip(), max(1, int(limit))),
        ).fetchall()
    else:
        rows = conn.execute(
            """
            SELECT * FROM evoflow_collab_peer_messages
            WHERE main_task_id = ?
            ORDER BY created_at ASC
            LIMIT ?
            """,
            (mid, max(1, int(limit))),
        ).fetchall()
    out: list[dict[str, Any]] = []
    for row in rows:
        item = _row_dict(row)
        try:
            item["visibility_json"] = json.loads(item.get("visibility_json") or "[]")
        except json.JSONDecodeError:
            item["visibility_json"] = []
        try:
            item["extra_json"] = json.loads(item.get("extra_json") or "{}")
        except json.JSONDecodeError:
            item["extra_json"] = {}
        out.append(item)
    return out


def count_pending_questions(main_task_id: str, from_party: str) -> int:
    conn = get_db()
    row = conn.execute(
        """
        SELECT COUNT(*) FROM evoflow_collab_peer_messages
        WHERE main_task_id = ? AND from_party = ? AND direction = 'question'
          AND status = 'pending'
        """,
        (str(main_task_id).strip(), str(from_party).strip()),
    ).fetchone()
    return int(row[0] if row else 0)


def delete_peer_messages_for_task(main_task_id: str) -> None:
    conn = get_db()
    conn.execute(
        "DELETE FROM evoflow_collab_peer_messages WHERE main_task_id = ?",
        (str(main_task_id).strip(),),
    )
    conn.commit()
