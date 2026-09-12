"""Normalized agent runtime status (``evoflow_agent_runtime``)."""

from __future__ import annotations

import json
from typing import Any

from evoflow.persistence.db import get_db
from evoflow.persistence.timestamps import coerce_iso_z, now_iso_z

_RUNTIME_KNOWN = frozenset(
    {
        "agent_id",
        "agent_name",
        "status",
        "current_task_id",
        "last_heartbeat",
        "progress",
        "main_task_id",
    }
)


def _json_dumps(obj: Any) -> str:
    return json.dumps(obj, ensure_ascii=False, separators=(",", ":"))


def _json_loads(raw: str | None) -> Any:
    if not raw:
        return None
    return json.loads(raw)


def _row_dict(row: Any) -> dict[str, Any]:
    return {k: row[k] for k in row.keys()}


def runtime_to_row(document: dict[str, Any]) -> dict[str, Any]:
    doc = dict(document)
    extra = {k: v for k, v in doc.items() if k not in _RUNTIME_KNOWN}
    return {
        "agent_id": str(doc.get("agent_id") or ""),
        "agent_name": str(doc.get("agent_name") or ""),
        "status": str(doc.get("status") or "idle"),
        "current_task_id": doc.get("current_task_id"),
        "last_heartbeat": coerce_iso_z(doc.get("last_heartbeat")),
        "progress": int(doc.get("progress") or 0),
        "main_task_id": doc.get("main_task_id"),
        "extra_json": _json_dumps(extra) if extra else "{}",
    }


def row_to_runtime(row: dict[str, Any]) -> dict[str, Any]:
    out: dict[str, Any] = {
        "agent_id": row["agent_id"],
        "agent_name": row.get("agent_name") or "",
        "status": row.get("status") or "idle",
        "current_task_id": row.get("current_task_id"),
        "last_heartbeat": row.get("last_heartbeat") or None,
        "progress": int(row.get("progress") or 0),
        "main_task_id": row.get("main_task_id"),
    }
    extra = _json_loads(row.get("extra_json"))
    if isinstance(extra, dict):
        out.update(extra)
    return out


def save_agent_runtime(agent_id: str, document: dict[str, Any]) -> None:
    r = runtime_to_row({**document, "agent_id": agent_id})
    now = now_iso_z()
    get_db().execute(
        """
        INSERT INTO evoflow_agent_runtime (
            agent_id, agent_name, status, current_task_id, last_heartbeat, progress,
            main_task_id, extra_json, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(agent_id) DO UPDATE SET
            agent_name = excluded.agent_name,
            status = excluded.status,
            current_task_id = excluded.current_task_id,
            last_heartbeat = excluded.last_heartbeat,
            progress = excluded.progress,
            main_task_id = excluded.main_task_id,
            extra_json = excluded.extra_json,
            updated_at = excluded.updated_at
        """,
        (
            r["agent_id"],
            r["agent_name"],
            r["status"],
            r["current_task_id"],
            r["last_heartbeat"] or None,
            r["progress"],
            r["main_task_id"],
            r["extra_json"],
            now,
        ),
    )
    get_db().commit()


def load_all_agent_runtime() -> dict[str, dict[str, Any]]:
    rows = (
        get_db()
        .execute(
            """
        SELECT agent_id, agent_name, status, current_task_id, last_heartbeat, progress,
               main_task_id, extra_json
        FROM evoflow_agent_runtime
        """
        )
        .fetchall()
    )
    return {str(r["agent_id"]): row_to_runtime(_row_dict(r)) for r in rows}


def delete_agent_runtime(agent_id: str) -> bool:
    cur = get_db().execute("DELETE FROM evoflow_agent_runtime WHERE agent_id = ?", (agent_id,))
    get_db().commit()
    return cur.rowcount > 0
