"""Session ownership helpers (org_id / scope_id / created_by)."""

from __future__ import annotations

import logging
from typing import Any

from evoflow.authz.scope import org_scope, personal_scope
from evoflow.authz.types import DEFAULT_ORG_ID, Principal
from evoflow.persistence.db import get_db, run_db_transaction

logger = logging.getLogger(__name__)


def acl_session_list_filter_sql(
    principal: Principal | None,
    *,
    is_admin: bool = False,
) -> tuple[str, tuple[Any, ...]]:
    """SQL fragment for session list visibility.

    Sessions are visible when the principal is the owner (``created_by``), a member
    of the owning scope, or an admin. Orphan rows are attributed to the local
    admin (v136), so normal users never see unowned sessions.
    """
    if principal is None or is_admin:
        return "", ()
    pid = str(principal.get("principal_id") or "").strip()
    if not pid:
        return "", ()
    oid = str(principal.get("org_id") or DEFAULT_ORG_ID)
    personal = personal_scope(pid)
    sql = """
          AND (
            created_by = ?
            OR scope_id = ?
            OR scope_id IN (
              SELECT scope_id FROM evoflow_scope_members
              WHERE org_id = ? AND principal_id = ?
            )
          )
        """
    return sql, (pid, personal, oid, pid)


def stamp_session_ownership(
    session_key: str,
    principal: Principal,
    *,
    scope_id: str | None = None,
    force: bool = False,
) -> None:
    """Write ownership columns on a chat session.

    By default only fills empty columns so legacy rows stay untouched when
    re-upserted. Pass ``force=True`` to overwrite.
    """
    key = str(session_key or "").strip()
    if not key:
        return
    pid = str(principal.get("principal_id") or "").strip()
    if not pid:
        return
    oid = str(principal.get("org_id") or DEFAULT_ORG_ID)
    sid = str(scope_id or personal_scope(pid))

    def _write(db: Any) -> None:
        cols = {r[1] for r in db.execute("PRAGMA table_info(evoflow_chat_sessions)").fetchall()}
        if "org_id" not in cols or "scope_id" not in cols or "created_by" not in cols:
            return
        if force:
            db.execute(
                """
                UPDATE evoflow_chat_sessions
                SET org_id = ?, scope_id = ?, created_by = ?
                WHERE session_key = ?
                """,
                (oid, sid, pid, key),
            )
            return
        db.execute(
            """
            UPDATE evoflow_chat_sessions
            SET
                org_id = COALESCE(NULLIF(org_id, ''), ?),
                scope_id = COALESCE(NULLIF(scope_id, ''), ?),
                created_by = COALESCE(NULLIF(created_by, ''), ?)
            WHERE session_key = ?
            """,
            (oid, sid, pid, key),
        )

    try:
        run_db_transaction(_write)
    except Exception:
        logger.debug("stamp_session_ownership failed for %s", key, exc_info=True)


def add_session_participant(session_key: str, principal_id: str) -> None:
    import time

    key = str(session_key or "").strip()
    pid = str(principal_id or "").strip()
    if not key or not pid:
        return
    now = float(time.time())

    def _write(db: Any) -> None:
        if not db.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='evoflow_session_participants'"
        ).fetchone():
            return
        db.execute(
            """
            INSERT INTO evoflow_session_participants (session_key, principal_id, joined_at, left_at)
            VALUES (?, ?, ?, NULL)
            ON CONFLICT(session_key, principal_id) DO UPDATE SET left_at = NULL
            """,
            (key, pid, now),
        )

    try:
        run_db_transaction(_write)
    except Exception:
        logger.debug("add_session_participant failed", exc_info=True)


def session_visible_to_principal(
    row: dict[str, Any],
    principal: Principal,
    *,
    is_admin: bool = False,
) -> bool:
    """Visibility rule for isolated sessions.

    Owner (``created_by``), member of owning scope, or admin. Orphan rows were
    attributed to the local admin (v136), so non-admins don't see them.
    """
    created_by = str(
        row.get("created_by") or row.get("createdBy") or row.get("user_id") or row.get("userId") or ""
    ).strip()
    scope = str(row.get("scope_id") or row.get("scopeId") or "").strip()
    pid = str(principal.get("principal_id") or "")
    if is_admin:
        return True
    if created_by and created_by == pid:
        return True
    if scope == personal_scope(pid):
        return True
    if scope == org_scope(str(principal.get("org_id") or DEFAULT_ORG_ID)):
        return True
    # group/channel: membership check
    if scope.startswith("group:") or scope.startswith("channel:"):
        from evoflow.authz.membership import can_read_scope

        return can_read_scope(principal, scope)
    return False
