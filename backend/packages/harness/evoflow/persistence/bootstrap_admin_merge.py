"""Merge the bootstrap ``local-admin`` identity into the primary WebUI admin.

Background
----------
Before the primary WebUI login account existed, every localhost / no-JWT call
resolved to a bootstrap principal with ``principal_id='local-admin'`` and
``display_name='Local Admin'``. Once the operator sets up the WebUI account
(``evoflow_webui_users.is_primary=1``), that account owns a *second* principal.
The two identities then split one person's data, and the account chip keeps
showing the bootstrap label the user never chose.

This module performs the one-time, idempotent re-attribution of everything the
bootstrap principal owns onto the primary admin:

* ``evoflow_chat_sessions``      — ``org_id`` / ``scope_id`` / ``created_by``
  plus the ``context_json.created_by`` and ``local_workspace_root`` inside it
* ``evoflow_session_participants`` — replace or drop the bootstrap row so the
  ``(session_key, principal_id)`` primary key cannot collide
* ``evoflow_usage_events`` / ``evoflow_usage_daily`` — ``principal_id``; the
  daily table has ``principal_id`` inside its primary key, so colliding rows are
  summed into the target row instead of being updated in place
* ``evoflow_admin_grants``       — drop the bootstrap grant (the target admin is
  already an org admin)
* ``evoflow_apps``               — ``created_by`` / ``owner_scope_id``
* ``evoflow_app_settings``       — ``panel.ui:local-admin`` → ``panel.ui:<admin>``
* ``evoflow_workspaces``         — ``owner_scope_id`` and the workspace path
* ``evoflow_chat_live_runs``     — display/partial text mentions are left alone
  (they are transcript content, not ownership)

On-disk: ``scopes/personal/local-admin/`` is merged into ``scopes/personal/<admin>/``
then removed, so the personal files/memory/skills buckets follow the identity.

Safety
------
* Runs only when a primary WebUI admin principal exists and the bootstrap
  principal still owns something.
* Every step is guarded by table/column existence checks, so partially migrated
  or older schemas do not raise.
* Idempotent: once nothing references the bootstrap principal, it is a no-op.
* Records a marker in ``evoflow_app_settings`` (``authz.bootstrap_admin_merged``)
  so the work happens once per install.

The bootstrap principal row itself is kept (status stays ``active``) because
``orphan_ownership_heal`` still uses it as the owner for historical orphans.
Only its ``display_name`` is normalized so it can never leak "Local Admin" into
the UI again.
"""

from __future__ import annotations

import json
import logging
import shutil
import sqlite3
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

BOOTSTRAP_PRINCIPAL_ID = "local-admin"
MIGRATION_MARKER_KEY = "authz.bootstrap_admin_merged"
_DISPLAY_NAME_FALLBACK = "admin"


def _table_exists(conn: sqlite3.Connection, table: str) -> bool:
    return bool(conn.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (table,)).fetchone())


def _columns(conn: sqlite3.Connection, table: str) -> set[str]:
    if not _table_exists(conn, table):
        return set()
    return {str(r[1]) for r in conn.execute(f'PRAGMA table_info("{table}")').fetchall()}


def _count_refs(conn: sqlite3.Connection, table: str, column: str, value: str) -> int:
    if column not in _columns(conn, table):
        return 0
    try:
        return int(
            conn.execute(f'SELECT COUNT(*) FROM "{table}" WHERE "{column}" = ?', (value,)).fetchone()[0] or 0
        )
    except sqlite3.Error:
        return 0


def _primary_admin_principal_id(conn: sqlite3.Connection) -> str | None:
    """Principal id of the primary WebUI login account, if it exists."""
    if not _table_exists(conn, "evoflow_webui_users") or not _table_exists(conn, "evoflow_principal_identities"):
        return None
    row = conn.execute(
        """
        SELECT i.principal_id
        FROM evoflow_webui_users u
        JOIN evoflow_principal_identities i
          ON i.provider = 'webui' AND i.external_id = CAST(u.id AS TEXT)
        WHERE u.is_primary = 1
        ORDER BY u.id ASC
        LIMIT 1
        """
    ).fetchone()
    return str(row[0]) if row and str(row[0] or "").strip() else None


def _marker_done(conn: sqlite3.Connection) -> bool:
    if not _table_exists(conn, "evoflow_app_settings"):
        return False
    row = conn.execute("SELECT value_json FROM evoflow_app_settings WHERE key = ?", (MIGRATION_MARKER_KEY,)).fetchone()
    if not row:
        return False
    try:
        return bool(json.loads(row[0] or "{}").get("done"))
    except Exception:
        return False


def _write_marker(conn: sqlite3.Connection, payload: dict[str, Any]) -> None:
    if not _table_exists(conn, "evoflow_app_settings"):
        return
    import time

    conn.execute(
        """
        INSERT INTO evoflow_app_settings (key, value_text, value_json, updated_at)
        VALUES (?, NULL, ?, ?)
        ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at
        """,
        (MIGRATION_MARKER_KEY, json.dumps(payload, ensure_ascii=False), time.strftime("%Y-%m-%dT%H:%M:%S")),
    )


def _merge_sessions(conn: sqlite3.Connection, target: str) -> int:
    """Re-point session ownership, including the JSON blobs that cache it."""
    if not _table_exists(conn, "evoflow_chat_sessions"):
        return 0
    cols = _columns(conn, "evoflow_chat_sessions")
    target_scope = f"personal:{target}"
    source_scope = f"personal:{BOOTSTRAP_PRINCIPAL_ID}"
    sets: list[str] = []
    params: list[Any] = []
    if "created_by" in cols:
        sets.append("created_by = ?")
        params.append(target)
    if "scope_id" in cols:
        sets.append("scope_id = ?")
        params.append(target_scope)

    where = " OR ".join(
        clause
        for clause in (
            "created_by = ?" if "created_by" in cols else "",
            "scope_id = ?" if "scope_id" in cols else "",
        )
        if clause
    )
    if not where:
        return 0
    where_params = [BOOTSTRAP_PRINCIPAL_ID if "created_by" in cols else None]
    if "scope_id" in cols:
        where_params.append(source_scope)

    rows = conn.execute(
        f'SELECT rowid, * FROM evoflow_chat_sessions WHERE {where}',
        [p for p in where_params if p is not None],
    ).fetchall()
    if not rows:
        return 0

    names = ["rowid"] + [d[0] for d in conn.execute("SELECT * FROM evoflow_chat_sessions LIMIT 0").description]
    for row in rows:
        rec = dict(zip(names, row))
        updates: dict[str, Any] = {}
        if "created_by" in cols and str(rec.get("created_by") or "") == BOOTSTRAP_PRINCIPAL_ID:
            updates["created_by"] = target
        if "scope_id" in cols and str(rec.get("scope_id") or "") == source_scope:
            updates["scope_id"] = target_scope

        ctx_raw = rec.get("context_json")
        if "context_json" in cols and isinstance(ctx_raw, str) and BOOTSTRAP_PRINCIPAL_ID in ctx_raw:
            try:
                ctx = json.loads(ctx_raw)
            except Exception:
                ctx = None
            if isinstance(ctx, dict):
                changed = False
                if str(ctx.get("created_by") or "") == BOOTSTRAP_PRINCIPAL_ID:
                    ctx["created_by"] = target
                    changed = True
                if str(ctx.get("principal_id") or "") == BOOTSTRAP_PRINCIPAL_ID:
                    ctx["principal_id"] = target
                    changed = True
                root = str(ctx.get("local_workspace_root") or "")
                if source_scope.replace(":", "/").replace("/", "/") and (
                    "scopes/personal/" + BOOTSTRAP_PRINCIPAL_ID in root.replace("\\", "/")
                ):
                    ctx["local_workspace_root"] = root.replace(
                        f"scopes/personal/{BOOTSTRAP_PRINCIPAL_ID}",
                        f"scopes/personal/{target}",
                    ).replace(
                        f"scopes\\personal\\{BOOTSTRAP_PRINCIPAL_ID}",
                        f"scopes\\personal\\{target}",
                    )
                    changed = True
                if changed:
                    updates["context_json"] = json.dumps(ctx, ensure_ascii=False)

        root = str(rec.get("local_workspace_root") or "")
        if "local_workspace_root" in cols and BOOTSTRAP_PRINCIPAL_ID in root:
            updates["local_workspace_root"] = root.replace(
                f"scopes/personal/{BOOTSTRAP_PRINCIPAL_ID}", f"scopes/personal/{target}"
            ).replace(f"scopes\\personal\\{BOOTSTRAP_PRINCIPAL_ID}", f"scopes\\personal\\{target}")

        if not updates:
            continue
        assign = ", ".join(f'"{k}" = ?' for k in updates)
        conn.execute(
            f'UPDATE evoflow_chat_sessions SET {assign} WHERE rowid = ?',
            [*updates.values(), rec["rowid"]],
        )
    return len(rows)


def _merge_participants(conn: sqlite3.Connection, target: str) -> int:
    """Participants PK is (session_key, principal_id) — drop ours if the target already joined."""
    table = "evoflow_session_participants"
    if not _table_exists(conn, table):
        return 0
    try:
        conn.execute(
            f"""
            DELETE FROM {table}
            WHERE principal_id = ?
              AND session_key IN (SELECT session_key FROM {table} WHERE principal_id = ?)
            """,
            (BOOTSTRAP_PRINCIPAL_ID, target),
        )
        cur = conn.execute(f"UPDATE {table} SET principal_id = ? WHERE principal_id = ?", (target, BOOTSTRAP_PRINCIPAL_ID))
        return int(cur.rowcount or 0)
    except sqlite3.IntegrityError:
        logger.warning("bootstrap admin merge: participant collision, keeping existing rows", exc_info=True)
        return 0


def _merge_usage(conn: sqlite3.Connection, target: str) -> tuple[int, int]:
    events = 0
    table = "evoflow_usage_events"
    if "principal_id" in _columns(conn, table):
        cur = conn.execute(f"UPDATE {table} SET principal_id = ? WHERE principal_id = ?", (target, BOOTSTRAP_PRINCIPAL_ID))
        events = int(cur.rowcount or 0)

    daily = 0
    table = "evoflow_usage_daily"
    if "principal_id" in _columns(conn, table):
        # principal_id is part of the PK: merge colliding rows by summation, then
        # update the remainder.
        try:
            conn.execute(
                """
                UPDATE evoflow_usage_daily AS dst
                SET quantity_sum = dst.quantity_sum + (
                        SELECT SUM(src.quantity_sum) FROM evoflow_usage_daily AS src
                        WHERE src.day = dst.day AND src.category = dst.category
                          AND src.subcategory = dst.subcategory AND src.sku = dst.sku
                          AND src.subject_type = dst.subject_type AND src.subject_id = dst.subject_id
                          AND src.principal_id = ?
                    ),
                    quantity_in_sum = dst.quantity_in_sum + (
                        SELECT SUM(src.quantity_in_sum) FROM evoflow_usage_daily AS src
                        WHERE src.day = dst.day AND src.category = dst.category
                          AND src.subcategory = dst.subcategory AND src.sku = dst.sku
                          AND src.subject_type = dst.subject_type AND src.subject_id = dst.subject_id
                          AND src.principal_id = ?
                    ),
                    quantity_out_sum = dst.quantity_out_sum + (
                        SELECT SUM(src.quantity_out_sum) FROM evoflow_usage_daily AS src
                        WHERE src.day = dst.day AND src.category = dst.category
                          AND src.subcategory = dst.subcategory AND src.sku = dst.sku
                          AND src.subject_type = dst.subject_type AND src.subject_id = dst.subject_id
                          AND src.principal_id = ?
                    ),
                    amount_sum = dst.amount_sum + (
                        SELECT SUM(src.amount_sum) FROM evoflow_usage_daily AS src
                        WHERE src.day = dst.day AND src.category = dst.category
                          AND src.subcategory = dst.subcategory AND src.sku = dst.sku
                          AND src.subject_type = dst.subject_type AND src.subject_id = dst.subject_id
                          AND src.principal_id = ?
                    ),
                    event_count = dst.event_count + (
                        SELECT SUM(src.event_count) FROM evoflow_usage_daily AS src
                        WHERE src.day = dst.day AND src.category = dst.category
                          AND src.subcategory = dst.subcategory AND src.sku = dst.sku
                          AND src.subject_type = dst.subject_type AND src.subject_id = dst.subject_id
                          AND src.principal_id = ?
                    )
                WHERE dst.principal_id = ?
                  AND EXISTS (
                    SELECT 1 FROM evoflow_usage_daily AS src
                    WHERE src.day = dst.day AND src.category = dst.category
                      AND src.subcategory = dst.subcategory AND src.sku = dst.sku
                      AND src.subject_type = dst.subject_type AND src.subject_id = dst.subject_id
                      AND src.principal_id = ?
                  )
                """,
                (BOOTSTRAP_PRINCIPAL_ID,) * 5 + (target, BOOTSTRAP_PRINCIPAL_ID),
            )
            conn.execute(
                """
                DELETE FROM evoflow_usage_daily
                WHERE principal_id = ?
                  AND EXISTS (
                    SELECT 1 FROM evoflow_usage_daily AS dst
                    WHERE dst.day = evoflow_usage_daily.day AND dst.category = evoflow_usage_daily.category
                      AND dst.subcategory = evoflow_usage_daily.subcategory AND dst.sku = evoflow_usage_daily.sku
                      AND dst.subject_type = evoflow_usage_daily.subject_type
                      AND dst.subject_id = evoflow_usage_daily.subject_id
                      AND dst.principal_id = ?
                  )
                """,
                (BOOTSTRAP_PRINCIPAL_ID, target),
            )
            cur = conn.execute(
                "UPDATE evoflow_usage_daily SET principal_id = ? WHERE principal_id = ?",
                (target, BOOTSTRAP_PRINCIPAL_ID),
            )
            daily = int(cur.rowcount or 0)
        except sqlite3.Error:
            logger.warning("bootstrap admin merge: usage_daily merge failed", exc_info=True)
    return events, daily


def _merge_grants(conn: sqlite3.Connection, target: str) -> int:
    table = "evoflow_admin_grants"
    if "principal_id" not in _columns(conn, table):
        return 0
    cur = conn.execute(f"DELETE FROM {table} WHERE principal_id = ?", (BOOTSTRAP_PRINCIPAL_ID,))
    return int(cur.rowcount or 0)


def _merge_apps(conn: sqlite3.Connection, target: str) -> int:
    table = "evoflow_apps"
    cols = _columns(conn, table)
    if not cols:
        return 0
    sets = []
    params: list[Any] = []
    if "created_by" in cols:
        sets.append("created_by = ?")
        params.append(target)
    if "owner_scope_id" in cols:
        sets.append("owner_scope_id = ?")
        params.append(f"personal:{target}")
    if not sets:
        return 0
    where = " OR ".join(
        clause
        for clause in (
            "created_by = ?" if "created_by" in cols else "",
            "owner_scope_id = ?" if "owner_scope_id" in cols else "",
        )
        if clause
    )
    where_params = [BOOTSTRAP_PRINCIPAL_ID]
    if "owner_scope_id" in cols:
        where_params.append(f"personal:{BOOTSTRAP_PRINCIPAL_ID}")
    cur = conn.execute(f"UPDATE {table} SET {', '.join(sets)} WHERE {where}", [*params, *where_params])
    return int(cur.rowcount or 0)


def _merge_app_settings(conn: sqlite3.Connection, target: str) -> int:
    table = "evoflow_app_settings"
    if not _table_exists(conn, table):
        return 0
    old_key = f"panel.ui:{BOOTSTRAP_PRINCIPAL_ID}"
    new_key = f"panel.ui:{target}"
    row = conn.execute(f"SELECT 1 FROM {table} WHERE key = ?", (old_key,)).fetchone()
    if not row:
        return 0
    exists = conn.execute(f"SELECT 1 FROM {table} WHERE key = ?", (new_key,)).fetchone()
    if exists:
        conn.execute(f"DELETE FROM {table} WHERE key = ?", (old_key,))
        return 1
    cur = conn.execute(f"UPDATE {table} SET key = ? WHERE key = ?", (new_key, old_key))
    return int(cur.rowcount or 0)


def _merge_workspaces(conn: sqlite3.Connection, target: str) -> int:
    table = "evoflow_workspaces"
    cols = _columns(conn, table)
    if "owner_scope_id" not in cols:
        return 0
    old_scope = f"personal:{BOOTSTRAP_PRINCIPAL_ID}"
    new_scope = f"personal:{target}"
    total = 0
    paths: list[str] = []
    if "workspace_path" in cols:
        paths = [
            str(r[0])
            for r in conn.execute(
                f"SELECT workspace_path FROM {table} WHERE owner_scope_id = ? OR workspace_path LIKE ?",
                (old_scope, f"%scopes/personal/{BOOTSTRAP_PRINCIPAL_ID}/%"),
            ).fetchall()
        ]
    for path in paths:
        new_path = path.replace(
            f"scopes/personal/{BOOTSTRAP_PRINCIPAL_ID}", f"scopes/personal/{target}"
        ).replace(f"scopes\\personal\\{BOOTSTRAP_PRINCIPAL_ID}", f"scopes\\personal\\{target}")
        clash = conn.execute(f"SELECT 1 FROM {table} WHERE workspace_path = ?", (new_path,)).fetchone()
        if clash:
            conn.execute(f"DELETE FROM {table} WHERE workspace_path = ?", (path,))
        else:
            conn.execute(f"UPDATE {table} SET workspace_path = ? WHERE workspace_path = ?", (new_path, path))
        total += 1
    cur = conn.execute(f"UPDATE {table} SET owner_scope_id = ? WHERE owner_scope_id = ?", (new_scope, old_scope))
    return total + int(cur.rowcount or 0)


def _normalize_bootstrap_display_name(conn: sqlite3.Connection) -> bool:
    """Never let the bootstrap row render as "Local Admin" again."""
    if "display_name" not in _columns(conn, "evoflow_principals"):
        return False
    row = conn.execute(
        "SELECT display_name FROM evoflow_principals WHERE principal_id = ?",
        (BOOTSTRAP_PRINCIPAL_ID,),
    ).fetchone()
    if not row:
        return False
    current = str(row[0] or "").strip()
    if current and current != _DISPLAY_NAME_FALLBACK and "local admin" not in current.lower():
        return False
    conn.execute(
        "UPDATE evoflow_principals SET display_name = ? WHERE principal_id = ?",
        (_DISPLAY_NAME_FALLBACK, BOOTSTRAP_PRINCIPAL_ID),
    )
    return True


def _merge_scope_dirs(target: str, *, scopes_root: Path | None = None) -> bool:
    """Move ``scopes/personal/local-admin/*`` into ``scopes/personal/<target>/``."""
    if scopes_root is None:
        try:
            from evoflow.config.paths import get_paths

            scopes_root = Path(get_paths().base_dir) / "scopes"
        except Exception:
            logger.debug("bootstrap admin merge: scopes root unavailable", exc_info=True)
            return False
    src = scopes_root / "personal" / BOOTSTRAP_PRINCIPAL_ID
    dst = scopes_root / "personal" / target
    if not src.is_dir():
        return False
    try:
        dst.mkdir(parents=True, exist_ok=True)
        for child in list(src.iterdir()):
            target_path = dst / child.name
            if not target_path.exists():
                shutil.move(str(child), str(target_path))
                continue
            if child.is_dir() and target_path.is_dir():
                for grandchild in list(child.iterdir()):
                    grandchild_target = target_path / grandchild.name
                    if grandchild_target.exists():
                        continue
                    shutil.move(str(grandchild), str(grandchild_target))
        shutil.rmtree(src, ignore_errors=True)
        return True
    except Exception:
        logger.warning("bootstrap admin merge: scopes merge failed for %s", target, exc_info=True)
        return False


def _merge_asset_buckets(target: str, *, assets_root: Path | None = None) -> bool:
    """Move ``assets/users/local-admin/`` into ``assets/users/<target>/``.

    The per-user asset bucket holds the memory / profile / craft files the
    runtime reads back for prompts. Leaving it behind would keep the bootstrap
    identity alive in ``/assets/entities`` and silently drop the operator's
    memory after the merge.
    """
    from evoflow.assets.paths import sanitize_user_asset_id

    if assets_root is None:
        try:
            from evoflow.assets.paths import assets_root as _assets_root

            assets_root = _assets_root()
        except Exception:
            logger.debug("bootstrap admin merge: assets root unavailable", exc_info=True)
            return False
    src = assets_root / "users" / BOOTSTRAP_PRINCIPAL_ID
    dst = assets_root / "users" / sanitize_user_asset_id(target)
    if not src.is_dir():
        return False
    try:
        dst.mkdir(parents=True, exist_ok=True)
        for child in list(src.iterdir()):
            if child.is_dir():
                shutil.copytree(child, dst / child.name, dirs_exist_ok=True)
            else:
                shutil.copy2(child, dst / child.name)
        shutil.rmtree(src, ignore_errors=True)
        return True
    except Exception:
        logger.warning("bootstrap admin merge: asset bucket merge failed", exc_info=True)
        return False


def _deactivate_bootstrap_principal(conn: sqlite3.Connection) -> bool:
    """Retire the bootstrap row so it stops showing up as a second user.

    Deactivated (not deleted): ``orphan_ownership_heal`` and the legacy admin
    fallback still reference this principal id for historical rows.
    """
    cols = _columns(conn, "evoflow_principals")
    if "status" not in cols:
        return False
    row = conn.execute(
        "SELECT status FROM evoflow_principals WHERE principal_id = ?",
        (BOOTSTRAP_PRINCIPAL_ID,),
    ).fetchone()
    if not row or str(row[0] or "") == "deactivated":
        return False
    conn.execute(
        """
        UPDATE evoflow_principals
        SET status = 'deactivated',
            principal_type = CASE WHEN principal_type = 'internal' THEN 'guest' ELSE principal_type END
        WHERE principal_id = ?
        """,
        (BOOTSTRAP_PRINCIPAL_ID,),
    )
    return True


def merge_bootstrap_admin_into_primary(
    conn: sqlite3.Connection,
    *,
    dry_run: bool = False,
    scopes_root: Path | None = None,
) -> dict[str, Any]:
    """One-time re-attribution of ``local-admin`` data onto the primary admin.

    Returns a summary dict; ``skipped`` explains why nothing happened.
    """
    summary: dict[str, Any] = {"skipped": None, "target": None}

    target = _primary_admin_principal_id(conn)
    if not target:
        summary["skipped"] = "no primary webui admin"
        return summary
    if target == BOOTSTRAP_PRINCIPAL_ID:
        summary["skipped"] = "primary admin is the bootstrap principal"
        return summary
    if _marker_done(conn):
        summary["skipped"] = "already merged"
        summary["target"] = target
        return summary

    owned = 0
    for table, column in (
        ("evoflow_chat_sessions", "created_by"),
        ("evoflow_session_participants", "principal_id"),
        ("evoflow_usage_events", "principal_id"),
        ("evoflow_usage_daily", "principal_id"),
        ("evoflow_apps", "created_by"),
        ("evoflow_admin_grants", "principal_id"),
    ):
        owned += _count_refs(conn, table, column, BOOTSTRAP_PRINCIPAL_ID)
    if owned == 0:
        summary["skipped"] = "bootstrap principal owns nothing"
        summary["target"] = target
        if not dry_run:
            _normalize_bootstrap_display_name(conn)
            _write_marker(conn, {"done": True, "target": target, "mode": "noop"})
            conn.commit()
        return summary

    summary["target"] = target
    summary["owned_rows_before"] = owned
    if dry_run:
        summary["skipped"] = "dry run"
        return summary

    summary["sessions"] = _merge_sessions(conn, target)
    summary["participants"] = _merge_participants(conn, target)
    events, daily = _merge_usage(conn, target)
    summary["usage_events"] = events
    summary["usage_daily"] = daily
    summary["grants"] = _merge_grants(conn, target)
    summary["apps"] = _merge_apps(conn, target)
    summary["app_settings"] = _merge_app_settings(conn, target)
    summary["workspaces"] = _merge_workspaces(conn, target)
    summary["display_name_fixed"] = _normalize_bootstrap_display_name(conn)
    _write_marker(conn, {"done": True, "target": target, **{k: v for k, v in summary.items() if k != "target"}})
    conn.commit()

    summary["scopes_merged"] = _merge_scope_dirs(target, scopes_root=scopes_root)
    summary["assets_merged"] = _merge_asset_buckets(target)
    summary["bootstrap_deactivated"] = _deactivate_bootstrap_principal(conn)
    conn.commit()
    logger.info("bootstrap admin merged into %s: %s", target, summary)
    return summary
