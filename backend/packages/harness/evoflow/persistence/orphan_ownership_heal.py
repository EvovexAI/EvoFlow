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

_DEFAULT_BATCH = 5_000


def _has_column(conn: sqlite3.Connection, table: str, column: str) -> bool:
    cols = {r[1] for r in conn.execute(f"PRAGMA table_info({table})").fetchall()}
    return column in cols


def _stamp_orphan_sessions(conn: sqlite3.Connection, *, batch_size: int = _DEFAULT_BATCH) -> int:
    if not conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='evoflow_chat_sessions'"
    ).fetchone():
        return 0
    if not _has_column(conn, "evoflow_chat_sessions", "created_by"):
        return 0
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
            (ADMIN_SCOPE, ADMIN_PRINCIPAL_ID, int(batch_size)),
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
                (ADMIN_PRINCIPAL_ID,),
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
                (ADMIN_PRINCIPAL_ID, int(batch_size)),
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
    return _stamp_orphan_usage_table(conn, "evoflow_usage_events", batch_size=batch_size) + _stamp_orphan_usage_table(
        conn, "evoflow_usage_daily", batch_size=batch_size
    )


def heal_orphan_ownership_to_admin(conn: sqlite3.Connection) -> None:
    s = _stamp_orphan_sessions(conn)
    u = _stamp_orphan_usage(conn)
    logger.info(
        "Schema v136: orphan attribution → admin (sessions=%d usage_rows=%d)",
        s,
        u,
    )
