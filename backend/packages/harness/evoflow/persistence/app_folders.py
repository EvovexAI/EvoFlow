"""Nestable folders for the workflow (apps) list."""

from __future__ import annotations

import uuid
from typing import Any

from evoflow.persistence.db import get_db, run_db_read, run_db_with_retry
from evoflow.timeutil import utc_now_iso_z

MAX_FOLDER_DEPTH = 8
_FOLDER_SELECT = (
    "folder_id, parent_id, name, sort_order, org_id, owner_scope_id, "
    "created_by, created_at, updated_at"
)


def _row_to_folder(row: Any, cols: list[str] | None = None) -> dict[str, Any]:
    if cols is None:
        return {
            "folder_id": str(row[0] or ""),
            "parent_id": str(row[1] or ""),
            "name": str(row[2] or ""),
            "sort_order": int(row[3] or 0),
            "org_id": row[4],
            "owner_scope_id": row[5],
            "created_by": row[6],
            "created_at": str(row[7] or ""),
            "updated_at": str(row[8] or ""),
        }
    return dict(zip(cols, row, strict=False))


def _normalize_parent_id(parent_id: str | None) -> str:
    return str(parent_id or "").strip()


def _folder_depth(conn: Any, folder_id: str) -> int:
    """Depth of ``folder_id`` (root children = 1). Missing id → 0."""
    fid = str(folder_id or "").strip()
    if not fid:
        return 0
    depth = 0
    seen: set[str] = set()
    cur = fid
    while cur:
        if cur in seen or depth > MAX_FOLDER_DEPTH + 2:
            break
        seen.add(cur)
        row = conn.execute(
            "SELECT parent_id FROM evoflow_app_folders WHERE folder_id = ?",
            (cur,),
        ).fetchone()
        if row is None:
            break
        depth += 1
        cur = str(row[0] or "").strip()
    return depth


def _is_descendant(conn: Any, ancestor_id: str, maybe_child_id: str) -> bool:
    """True if ``maybe_child_id`` is ``ancestor_id`` or nested under it."""
    target = str(ancestor_id or "").strip()
    cur = str(maybe_child_id or "").strip()
    if not target or not cur:
        return False
    if cur == target:
        return True
    seen: set[str] = set()
    while cur:
        if cur in seen:
            return False
        seen.add(cur)
        row = conn.execute(
            "SELECT parent_id FROM evoflow_app_folders WHERE folder_id = ?",
            (cur,),
        ).fetchone()
        if row is None:
            return False
        parent = str(row[0] or "").strip()
        if parent == target:
            return True
        cur = parent
    return False


def get_folder(folder_id: str) -> dict[str, Any] | None:
    fid = str(folder_id or "").strip()
    if not fid:
        return None

    def _query(conn: Any) -> dict[str, Any] | None:
        cur = conn.execute(
            f"SELECT {_FOLDER_SELECT} FROM evoflow_app_folders WHERE folder_id = ?",
            (fid,),
        )
        row = cur.fetchone()
        if row is None:
            return None
        cols = [d[0] for d in cur.description]
        return _row_to_folder(row, cols)

    return run_db_read(_query)


def list_folders(*, viewer: dict[str, str] | None = None) -> list[dict[str, Any]]:
    """List all workflow folders visible to ``viewer`` (None = no ACL filter)."""

    def _query(conn: Any) -> list[dict[str, Any]]:
        params: list[Any] = []
        where = ""
        if viewer:
            pid = str(viewer.get("principal_id") or "").strip()
            personal = str(viewer.get("personal_scope") or "").strip()
            org = str(viewer.get("org_scope") or "").strip()
            org_id = str(viewer.get("org_id") or "").strip()
            if pid and (personal or org):
                where = (
                    "WHERE owner_scope_id = ? OR owner_scope_id = ? OR owner_scope_id IN "
                    "(SELECT scope_id FROM evoflow_scope_members WHERE org_id = ? AND principal_id = ?) "
                    "OR owner_scope_id IS NULL OR owner_scope_id = ''"
                )
                params.extend([personal, org, org_id, pid])
            else:
                return []
        sql = (
            f"SELECT {_FOLDER_SELECT} FROM evoflow_app_folders {where} "
            "ORDER BY sort_order ASC, name ASC, folder_id ASC"
        )
        cur = conn.execute(sql, params)
        cols = [d[0] for d in cur.description]
        return [_row_to_folder(row, cols) for row in cur.fetchall()]

    return run_db_read(_query)


def create_folder(
    name: str,
    *,
    parent_id: str | None = None,
    org_id: str | None = None,
    owner_scope_id: str | None = None,
    created_by: str | None = None,
    sort_order: int = 0,
) -> dict[str, Any]:
    label = str(name or "").strip()
    if not label:
        raise ValueError("folder.name is required")

    parent = _normalize_parent_id(parent_id)
    folder_id = f"afolder_{uuid.uuid4().hex[:16]}"
    now = utc_now_iso_z()

    def _do() -> dict[str, Any]:
        conn = get_db()
        if parent:
            prow = conn.execute(
                "SELECT folder_id FROM evoflow_app_folders WHERE folder_id = ?",
                (parent,),
            ).fetchone()
            if prow is None:
                raise ValueError("parent folder not found")
            depth = _folder_depth(conn, parent)
            if depth >= MAX_FOLDER_DEPTH:
                raise ValueError(f"folder nesting exceeds max depth ({MAX_FOLDER_DEPTH})")
        conn.execute(
            """
            INSERT INTO evoflow_app_folders (
                folder_id, parent_id, name, sort_order,
                org_id, owner_scope_id, created_by, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                folder_id,
                parent,
                label,
                int(sort_order or 0),
                str(org_id or "").strip() or None,
                str(owner_scope_id or "").strip() or None,
                str(created_by or "").strip() or None,
                now,
                now,
            ),
        )
        conn.commit()
        cur = conn.execute(
            f"SELECT {_FOLDER_SELECT} FROM evoflow_app_folders WHERE folder_id = ?",
            (folder_id,),
        )
        row = cur.fetchone()
        cols = [d[0] for d in cur.description]
        return _row_to_folder(row, cols)

    return run_db_with_retry(_do)


def update_folder(
    folder_id: str,
    *,
    name: str | None = None,
    parent_id: str | None = None,
    sort_order: int | None = None,
) -> dict[str, Any]:
    fid = str(folder_id or "").strip()
    if not fid:
        raise ValueError("folder_id is required")

    def _do() -> dict[str, Any]:
        conn = get_db()
        existing = conn.execute(
            f"SELECT {_FOLDER_SELECT} FROM evoflow_app_folders WHERE folder_id = ?",
            (fid,),
        ).fetchone()
        if existing is None:
            raise LookupError(f"folder not found: {fid}")

        new_name = str(existing[2] or "")
        new_parent = str(existing[1] or "")
        new_sort = int(existing[3] or 0)

        if name is not None:
            label = str(name).strip()
            if not label:
                raise ValueError("folder.name is required")
            new_name = label

        if parent_id is not None:
            new_parent = _normalize_parent_id(parent_id)
            if new_parent == fid:
                raise ValueError("cannot move folder into itself")
            if new_parent:
                prow = conn.execute(
                    "SELECT folder_id FROM evoflow_app_folders WHERE folder_id = ?",
                    (new_parent,),
                ).fetchone()
                if prow is None:
                    raise ValueError("parent folder not found")
                if _is_descendant(conn, fid, new_parent):
                    raise ValueError("cannot move folder under its descendant")
                # Depth of moved subtree: parent depth + 1 + max relative child depth
                parent_depth = _folder_depth(conn, new_parent)
                subtree_extra = _max_relative_depth(conn, fid)
                if parent_depth + 1 + subtree_extra > MAX_FOLDER_DEPTH:
                    raise ValueError(f"folder nesting exceeds max depth ({MAX_FOLDER_DEPTH})")

        if sort_order is not None:
            new_sort = int(sort_order)

        now = utc_now_iso_z()
        conn.execute(
            """
            UPDATE evoflow_app_folders
            SET name = ?, parent_id = ?, sort_order = ?, updated_at = ?
            WHERE folder_id = ?
            """,
            (new_name, new_parent, new_sort, now, fid),
        )
        conn.commit()
        cur = conn.execute(
            f"SELECT {_FOLDER_SELECT} FROM evoflow_app_folders WHERE folder_id = ?",
            (fid,),
        )
        row = cur.fetchone()
        cols = [d[0] for d in cur.description]
        return _row_to_folder(row, cols)

    return run_db_with_retry(_do)


def _max_relative_depth(conn: Any, root_id: str) -> int:
    """Max depth of descendants relative to ``root_id`` (0 if no children)."""
    children = conn.execute(
        "SELECT folder_id FROM evoflow_app_folders WHERE parent_id = ?",
        (root_id,),
    ).fetchall()
    if not children:
        return 0
    return 1 + max(_max_relative_depth(conn, str(c[0])) for c in children)


def delete_folder(folder_id: str) -> bool:
    """Delete folder; refuse if it has subfolders; move apps to parent."""
    fid = str(folder_id or "").strip()
    if not fid:
        raise ValueError("folder_id is required")

    def _do() -> bool:
        conn = get_db()
        row = conn.execute(
            "SELECT parent_id FROM evoflow_app_folders WHERE folder_id = ?",
            (fid,),
        ).fetchone()
        if row is None:
            return False
        parent = str(row[0] or "").strip()
        child = conn.execute(
            "SELECT 1 FROM evoflow_app_folders WHERE parent_id = ? LIMIT 1",
            (fid,),
        ).fetchone()
        if child:
            raise ValueError("folder is not empty (has subfolders)")

        # Move contained apps up to parent (root = '')
        try:
            cols = {str(r[1]) for r in conn.execute("PRAGMA table_info(evoflow_apps)").fetchall()}
            if "folder_id" in cols:
                conn.execute(
                    "UPDATE evoflow_apps SET folder_id = ? WHERE folder_id = ?",
                    (parent, fid),
                )
        except Exception:
            pass

        cur = conn.execute("DELETE FROM evoflow_app_folders WHERE folder_id = ?", (fid,))
        conn.commit()
        return cur.rowcount > 0

    return run_db_with_retry(_do)


def set_folder_owner_scope(
    folder_id: str,
    *,
    org_id: str,
    owner_scope_id: str,
    created_by: str | None = None,
) -> None:
    fid = str(folder_id or "").strip()
    if not fid:
        return

    def _write() -> None:
        conn = get_db()
        if created_by:
            conn.execute(
                """
                UPDATE evoflow_app_folders
                SET org_id = COALESCE(NULLIF(org_id, ''), ?),
                    owner_scope_id = COALESCE(NULLIF(owner_scope_id, ''), ?),
                    created_by = COALESCE(NULLIF(created_by, ''), ?)
                WHERE folder_id = ?
                """,
                (org_id, owner_scope_id, created_by, fid),
            )
        else:
            conn.execute(
                """
                UPDATE evoflow_app_folders
                SET org_id = COALESCE(NULLIF(org_id, ''), ?),
                    owner_scope_id = COALESCE(NULLIF(owner_scope_id, ''), ?)
                WHERE folder_id = ?
                """,
                (org_id, owner_scope_id, fid),
            )
        conn.commit()

    run_db_with_retry(_write)


def folder_visible_to_principal(
    folder: dict[str, Any] | None,
    *,
    principal_id: str,
    is_admin: bool,
    personal_scope: str,
    org_scope: str,
    org_id: str,
) -> bool:
    if is_admin:
        return True
    if not isinstance(folder, dict):
        return False
    owner = str(folder.get("owner_scope_id") or "").strip()
    if not owner:
        # Legacy / unstamped: visible (desktop single-user); list SQL also allows empty.
        return True
    if owner == personal_scope or owner == org_scope:
        return True
    pid = str(principal_id or "").strip()
    oid = str(org_id or "").strip()
    if not pid or not oid:
        return False

    def _query(conn: Any) -> bool:
        row = conn.execute(
            """
            SELECT 1 FROM evoflow_scope_members
            WHERE org_id = ? AND principal_id = ? AND scope_id = ?
            LIMIT 1
            """,
            (oid, pid, owner),
        ).fetchone()
        return row is not None

    return bool(run_db_read(_query))
