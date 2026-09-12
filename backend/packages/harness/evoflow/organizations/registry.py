"""Organization Pack install registry (evoflow_org_registry)."""

from __future__ import annotations

import json
import logging
from typing import Any

from evoflow.persistence.db import get_db
from evoflow.timeutil import utc_now_iso_z

logger = logging.getLogger(__name__)


def _row_to_instance(row: Any, *, artifacts: dict[str, list[str]] | None = None) -> dict[str, Any]:
    d = dict(row) if not isinstance(row, dict) else row
    return {
        "org_instance_id": str(d.get("id") or ""),
        "pack_id": str(d.get("pack_id") or ""),
        "pack_version": str(d.get("pack_version") or ""),
        "kind": str(d.get("kind") or ""),
        "workspace_path": d.get("workspace_path"),
        "status": str(d.get("status") or "active"),
        "installed_at": str(d.get("installed_at") or ""),
        "artifacts": artifacts if artifacts is not None else {},
        "warnings": [],
    }


def list_artifacts(org_instance_id: str) -> dict[str, list[str]]:
    oid = str(org_instance_id or "").strip()
    out: dict[str, list[str]] = {}
    if not oid:
        return out
    rows = get_db().execute(
        "SELECT artifact_type, artifact_id FROM evoflow_org_artifacts "
        "WHERE org_instance_id = ? ORDER BY id",
        (oid,),
    ).fetchall()
    for r in rows:
        t = str(r[0] or "").strip()
        aid = str(r[1] or "").strip()
        if not t or not aid:
            continue
        out.setdefault(t, []).append(aid)
    return out


def list_org_instances(*, status: str | None = "active") -> list[dict[str, Any]]:
    sql = "SELECT * FROM evoflow_org_registry"
    params: tuple[Any, ...] = ()
    st = str(status or "").strip().lower()
    if st:
        sql += " WHERE status = ?"
        params = (st,)
    sql += " ORDER BY installed_at DESC"
    rows = get_db().execute(sql, params).fetchall()
    items: list[dict[str, Any]] = []
    for r in rows:
        raw = dict(r)
        oid = str(raw.get("id") or "")
        items.append(_row_to_instance(raw, artifacts=list_artifacts(oid)))
    return items


def get_org_instance(org_instance_id: str) -> dict[str, Any] | None:
    oid = str(org_instance_id or "").strip()
    if not oid:
        return None
    row = get_db().execute(
        "SELECT * FROM evoflow_org_registry WHERE id = ?", (oid,)
    ).fetchone()
    if not row:
        return None
    raw = dict(row)
    return _row_to_instance(raw, artifacts=list_artifacts(oid))


def insert_org_instance(
    *,
    org_instance_id: str,
    pack_id: str,
    pack_version: str,
    kind: str,
    workspace_path: str | None,
    manifest: dict[str, Any],
    artifacts: dict[str, list[str]],
) -> dict[str, Any]:
    now = utc_now_iso_z()
    db = get_db()
    db.execute(
        """
        INSERT INTO evoflow_org_registry
        (id, pack_id, pack_version, kind, workspace_path, installed_at, status, manifest_json)
        VALUES (?, ?, ?, ?, ?, ?, 'active', ?)
        """,
        (
            org_instance_id,
            pack_id,
            pack_version,
            kind,
            workspace_path,
            now,
            json.dumps(manifest, ensure_ascii=False),
        ),
    )
    for atype, ids in (artifacts or {}).items():
        for aid in ids or []:
            a = str(aid or "").strip()
            if not a:
                continue
            db.execute(
                """
                INSERT OR IGNORE INTO evoflow_org_artifacts
                (org_instance_id, artifact_type, artifact_id, created_at)
                VALUES (?, ?, ?, ?)
                """,
                (org_instance_id, str(atype), a, now),
            )
    db.commit()
    return get_org_instance(org_instance_id) or {}


def mark_uninstalled(org_instance_id: str) -> None:
    oid = str(org_instance_id or "").strip()
    if not oid:
        return
    db = get_db()
    db.execute(
        "UPDATE evoflow_org_registry SET status = 'uninstalled' WHERE id = ?",
        (oid,),
    )
    db.commit()


def find_artifact_owner(artifact_type: str, artifact_id: str) -> str | None:
    """Return active org_instance_id that owns this artifact, if any."""
    row = get_db().execute(
        """
        SELECT a.org_instance_id
        FROM evoflow_org_artifacts a
        JOIN evoflow_org_registry r ON r.id = a.org_instance_id
        WHERE a.artifact_type = ? AND a.artifact_id = ? AND r.status = 'active'
        LIMIT 1
        """,
        (str(artifact_type), str(artifact_id)),
    ).fetchone()
    if not row:
        return None
    return str(row[0] or "") or None
