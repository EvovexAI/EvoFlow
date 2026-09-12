"""Resource ACL grants + audience intersection."""

from __future__ import annotations

import logging
import time
from typing import Any, Callable

from evoflow.authz.scope import parse_scope_id, personal_scope
from evoflow.authz.types import DEFAULT_ORG_ID, Grant, Permission, Principal
from evoflow.persistence.db import get_db, run_db_transaction

logger = logging.getLogger(__name__)

ScopeEntitlement = Callable[[Principal, str, str, str], bool]


def encode_resource_ref(kind: str, resource_id: str) -> str:
    k = str(kind or "").strip()
    rid = str(resource_id or "").strip()
    if not k or not rid:
        raise ValueError("kind and resource_id required")
    if k == "file":
        return rid
    return f"{k}:{rid}"


def parse_resource_ref(ref: str) -> tuple[str, str]:
    raw = str(ref or "").strip()
    if not raw:
        raise ValueError("empty ref")
    known = ("memory", "skill", "app", "agent", "cron", "credential", "deployment", "file")
    for k in known:
        prefix = f"{k}:"
        if raw.startswith(prefix):
            return k, raw[len(prefix) :]
    return "file", raw


def principal_entitled_to_scope(
    principal: Principal,
    label: str,
    session_scope_id: str,
    org_scope_id: str,
) -> bool:
    """Default entitlement predicate (QM-compatible)."""
    if label in {org_scope_id, session_scope_id}:
        return True
    try:
        kind, ref = parse_scope_id(label)
    except ValueError:
        return False
    pid = str(principal.get("principal_id") or "")
    if kind == "personal":
        return ref == pid
    if kind == "team":
        return ref in list(principal.get("team_ids") or [])
    return False


def _grant_from_row(row: Any) -> Grant:
    return Grant(
        org_id=str(row[0]),
        owner_scope_id=str(row[1]),
        ref=str(row[2]),
        grantee_scope_id=str(row[3]),
        permission=str(row[4]),  # type: ignore[typeddict-item]
        granted_by=str(row[5]),
        created_at=float(row[6] or 0),
    )


def grant(
    *,
    owner_scope_id: str,
    ref: str,
    grantee_scope_id: str,
    permission: Permission,
    granted_by: str,
    org_id: str = DEFAULT_ORG_ID,
) -> None:
    now = float(time.time())

    def _write(db: Any) -> None:
        db.execute(
            """
            INSERT INTO evoflow_acl_grants (
                org_id, owner_scope_id, ref, grantee_scope_id, permission, granted_by, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(org_id, owner_scope_id, ref, grantee_scope_id, permission)
            DO UPDATE SET granted_by = excluded.granted_by
            """,
            (org_id, owner_scope_id, ref, grantee_scope_id, permission, granted_by, now),
        )

    run_db_transaction(_write)


def revoke(
    *,
    owner_scope_id: str,
    ref: str,
    grantee_scope_id: str,
    permission: Permission | None = None,
    org_id: str = DEFAULT_ORG_ID,
) -> None:
    def _write(db: Any) -> None:
        if permission:
            db.execute(
                """
                DELETE FROM evoflow_acl_grants
                WHERE org_id = ? AND owner_scope_id = ? AND ref = ?
                  AND grantee_scope_id = ? AND permission = ?
                """,
                (org_id, owner_scope_id, ref, grantee_scope_id, permission),
            )
        else:
            db.execute(
                """
                DELETE FROM evoflow_acl_grants
                WHERE org_id = ? AND owner_scope_id = ? AND ref = ?
                  AND grantee_scope_id = ?
                """,
                (org_id, owner_scope_id, ref, grantee_scope_id),
            )

    run_db_transaction(_write)


def list_grants_for_ref(
    owner_scope_id: str,
    ref: str,
    *,
    org_id: str = DEFAULT_ORG_ID,
) -> list[Grant]:
    rows = get_db().execute(
        """
        SELECT org_id, owner_scope_id, ref, grantee_scope_id, permission, granted_by, created_at
        FROM evoflow_acl_grants
        WHERE org_id = ? AND owner_scope_id = ? AND ref = ?
        ORDER BY created_at ASC
        """,
        (org_id, owner_scope_id, ref),
    ).fetchall()
    return [_grant_from_row(r) for r in rows]


def list_grants_to_scope(
    grantee_scope_id: str,
    *,
    org_id: str = DEFAULT_ORG_ID,
) -> list[Grant]:
    rows = get_db().execute(
        """
        SELECT org_id, owner_scope_id, ref, grantee_scope_id, permission, granted_by, created_at
        FROM evoflow_acl_grants
        WHERE org_id = ? AND grantee_scope_id = ?
        ORDER BY created_at ASC
        """,
        (org_id, grantee_scope_id),
    ).fetchall()
    return [_grant_from_row(r) for r in rows]


def handles_for_audience(
    audience: list[Principal],
    *,
    session_scope_id: str,
    org_scope_id: str,
    org_id: str = DEFAULT_ORG_ID,
    entitled: ScopeEntitlement | None = None,
) -> list[Grant]:
    """Return grants visible under audience intersection (least privilege)."""
    if not audience:
        return []
    pred = entitled or principal_entitled_to_scope
    rows = get_db().execute(
        """
        SELECT org_id, owner_scope_id, ref, grantee_scope_id, permission, granted_by, created_at
        FROM evoflow_acl_grants
        WHERE org_id = ?
        """,
        (org_id,),
    ).fetchall()
    out: list[Grant] = []
    for row in rows:
        g = _grant_from_row(row)
        grantee = g["grantee_scope_id"]
        owner = g["owner_scope_id"]
        # At least one audience member entitled to grantee
        if not any(pred(p, grantee, session_scope_id, org_scope_id) for p in audience):
            continue
        # Every audience member reaches via grantee OR owner
        if not all(
            pred(p, grantee, session_scope_id, org_scope_id)
            or pred(p, owner, session_scope_id, org_scope_id)
            for p in audience
        ):
            continue
        out.append(g)
    return out


def can_access_ref(
    principal: Principal,
    *,
    owner_scope_id: str,
    ref: str,
    need: Permission = "read",
    org_id: str = DEFAULT_ORG_ID,
) -> bool:
    """Owner always can; otherwise need a grant to a scope the principal is entitled to."""
    pid = str(principal.get("principal_id") or "")
    my_personal = personal_scope(pid) if pid else ""
    if owner_scope_id == my_personal:
        return True
    from evoflow.authz.membership import can_read_scope, can_write_scope

    if need == "write":
        if can_write_scope(principal, owner_scope_id, org_id=org_id):
            return True
    elif can_read_scope(principal, owner_scope_id, org_id=org_id):
        return True

    grants = list_grants_for_ref(owner_scope_id, ref, org_id=org_id)
    for g in grants:
        if need == "write" and g["permission"] != "write":
            continue
        if can_read_scope(principal, g["grantee_scope_id"], org_id=org_id):
            return True
        # personal grantee
        try:
            kind, ref_id = parse_scope_id(g["grantee_scope_id"])
            if kind == "personal" and ref_id == pid:
                return True
        except ValueError:
            continue
    return False
