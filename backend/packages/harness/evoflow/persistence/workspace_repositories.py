"""User-bound local workspace paths and per-session / global history."""

from __future__ import annotations

from typing import Any

from evoflow.persistence import session_repositories as sess_repo
from evoflow.persistence.db import get_db
from evoflow.persistence.session_context_fields import (
    normalize_workspace_group_key,
    normalize_workspace_root_for_storage,
)
from evoflow.persistence.timestamps import iso_z_to_ms, now_iso_z

_SESSION_HISTORY_LIMIT = 30
_GLOBAL_HISTORY_LIMIT = 60

# Mirrors the DB-level unique index (v127): LOWER(RTRIM(REPLACE(path, '\\', '/'), '/'))
# so the repository lookup matches the constraint exactly.
_WORKSPACE_PATH_NORM_SQL = "LOWER(RTRIM(REPLACE(TRIM(workspace_path), '\\', '/'), '/'))"


def normalize_workspace_path(path: str) -> str:
    """Canonical storage form (forward slashes, trailing slash trimmed, case kept).

    All writes to ``evoflow_workspaces`` must go through this so the same folder
    cannot be stored under two spellings (``D:\\a\\b`` vs ``D:/a/b``).
    """
    return normalize_workspace_root_for_storage(path) or ""


def _workspace_ownership_cols(conn: Any) -> set[str]:
    return {str(r[1]) for r in conn.execute("PRAGMA table_info(evoflow_workspaces)").fetchall()}


def get_workspace_owner_scope(path: str) -> str | None:
    """Return ``owner_scope_id`` for a catalog path, or None if missing / unstamped."""
    p = normalize_workspace_path(path)
    if not p:
        return None
    key = normalize_workspace_group_key(p)
    conn = get_db()
    cols = _workspace_ownership_cols(conn)
    if "owner_scope_id" not in cols:
        return None
    row = conn.execute(
        f"SELECT owner_scope_id FROM evoflow_workspaces WHERE {_WORKSPACE_PATH_NORM_SQL} = ?",
        (key,),
    ).fetchone()
    if not row:
        return None
    return str(row[0] or "").strip() or None


def set_workspace_owner_scope(
    path: str,
    *,
    org_id: str,
    owner_scope_id: str,
) -> None:
    """COALESCE-stamp ownership (first non-empty wins)."""
    p = normalize_workspace_path(path)
    if not p or not owner_scope_id:
        return
    key = normalize_workspace_group_key(p)
    conn = get_db()
    cols = _workspace_ownership_cols(conn)
    if "owner_scope_id" not in cols:
        return
    now = now_iso_z()
    if "org_id" in cols:
        conn.execute(
            f"""
            UPDATE evoflow_workspaces
            SET org_id = COALESCE(NULLIF(org_id, ''), ?),
                owner_scope_id = COALESCE(NULLIF(owner_scope_id, ''), ?),
                updated_at = ?
            WHERE {_WORKSPACE_PATH_NORM_SQL} = ?
            """,
            (org_id, owner_scope_id, now, key),
        )
    else:
        conn.execute(
            f"""
            UPDATE evoflow_workspaces
            SET owner_scope_id = COALESCE(NULLIF(owner_scope_id, ''), ?),
                updated_at = ?
            WHERE {_WORKSPACE_PATH_NORM_SQL} = ?
            """,
            (owner_scope_id, now, key),
        )
    conn.commit()


def get_or_create_workspace(
    path: str,
    *,
    org_id: str | None = None,
    owner_scope_id: str | None = None,
) -> int:
    p = normalize_workspace_path(path)
    if not p:
        raise ValueError("workspace_path required")
    key = normalize_workspace_group_key(p)
    conn = get_db()
    now = now_iso_z()
    cols = _workspace_ownership_cols(conn)
    row = conn.execute(
        f"SELECT id FROM evoflow_workspaces WHERE {_WORKSPACE_PATH_NORM_SQL} = ?",
        (key,),
    ).fetchone()
    if row:
        wid = int(row[0])
        conn.execute(
            "UPDATE evoflow_workspaces SET last_used_at = ?, updated_at = ? WHERE id = ?",
            (now, now, wid),
        )
        conn.commit()
        if owner_scope_id and "owner_scope_id" in cols:
            set_workspace_owner_scope(
                p,
                org_id=str(org_id or "local"),
                owner_scope_id=owner_scope_id,
            )
        return wid
    if "owner_scope_id" in cols and "org_id" in cols and owner_scope_id:
        cur = conn.execute(
            """
            INSERT INTO evoflow_workspaces
                (workspace_path, created_at, last_used_at, updated_at, org_id, owner_scope_id)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            (p, now, now, now, str(org_id or "local"), owner_scope_id),
        )
    else:
        cur = conn.execute(
            """
            INSERT INTO evoflow_workspaces (workspace_path, created_at, last_used_at, updated_at)
            VALUES (?, ?, ?, ?)
            """,
            (p, now, now, now),
        )
    conn.commit()
    return int(cur.lastrowid)


def _paths_for_workspace_ids(ids: list[int]) -> list[str]:
    if not ids:
        return []
    conn = get_db()
    placeholders = ",".join("?" * len(ids))
    rows = conn.execute(
        f"""
        SELECT id, workspace_path FROM evoflow_workspaces
        WHERE id IN ({placeholders})
        """,
        ids,
    ).fetchall()
    by_id = {int(r[0]): str(r[1]) for r in rows}
    return [by_id[i] for i in ids if i in by_id]


def list_session_workspace_paths(session_key: str, *, limit: int = _SESSION_HISTORY_LIMIT) -> list[str]:
    sk = str(session_key or "").strip()
    if not sk:
        return []
    rows = (
        get_db()
        .execute(
            """
        SELECT w.workspace_path
        FROM evoflow_session_workspace_history h
        JOIN evoflow_workspaces w ON w.id = h.workspace_id
        WHERE h.session_key = ?
        ORDER BY h.sort_index ASC, h.bound_at DESC
        LIMIT ?
        """,
            (sk, max(1, int(limit))),
        )
        .fetchall()
    )
    # Normalize + dedupe (defense-in-depth; v127 migration already canonicalizes).
    out: list[str] = []
    seen: set[str] = set()
    for r in rows:
        if not r or not r[0]:
            continue
        p = normalize_workspace_path(str(r[0]))
        if not p:
            continue
        key = normalize_workspace_group_key(p)
        if key in seen:
            continue
        seen.add(key)
        out.append(p)
    return out


def list_global_workspace_paths(*, limit: int = _GLOBAL_HISTORY_LIMIT) -> list[str]:
    rows = (
        get_db()
        .execute(
            """
        SELECT w.workspace_path
        FROM evoflow_workspace_global_history g
        JOIN evoflow_workspaces w ON w.id = g.workspace_id
        ORDER BY g.sort_index ASC, g.last_used_at DESC
        LIMIT ?
        """,
            (max(1, int(limit)),),
        )
        .fetchall()
    )
    # Dedupe by normalized key (defense-in-depth in case a legacy DB still holds
    # path variants before v127 runs).
    out: list[str] = []
    seen: set[str] = set()
    for r in rows:
        if not r or not r[0]:
            continue
        p = normalize_workspace_path(str(r[0]))
        if not p:
            continue
        key = normalize_workspace_group_key(p)
        if key in seen:
            continue
        seen.add(key)
        out.append(p)
    return out


def get_session_current_workspace(session_key: str) -> str | None:
    sk = str(session_key or "").strip()
    if not sk:
        return None
    row = (
        get_db()
        .execute(
            """
        SELECT local_workspace_root FROM evoflow_chat_sessions
        WHERE session_key = ? AND is_deleted = 0
        """,
            (sk,),
        )
        .fetchone()
    )
    if not row or not row[0]:
        return None
    return normalize_workspace_path(str(row[0])) or None


def set_session_workspace_paths(
    session_key: str,
    paths: list[str],
    *,
    limit: int = _SESSION_HISTORY_LIMIT,
    org_id: str | None = None,
    owner_scope_id: str | None = None,
    stamp: dict[str, Any] | None = None,
) -> list[str]:
    sk = str(session_key or "").strip()
    if not sk:
        raise ValueError("session_key required")
    lim = max(1, int(limit))
    normalized: list[str] = []
    seen: set[str] = set()
    for raw in paths or []:
        p = normalize_workspace_path(raw)
        if not p or p in seen:
            continue
        seen.add(p)
        normalized.append(p)
        if len(normalized) >= lim:
            break
    conn = get_db()
    conn.execute(
        "DELETE FROM evoflow_session_workspace_history WHERE session_key = ?",
        (sk,),
    )
    now = now_iso_z()
    for idx, p in enumerate(normalized):
        oid, owner = _resolve_stamp_args(p, org_id=org_id, owner_scope_id=owner_scope_id, stamp=stamp)
        wid = get_or_create_workspace(p, org_id=oid, owner_scope_id=owner)
        conn.execute(
            """
            INSERT INTO evoflow_session_workspace_history
                (session_key, workspace_id, sort_index, bound_at, updated_at)
            VALUES (?, ?, ?, ?, ?)
            """,
            (sk, wid, idx, now, now),
        )
    conn.commit()
    return normalized


def _resolve_stamp_args(
    path: str,
    *,
    org_id: str | None = None,
    owner_scope_id: str | None = None,
    stamp: dict[str, Any] | None = None,
) -> tuple[str | None, str | None]:
    if owner_scope_id:
        return (str(org_id or "local"), owner_scope_id)
    if stamp:
        try:
            from evoflow.authz.workspace_visibility import resolve_stamp_for_workspace_path

            resolved = resolve_stamp_for_workspace_path(path, stamp)
            return (resolved.get("org_id"), resolved.get("owner_scope_id"))
        except Exception:
            pass
    return (org_id, owner_scope_id)


def set_global_workspace_paths(
    paths: list[str],
    *,
    limit: int = _GLOBAL_HISTORY_LIMIT,
    org_id: str | None = None,
    owner_scope_id: str | None = None,
    stamp: dict[str, Any] | None = None,
) -> list[str]:
    lim = max(1, int(limit))
    normalized: list[str] = []
    seen: set[str] = set()
    for raw in paths or []:
        p = normalize_workspace_path(raw)
        if not p or p in seen:
            continue
        seen.add(p)
        normalized.append(p)
        if len(normalized) >= lim:
            break
    conn = get_db()
    conn.execute("DELETE FROM evoflow_workspace_global_history")
    now = now_iso_z()
    for idx, p in enumerate(normalized):
        oid, owner = _resolve_stamp_args(p, org_id=org_id, owner_scope_id=owner_scope_id, stamp=stamp)
        wid = get_or_create_workspace(p, org_id=oid, owner_scope_id=owner)
        conn.execute(
            """
            INSERT INTO evoflow_workspace_global_history
                (workspace_id, sort_index, last_used_at, updated_at)
            VALUES (?, ?, ?, ?)
            """,
            (wid, idx, now, now),
        )
    conn.commit()
    return normalized


def touch_session_workspace(
    session_key: str,
    path: str,
    *,
    limit: int = _SESSION_HISTORY_LIMIT,
    set_current: bool = True,
    user_pinned: bool = False,
    stamp: dict[str, Any] | None = None,
) -> list[str]:
    """Move path to top of session history; optionally set as current binding on session row."""
    from evoflow.persistence.session_context_fields import is_workspace_user_pinned

    sk = str(session_key or "").strip()
    p = normalize_workspace_path(path)
    if not sk or not p:
        raise ValueError("session_key and workspace_path required")
    prev = [x for x in list_session_workspace_paths(sk, limit=limit) if x != p]
    next_paths = [p, *prev][:limit]
    set_session_workspace_paths(sk, next_paths, limit=limit, stamp=stamp)
    if set_current:
        row = sess_repo.load_session_map().get(sk) or {}
        ctx = row.get("context") if isinstance(row.get("context"), dict) else {}
        if is_workspace_user_pinned(ctx) and not user_pinned:
            set_current = False
        if set_current:
            merged = {**ctx, "local_workspace_root": p, "use_virtual_paths": False}
            if user_pinned:
                merged["workspace_user_pinned"] = True
            sess_repo.upsert_session_row(
                sk,
                thread_id=row.get("threadId"),
                created_at_ms=int(row.get("createdAt") or 0),
                updated_at_ms=iso_z_to_ms(now_iso_z()),
                message_count=int(row.get("messageCount") or 0),
                context=merged,
                local_workspace_root=p,
                use_virtual_paths=0,
            )
    global_paths = list_global_workspace_paths(limit=limit)
    global_next = [p, *[x for x in global_paths if x != p]][:_GLOBAL_HISTORY_LIMIT]
    set_global_workspace_paths(global_next, limit=_GLOBAL_HISTORY_LIMIT, stamp=stamp)
    return next_paths


def remove_workspace_path_everywhere(path: str) -> None:
    """Remove workspace catalog row and cascade global/session history (path variants match)."""
    from evoflow.persistence.session_context_fields import (
        normalize_workspace_group_key,
        normalize_workspace_root_for_storage,
    )

    p = normalize_workspace_root_for_storage(path)
    if not p:
        return
    target_key = normalize_workspace_group_key(p)
    conn = get_db()
    rows = conn.execute("SELECT id, workspace_path FROM evoflow_workspaces").fetchall()
    ids_to_delete: list[int] = []
    for row in rows:
        wid = int(row[0])
        wp = str(row[1] or "")
        if normalize_workspace_group_key(wp) == target_key:
            ids_to_delete.append(wid)
    for wid in ids_to_delete:
        conn.execute("DELETE FROM evoflow_workspaces WHERE id = ?", (wid,))
    conn.commit()


def clear_session_workspace_history(session_key: str) -> None:
    sk = str(session_key or "").strip()
    if not sk:
        return
    get_db().execute(
        "DELETE FROM evoflow_session_workspace_history WHERE session_key = ?",
        (sk,),
    )
    get_db().commit()


def import_session_current_to_history_if_empty(session_key: str) -> None:
    sk = str(session_key or "").strip()
    if not sk:
        return
    if list_session_workspace_paths(sk, limit=1):
        return
    current = get_session_current_workspace(sk)
    if current:
        touch_session_workspace(sk, current, set_current=False)


def _get_or_create_workspace_on_conn(conn: Any, path: str, now: str) -> int:
    p = normalize_workspace_path(path)
    if not p:
        raise ValueError("workspace_path required")
    key = normalize_workspace_group_key(p)
    row = conn.execute(
        f"SELECT id FROM evoflow_workspaces WHERE {_WORKSPACE_PATH_NORM_SQL} = ?",
        (key,),
    ).fetchone()
    if row:
        wid = int(row[0])
        conn.execute(
            "UPDATE evoflow_workspaces SET last_used_at = ?, updated_at = ? WHERE id = ?",
            (now, now, wid),
        )
        return wid
    cur = conn.execute(
        """
        INSERT INTO evoflow_workspaces (workspace_path, created_at, last_used_at, updated_at)
        VALUES (?, ?, ?, ?)
        """,
        (p, now, now, now),
    )
    return int(cur.lastrowid)


def migrate_existing_session_roots_to_history(conn: Any) -> None:
    """One-off v11: seed history from ``local_workspace_root`` on existing sessions."""
    rows = conn.execute(
        """
        SELECT session_key, local_workspace_root
        FROM evoflow_chat_sessions
        WHERE is_deleted = 0
          AND local_workspace_root IS NOT NULL
          AND TRIM(local_workspace_root) != ''
        """
    ).fetchall()
    now = now_iso_z()
    for row in rows:
        sk = str(row[0] or "").strip()
        path = normalize_workspace_path(str(row[1] or ""))
        if not sk or not path:
            continue
        existing = conn.execute(
            "SELECT 1 FROM evoflow_session_workspace_history WHERE session_key = ? LIMIT 1",
            (sk,),
        ).fetchone()
        if existing:
            continue
        wid = _get_or_create_workspace_on_conn(conn, path, now)
        conn.execute(
            """
            INSERT OR IGNORE INTO evoflow_session_workspace_history
                (session_key, workspace_id, sort_index, bound_at)
            VALUES (?, ?, 0, ?)
            """,
            (sk, wid, now),
        )
