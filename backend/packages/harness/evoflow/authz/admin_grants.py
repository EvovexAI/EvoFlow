"""Org admin grants (separate from resource ACL)."""

from __future__ import annotations

import logging
import time
from typing import Any

from evoflow.authz.scope import org_scope
from evoflow.authz.types import DEFAULT_ORG_ID
from evoflow.persistence.db import get_db, run_db_transaction

logger = logging.getLogger(__name__)


def is_org_admin(principal_id: str, *, org_id: str = DEFAULT_ORG_ID) -> bool:
    pid = str(principal_id or "").strip()
    if not pid:
        return False
    row = (
        get_db()
        .execute(
            """
            SELECT 1 FROM evoflow_admin_grants
            WHERE org_id = ? AND principal_id = ? AND scope_id = ? AND role = 'org_admin'
            LIMIT 1
            """,
            (org_id, pid, org_scope(org_id)),
        )
        .fetchone()
    )
    return bool(row)


def list_org_admins(*, org_id: str = DEFAULT_ORG_ID) -> list[str]:
    rows = get_db().execute(
        """
        SELECT principal_id FROM evoflow_admin_grants
        WHERE org_id = ? AND scope_id = ? AND role = 'org_admin'
        ORDER BY created_at ASC
        """,
        (org_id, org_scope(org_id)),
    ).fetchall()
    return [str(r[0]) for r in rows]


def promote_org_admin(
    principal_id: str,
    *,
    granted_by: str | None,
    org_id: str = DEFAULT_ORG_ID,
) -> None:
    pid = str(principal_id or "").strip()
    if not pid:
        raise ValueError("principal_id required")
    now = float(time.time())

    def _write(db: Any) -> None:
        db.execute(
            """
            INSERT OR IGNORE INTO evoflow_admin_grants
                (org_id, principal_id, scope_id, role, granted_by, created_at)
            VALUES (?, ?, ?, 'org_admin', ?, ?)
            """,
            (org_id, pid, org_scope(org_id), granted_by, now),
        )

    run_db_transaction(_write)


def revoke_org_admin(
    principal_id: str,
    *,
    org_id: str = DEFAULT_ORG_ID,
    actor_id: str | None = None,
) -> None:
    """Revoke org_admin; refuses to remove the last admin."""
    pid = str(principal_id or "").strip()
    if not pid:
        raise ValueError("principal_id required")
    admins = list_org_admins(org_id=org_id)
    if pid not in admins:
        return
    if len(admins) <= 1:
        raise ValueError("cannot revoke the last org_admin")

    def _write(db: Any) -> None:
        db.execute(
            """
            DELETE FROM evoflow_admin_grants
            WHERE org_id = ? AND principal_id = ? AND scope_id = ? AND role = 'org_admin'
            """,
            (org_id, pid, org_scope(org_id)),
        )

    run_db_transaction(_write)
    logger.info("revoked org_admin principal=%s by=%s", pid, actor_id)
