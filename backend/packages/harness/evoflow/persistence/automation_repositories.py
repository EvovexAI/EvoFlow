"""Scheduled automations (cron / once) in ``evoflow_automations``."""

from __future__ import annotations

from typing import Any

from evoflow.persistence.db import get_db
from evoflow.persistence.row_mappers import (
    automation_doc_to_row,
    automation_row_to_doc,
    automation_run_doc_to_row,
    automation_run_row_to_doc,
)
from evoflow.timeutil import utc_now_iso_z


def _row_dict(row: Any) -> dict[str, Any]:
    return {k: row[k] for k in row.keys()}


_AUTOMATION_COLS = """
    task_id, name, prompt, schedule, rrule, scheduled_at, status, schedule_type,
    workspace, valid_from, valid_until, max_duration_minutes,
    feishu_push_enabled, langgraph_run, langgraph_thread_mode, langgraph_thread_id,
    langgraph_timeout_seconds, once_fired, created_at, last_run, last_status, run_count,
    extra_json, updated_at
"""


def list_automations() -> list[tuple[str, dict[str, Any]]]:
    rows = get_db().execute(f"SELECT {_AUTOMATION_COLS.strip()} FROM evoflow_automations ORDER BY task_id").fetchall()
    return [(str(r["task_id"]), automation_row_to_doc(_row_dict(r))) for r in rows]


def load_automation(task_id: str) -> dict[str, Any] | None:
    row = (
        get_db()
        .execute(
            f"SELECT {_AUTOMATION_COLS.strip()} FROM evoflow_automations WHERE task_id = ?",
            (task_id.strip(),),
        )
        .fetchone()
    )
    if not row:
        return None
    return automation_row_to_doc(_row_dict(row))


def save_automation(task_id: str, document: dict[str, Any]) -> None:
    r = automation_doc_to_row(task_id, document)
    now = utc_now_iso_z()
    get_db().execute(
        f"""
        INSERT INTO evoflow_automations ({_AUTOMATION_COLS.strip()})
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(task_id) DO UPDATE SET
            name = excluded.name,
            prompt = excluded.prompt,
            schedule = excluded.schedule,
            rrule = excluded.rrule,
            scheduled_at = excluded.scheduled_at,
            status = excluded.status,
            schedule_type = excluded.schedule_type,
            workspace = excluded.workspace,
            valid_from = excluded.valid_from,
            valid_until = excluded.valid_until,
            max_duration_minutes = excluded.max_duration_minutes,
            feishu_push_enabled = excluded.feishu_push_enabled,
            langgraph_run = excluded.langgraph_run,
            langgraph_thread_mode = excluded.langgraph_thread_mode,
            langgraph_thread_id = excluded.langgraph_thread_id,
            langgraph_timeout_seconds = excluded.langgraph_timeout_seconds,
            once_fired = excluded.once_fired,
            created_at = excluded.created_at,
            last_run = excluded.last_run,
            last_status = excluded.last_status,
            run_count = excluded.run_count,
            extra_json = excluded.extra_json,
            updated_at = excluded.updated_at
        """,
        (
            r["task_id"],
            r["name"],
            r["prompt"],
            r["schedule"],
            r["rrule"],
            r["scheduled_at"],
            r["status"],
            r["schedule_type"],
            r["workspace"],
            r["valid_from"],
            r["valid_until"],
            r["max_duration_minutes"],
            r["feishu_push_enabled"],
            r["langgraph_run"],
            r["langgraph_thread_mode"],
            r["langgraph_thread_id"],
            r["langgraph_timeout_seconds"],
            r["once_fired"],
            r["created_at"],
            r["last_run"],
            r["last_status"],
            r["run_count"],
            r["extra_json"],
            now,
        ),
    )
    get_db().commit()


def delete_automation(task_id: str) -> bool:
    tid = task_id.strip()
    conn = get_db()
    cur = conn.execute("DELETE FROM evoflow_automations WHERE task_id = ?", (tid,))
    conn.execute("DELETE FROM evoflow_automation_runs WHERE task_id = ?", (tid,))
    conn.commit()
    return cur.rowcount > 0


def set_automation_owner_scope(
    task_id: str,
    *,
    org_id: str,
    owner_scope_id: str,
    created_by: str | None = None,
) -> None:
    tid = str(task_id or "").strip()
    if not tid:
        return
    cols = {str(r[1]) for r in get_db().execute("PRAGMA table_info(evoflow_automations)").fetchall()}
    if "owner_scope_id" not in cols:
        return
    if "created_by" in cols and created_by:
        get_db().execute(
            """
            UPDATE evoflow_automations
            SET org_id = COALESCE(NULLIF(org_id, ''), ?),
                owner_scope_id = COALESCE(NULLIF(owner_scope_id, ''), ?),
                created_by = COALESCE(NULLIF(created_by, ''), ?)
            WHERE task_id = ?
            """,
            (org_id, owner_scope_id, created_by, tid),
        )
    else:
        get_db().execute(
            """
            UPDATE evoflow_automations
            SET org_id = COALESCE(NULLIF(org_id, ''), ?),
                owner_scope_id = COALESCE(NULLIF(owner_scope_id, ''), ?)
            WHERE task_id = ?
            """,
            (org_id, owner_scope_id, tid),
        )
    get_db().commit()


def get_automation_owner_scope(task_id: str) -> tuple[str | None, str | None]:
    tid = str(task_id or "").strip()
    if not tid:
        return None, None
    cols = {str(r[1]) for r in get_db().execute("PRAGMA table_info(evoflow_automations)").fetchall()}
    if "owner_scope_id" not in cols:
        return None, None
    row = get_db().execute(
        "SELECT org_id, owner_scope_id FROM evoflow_automations WHERE task_id = ?",
        (tid,),
    ).fetchone()
    if not row:
        return None, None
    return (str(row[0] or "").strip() or None, str(row[1] or "").strip() or None)


def automation_visible_to_principal(
    task_id: str,
    *,
    is_admin: bool = False,
    personal_scope: str | None = None,
    org_scope: str | None = None,
    principal: Any = None,
) -> bool:
    from evoflow.authz.resource_visibility import owner_scope_visible_to_principal

    _org, owner = get_automation_owner_scope(task_id)
    return owner_scope_visible_to_principal(
        owner,
        principal,
        is_admin=is_admin,
        personal_scope=personal_scope,
        org_scope=org_scope,
    )


def automation_count() -> int:
    row = get_db().execute("SELECT COUNT(*) FROM evoflow_automations").fetchone()
    return int(row[0]) if row else 0


def append_automation_run(task_id: str, record: dict[str, Any]) -> None:
    from evoflow.persistence.timestamps import coerce_iso_z

    r = automation_run_doc_to_row(record)
    updated = coerce_iso_z(r.get("started_at"), now_if_empty=True)
    get_db().execute(
        """
        INSERT INTO evoflow_automation_runs (
            task_id, run_id, started_at, trigger_type, status, output, error,
            duration_seconds, langgraph_thread_id, langgraph_run, extra_json, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            task_id.strip(),
            r["run_id"],
            r["started_at"],
            r["trigger_type"],
            r["status"],
            r["output"],
            r["error"],
            r["duration_seconds"],
            r["langgraph_thread_id"],
            r["langgraph_run"],
            r["extra_json"],
            updated,
        ),
    )
    get_db().commit()


def list_automation_runs(task_id: str, *, limit: int = 50, offset: int = 0) -> list[dict[str, Any]]:
    rows = (
        get_db()
        .execute(
            """
        SELECT run_id, started_at, trigger_type, status, output, error,
               duration_seconds, langgraph_thread_id, langgraph_run, extra_json
        FROM evoflow_automation_runs
        WHERE task_id = ?
        ORDER BY id DESC
        LIMIT ? OFFSET ?
        """,
            (task_id.strip(), int(limit), int(offset)),
        )
        .fetchall()
    )
    return [automation_run_row_to_doc(_row_dict(row)) for row in rows]


def count_automation_runs(task_id: str) -> int:
    row = (
        get_db()
        .execute(
            "SELECT COUNT(*) FROM evoflow_automation_runs WHERE task_id = ?",
            (task_id.strip(),),
        )
        .fetchone()
    )
    return int(row[0]) if row else 0
