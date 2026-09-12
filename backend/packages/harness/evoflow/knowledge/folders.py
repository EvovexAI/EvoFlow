"""Wiki-style folder tree for knowledge bases."""

from __future__ import annotations

import uuid
from typing import Any

from evoflow.persistence.db import db_connection_lock, get_db
from evoflow.timeutil import utc_now_iso_z

ROOT_NAME = "全部文档"


def root_folder_id(dataset_id: str) -> str:
    return f"folder_root_{dataset_id}"


def ensure_root_folder(dataset_id: str) -> str:
    fid = root_folder_id(dataset_id)
    now = utc_now_iso_z()

    with db_connection_lock():
        conn = get_db()
        row = conn.execute(
            "SELECT folder_id FROM evoflow_kb_folder WHERE folder_id = ?",
            (fid,),
        ).fetchone()
        if row:
            return fid
        conn.execute(
            """
            INSERT INTO evoflow_kb_folder (folder_id, dataset_id, parent_id, name, sort_order, created_at, updated_at)
            VALUES (?, ?, NULL, ?, 0, ?, ?)
            """,
            (fid, dataset_id, ROOT_NAME, now, now),
        )
        conn.commit()
    return fid


def list_folders(dataset_id: str) -> list[dict[str, Any]]:
    ensure_root_folder(dataset_id)
    with db_connection_lock():
        conn = get_db()
        rows = conn.execute(
            """
            SELECT folder_id, dataset_id, parent_id, name, sort_order, created_at, updated_at
            FROM evoflow_kb_folder
            WHERE dataset_id = ?
            ORDER BY sort_order ASC, name ASC
            """,
            (dataset_id,),
        ).fetchall()
    return [dict(r) for r in rows]


def create_folder(dataset_id: str, name: str, *, parent_id: str | None = None) -> dict[str, Any]:
    ensure_root_folder(dataset_id)
    label = str(name or "").strip()
    if not label:
        raise ValueError("folder.name is required")

    parent = parent_id or root_folder_id(dataset_id)
    folder_id = f"folder_{uuid.uuid4().hex[:16]}"
    now = utc_now_iso_z()

    with db_connection_lock():
        conn = get_db()
        parent_row = conn.execute(
            "SELECT folder_id FROM evoflow_kb_folder WHERE folder_id = ? AND dataset_id = ?",
            (parent, dataset_id),
        ).fetchone()
        if parent_row is None:
            raise ValueError("parent folder not found")

        conn.execute(
            """
            INSERT INTO evoflow_kb_folder (folder_id, dataset_id, parent_id, name, sort_order, created_at, updated_at)
            VALUES (?, ?, ?, ?, 0, ?, ?)
            """,
            (folder_id, dataset_id, parent, label, now, now),
        )
        conn.commit()

    return get_folder(folder_id)  # type: ignore[return-value]


def get_folder(folder_id: str) -> dict[str, Any] | None:
    with db_connection_lock():
        conn = get_db()
        row = conn.execute(
            """
            SELECT folder_id, dataset_id, parent_id, name, sort_order, created_at, updated_at
            FROM evoflow_kb_folder WHERE folder_id = ?
            """,
            (folder_id,),
        ).fetchone()
    return dict(row) if row else None


def rename_folder(folder_id: str, name: str) -> dict[str, Any] | None:
    if folder_id.startswith("folder_root_"):
        raise ValueError("cannot rename root folder")
    label = str(name or "").strip()
    if not label:
        raise ValueError("folder.name is required")
    now = utc_now_iso_z()
    with db_connection_lock():
        conn = get_db()
        conn.execute(
            "UPDATE evoflow_kb_folder SET name = ?, updated_at = ? WHERE folder_id = ?",
            (label, now, folder_id),
        )
        conn.commit()
    return get_folder(folder_id)


def delete_folder(folder_id: str) -> bool:
    if folder_id.startswith("folder_root_"):
        raise ValueError("cannot delete root folder")
    with db_connection_lock():
        conn = get_db()
        child = conn.execute(
            "SELECT 1 FROM evoflow_kb_folder WHERE parent_id = ? LIMIT 1",
            (folder_id,),
        ).fetchone()
        if child:
            raise ValueError("folder is not empty (has subfolders)")
        file_row = conn.execute(
            "SELECT 1 FROM evoflow_kb_source_file WHERE folder_id = ? LIMIT 1",
            (folder_id,),
        ).fetchone()
        if file_row:
            raise ValueError("folder is not empty (has files)")
        cur = conn.execute("DELETE FROM evoflow_kb_folder WHERE folder_id = ?", (folder_id,))
        conn.commit()
        return cur.rowcount > 0


def normalize_folder_id(dataset_id: str, folder_id: str | None) -> str:
    if folder_id and str(folder_id).strip():
        return str(folder_id).strip()
    return ensure_root_folder(dataset_id)


def find_folder_by_parent_and_name(dataset_id: str, parent_id: str, name: str) -> dict[str, Any] | None:
    label = str(name or "").strip()
    if not label:
        return None
    with db_connection_lock():
        conn = get_db()
        row = conn.execute(
            """
            SELECT folder_id, dataset_id, parent_id, name, sort_order, created_at, updated_at
            FROM evoflow_kb_folder
            WHERE dataset_id = ? AND parent_id = ? AND name = ?
            """,
            (dataset_id, parent_id, label),
        ).fetchone()
    return dict(row) if row else None


def ensure_folder_chain(dataset_id: str, parts: list[str]) -> str:
    """Return folder_id for nested path segments under the dataset root."""
    parent = root_folder_id(dataset_id)
    for part in parts:
        label = str(part or "").strip()
        if not label or label in (".", ".."):
            continue
        existing = find_folder_by_parent_and_name(dataset_id, parent, label)
        if existing:
            parent = str(existing["folder_id"])
            continue
        created = create_folder(dataset_id, label, parent_id=parent)
        parent = str(created["folder_id"])
    return parent
