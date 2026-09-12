"""Application definition and run instance persistence."""

from __future__ import annotations

import json
from typing import Any

from evoflow.persistence.db import get_db, run_db_with_retry
from evoflow.timeutil import utc_now_iso_z


def _json_dump(value: Any, *, default: str = "[]") -> str:
    """Serialize value to JSON string.

    Args:
        default: Fallback when value is None (caller picks ``"[]"`` for list
                 fields like parameters/steps/tags, or ``"{}"`` for dict fields).
    """
    if value is None:
        return default
    if isinstance(value, str):
        return value
    return json.dumps(value, ensure_ascii=False)


def _json_load(value: str | None) -> Any:
    if value is None or value == "":
        return []
    if isinstance(value, (list, dict)):
        return value
    try:
        return json.loads(value)
    except Exception:
        return []


def _normalize_for_storage(document: dict[str, Any]) -> dict[str, Any]:
    from evoflow.collab.app_schema import normalize_app_document

    return normalize_app_document(document)


# ───────────────────────────────────────── App CRUD ─────────────────────────────────────────


def _snapshot_from_document(document: dict[str, Any]) -> dict[str, Any]:
    """Immutable definition slice stored in evoflow_app_revisions."""
    return {
        "name": document.get("name", ""),
        "description": document.get("description", ""),
        "icon": document.get("icon", ""),
        "category": document.get("category", "general"),
        "parameters": document.get("parameters", []),
        "steps": document.get("steps", []),
        "canvas": document.get("canvas", {}),
        "goal_template": document.get("goal_template", ""),
        "validation_template": document.get("validation_template", []),
        "flowchart_mermaid": document.get("flowchart_mermaid", ""),
        "execution_mode": document.get("execution_mode", "workflow"),
        "auto_run": bool(document.get("auto_run")),
        "tags": document.get("tags", []),
        "status": document.get("status", "draft"),
        "answer_from_ref": document.get("answer_from_ref") or "",
        "final_rollup": document.get("final_rollup", "auto"),
        "final_rollup_agent": document.get("final_rollup_agent", ""),
        "final_rollup_instruction": document.get("final_rollup_instruction", ""),
    }


def save_revision(
    app_id: str,
    version: int,
    document: dict[str, Any],
    *,
    note: str = "",
) -> None:
    """Insert or replace a revision snapshot for (app_id, version)."""

    def _do() -> None:
        conn = get_db()
        now = utc_now_iso_z()
        snap = _snapshot_from_document(document)
        conn.execute(
            """
INSERT OR REPLACE INTO evoflow_app_revisions (
    app_id, version, snapshot_json, status, note, created_at
) VALUES (?, ?, ?, ?, ?, ?)
""",
            (
                app_id,
                int(version),
                _json_dump(snap),
                snap.get("status", "draft"),
                note or "",
                now,
            ),
        )
        conn.commit()

    run_db_with_retry(_do)


def load_revision(app_id: str, version: int) -> dict[str, Any] | None:
    conn = get_db()
    cur = conn.execute(
        "SELECT * FROM evoflow_app_revisions WHERE app_id = ? AND version = ?",
        (app_id, int(version)),
    )
    row = cur.fetchone()
    if row is None:
        return None
    cols = [d[0] for d in cur.description]
    doc = dict(zip(cols, row, strict=False))
    snap = _json_load(doc.pop("snapshot_json", "{}"))
    doc["snapshot"] = snap if isinstance(snap, dict) else {}
    return doc


def list_revisions(app_id: str, limit: int = 50) -> list[dict[str, Any]]:
    conn = get_db()
    cur = conn.execute(
        """
SELECT app_id, version, status, note, created_at
FROM evoflow_app_revisions
WHERE app_id = ?
ORDER BY version DESC
LIMIT ?
""",
        (app_id, limit),
    )
    cols = [d[0] for d in cur.description]
    return [dict(zip(cols, row, strict=False)) for row in cur.fetchall()]


_RESTORE_SNAPSHOT_KEYS = (
    "name",
    "description",
    "icon",
    "category",
    "parameters",
    "steps",
    "canvas",
    "goal_template",
    "validation_template",
    "flowchart_mermaid",
    "execution_mode",
    "auto_run",
    "tags",
    "answer_from_ref",
    "final_rollup",
    "final_rollup_agent",
    "final_rollup_instruction",
)


def restore_app_from_revision(app_id: str, version: int, *, as_draft: bool = True) -> dict[str, Any]:
    """Restore definition fields from an immutable revision into a new current version.

    Old revision rows are never mutated. Returns the updated app document.
    """
    rev = load_revision(app_id, version)
    if rev is None:
        raise ValueError(f"Revision not found: {app_id}@v{version}")
    snap = rev.get("snapshot")
    if not isinstance(snap, dict):
        raise ValueError(f"Revision snapshot invalid: {app_id}@v{version}")

    current = load_app(app_id)
    if current is None:
        raise ValueError(f"Application not found: {app_id}")

    merged = dict(current)
    for key in _RESTORE_SNAPSHOT_KEYS:
        if key in snap:
            merged[key] = snap[key]
    merged["version"] = int(current.get("version") or 1) + 1
    if as_draft:
        merged["status"] = "draft"
    elif "status" in snap:
        merged["status"] = snap["status"]

    save_app(app_id, merged)
    # Re-stamp the new revision note (save_app wrote a generic "save" note)
    save_revision(
        app_id,
        int(merged["version"]),
        merged,
        note=f"restore from v{int(version)}",
    )
    loaded = load_app(app_id)
    if loaded is None:
        raise ValueError(f"Failed to reload application after restore: {app_id}")
    return loaded


def save_app(app_id: str, document: dict[str, Any]) -> None:
    """Save or update an application definition (INSERT OR REPLACE) + revision snapshot."""

    def _do_save() -> None:
        conn = get_db()
        now = utc_now_iso_z()
        # Preserve ownership columns across REPLACE (REPLACE clears omitted cols).
        prev_org = prev_owner = prev_created = None
        cols = {str(r[1]) for r in conn.execute("PRAGMA table_info(evoflow_apps)").fetchall()}
        if "owner_scope_id" in cols:
            prev = conn.execute(
                "SELECT org_id, owner_scope_id, created_by FROM evoflow_apps WHERE id = ?"
                if "created_by" in cols
                else "SELECT org_id, owner_scope_id FROM evoflow_apps WHERE id = ?",
                (app_id,),
            ).fetchone()
            if prev:
                prev_org = str(prev[0] or "").strip() or None
                prev_owner = str(prev[1] or "").strip() or None
                if "created_by" in cols and len(prev) > 2:
                    prev_created = str(prev[2] or "").strip() or None
        document_n = _normalize_for_storage(document)
        canvas = document_n.get("canvas")
        if not isinstance(canvas, dict):
            canvas = {}
        version = int(document_n.get("version") or 1)
        conn.execute(
            """
INSERT OR REPLACE INTO evoflow_apps (
    id, name, description, icon, category,
    parameters_json, steps_json, goal_template, validation_template_json, flowchart_mermaid,
    execution_mode, auto_run, source, source_task_id, version,
    status, tags_json, created_at, updated_at, usage_count, last_used_at, canvas_json,
    answer_from_ref, final_rollup, final_rollup_agent, final_rollup_instruction
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
""",
            (
                app_id,
                document_n.get("name", ""),
                document_n.get("description", ""),
                document_n.get("icon", ""),
                document_n.get("category", "general"),
                _json_dump(document_n.get("parameters", [])),
                _json_dump(document_n.get("steps", [])),
                document_n.get("goal_template", ""),
                _json_dump(document_n.get("validation_template", [])),
                document_n.get("flowchart_mermaid", ""),
                document_n.get("execution_mode", "workflow"),
                1 if document_n.get("auto_run") else 0,
                document_n.get("source", "generated"),
                document_n.get("source_task_id"),
                version,
                document_n.get("status", "draft"),
                _json_dump(document_n.get("tags", [])),
                document_n.get("created_at") or now,
                now,
                document_n.get("usage_count", 0),
                document_n.get("last_used_at"),
                _json_dump(canvas, default="{}"),
                document_n.get("answer_from_ref", ""),
                document_n.get("final_rollup", "off"),
                document_n.get("final_rollup_agent", ""),
                document_n.get("final_rollup_instruction", ""),
            ),
        )
        if prev_owner and "owner_scope_id" in cols:
            if "created_by" in cols:
                conn.execute(
                    """
                    UPDATE evoflow_apps
                    SET org_id = ?, owner_scope_id = ?, created_by = COALESCE(NULLIF(created_by, ''), ?)
                    WHERE id = ?
                    """,
                    (prev_org or "", prev_owner, prev_created or "", app_id),
                )
            else:
                conn.execute(
                    """
                    UPDATE evoflow_apps SET org_id = ?, owner_scope_id = ? WHERE id = ?
                    """,
                    (prev_org or "", prev_owner, app_id),
                )
        # Revision inside same connection for consistency (table may be missing on very old DBs pre-migrate)
        try:
            snap = _snapshot_from_document(document_n)
            note = "publish" if snap.get("status") == "published" else "save"
            conn.execute(
                """
INSERT OR REPLACE INTO evoflow_app_revisions (
    app_id, version, snapshot_json, status, note, created_at
) VALUES (?, ?, ?, ?, ?, ?)
""",
                (
                    app_id,
                    version,
                    _json_dump(snap),
                    snap.get("status", "draft"),
                    note,
                    now,
                ),
            )
        except Exception as rev_err:
            import logging
            logging.getLogger("evoflow.app_repositories").warning(
                "Failed to write app revision for %s v%s: %s", app_id, version, rev_err
            )
        conn.commit()
    run_db_with_retry(_do_save)


def set_app_owner_scope(
    app_id: str,
    *,
    org_id: str,
    owner_scope_id: str,
    created_by: str | None = None,
) -> None:
    """Stamp ownership after save (INSERT OR REPLACE clears ACL cols)."""
    aid = str(app_id or "").strip()
    if not aid:
        return

    def _write() -> None:
        conn = get_db()
        cols = {str(r[1]) for r in conn.execute("PRAGMA table_info(evoflow_apps)").fetchall()}
        if "owner_scope_id" not in cols:
            return
        if "created_by" in cols and created_by:
            conn.execute(
                """
                UPDATE evoflow_apps
                SET org_id = COALESCE(NULLIF(org_id, ''), ?),
                    owner_scope_id = COALESCE(NULLIF(owner_scope_id, ''), ?),
                    created_by = COALESCE(NULLIF(created_by, ''), ?)
                WHERE id = ?
                """,
                (org_id, owner_scope_id, created_by, aid),
            )
        else:
            conn.execute(
                """
                UPDATE evoflow_apps
                SET org_id = COALESCE(NULLIF(org_id, ''), ?),
                    owner_scope_id = COALESCE(NULLIF(owner_scope_id, ''), ?)
                WHERE id = ?
                """,
                (org_id, owner_scope_id, aid),
            )
        conn.commit()

    run_db_with_retry(_write)


def get_app_owner_scope(app_id: str) -> tuple[str | None, str | None]:
    aid = str(app_id or "").strip()
    if not aid:
        return None, None
    cols = {str(r[1]) for r in get_db().execute("PRAGMA table_info(evoflow_apps)").fetchall()}
    if "owner_scope_id" not in cols:
        return None, None
    row = get_db().execute(
        "SELECT org_id, owner_scope_id FROM evoflow_apps WHERE id = ?",
        (aid,),
    ).fetchone()
    if not row:
        return None, None
    return (str(row[0] or "").strip() or None, str(row[1] or "").strip() or None)


def app_visible_to_principal(
    app_id: str,
    principal_id: str,
    *,
    is_admin: bool = False,
    personal_scope: str | None = None,
    org_scope: str | None = None,
    principal: Any = None,
) -> bool:
    from evoflow.authz.resource_visibility import owner_scope_visible_to_principal

    _org, owner = get_app_owner_scope(app_id)
    return owner_scope_visible_to_principal(
        owner,
        principal,
        is_admin=is_admin,
        personal_scope=personal_scope,
        org_scope=org_scope,
    )


def load_app(app_id: str) -> dict[str, Any] | None:
    """Load an application definition by ID."""
    conn = get_db()
    cur = conn.execute("SELECT * FROM evoflow_apps WHERE id = ?", (app_id,))
    row = cur.fetchone()
    if row is None:
        return None
    cols = [d[0] for d in cur.description]
    doc = dict(zip(cols, row, strict=False))
    # Deserialize JSON fields
    doc["parameters"] = _json_load(doc.pop("parameters_json", "[]"))
    doc["steps"] = _json_load(doc.pop("steps_json", "[]"))
    doc["validation_template"] = _json_load(doc.pop("validation_template_json", "[]"))
    doc["tags"] = _json_load(doc.pop("tags_json", "[]"))
    canvas_raw = doc.pop("canvas_json", "{}")
    canvas = _json_load(canvas_raw)
    doc["canvas"] = canvas if isinstance(canvas, dict) else {}
    # Boolean conversion
    doc["auto_run"] = bool(doc.get("auto_run"))
    from evoflow.collab.app_schema import normalize_app_document

    return normalize_app_document(doc)


def list_apps(
    status: str | None = None,
    category: str | None = None,
    search: str | None = None,
    limit: int = 100,
) -> list[dict[str, Any]]:
    """List applications with optional filtering."""
    conn = get_db()
    params: list[Any] = []
    where = []
    if status:
        where.append("status = ?")
        params.append(status)
    if category:
        where.append("category = ?")
        params.append(category)
    if search:
        where.append("(name LIKE ? OR description LIKE ?)")
        params.extend([f"%{search}%", f"%{search}%"])
    where_clause = f"WHERE {' AND '.join(where)}" if where else ""
    sql = f"SELECT * FROM evoflow_apps {where_clause} ORDER BY usage_count DESC, created_at DESC LIMIT ?"
    params.append(limit)
    cur = conn.execute(sql, params)
    cols = [d[0] for d in cur.description]
    results = []
    for row in cur.fetchall():
        doc = dict(zip(cols, row, strict=False))
        doc["parameters"] = _json_load(doc.pop("parameters_json", "[]"))
        doc["steps"] = _json_load(doc.pop("steps_json", "[]"))
        doc["validation_template"] = _json_load(doc.pop("validation_template_json", "[]"))
        doc["tags"] = _json_load(doc.pop("tags_json", "[]"))
        canvas_raw = doc.pop("canvas_json", "{}")
        canvas = _json_load(canvas_raw)
        doc["canvas"] = canvas if isinstance(canvas, dict) else {}
        doc["auto_run"] = bool(doc.get("auto_run"))
        from evoflow.collab.app_schema import normalize_app_document

        results.append(normalize_app_document(doc))
    return results


def delete_app(app_id: str) -> bool:
    """Delete an application and its associated run/revision history."""
    conn = get_db()
    conn.execute("DELETE FROM evoflow_app_runs WHERE app_id = ?", (app_id,))
    try:
        conn.execute("DELETE FROM evoflow_app_revisions WHERE app_id = ?", (app_id,))
    except Exception:
        pass
    cur = conn.execute("DELETE FROM evoflow_apps WHERE id = ?", (app_id,))
    conn.commit()
    return cur.rowcount > 0


def increment_app_usage(app_id: str) -> None:
    """Increment application usage count (called on each run)."""
    now = utc_now_iso_z()
    conn = get_db()
    conn.execute(
        "UPDATE evoflow_apps SET usage_count = usage_count + 1, last_used_at = ?, updated_at = ? WHERE id = ?",
        (now, now, app_id),
    )
    conn.commit()


# ───────────────────────────────────── App Run CRUD ─────────────────────────────────────


def save_run(run_id: str, document: dict[str, Any]) -> None:
    """Save or update a run instance (execution tracker)."""

    def _do_save() -> None:
        conn = get_db()
        now = utc_now_iso_z()
        # Use INSERT OR REPLACE for atomic upsert (avoids DELETE+INSERT race)
        conn.execute(
            """
INSERT OR REPLACE INTO evoflow_app_runs (
    id, app_id, app_version, parameters_json, execution_mode, task_id, thread_id,
    status, progress, result_summary, created_at, started_at, completed_at, error
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
""",
            (
                run_id,
                document["app_id"],
                document.get("app_version", 1),
                _json_dump(document.get("parameters", {}), default="{}"),
                document.get("execution_mode", "workflow"),
                document["task_id"],
                document.get("thread_id"),
                document.get("status", "running"),
                document.get("progress", 0),
                document.get("result_summary", ""),
                document.get("created_at") or now,
                document.get("started_at"),
                document.get("completed_at"),
                document.get("error"),
            ),
        )
        conn.commit()

    run_db_with_retry(_do_save)


def load_run(run_id: str) -> dict[str, Any] | None:
    """Load a run instance by ID."""
    conn = get_db()
    cur = conn.execute("SELECT * FROM evoflow_app_runs WHERE id = ?", (run_id,))
    row = cur.fetchone()
    if row is None:
        return None
    cols = [d[0] for d in cur.description]
    doc = dict(zip(cols, row, strict=False))
    doc["parameters"] = _json_load(doc.pop("parameters_json", "{}"))
    return doc


def load_run_by_task_id(task_id: str) -> dict[str, Any] | None:
    """Load a run instance by its bound task center ID."""
    conn = get_db()
    cur = conn.execute("SELECT * FROM evoflow_app_runs WHERE task_id = ? LIMIT 1", (task_id,))
    row = cur.fetchone()
    if row is None:
        return None
    cols = [d[0] for d in cur.description]
    doc = dict(zip(cols, row, strict=False))
    doc["parameters"] = _json_load(doc.pop("parameters_json", "{}"))
    return doc


def update_run_status(run_id: str, status: str, **fields: Any) -> None:
    """Update run status (running -> completed / failed / cancelled / paused)."""
    now = utc_now_iso_z()
    conn = get_db()
    params: list[Any] = []
    set_clauses = ["status = ?"]
    params.append(status)
    # Additional fields (progress, result_summary, error, etc.)
    for key, value in fields.items():
        if key in ("progress", "result_summary", "error", "started_at", "completed_at"):
            set_clauses.append(f"{key} = ?")
            params.append(value)
    # Always touch completed_at for terminal statuses (completed/failed/cancelled)
    set_clauses.append("completed_at = COALESCE(?, completed_at)")
    params.append(fields.get("completed_at") or (now if status in ("completed", "failed", "cancelled") else None))
    params.append(run_id)
    conn.execute(f"UPDATE evoflow_app_runs SET {', '.join(set_clauses)} WHERE id = ?", params)
    conn.commit()


def count_runs(app_id: str) -> int:
    """Total run rows for an application."""
    conn = get_db()
    row = conn.execute(
        "SELECT COUNT(*) FROM evoflow_app_runs WHERE app_id = ?",
        (app_id,),
    ).fetchone()
    return int(row[0] or 0) if row else 0


def count_runs_batch(app_ids: list[str]) -> dict[str, int]:
    """Total run rows for many applications (single GROUP BY query).

    Avoids the N+1 pattern of calling ``count_runs`` per app in list views.
    """
    ids = [str(x) for x in (app_ids or []) if x]
    if not ids:
        return {}
    conn = get_db()
    placeholders = ",".join("?" for _ in ids)
    cur = conn.execute(
        f"SELECT app_id, COUNT(*) FROM evoflow_app_runs WHERE app_id IN ({placeholders}) GROUP BY app_id",
        ids,
    )
    return {str(row[0]): int(row[1] or 0) for row in cur.fetchall()}


def list_runs(app_id: str, limit: int = 20, offset: int = 0) -> list[dict[str, Any]]:
    """List run history for an application (most recent first)."""
    lim = max(1, min(int(limit or 20), 100))
    off = max(0, int(offset or 0))
    conn = get_db()
    cur = conn.execute(
        "SELECT * FROM evoflow_app_runs WHERE app_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?",
        (app_id, lim, off),
    )
    cols = [d[0] for d in cur.description]
    results = []
    for row in cur.fetchall():
        doc = dict(zip(cols, row, strict=False))
        doc["parameters"] = _json_load(doc.pop("parameters_json", "{}"))
        results.append(doc)
    return results


def list_runs_page(
    app_id: str,
    *,
    page: int = 1,
    page_size: int = 20,
) -> dict[str, Any]:
    """Paginated run history: ``items`` + ``total`` + page meta."""
    size = max(1, min(int(page_size or 20), 100))
    pg = max(1, int(page or 1))
    offset = (pg - 1) * size
    total = count_runs(app_id)
    items = list_runs(app_id, limit=size, offset=offset)
    return {
        "items": items,
        "total": total,
        "page": pg,
        "page_size": size,
        "offset": offset,
        "has_more": offset + len(items) < total,
    }
