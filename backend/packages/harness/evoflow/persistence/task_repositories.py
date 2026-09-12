"""Normalized task bundle, detail, global facts, and thread collab persistence."""

from __future__ import annotations

from typing import Any

from evoflow.persistence import task_row_mappers as m
from evoflow.persistence.db import get_db
from evoflow.timeutil import utc_now_iso_z


def _row_dict(cursor_row: Any) -> dict[str, Any]:
    if cursor_row is None:
        return {}
    if hasattr(cursor_row, "keys"):
        return dict(cursor_row)
    cols = [d[0] for d in cursor_row.description] if hasattr(cursor_row, "description") else []
    return dict(zip(cols, cursor_row, strict=False))


def _safe_exec(conn: Any, sql: str, params: tuple[Any, ...] = ()) -> None:
    """Execute SQL; ignore missing-table errors so deletes can proceed on older DBs."""
    try:
        conn.execute(sql, params)
    except Exception as e:
        if "no such table" in str(e).lower():
            return
        raise


def delete_task_bundle_children(conn: Any, main_task_id: str) -> None:
    _safe_exec(conn, "DELETE FROM evoflow_collab_peer_messages WHERE main_task_id = ?", (main_task_id,))
    _safe_exec(conn, "DELETE FROM evoflow_collab_task_execution_history WHERE main_task_id = ?", (main_task_id,))
    _safe_exec(conn, "DELETE FROM evoflow_collab_subtask_skills WHERE main_task_id = ?", (main_task_id,))
    _safe_exec(conn, "DELETE FROM evoflow_collab_subtask_tools WHERE main_task_id = ?", (main_task_id,))
    _safe_exec(conn, "DELETE FROM evoflow_collab_subtask_expected_outputs WHERE main_task_id = ?", (main_task_id,))
    _safe_exec(conn, "DELETE FROM evoflow_collab_subtask_deps WHERE main_task_id = ?", (main_task_id,))
    _safe_exec(conn, "DELETE FROM evoflow_collab_subtasks WHERE main_task_id = ?", (main_task_id,))
    _safe_exec(conn, "DELETE FROM evoflow_collab_task_deps WHERE main_task_id = ?", (main_task_id,))
    _safe_exec(conn, "DELETE FROM evoflow_collab_tasks WHERE main_task_id = ?", (main_task_id,))
    _safe_exec(conn, "DELETE FROM evoflow_task_bundles WHERE main_task_id = ?", (main_task_id,))


def _ensure_plan_columns_compat(conn: Any) -> None:
    """No-op: structured plan columns are part of the public baseline schema."""
    return

def save_task_bundle(main_task_id: str, document: dict[str, Any]) -> None:
    from evoflow.persistence.db import run_db_with_retry

    def _do_save() -> None:
        conn = get_db()
        _ensure_plan_columns_compat(conn)
        now = utc_now_iso_z()
        mid = str(main_task_id or "").strip()
        # Preserve ACL across REPLACE (delete+insert clears columns).
        prev_owner: tuple[str | None, str | None, str | None] = (None, None, None)
        try:
            cols = {str(r[1]) for r in conn.execute("PRAGMA table_info(evoflow_collab_tasks)").fetchall()}
            if "owner_scope_id" in cols:
                row = conn.execute(
                    "SELECT org_id, owner_scope_id, created_by FROM evoflow_collab_tasks "
                    "WHERE main_task_id = ? AND task_id = main_task_id LIMIT 1",
                    (mid,),
                ).fetchone()
                if row:
                    prev_owner = (
                        str(row[0] or "").strip() or None,
                        str(row[1] or "").strip() or None,
                        str(row[2] or "").strip() or None,
                    )
        except Exception:
            prev_owner = (None, None, None)
        parts = m.bundle_to_rows(document)
        bundle = parts["bundle"]
        bundle["updated_at"] = now
        parts["tasks"] = m.apply_bundle_header_to_task_rows(main_task_id, bundle, parts["tasks"])
        delete_task_bundle_children(conn, main_task_id)
        for tr in parts["tasks"]:
            conn.execute(
                """
                INSERT INTO evoflow_collab_tasks (
                    main_task_id, task_id, name, description, status, parent_id, assigned_to, error_text,
                    created_at, started_at, completed_at, progress, execution_authorized, thread_id,
                    authorized_at, authorized_by, result_json,
                    plan_goal, plan_flowchart_mermaid, plan_validation_json, plan_open_questions,
                    plan_steps_json, plan_bound_at,
                    extra_json, sort_order, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    tr["main_task_id"],
                    tr["task_id"],
                    tr["name"],
                    tr["description"],
                    tr["status"],
                    tr.get("parent_id"),
                    tr.get("assigned_to"),
                    tr.get("error_text"),
                    tr.get("created_at"),
                    tr.get("started_at"),
                    tr.get("completed_at"),
                    tr["progress"],
                    tr["execution_authorized"],
                    tr.get("thread_id"),
                    tr.get("authorized_at"),
                    tr.get("authorized_by"),
                    tr.get("result_json"),
                    tr.get("plan_goal") or "",
                    tr.get("plan_flowchart_mermaid") or "",
                    tr.get("plan_validation_json") or "[]",
                    tr.get("plan_open_questions") or "",
                    tr.get("plan_steps_json") or "[]",
                    tr.get("plan_bound_at") or "",
                    tr.get("extra_json") or "{}",
                    tr["sort_order"],
                    tr.get("updated_at") or now,
                ),
            )
        for d in parts["task_deps"]:
            conn.execute(
                """
                INSERT INTO evoflow_collab_task_deps (
                    main_task_id, task_id, depends_on_id, sort_order, updated_at
                ) VALUES (?, ?, ?, ?, ?)
                """,
                (d["main_task_id"], d["task_id"], d["depends_on_id"], d["sort_order"], now),
            )
        for sr in parts["subtasks"]:
            conn.execute(
                """
                INSERT INTO evoflow_collab_subtasks (
                    main_task_id, parent_task_id, subtask_id, name, description, status, parent_id,
                    assigned_to, error_text, created_at, started_at, completed_at, progress,
                    execution_authorized, thread_id, authorized_at, authorized_by, project_path,
                    claude_session_id, external_session_id, updated_at, result_json, extra_json,
                    worker_base_subagent, worker_model, worker_instruction, worker_validation,
                    worker_max_retries, sort_order
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    sr["main_task_id"],
                    sr["parent_task_id"],
                    sr["subtask_id"],
                    sr["name"],
                    sr["description"],
                    sr["status"],
                    sr.get("parent_id"),
                    sr.get("assigned_to"),
                    sr.get("error_text"),
                    sr.get("created_at"),
                    sr.get("started_at"),
                    sr.get("completed_at"),
                    sr["progress"],
                    sr["execution_authorized"],
                    sr.get("thread_id"),
                    sr.get("authorized_at"),
                    sr.get("authorized_by"),
                    sr.get("project_path"),
                    sr.get("claude_session_id"),
                    sr.get("external_session_id"),
                    sr.get("updated_at") or now,
                    sr.get("result_json"),
                    sr.get("extra_json") or "{}",
                    sr.get("worker_base_subagent"),
                    sr.get("worker_model"),
                    sr.get("worker_instruction"),
                    sr.get("worker_validation"),
                    sr.get("worker_max_retries"),
                    sr["sort_order"],
                ),
            )
        for d in parts["subtask_deps"]:
            conn.execute(
                """
                INSERT INTO evoflow_collab_subtask_deps (
                    main_task_id, parent_task_id, subtask_id, depends_on_subtask_id, link_kind, sort_order,
                    updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    d["main_task_id"],
                    d["parent_task_id"],
                    d["subtask_id"],
                    d["depends_on_subtask_id"],
                    d["link_kind"],
                    d["sort_order"],
                    now,
                ),
            )
        for o in parts["subtask_outputs"]:
            conn.execute(
                """
                INSERT INTO evoflow_collab_subtask_expected_outputs (
                    main_task_id, parent_task_id, subtask_id, output_path, sort_order, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?)
                """,
                (o["main_task_id"], o["parent_task_id"], o["subtask_id"], o["output_path"], o["sort_order"], now),
            )
        for t in parts["subtask_tools"]:
            conn.execute(
                """
                INSERT INTO evoflow_collab_subtask_tools (
                    main_task_id, parent_task_id, subtask_id, item_value, sort_order, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?)
                """,
                (t["main_task_id"], t["parent_task_id"], t["subtask_id"], t["item_value"], t["sort_order"], now),
            )
        for s in parts["subtask_skills"]:
            conn.execute(
                """
                INSERT INTO evoflow_collab_subtask_skills (
                    main_task_id, parent_task_id, subtask_id, item_value, sort_order, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?)
                """,
                (s["main_task_id"], s["parent_task_id"], s["subtask_id"], s["item_value"], s["sort_order"], now),
            )
        for h in parts["execution_history"]:
            conn.execute(
                """
                INSERT INTO evoflow_collab_task_execution_history (
                    main_task_id, parent_task_id, subtask_id, sort_order, event_json, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?)
                """,
                (
                    h["main_task_id"],
                    h["parent_task_id"],
                    h.get("subtask_id") or "",
                    h["sort_order"],
                    h["event_json"],
                    now,
                ),
            )
        # Restore / apply ownership on root row
        try:
            cols = {str(r[1]) for r in conn.execute("PRAGMA table_info(evoflow_collab_tasks)").fetchall()}
            if "owner_scope_id" in cols:
                org_id, owner, created = prev_owner
                doc_owner = str((document or {}).get("owner_scope_id") or "").strip()
                doc_created = str((document or {}).get("created_by") or "").strip()
                doc_org = str((document or {}).get("org_id") or "").strip()
                if doc_owner:
                    owner = owner or doc_owner
                if doc_created:
                    created = created or doc_created
                if doc_org:
                    org_id = org_id or doc_org
                if owner or created:
                    conn.execute(
                        """
                        UPDATE evoflow_collab_tasks
                        SET org_id = COALESCE(NULLIF(org_id, ''), ?),
                            owner_scope_id = COALESCE(NULLIF(owner_scope_id, ''), ?),
                            created_by = COALESCE(NULLIF(created_by, ''), ?)
                        WHERE main_task_id = ? AND task_id = main_task_id
                        """,
                        (org_id or "local", owner or "", created or "", mid),
                    )
        except Exception:
            pass
        conn.commit()

    run_db_with_retry(_do_save)


def load_task_bundle(main_task_id: str) -> dict[str, Any] | None:
    conn = get_db()
    tasks = [
        _row_dict(r)
        for r in conn.execute(
            "SELECT * FROM evoflow_collab_tasks WHERE main_task_id = ? ORDER BY sort_order",
            (main_task_id,),
        ).fetchall()
    ]
    if not tasks:
        return None
    bundle_row = m.bundle_row_from_task_rows(main_task_id, tasks)
    task_deps = [
        _row_dict(r)
        for r in conn.execute(
            "SELECT * FROM evoflow_collab_task_deps WHERE main_task_id = ? ORDER BY sort_order",
            (main_task_id,),
        ).fetchall()
    ]
    subtasks = [
        _row_dict(r)
        for r in conn.execute(
            "SELECT * FROM evoflow_collab_subtasks WHERE main_task_id = ? ORDER BY sort_order",
            (main_task_id,),
        ).fetchall()
    ]
    subtask_deps = [
        _row_dict(r)
        for r in conn.execute(
            "SELECT * FROM evoflow_collab_subtask_deps WHERE main_task_id = ? ORDER BY sort_order",
            (main_task_id,),
        ).fetchall()
    ]
    subtask_outputs = [
        _row_dict(r)
        for r in conn.execute(
            "SELECT * FROM evoflow_collab_subtask_expected_outputs WHERE main_task_id = ? ORDER BY sort_order",
            (main_task_id,),
        ).fetchall()
    ]
    subtask_tools = [
        _row_dict(r)
        for r in conn.execute(
            "SELECT * FROM evoflow_collab_subtask_tools WHERE main_task_id = ? ORDER BY sort_order",
            (main_task_id,),
        ).fetchall()
    ]
    subtask_skills = [
        _row_dict(r)
        for r in conn.execute(
            "SELECT * FROM evoflow_collab_subtask_skills WHERE main_task_id = ? ORDER BY sort_order",
            (main_task_id,),
        ).fetchall()
    ]
    execution_history = [
        _row_dict(r)
        for r in conn.execute(
            """
            SELECT * FROM evoflow_collab_task_execution_history
            WHERE main_task_id = ? ORDER BY parent_task_id, subtask_id, sort_order
            """,
            (main_task_id,),
        ).fetchall()
    ]
    return m.rows_to_bundle(
        bundle_row,
        tasks,
        task_deps,
        subtasks,
        subtask_deps,
        subtask_outputs,
        subtask_tools,
        subtask_skills,
        execution_history,
    )


def list_task_bundle_ids() -> list[str]:
    rows = get_db().execute(
        """
        SELECT main_task_id
        FROM evoflow_collab_tasks
        GROUP BY main_task_id
        ORDER BY MAX(updated_at) DESC
        """
    ).fetchall()
    return [str(r[0]) for r in rows]


def list_root_task_summaries(
    *,
    main_task_id: str | None = None,
) -> list[dict[str, Any]]:
    """List root collaborative tasks with one SQL query (no full-bundle hydrate).

    Root rows are ``task_id = main_task_id``. Used by ``GET /api/tasks`` so the
    Gateway does not load subtasks/history for every project on each list call.

    Omits heavy columns (``result_json``, plan mermaid/steps/validation) that the
    task-center list does not need — those dominate I/O when there are 1000+ roots.
    """
    from evoflow.persistence.db import run_db_read

    # Schema migrations run on the write connection at startup (get_db); read pool is query-only.
    cols = """
        main_task_id, task_id, name, description, status, parent_id, assigned_to,
        error_text, created_at, started_at, completed_at, progress, execution_authorized,
        thread_id, authorized_at, authorized_by, extra_json, sort_order, updated_at,
        plan_goal, plan_open_questions, plan_bound_at
    """
    # Append ownership cols when present (v139+).
    try:
        have = {str(r[1]) for r in get_db().execute("PRAGMA table_info(evoflow_collab_tasks)").fetchall()}
        for c in ("org_id", "owner_scope_id", "created_by"):
            if c in have:
                cols = cols.rstrip() + f", {c}"
    except Exception:
        pass
    mid = str(main_task_id or "").strip()

    def _query(conn: Any) -> list[dict[str, Any]]:
        if mid:
            rows = conn.execute(
                f"""
                SELECT {cols}
                FROM evoflow_collab_tasks
                WHERE main_task_id = ? AND task_id = main_task_id
                ORDER BY COALESCE(updated_at, created_at, '') DESC
                """,
                (mid,),
            ).fetchall()
        else:
            rows = conn.execute(
                f"""
                SELECT {cols}
                FROM evoflow_collab_tasks
                WHERE task_id = main_task_id
                ORDER BY COALESCE(updated_at, created_at, '') DESC
                """
            ).fetchall()
        out = []
        for r in rows:
            d = _row_dict(r)
            summary = m.collab_task_row_to_summary(d)
            if "owner_scope_id" in d:
                summary["owner_scope_id"] = d.get("owner_scope_id")
                summary["created_by"] = d.get("created_by")
                summary["org_id"] = d.get("org_id")
            out.append(summary)
        return out

    return run_db_read(_query)


def get_root_task_owner_scope(task_id: str) -> tuple[str | None, str | None, str | None]:
    tid = str(task_id or "").strip()
    if not tid:
        return None, None, None
    cols = {str(r[1]) for r in get_db().execute("PRAGMA table_info(evoflow_collab_tasks)").fetchall()}
    if "owner_scope_id" not in cols:
        return None, None, None
    row = get_db().execute(
        "SELECT org_id, owner_scope_id, created_by FROM evoflow_collab_tasks "
        "WHERE (task_id = ? OR main_task_id = ?) AND task_id = main_task_id LIMIT 1",
        (tid, tid),
    ).fetchone()
    if not row:
        return None, None, None
    return (
        str(row[0] or "").strip() or None,
        str(row[1] or "").strip() or None,
        str(row[2] or "").strip() or None,
    )


def set_root_task_owner_scope(
    task_id: str,
    *,
    org_id: str,
    owner_scope_id: str,
    created_by: str | None = None,
) -> None:
    tid = str(task_id or "").strip()
    if not tid or not owner_scope_id:
        return

    def _write() -> None:
        conn = get_db()
        cols = {str(r[1]) for r in conn.execute("PRAGMA table_info(evoflow_collab_tasks)").fetchall()}
        if "owner_scope_id" not in cols:
            return
        if "created_by" in cols and created_by:
            conn.execute(
                """
                UPDATE evoflow_collab_tasks
                SET org_id = COALESCE(NULLIF(org_id, ''), ?),
                    owner_scope_id = COALESCE(NULLIF(owner_scope_id, ''), ?),
                    created_by = COALESCE(NULLIF(created_by, ''), ?)
                WHERE main_task_id = ? AND task_id = main_task_id
                """,
                (org_id, owner_scope_id, created_by, tid),
            )
        else:
            conn.execute(
                """
                UPDATE evoflow_collab_tasks
                SET org_id = COALESCE(NULLIF(org_id, ''), ?),
                    owner_scope_id = COALESCE(NULLIF(owner_scope_id, ''), ?)
                WHERE main_task_id = ? AND task_id = main_task_id
                """,
                (org_id, owner_scope_id, tid),
            )
        conn.commit()

    from evoflow.persistence.db import run_db_with_retry

    run_db_with_retry(_write)


def task_visible_to_principal(
    task_id: str,
    *,
    is_admin: bool = False,
    personal_scope: str | None = None,
    org_scope: str | None = None,
    principal: Any = None,
) -> bool:
    from evoflow.authz.resource_visibility import owner_scope_visible_to_principal

    _org, owner, _created = get_root_task_owner_scope(task_id)
    return owner_scope_visible_to_principal(
        owner,
        principal,
        is_admin=is_admin,
        personal_scope=personal_scope,
        org_scope=org_scope,
    )


def list_subtask_summaries(
    *,
    main_task_id: str | None = None,
) -> list[dict[str, Any]]:
    """List collab subtasks with one SQL query (no full-bundle hydrate).

    Used by agent/CLI ``list_tasks(include_subtasks=True)`` so patrols do not
    N× ``load_project`` and stall on path absolutization.
    """
    from evoflow.persistence.db import run_db_read

    cols = """
        main_task_id, parent_task_id, subtask_id, name, description, status, parent_id,
        assigned_to, error_text, created_at, started_at, completed_at, progress,
        thread_id, extra_json, sort_order, updated_at
    """
    mid = str(main_task_id or "").strip()

    def _query(conn: Any) -> list[dict[str, Any]]:
        if mid:
            rows = conn.execute(
                f"""
                SELECT {cols}
                FROM evoflow_collab_subtasks
                WHERE main_task_id = ?
                ORDER BY COALESCE(updated_at, created_at, '') DESC
                """,
                (mid,),
            ).fetchall()
        else:
            rows = conn.execute(
                f"""
                SELECT {cols}
                FROM evoflow_collab_subtasks
                ORDER BY COALESCE(updated_at, created_at, '') DESC
                """
            ).fetchall()
        return [m.collab_subtask_row_to_summary(_row_dict(r)) for r in rows]

    return run_db_read(_query)


def delete_task_detail_children(conn: Any, main_task_id: str, agent_id: str, task_id: str) -> None:
    _safe_exec(
        conn,
        """
        DELETE FROM evoflow_task_detail_facts
        WHERE main_task_id = ? AND agent_id = ? AND task_id = ?
        """,
        (main_task_id, agent_id, task_id),
    )


def save_task_detail(main_task_id: str, agent_id: str, task_id: str, document: dict[str, Any]) -> None:
    from evoflow.persistence.db import run_db_with_retry

    def _do_save() -> None:
        conn = get_db()
        now = utc_now_iso_z()
        row, facts = m.detail_to_rows(document)
        row["updated_at"] = now
        delete_task_detail_children(conn, main_task_id, agent_id, task_id)
        conn.execute(
            """
            INSERT INTO evoflow_task_details (
                main_task_id, agent_id, task_id, status, output_summary, current_step, progress,
                created_at, updated_at, completed_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(main_task_id, agent_id, task_id) DO UPDATE SET
                status = excluded.status,
                output_summary = excluded.output_summary,
                current_step = excluded.current_step,
                progress = excluded.progress,
                created_at = excluded.created_at,
                updated_at = excluded.updated_at,
                completed_at = excluded.completed_at
            """,
            (
                main_task_id,
                agent_id,
                task_id,
                row["status"],
                row["output_summary"],
                row["current_step"],
                row["progress"],
                row.get("created_at") or now,
                row["updated_at"],
                row.get("completed_at"),
            ),
        )
        for f in facts:
            conn.execute(
                """
                INSERT INTO evoflow_task_detail_facts (
                    main_task_id, agent_id, task_id, fact_id, content, category, confidence,
                    source_message, sort_order, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    f["main_task_id"],
                    f["agent_id"],
                    f["task_id"],
                    f["fact_id"],
                    f["content"],
                    f["category"],
                    f["confidence"],
                    f.get("source_message"),
                    f["sort_order"],
                    now,
                ),
            )
        conn.commit()

    run_db_with_retry(_do_save)


def load_task_detail(main_task_id: str, agent_id: str, task_id: str) -> dict[str, Any] | None:
    conn = get_db()
    row = conn.execute(
        """
        SELECT main_task_id, agent_id, task_id, status, output_summary, current_step, progress,
               created_at, updated_at, completed_at
        FROM evoflow_task_details
        WHERE main_task_id = ? AND agent_id = ? AND task_id = ?
        """,
        (main_task_id, agent_id, task_id),
    ).fetchone()
    if not row:
        return None
    facts = [
        _row_dict(r)
        for r in conn.execute(
            """
            SELECT * FROM evoflow_task_detail_facts
            WHERE main_task_id = ? AND agent_id = ? AND task_id = ?
            ORDER BY sort_order
            """,
            (main_task_id, agent_id, task_id),
        ).fetchall()
    ]
    return m.rows_to_detail(_row_dict(row), facts)


def list_task_details_for_agent(main_task_id: str, agent_id: str) -> list[dict[str, Any]]:
    conn = get_db()
    rows = conn.execute(
        """
        SELECT main_task_id, agent_id, task_id FROM evoflow_task_details
        WHERE main_task_id = ? AND agent_id = ? AND task_id != '__index__'
        """,
        (main_task_id, agent_id),
    ).fetchall()
    out: list[dict[str, Any]] = []
    for r in rows:
        doc = load_task_detail(str(r[0]), str(r[1]), str(r[2]))
        if doc:
            out.append(doc)
    return out


def delete_task_details_for_main(main_task_id: str, conn: Any | None = None) -> None:
    own = conn is None
    db = conn or get_db()
    _safe_exec(db, "DELETE FROM evoflow_task_detail_facts WHERE main_task_id = ?", (main_task_id,))
    _safe_exec(db, "DELETE FROM evoflow_task_details WHERE main_task_id = ?", (main_task_id,))
    if own:
        db.commit()


def save_task_global_facts(main_task_id: str, document: dict[str, Any]) -> None:
    from evoflow.persistence.db import run_db_with_retry

    def _do_save() -> None:
        conn = get_db()
        now = utc_now_iso_z()
        header, facts = m.global_facts_to_rows(document)
        header["last_updated"] = now
        conn.execute("DELETE FROM evoflow_task_global_fact_rows WHERE main_task_id = ?", (main_task_id,))
        conn.execute(
            """
            INSERT INTO evoflow_task_global_facts (main_task_id, version, last_updated, updated_at)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(main_task_id) DO UPDATE SET
                version = excluded.version,
                last_updated = excluded.last_updated,
                updated_at = excluded.updated_at
            """,
            (main_task_id, header["version"], header["last_updated"], now),
        )
        for f in facts:
            conn.execute(
                """
                INSERT INTO evoflow_task_global_fact_rows (
                    main_task_id, fact_id, content, category, confidence, source_message, sort_order,
                    updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    f["main_task_id"],
                    f["fact_id"],
                    f["content"],
                    f["category"],
                    f["confidence"],
                    f.get("source_message"),
                    f["sort_order"],
                    now,
                ),
            )
        conn.commit()

    run_db_with_retry(_do_save)


def load_task_global_facts(main_task_id: str) -> dict[str, Any] | None:
    conn = get_db()
    row = conn.execute(
        "SELECT main_task_id, version, last_updated FROM evoflow_task_global_facts WHERE main_task_id = ?",
        (main_task_id,),
    ).fetchone()
    if not row:
        return None
    facts = [
        _row_dict(r)
        for r in conn.execute(
            "SELECT * FROM evoflow_task_global_fact_rows WHERE main_task_id = ? ORDER BY sort_order",
            (main_task_id,),
        ).fetchall()
    ]
    return m.rows_to_global_facts(_row_dict(row), facts)


def delete_task_global_facts(main_task_id: str, conn: Any | None = None) -> None:
    own = conn is None
    db = conn or get_db()
    _safe_exec(db, "DELETE FROM evoflow_task_global_fact_rows WHERE main_task_id = ?", (main_task_id,))
    _safe_exec(db, "DELETE FROM evoflow_task_global_facts WHERE main_task_id = ?", (main_task_id,))
    if own:
        db.commit()


def delete_thread_collab_children(conn: Any, thread_id: str) -> None:
    conn.execute("DELETE FROM evoflow_thread_collab_scenarios WHERE thread_id = ?", (thread_id,))
    conn.execute("DELETE FROM evoflow_thread_collab_sidebar_steps WHERE thread_id = ?", (thread_id,))


def save_thread_collab(thread_id: str, state: dict[str, Any]) -> None:
    from evoflow.persistence.db import run_db_with_retry

    def _do_save() -> None:
        conn = get_db()
        now = utc_now_iso_z()
        header, scenarios, steps = m.collab_to_rows(state)
        header["thread_id"] = thread_id
        header["updated_at"] = now
        delete_thread_collab_children(conn, thread_id)
        conn.execute(
            """
            INSERT INTO evoflow_thread_collab (thread_id, collab_phase, bound_task_id, updated_at)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(thread_id) DO UPDATE SET
                collab_phase = excluded.collab_phase,
                bound_task_id = excluded.bound_task_id,
                updated_at = excluded.updated_at
            """,
            (thread_id, header["collab_phase"], header.get("bound_task_id"), header["updated_at"]),
        )
        for s in scenarios:
            conn.execute(
                """
                INSERT INTO evoflow_thread_collab_scenarios (
                    thread_id, scenario_key, sort_order, updated_at
                ) VALUES (?, ?, ?, ?)
                """,
                (thread_id, s["scenario_key"], s["sort_order"], now),
            )
        for s in steps:
            conn.execute(
                """
                INSERT INTO evoflow_thread_collab_sidebar_steps (
                    thread_id, sort_order, step_json, updated_at
                ) VALUES (?, ?, ?, ?)
                """,
                (thread_id, s["sort_order"], s["step_json"], now),
            )
        conn.commit()

    run_db_with_retry(_do_save)


def load_thread_collab(thread_id: str) -> dict[str, Any] | None:
    conn = get_db()
    row = conn.execute(
        "SELECT thread_id, collab_phase, bound_task_id, updated_at FROM evoflow_thread_collab WHERE thread_id = ?",
        (thread_id,),
    ).fetchone()
    if not row:
        return None
    header = _row_dict(row)
    scenarios = [
        _row_dict(r)
        for r in conn.execute(
            "SELECT scenario_key, sort_order FROM evoflow_thread_collab_scenarios WHERE thread_id = ? ORDER BY sort_order",
            (thread_id,),
        ).fetchall()
    ]
    steps = [
        _row_dict(r)
        for r in conn.execute(
            "SELECT sort_order, step_json FROM evoflow_thread_collab_sidebar_steps WHERE thread_id = ? ORDER BY sort_order",
            (thread_id,),
        ).fetchall()
    ]
    return m.rows_to_collab(header, scenarios, steps)


def delete_thread_collab(thread_id: str) -> None:
    conn = get_db()
    delete_thread_collab_children(conn, thread_id)
    conn.execute("DELETE FROM evoflow_thread_collab WHERE thread_id = ?", (thread_id,))
    conn.commit()


def save_mission_runtime(
    thread_id: str,
    *,
    mode: str,
    drift_count: int,
    chat_downgrade_streak: int,
) -> None:
    now = utc_now_iso_z()
    get_db().execute(
        """
        INSERT INTO evoflow_mission_runtime (thread_id, mode, drift_count, chat_downgrade_streak, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(thread_id) DO UPDATE SET
            mode = excluded.mode,
            drift_count = excluded.drift_count,
            chat_downgrade_streak = excluded.chat_downgrade_streak,
            updated_at = excluded.updated_at
        """,
        (thread_id, mode, max(0, int(drift_count)), max(0, int(chat_downgrade_streak)), now),
    )
    get_db().commit()


def _thread_root_plan_score(row: dict[str, Any], *, prefer_task_id: str = "") -> int:
    """Prefer root task rows with bound plan fields (mirrors tasks router scoring)."""
    if not row:
        return -1
    s = 0
    goal = str(row.get("plan_goal") or "").strip()
    if goal:
        s += 20
    steps = row.get("plan_steps")
    if not isinstance(steps, list):
        raw = row.get("plan_steps_json")
        if isinstance(raw, str) and raw.strip():
            try:
                import json

                loaded = json.loads(raw)
                steps = loaded if isinstance(loaded, list) else []
            except json.JSONDecodeError:
                steps = []
        else:
            steps = []
    if isinstance(steps, list) and steps:
        s += 10
    if goal and isinstance(steps, list) and steps:
        s += 100
    tid = str(row.get("task_id") or row.get("id") or "").strip()
    prefer = str(prefer_task_id or "").strip()
    if tid and prefer and tid == prefer:
        s += 8
    if str(row.get("plan_bound_at") or "").strip():
        s += 4
    if row.get("execution_authorized"):
        s += 1
    st = str(row.get("status") or "").strip().lower()
    if st in {"planned", "planning"}:
        s += 2
    return s


def find_root_task_by_thread_id(
    thread_id: str,
    *,
    prefer_task_id: str = "",
) -> dict[str, Any] | None:
    """Load the best root task row for a thread directly from SQLite (bypasses in-process project cache).

    Agent workers and the Gateway API run in separate processes; ``ProjectStorage`` may hold a stale
    placeholder snapshot while ``evoflow_collab_tasks`` already has bound plan columns.
    """
    want = str(thread_id or "").strip()
    if not want:
        return None
    prefer = str(prefer_task_id or "").strip().lower()
    conn = get_db()
    root_rows = [
        _row_dict(r)
        for r in conn.execute(
            """
            SELECT main_task_id, task_id, status, plan_goal, plan_steps_json, plan_bound_at,
                   execution_authorized, updated_at
            FROM evoflow_collab_tasks
            WHERE task_id = main_task_id
              AND LOWER(TRIM(COALESCE(thread_id, ''))) = LOWER(?)
            """,
            (want,),
        ).fetchall()
    ]
    if not root_rows:
        return None
    root_rows.sort(
        key=lambda r: (
            _thread_root_plan_score(r, prefer_task_id=prefer),
            str(r.get("updated_at") or ""),
        ),
        reverse=True,
    )
    main_task_id = str(root_rows[0].get("main_task_id") or root_rows[0].get("task_id") or "").strip()
    if not main_task_id:
        return None
    bundle = load_task_bundle(main_task_id)
    if not bundle:
        return None
    for task in bundle.get("tasks") or []:
        if not isinstance(task, dict):
            continue
        tid = str(task.get("id") or "").strip()
        if tid == main_task_id:
            return task
    tasks = bundle.get("tasks") or []
    return tasks[0] if tasks else None


def _root_task_from_main_id(main_task_id: str) -> dict[str, Any] | None:
    mid = str(main_task_id or "").strip()
    if not mid:
        return None
    bundle = load_task_bundle(mid)
    if not bundle:
        return None
    for task in bundle.get("tasks") or []:
        if not isinstance(task, dict):
            continue
        tid = str(task.get("id") or "").strip()
        if tid == mid:
            return task
    tasks = bundle.get("tasks") or []
    return tasks[0] if tasks else None


def find_root_task_by_session_key(
    session_key: str,
    *,
    prefer_task_id: str = "",
) -> dict[str, Any] | None:
    """Resolve the collaborative main task for a chat session (survives LangGraph thread rotation)."""
    sk = str(session_key or "").strip()
    if not sk:
        return None
    prefer = str(prefer_task_id or "").strip()
    if prefer:
        found = _root_task_from_main_id(prefer)
        if found:
            return found

    row = get_db().execute(
        """
        SELECT collab_task_id FROM evoflow_chat_sessions
        WHERE session_key = ? AND is_deleted = 0
        LIMIT 1
        """,
        (sk,),
    ).fetchone()
    session_task_id = str(row[0] or "").strip() if row else ""
    if session_task_id:
        found = _root_task_from_main_id(session_task_id)
        if found:
            return found

    thread_rows = get_db().execute(
        """
        SELECT DISTINCT thread_id FROM evoflow_chat_messages
        WHERE session_key = ? AND TRIM(COALESCE(thread_id, '')) != ''
        ORDER BY seq DESC
        LIMIT 16
        """,
        (sk,),
    ).fetchall()
    seen_tasks: set[str] = set()
    for tr in thread_rows:
        tid = str(tr[0] or "").strip()
        if not tid:
            continue
        collab = load_thread_collab(tid)
        bound = str((collab or {}).get("bound_task_id") or "").strip()
        if bound and bound not in seen_tasks:
            seen_tasks.add(bound)
            found = _root_task_from_main_id(bound)
            if found:
                return found
        found = find_root_task_by_thread_id(tid, prefer_task_id=prefer)
        if found:
            return found
    return None


def load_mission_runtime(thread_id: str) -> dict[str, Any] | None:
    row = (
        get_db()
        .execute(
            """
        SELECT thread_id, mode, drift_count, chat_downgrade_streak, updated_at
        FROM evoflow_mission_runtime WHERE thread_id = ?
        """,
            (thread_id,),
        )
        .fetchone()
    )
    if not row:
        return None
    return _row_dict(row)


def delete_mission_runtime(thread_id: str) -> None:
    get_db().execute("DELETE FROM evoflow_mission_runtime WHERE thread_id = ?", (thread_id,))
    get_db().commit()
