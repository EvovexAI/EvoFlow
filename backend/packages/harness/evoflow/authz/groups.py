"""Groups (managed shared scopes)."""

from __future__ import annotations

import time
import uuid
from typing import Any

from evoflow.authz.membership import add_scope_member
from evoflow.authz.scope import group_scope
from evoflow.authz.types import DEFAULT_ORG_ID
from evoflow.persistence.db import get_db, run_db_transaction


def create_group(
    *,
    name: str,
    created_by: str,
    org_id: str = DEFAULT_ORG_ID,
    kind: str = "project",
    group_id: str | None = None,
    attrs: dict[str, Any] | None = None,
) -> dict[str, Any]:
    import json

    gid = str(group_id or "").strip() or uuid.uuid4().hex
    now = float(time.time())
    display = str(name or "").strip() or gid
    scope = group_scope(gid)

    def _write(db: Any) -> None:
        db.execute(
            """
            INSERT INTO evoflow_groups (
                org_id, group_id, name, kind, created_by, created_at, attrs_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (
                org_id,
                gid,
                display,
                str(kind or "project"),
                created_by,
                now,
                json.dumps(attrs or {}, ensure_ascii=False),
            ),
        )

    run_db_transaction(_write)
    add_scope_member(scope, created_by, role="manager", org_id=org_id, joined_at=now)
    return {
        "org_id": org_id,
        "group_id": gid,
        "scope_id": scope,
        "name": display,
        "kind": kind,
        "created_by": created_by,
        "created_at": now,
    }


def get_group(group_id: str, *, org_id: str = DEFAULT_ORG_ID) -> dict[str, Any] | None:
    import json

    row = (
        get_db()
        .execute(
            """
            SELECT org_id, group_id, name, kind, created_by, created_at, attrs_json
            FROM evoflow_groups
            WHERE org_id = ? AND group_id = ?
            LIMIT 1
            """,
            (org_id, group_id),
        )
        .fetchone()
    )
    if not row:
        return None
    try:
        attrs = json.loads(row[6] or "{}")
    except Exception:
        attrs = {}
    return {
        "org_id": str(row[0]),
        "group_id": str(row[1]),
        "scope_id": group_scope(str(row[1])),
        "name": str(row[2]),
        "kind": str(row[3]),
        "created_by": str(row[4]),
        "created_at": float(row[5] or 0),
        "attrs": attrs if isinstance(attrs, dict) else {},
    }


def list_groups(*, org_id: str = DEFAULT_ORG_ID) -> list[dict[str, Any]]:
    rows = get_db().execute(
        """
        SELECT org_id, group_id, name, kind, created_by, created_at
        FROM evoflow_groups
        WHERE org_id = ?
        ORDER BY created_at DESC
        """,
        (org_id,),
    ).fetchall()
    return [
        {
            "org_id": str(r[0]),
            "group_id": str(r[1]),
            "scope_id": group_scope(str(r[1])),
            "name": str(r[2]),
            "kind": str(r[3]),
            "created_by": str(r[4]),
            "created_at": float(r[5] or 0),
        }
        for r in rows
    ]
