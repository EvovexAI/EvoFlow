"""Repository helpers over ``evoflow.db`` application tables."""

from __future__ import annotations

import json
from typing import Any

from evoflow.persistence.db import get_db

TASK_EVENT_TYPE_STREAM = "stream"
TASK_EVENT_TYPE_STATUS = "status"


def _json_dumps(obj: Any) -> str:
    return json.dumps(obj, ensure_ascii=False, separators=(",", ":"))


def _json_loads(raw: str | None) -> Any:
    if not raw:
        return None
    return json.loads(raw)


# --- Task bundles (v14 normalized tables via task_repositories) ---


def list_task_bundle_ids() -> list[str]:
    from evoflow.persistence import task_repositories as task_repo

    return task_repo.list_task_bundle_ids()


def list_root_task_summaries(*, main_task_id: str | None = None) -> list[dict[str, Any]]:
    from evoflow.persistence import task_repositories as task_repo

    return task_repo.list_root_task_summaries(main_task_id=main_task_id)


def list_subtask_summaries(*, main_task_id: str | None = None) -> list[dict[str, Any]]:
    from evoflow.persistence import task_repositories as task_repo

    return task_repo.list_subtask_summaries(main_task_id=main_task_id)


def load_task_bundle(main_task_id: str) -> dict[str, Any] | None:
    from evoflow.persistence import task_repositories as task_repo

    return task_repo.load_task_bundle(main_task_id)


def find_root_task_by_thread_id(thread_id: str, *, prefer_task_id: str = "") -> dict[str, Any] | None:
    from evoflow.persistence import task_repositories as task_repo

    return task_repo.find_root_task_by_thread_id(thread_id, prefer_task_id=prefer_task_id)


def find_root_task_by_session_key(session_key: str, *, prefer_task_id: str = "") -> dict[str, Any] | None:
    from evoflow.persistence import task_repositories as task_repo

    return task_repo.find_root_task_by_session_key(session_key, prefer_task_id=prefer_task_id)


def save_task_bundle(main_task_id: str, document: dict[str, Any]) -> None:
    from evoflow.persistence import task_repositories as task_repo

    task_repo.save_task_bundle(main_task_id, document)


def delete_task_bundle(main_task_id: str) -> None:
    from evoflow.persistence import task_repositories as task_repo

    conn = get_db()
    task_repo.delete_task_bundle_children(conn, main_task_id)
    task_repo.delete_task_details_for_main(main_task_id, conn=conn)
    task_repo.delete_task_global_facts(main_task_id, conn=conn)
    try:
        conn.execute(
            "DELETE FROM evoflow_task_events WHERE event_type = ? AND task_id = ?",
            (TASK_EVENT_TYPE_STREAM, main_task_id),
        )
    except Exception as e:
        if "no such table" not in str(e).lower():
            raise
    conn.commit()


# --- Task details / facts ---


def load_task_detail(main_task_id: str, agent_id: str, task_id: str) -> dict[str, Any] | None:
    from evoflow.persistence import task_repositories as task_repo

    return task_repo.load_task_detail(main_task_id, agent_id, task_id)


def save_task_detail(main_task_id: str, agent_id: str, task_id: str, document: dict[str, Any]) -> None:
    from evoflow.persistence import task_repositories as task_repo

    task_repo.save_task_detail(main_task_id, agent_id, task_id, document)


def load_task_global_facts(main_task_id: str) -> dict[str, Any] | None:
    from evoflow.persistence import task_repositories as task_repo

    return task_repo.load_task_global_facts(main_task_id)


def save_task_global_facts(main_task_id: str, document: dict[str, Any]) -> None:
    from evoflow.persistence import task_repositories as task_repo

    task_repo.save_task_global_facts(main_task_id, document)


def list_task_details_for_agent(main_task_id: str, agent_id: str) -> list[dict[str, Any]]:
    from evoflow.persistence import task_repositories as task_repo

    return task_repo.list_task_details_for_agent(main_task_id, agent_id)


# --- Task events (stream + status) ---


def append_task_stream_event(main_task_id: str, event: dict[str, Any]) -> None:
    from evoflow.persistence.db import run_db_with_retry
    from evoflow.persistence.timestamps import now_iso_z

    def _do() -> None:
        now = now_iso_z()
        get_db().execute(
            """
            INSERT INTO evoflow_task_events (event_type, task_id, event_json, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?)
            """,
            (TASK_EVENT_TYPE_STREAM, main_task_id, _json_dumps(event), now, now),
        )
        get_db().commit()

    run_db_with_retry(_do)


def tail_task_stream_events(main_task_id: str, limit: int) -> list[dict[str, Any]]:
    rows = (
        get_db()
        .execute(
            """
        SELECT event_json FROM evoflow_task_events
        WHERE event_type = ? AND task_id = ?
        ORDER BY id DESC
        LIMIT ?
        """,
            (TASK_EVENT_TYPE_STREAM, main_task_id, limit),
        )
        .fetchall()
    )
    out: list[dict[str, Any]] = []
    for row in reversed(rows):
        data = _json_loads(row[0])
        if isinstance(data, dict):
            out.append(data)
    return out


def append_task_status_event(task_id: str, record: dict[str, Any]) -> None:
    from evoflow.persistence.db import run_db_with_retry
    from evoflow.persistence.timestamps import now_iso_z

    def _do() -> None:
        now = now_iso_z()
        get_db().execute(
            """
            INSERT INTO evoflow_task_events (event_type, task_id, event_json, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?)
            """,
            (TASK_EVENT_TYPE_STATUS, task_id, _json_dumps(record), now, now),
        )
        get_db().commit()

    run_db_with_retry(_do)


def list_task_status_events(task_id: str, *, offset: int = 0, limit: int | None = None) -> list[dict[str, Any]]:
    sql = (
        "SELECT event_json FROM evoflow_task_events "
        "WHERE event_type = ? AND task_id = ? ORDER BY id ASC"
    )
    params: list[Any] = [TASK_EVENT_TYPE_STATUS, task_id]
    if limit is not None:
        sql += " LIMIT ? OFFSET ?"
        params.extend([limit, offset])
    elif offset:
        sql += " OFFSET ?"
        params.append(offset)
    rows = get_db().execute(sql, params).fetchall()
    out: list[dict[str, Any]] = []
    for row in rows:
        data = _json_loads(row[0])
        if isinstance(data, dict):
            out.append(data)
    return out


# --- Thread collab ---


def load_thread_collab(thread_id: str) -> dict[str, Any] | None:
    from evoflow.persistence import task_repositories as task_repo

    return task_repo.load_thread_collab(thread_id)


def save_thread_collab(thread_id: str, state: dict[str, Any]) -> None:
    from evoflow.persistence import task_repositories as task_repo

    task_repo.save_thread_collab(thread_id, state)


def delete_thread_collab(thread_id: str) -> None:
    from evoflow.persistence import task_repositories as task_repo

    task_repo.delete_thread_collab(thread_id)


def delete_thread_data(thread_id: str) -> None:
    """Remove per-thread rows from application DB (collab, mission, retries)."""
    from evoflow.persistence.mission_state_repositories import delete_mission_state_children

    conn = get_db()
    from evoflow.persistence import task_repositories as task_repo

    task_repo.delete_thread_collab(thread_id)
    task_repo.delete_mission_runtime(thread_id)
    delete_mission_state_children(thread_id)
    conn.execute("DELETE FROM evoflow_mission_state WHERE thread_id = ?", (thread_id,))
    conn.execute("DELETE FROM evoflow_mission_retries WHERE thread_id = ?", (thread_id,))
    conn.execute("DELETE FROM evoflow_mission_nodes WHERE thread_id = ?", (thread_id,))
    conn.execute("DELETE FROM evoflow_thread_plans WHERE thread_id = ?", (thread_id,))
    try:
        from evoflow.persistence.exploration_graph_repositories import delete_exploration_graph

        delete_exploration_graph(thread_id)
    except Exception:
        pass
    try:
        from evoflow.persistence import session_repositories as sess_repo

        sess_repo.delete_sessions_by_thread_id(thread_id)
    except Exception:
        pass
    conn.commit()


# --- Mission state ---


def load_mission_state_doc(thread_id: str) -> dict[str, Any] | None:
    from evoflow.persistence.mission_state_repositories import load_mission_state_wrapped

    return load_mission_state_wrapped(thread_id)


def save_mission_state_doc(thread_id: str, document: dict[str, Any]) -> None:
    from evoflow.persistence.mission_state_repositories import save_mission_state_wrapped

    save_mission_state_wrapped(thread_id, document)


def delete_mission_state(thread_id: str) -> None:
    from evoflow.persistence.mission_state_repositories import delete_mission_state_children

    delete_mission_state_children(thread_id)
    get_db().execute("DELETE FROM evoflow_mission_state WHERE thread_id = ?", (thread_id,))
    get_db().commit()


# --- Mission retries ---


def append_mission_retry(thread_id: str, document: dict[str, Any], next_run_ts_ms: int) -> None:
    from evoflow.persistence.row_mappers import mission_retry_doc_to_row

    r = mission_retry_doc_to_row(document, int(next_run_ts_ms))
    get_db().execute(
        """
        INSERT INTO evoflow_mission_retries (
            thread_id, mode, turn_id, attempts, last_error, messages_json, ts, next_run_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            r["thread_id"],
            r["mode"],
            r["turn_id"],
            r["attempts"],
            r["last_error"],
            r["messages_json"],
            r["ts"],
            r["next_run_at"],
            r.get("updated_at") or r["ts"],
        ),
    )
    get_db().commit()


def load_due_mission_retries(now_ts_ms: int) -> list[dict[str, Any]]:
    from evoflow.persistence.row_mappers import mission_retry_row_to_doc
    from evoflow.persistence.timestamps import ms_to_iso_z

    now_at = ms_to_iso_z(int(now_ts_ms))
    rows = (
        get_db()
        .execute(
            """
        SELECT thread_id, mode, turn_id, attempts, last_error, messages_json, ts, next_run_at
        FROM evoflow_mission_retries
        WHERE next_run_at <= ?
        ORDER BY next_run_at ASC
        """,
            (now_at,),
        )
        .fetchall()
    )
    return [mission_retry_row_to_doc({k: row[k] for k in row.keys()}) for row in rows]


def clear_mission_retries_for_thread(thread_id: str) -> None:
    get_db().execute("DELETE FROM evoflow_mission_retries WHERE thread_id = ?", (thread_id,))
    get_db().commit()


def pop_due_mission_retries(now_ts_ms: int, *, limit: int = 10) -> list[dict[str, Any]]:
    from evoflow.persistence.row_mappers import mission_retry_row_to_doc
    from evoflow.persistence.timestamps import ms_to_iso_z

    now_at = ms_to_iso_z(int(now_ts_ms))
    conn = get_db()
    rows = conn.execute(
        """
        SELECT id, thread_id, mode, turn_id, attempts, last_error, messages_json, ts, next_run_at
        FROM evoflow_mission_retries
        WHERE next_run_at <= ?
        ORDER BY next_run_at ASC
        LIMIT ?
        """,
        (now_at, int(limit)),
    ).fetchall()
    ids = [int(r[0]) for r in rows]
    if ids:
        placeholders = ",".join("?" * len(ids))
        conn.execute(f"DELETE FROM evoflow_mission_retries WHERE id IN ({placeholders})", ids)
        conn.commit()
    out: list[dict[str, Any]] = []
    for row in rows:
        doc = {k: row[k] for k in row.keys() if k != "id"}
        out.append(mission_retry_row_to_doc(doc))
    return out


def peek_next_mission_retry_delay_ms(now_ts_ms: int) -> int | None:
    """Return milliseconds until the next scheduled retry, or None if queue is empty."""
    from evoflow.persistence.timestamps import iso_z_to_ms

    row = get_db().execute("SELECT MIN(next_run_at) FROM evoflow_mission_retries").fetchone()
    if row is None or row[0] is None:
        return None
    try:
        next_ms = int(iso_z_to_ms(row[0]))
    except Exception:
        return None
    return max(0, next_ms - int(now_ts_ms))


def prune_mission_retries(*, max_rows: int = 5000) -> None:
    conn = get_db()
    count = conn.execute("SELECT COUNT(*) FROM evoflow_mission_retries").fetchone()
    total = int(count[0]) if count else 0
    if total <= max_rows:
        return
    excess = total - max_rows
    conn.execute(
        """
        DELETE FROM evoflow_mission_retries WHERE id IN (
            SELECT id FROM evoflow_mission_retries ORDER BY id ASC LIMIT ?
        )
        """,
        (excess,),
    )
    conn.commit()


# --- Memory ---


def _memory_agent_key(agent_name: str | None) -> str:
    return (agent_name or "").strip()


def load_memory(agent_name: str | None) -> dict[str, Any] | None:
    from evoflow.persistence import memory_repositories as mem_repo

    return mem_repo.load_memory(agent_name)


def save_memory(agent_name: str | None, document: dict[str, Any]) -> None:
    from evoflow.persistence import memory_repositories as mem_repo

    mem_repo.save_memory(agent_name, document)


# --- Channel bindings ---


def load_all_channel_bindings() -> dict[str, dict[str, Any]]:
    from evoflow.persistence.timestamps import iso_z_to_unix

    rows = get_db().execute("SELECT channel_key, thread_id, user_id, created_at, updated_at FROM evoflow_channel_bindings").fetchall()
    out: dict[str, dict[str, Any]] = {}
    for row in rows:
        out[str(row[0])] = {
            "thread_id": str(row[1] or ""),
            "user_id": str(row[2] or ""),
            "created_at": iso_z_to_unix(row[3]),
            "updated_at": iso_z_to_unix(row[4]),
        }
    return out


def save_channel_binding(channel_key: str, document: dict[str, Any]) -> None:
    from evoflow.persistence.timestamps import coerce_iso_z, now_iso_z

    now = now_iso_z()
    get_db().execute(
        """
        INSERT INTO evoflow_channel_bindings (channel_key, thread_id, user_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(channel_key) DO UPDATE SET
            thread_id = excluded.thread_id,
            user_id = excluded.user_id,
            created_at = CASE
                WHEN excluded.created_at != '' THEN excluded.created_at
                ELSE evoflow_channel_bindings.created_at
            END,
            updated_at = excluded.updated_at
        """,
        (
            channel_key,
            str(document.get("thread_id") or ""),
            str(document.get("user_id") or ""),
            coerce_iso_z(document.get("created_at")),
            coerce_iso_z(document.get("updated_at"), now_if_empty=True) or now,
        ),
    )
    get_db().commit()


def delete_channel_binding(channel_key: str) -> bool:
    cur = get_db().execute(
        "DELETE FROM evoflow_channel_bindings WHERE channel_key = ?",
        (channel_key,),
    )
    get_db().commit()
    return cur.rowcount > 0


def delete_channel_bindings_by_prefix(prefix: str) -> int:
    cur = get_db().execute(
        "DELETE FROM evoflow_channel_bindings WHERE channel_key = ? OR channel_key LIKE ?",
        (prefix, prefix + ":%"),
    )
    get_db().commit()
    return int(cur.rowcount or 0)


# --- Agent runtime ---


def load_all_agent_runtime() -> dict[str, dict[str, Any]]:
    from evoflow.persistence import runtime_repositories as rt_repo

    return rt_repo.load_all_agent_runtime()


def save_agent_runtime(agent_id: str, document: dict[str, Any]) -> None:
    from evoflow.persistence import runtime_repositories as rt_repo

    rt_repo.save_agent_runtime(agent_id, document)


def delete_agent_runtime(agent_id: str) -> bool:
    from evoflow.persistence import runtime_repositories as rt_repo

    return rt_repo.delete_agent_runtime(agent_id)
