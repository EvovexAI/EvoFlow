"""Persistence for evoflow_plan_bindings."""

from __future__ import annotations

import json
import uuid
from typing import Any

from evoflow.persistence.db import get_db, run_db_transaction
from evoflow.plans.errors import PlanError, PlanErrorCode
from evoflow.timeutil import utc_now_iso_z


def _loads_list(raw: Any) -> list[Any]:
    if isinstance(raw, list):
        return raw
    s = str(raw or "").strip()
    if not s:
        return []
    try:
        data = json.loads(s)
    except Exception:
        return []
    return data if isinstance(data, list) else []


def _loads_dict(raw: Any) -> dict[str, Any]:
    if isinstance(raw, dict):
        return raw
    s = str(raw or "").strip()
    if not s:
        return {}
    try:
        data = json.loads(s)
    except Exception:
        return {}
    return data if isinstance(data, dict) else {}


def _row_to_dict(row: tuple[Any, ...], *, mask_key: bool = True) -> dict[str, Any]:
    api_key = str(row[5] or "")
    if mask_key and api_key:
        api_key_out = ("*" * min(max(len(api_key) - 4, 0), 12)) + api_key[-4:]
        configured = True
    else:
        api_key_out = api_key
        configured = bool(api_key.strip())
    return {
        "id": str(row[0]),
        "catalog_id": str(row[1]),
        "vendor": str(row[2]),
        "plan_family": str(row[3]),
        "tier_id": str(row[4] or "") or None,
        "api_key": api_key_out if mask_key else api_key,
        "api_key_configured": configured,
        "display_name": str(row[6] or ""),
        "bound_capabilities": [str(x) for x in _loads_list(row[7])],
        "overrides": _loads_dict(row[8]),
        "status": str(row[9] or "active"),
        "last_probe_at": str(row[10] or "") or None,
        "soft_quota": _loads_dict(row[11]) if row[11] else None,
        "linked_connection_ids": [str(x) for x in _loads_list(row[12])],
        "created_at": str(row[13] or ""),
        "updated_at": str(row[14] or ""),
    }


_SELECT = """
    SELECT id, catalog_id, vendor, plan_family, tier_id, api_key, display_name,
           bound_capabilities_json, overrides_json, status, last_probe_at,
           soft_quota_json, linked_connection_ids_json, created_at, updated_at
    FROM evoflow_plan_bindings
"""


def list_bindings(*, include_disabled: bool = True, mask_key: bool = True) -> list[dict[str, Any]]:
    sql = _SELECT + " ORDER BY updated_at DESC"
    rows = get_db().execute(sql).fetchall()
    out = [_row_to_dict(r, mask_key=mask_key) for r in rows]
    if not include_disabled:
        out = [b for b in out if b.get("status") == "active"]
    return out


def get_binding(binding_id: str, *, mask_key: bool = True) -> dict[str, Any] | None:
    bid = str(binding_id or "").strip()
    if not bid:
        return None
    row = get_db().execute(_SELECT + " WHERE id = ?", (bid,)).fetchone()
    return _row_to_dict(row, mask_key=mask_key) if row else None


def get_binding_secret(binding_id: str) -> dict[str, Any] | None:
    """Return binding with plaintext api_key (runtime only)."""
    return get_binding(binding_id, mask_key=False)


def find_active_binding(
    *,
    vendor: str | None = None,
    plan_family: str | None = None,
    capability: str | None = None,
    mask_key: bool = True,
) -> dict[str, Any] | None:
    for b in list_bindings(include_disabled=False, mask_key=mask_key):
        if vendor and b.get("vendor") != vendor:
            continue
        if plan_family and b.get("plan_family") != plan_family:
            continue
        if capability and capability not in (b.get("bound_capabilities") or []):
            continue
        return b
    return None


def insert_binding(payload: dict[str, Any]) -> dict[str, Any]:
    now = utc_now_iso_z()
    binding_id = str(payload.get("id") or uuid.uuid4())
    caps = payload.get("bound_capabilities") or []
    overrides = payload.get("overrides") or {}
    linked = payload.get("linked_connection_ids") or []

    def _write(db: Any) -> None:
        # Deactivate other active bindings for same vendor+family (P0 single-active).
        db.execute(
            """
            UPDATE evoflow_plan_bindings
            SET status = 'disabled', updated_at = ?
            WHERE vendor = ? AND plan_family = ? AND status = 'active' AND id != ?
            """,
            (now, payload["vendor"], payload["plan_family"], binding_id),
        )
        db.execute(
            """
            INSERT INTO evoflow_plan_bindings (
                id, catalog_id, vendor, plan_family, tier_id, api_key, display_name,
                bound_capabilities_json, overrides_json, status, last_probe_at,
                soft_quota_json, linked_connection_ids_json, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                binding_id,
                payload["catalog_id"],
                payload["vendor"],
                payload["plan_family"],
                payload.get("tier_id"),
                str(payload.get("api_key") or ""),
                str(payload.get("display_name") or ""),
                json.dumps(list(caps), ensure_ascii=False),
                json.dumps(dict(overrides), ensure_ascii=False),
                str(payload.get("status") or "active"),
                payload.get("last_probe_at"),
                json.dumps(payload["soft_quota"], ensure_ascii=False)
                if payload.get("soft_quota") is not None
                else None,
                json.dumps(list(linked), ensure_ascii=False),
                now,
                now,
            ),
        )

    run_db_transaction(_write)
    row = get_binding(binding_id, mask_key=True)
    if not row:
        raise PlanError(PlanErrorCode.BINDING_NOT_FOUND, "绑定写入失败")
    return row


def update_binding(binding_id: str, patch: dict[str, Any]) -> dict[str, Any]:
    existing = get_binding_secret(binding_id)
    if not existing:
        raise PlanError(
            PlanErrorCode.BINDING_NOT_FOUND,
            f"绑定不存在：{binding_id}",
            details={"binding_id": binding_id},
        )
    now = utc_now_iso_z()
    api_key = existing["api_key"]
    if "api_key" in patch and patch["api_key"] is not None:
        incoming = str(patch["api_key"]).strip()
        if incoming and not incoming.startswith("*"):
            api_key = incoming

    tier_id = patch["tier_id"] if "tier_id" in patch else existing.get("tier_id")
    display_name = (
        str(patch["display_name"]).strip()
        if "display_name" in patch
        else existing.get("display_name") or ""
    )
    status = str(patch["status"]).strip() if "status" in patch else existing.get("status") or "active"
    caps = patch["bound_capabilities"] if "bound_capabilities" in patch else existing.get("bound_capabilities")
    overrides = patch["overrides"] if "overrides" in patch else existing.get("overrides")
    linked = (
        patch["linked_connection_ids"]
        if "linked_connection_ids" in patch
        else existing.get("linked_connection_ids")
    )
    soft_quota = patch["soft_quota"] if "soft_quota" in patch else existing.get("soft_quota")
    last_probe = patch["last_probe_at"] if "last_probe_at" in patch else existing.get("last_probe_at")

    def _write(db: Any) -> None:
        if status == "active":
            db.execute(
                """
                UPDATE evoflow_plan_bindings
                SET status = 'disabled', updated_at = ?
                WHERE vendor = ? AND plan_family = ? AND status = 'active' AND id != ?
                """,
                (now, existing["vendor"], existing["plan_family"], binding_id),
            )
        db.execute(
            """
            UPDATE evoflow_plan_bindings SET
                tier_id = ?,
                api_key = ?,
                display_name = ?,
                bound_capabilities_json = ?,
                overrides_json = ?,
                status = ?,
                last_probe_at = ?,
                soft_quota_json = ?,
                linked_connection_ids_json = ?,
                updated_at = ?
            WHERE id = ?
            """,
            (
                tier_id,
                api_key,
                display_name,
                json.dumps(list(caps or []), ensure_ascii=False),
                json.dumps(dict(overrides or {}), ensure_ascii=False),
                status,
                last_probe,
                json.dumps(soft_quota, ensure_ascii=False) if soft_quota is not None else None,
                json.dumps(list(linked or []), ensure_ascii=False),
                now,
                binding_id,
            ),
        )

    run_db_transaction(_write)
    row = get_binding(binding_id, mask_key=True)
    assert row is not None
    return row


def delete_binding_row(binding_id: str) -> bool:
    bid = str(binding_id or "").strip()
    if not bid:
        return False

    def _write(db: Any) -> None:
        db.execute("DELETE FROM evoflow_plan_bindings WHERE id = ?", (bid,))

    run_db_transaction(_write)
    return True
