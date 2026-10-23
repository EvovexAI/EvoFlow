"""Attribute orphan (startup heal) (unowned) sessions & usage to local admin.

Historical rows created before per-user ownership existed have empty
``created_by`` / ``scope_id``. Previously they were treated as "visible to
everyone". This heal stamps them to the local admin (``local-admin``) so
ACL hides them from normal users while keeping admin access.

Applies to:
- ``evoflow_chat_sessions`` (org_id / scope_id / created_by)
- ``evoflow_usage_events`` / ``evoflow_usage_daily`` (principal_id)

Large ``evoflow_usage_*`` tables must be updated in batches with frequent
commits — a single ``UPDATE ... WHERE TRIM(...)`` on a multi-hundred-MB DB
holds the write lock long enough to starve the Gateway event loop and make
every subsequent ``get_db()`` retry ``ensure_app_schema``.
"""

from __future__ import annotations

import logging
import sqlite3
import time

logger = logging.getLogger(__name__)

ADMIN_PRINCIPAL_ID = "local-admin"
ADMIN_SCOPE = "personal:local-admin"


def admin_target(conn: sqlite3.Connection) -> tuple[str, str]:
    """Principal id + scope for unowned rows.

    Prefers the primary WebUI admin: after ``bootstrap_admin_merge`` the
    bootstrap ``local-admin`` is no longer an org admin, so stamping fresh
    orphans to it would hide them from the only real administrator.
    """
    try:
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
        pid = str(row[0] or "").strip() if row else ""
        if pid and pid != ADMIN_PRINCIPAL_ID:
            return pid, f"personal:{pid}"
    except sqlite3.Error:
        logger.debug("v136: admin_target lookup failed", exc_info=True)
    return ADMIN_PRINCIPAL_ID, ADMIN_SCOPE

_DEFAULT_BATCH = 5_000


def _has_column(conn: sqlite3.Connection, table: str, column: str) -> bool:
    cols = {r[1] for r in conn.execute(f"PRAGMA table_info({table})").fetchall()}
    return column in cols


def _stamp_orphan_sessions(conn: sqlite3.Connection, *, batch_size: int = _DEFAULT_BATCH) -> int:
    if not conn.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='evoflow_chat_sessions'").fetchone():
        return 0
    if not _has_column(conn, "evoflow_chat_sessions", "created_by"):
        return 0
    owner_pid, owner_scope = admin_target(conn)
    total = 0
    while True:
        cur = conn.execute(
            """
            UPDATE evoflow_chat_sessions
            SET
                org_id = COALESCE(NULLIF(org_id, ''), 'local'),
                scope_id = COALESCE(NULLIF(scope_id, ''), ?),
                created_by = COALESCE(NULLIF(created_by, ''), ?)
            WHERE rowid IN (
                SELECT rowid FROM evoflow_chat_sessions
                WHERE
                    (created_by IS NULL OR TRIM(created_by) = '')
                    AND (scope_id IS NULL OR TRIM(scope_id) = '')
                LIMIT ?
            )
            """,
            (owner_scope, owner_pid, int(batch_size)),
        )
        n = int(cur.rowcount or 0)
        total += n
        conn.commit()
        if n == 0:
            break
        time.sleep(0.001)  # release GIL so asyncio can serve /health
    return total


def _stamp_orphan_usage_table(
    conn: sqlite3.Connection,
    table: str,
    *,
    batch_size: int = _DEFAULT_BATCH,
) -> int:
    if not conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
        (table,),
    ).fetchone():
        return 0
    if not _has_column(conn, table, "principal_id"):
        return 0
    owner_pid, _owner_scope = admin_target(conn)

    # usage_daily has UNIQUE(..., principal_id). Stamping '' → local-admin can
    # collide with an existing admin row; drop conflicting orphans first.
    if table == "evoflow_usage_daily":
        try:
            conn.execute(
                """
                DELETE FROM evoflow_usage_daily
                WHERE (principal_id IS NULL OR principal_id = '' OR TRIM(principal_id) = '')
                  AND EXISTS (
                    SELECT 1 FROM evoflow_usage_daily AS admin
                    WHERE admin.day = evoflow_usage_daily.day
                      AND admin.category = evoflow_usage_daily.category
                      AND admin.subcategory IS evoflow_usage_daily.subcategory
                      AND admin.sku IS evoflow_usage_daily.sku
                      AND admin.subject_type IS evoflow_usage_daily.subject_type
                      AND admin.subject_id IS evoflow_usage_daily.subject_id
                      AND admin.principal_id = ?
                  )
                """,
                (owner_pid,),
            )
            conn.commit()
        except sqlite3.Error:
            logger.warning("v136: could not prune conflicting usage_daily orphans", exc_info=True)
            try:
                conn.rollback()
            except Exception:
                pass

    total = 0
    while True:
        try:
            cur = conn.execute(
                f"""
                UPDATE {table}
                SET principal_id = ?
                WHERE rowid IN (
                    SELECT rowid FROM {table}
                    WHERE principal_id IS NULL OR principal_id = '' OR TRIM(principal_id) = ''
                    LIMIT ?
                )
                """,
                (owner_pid, int(batch_size)),
            )
        except sqlite3.IntegrityError:
            # Last-resort: drop a batch of orphan daily rows rather than block open.
            logger.warning("v136: usage stamp hit UNIQUE on %s — deleting orphan batch", table)
            conn.rollback()
            conn.execute(
                f"""
                DELETE FROM {table}
                WHERE rowid IN (
                    SELECT rowid FROM {table}
                    WHERE principal_id IS NULL OR principal_id = '' OR TRIM(principal_id) = ''
                    LIMIT ?
                )
                """,
                (int(batch_size),),
            )
            conn.commit()
            continue
        n = int(cur.rowcount or 0)
        total += n
        conn.commit()
        if n == 0:
            break
        time.sleep(0.001)
    return total


def _stamp_orphan_usage(conn: sqlite3.Connection, *, batch_size: int = _DEFAULT_BATCH) -> int:
    return _stamp_orphan_usage_table(conn, "evoflow_usage_events", batch_size=batch_size) + _stamp_orphan_usage_table(conn, "evoflow_usage_daily", batch_size=batch_size)


def heal_orphan_ownership_to_admin(conn: sqlite3.Connection) -> None:
    s = _stamp_orphan_sessions(conn)
    u = _stamp_orphan_usage(conn)
    logger.info(
        "Schema v136: orphan attribution → admin (sessions=%d usage_rows=%d)",
        s,
        u,
    )
