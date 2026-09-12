"""Scope membership: can_read / can_write / can_manage."""

from __future__ import annotations

import logging
from typing import Any

from evoflow.authz import admin_grants as admin_mod
from evoflow.authz import principals as principals_mod
from evoflow.authz.scope import parse_scope_id
from evoflow.authz.types import DEFAULT_ORG_ID, MemberRole, Principal
from evoflow.persistence.db import get_db, run_db_transaction

logger = logging.getLogger(__name__)


def _member_row(
    org_id: str,
    scope_id: str,
    principal_id: str,
) -> dict[str, Any] | None:
    row = (
        get_db()
        .execute(
            """
            SELECT role FROM evoflow_scope_members
            WHERE org_id = ? AND scope_id = ? AND principal_id = ?
            LIMIT 1
            """,
            (org_id, scope_id, principal_id),
        )
        .fetchone()
    )
    if not row:
        return None
    return {"role": str(row[0] or "member")}


def list_scope_members(scope_id: str, *, org_id: str = DEFAULT_ORG_ID) -> list[dict[str, Any]]:
    rows = get_db().execute(
        """
        SELECT m.principal_id, m.role, m.joined_at, p.display_name, p.principal_type, p.status
        FROM evoflow_scope_members m
        LEFT JOIN evoflow_principals p ON p.principal_id = m.principal_id
        WHERE m.org_id = ? AND m.scope_id = ?
        ORDER BY m.joined_at ASC
        """,
        (org_id, scope_id),
    ).fetchall()
    out: list[dict[str, Any]] = []
    for r in rows:
        out.append(
            {
                "principalId": str(r[0]),
                "role": str(r[1] or "member"),
                "joined_at": float(r[2] or 0),
                "display_name": str(r[3] or ""),
                "principal_type": str(r[4] or ""),
                "status": str(r[5] or ""),
            }
        )
    return out


def add_scope_member(
    scope_id: str,
    principal_id: str,
    *,
    role: MemberRole = "member",
    org_id: str = DEFAULT_ORG_ID,
    joined_at: float | None = None,
) -> None:
    import time

    now = float(joined_at if joined_at is not None else time.time())

    def _write(db: Any) -> None:
        db.execute(
            """
            INSERT INTO evoflow_scope_members (org_id, scope_id, principal_id, role, joined_at)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(org_id, scope_id, principal_id) DO UPDATE SET role = excluded.role
            """,
            (org_id, scope_id, principal_id, role, now),
        )

    run_db_transaction(_write)


def remove_scope_member(
    scope_id: str,
    principal_id: str,
    *,
    org_id: str = DEFAULT_ORG_ID,
) -> None:
    def _write(db: Any) -> None:
        db.execute(
            """
            DELETE FROM evoflow_scope_members
            WHERE org_id = ? AND scope_id = ? AND principal_id = ?
            """,
            (org_id, scope_id, principal_id),
        )

    run_db_transaction(_write)


def can_read_scope(
    principal: Principal,
    target_scope: str,
    *,
    org_id: str | None = None,
) -> bool:
    oid = org_id or str(principal.get("org_id") or DEFAULT_ORG_ID)
    pid = str(principal.get("principal_id") or "")
    if not pid:
        return False
    try:
        kind, ref = parse_scope_id(target_scope)
    except ValueError:
        return False

    if kind == "org":
        return principals_mod.is_active_internal(principal) and ref == oid
    if kind == "personal":
        return ref == pid and str(principal.get("status") or "") == "active"
    if kind == "team":
        return ref in list(principal.get("team_ids") or []) and principals_mod.is_active_internal(principal)
    if kind in {"group", "channel"}:
        if not principals_mod.is_active_internal(principal) and str(principal.get("principal_type")) != "guest":
            return False
        return _member_row(oid, target_scope, pid) is not None
    return False


def can_write_scope(
    principal: Principal,
    target_scope: str,
    *,
    org_id: str | None = None,
) -> bool:
    oid = org_id or str(principal.get("org_id") or DEFAULT_ORG_ID)
    pid = str(principal.get("principal_id") or "")
    if not principals_mod.is_active_internal(principal):
        return False
    try:
        kind, ref = parse_scope_id(target_scope)
    except ValueError:
        return False

    if kind == "org":
        return admin_mod.is_org_admin(pid, org_id=oid) and ref == oid
    if kind == "personal":
        return ref == pid
    if kind == "team":
        return ref in list(principal.get("team_ids") or [])
    if kind in {"group", "channel"}:
        return _member_row(oid, target_scope, pid) is not None
    return False


def can_manage_scope(
    principal: Principal,
    target_scope: str,
    *,
    org_id: str | None = None,
) -> bool:
    """Manage = may grant/revoke ACL on resources owned by this scope."""
    oid = org_id or str(principal.get("org_id") or DEFAULT_ORG_ID)
    pid = str(principal.get("principal_id") or "")
    if not principals_mod.is_active_internal(principal):
        return False
    try:
        kind, ref = parse_scope_id(target_scope)
    except ValueError:
        return False

    if kind == "org":
        return admin_mod.is_org_admin(pid, org_id=oid) and ref == oid
    if kind == "personal":
        return ref == pid
    if kind == "team":
        return False
    if kind in {"group", "channel"}:
        row = _member_row(oid, target_scope, pid)
        if not row:
            return False
        return str(row.get("role") or "member") == "manager" or admin_mod.is_org_admin(pid, org_id=oid)
    return False
