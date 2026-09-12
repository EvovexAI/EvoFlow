"""Plan Bundle public service API."""

from __future__ import annotations

import logging
import uuid
from typing import Any

from evoflow.plans import bindings as bindings_store
from evoflow.plans.adapters import get_adapter
from evoflow.plans.catalog import (
    get_catalog_entry,
    list_catalog_entries,
    tier_entitlements,
)
from evoflow.plans.errors import PlanError, PlanErrorCode
from evoflow.plans.resolver import resolve_capability as _resolve_capability

logger = logging.getLogger(__name__)


def _reload_chat_models() -> None:
    """Panel GET /models reads in-memory config; bind writes SQLite first."""
    try:
        from evoflow.config.app_config import reload_models_from_db

        reload_models_from_db()
    except Exception as exc:
        logger.warning("reload_models_from_db after plan bind failed: %s", exc)


def list_catalog() -> list[dict[str, Any]]:
    return list_catalog_entries()


def list_bindings(*, include_disabled: bool = True) -> list[dict[str, Any]]:
    return bindings_store.list_bindings(include_disabled=include_disabled, mask_key=True)


def get_binding(binding_id: str) -> dict[str, Any]:
    row = bindings_store.get_binding(binding_id, mask_key=True)
    if not row:
        raise PlanError(
            PlanErrorCode.BINDING_NOT_FOUND,
            f"绑定不存在：{binding_id}",
            details={"binding_id": binding_id},
        )
    return row


def create_binding(body: dict[str, Any]) -> dict[str, Any]:
    catalog_id = str(body.get("catalog_id") or body.get("catalogId") or "").strip()
    if not catalog_id:
        raise PlanError(PlanErrorCode.INVALID_REQUEST, "catalog_id 必填")
    catalog = get_catalog_entry(catalog_id)
    api_key = str(body.get("api_key") or body.get("apiKey") or "").strip()
    tier_id = str(body.get("tier_id") or body.get("tierId") or "").strip() or None
    display_name = str(body.get("display_name") or body.get("displayName") or catalog.get("name") or "").strip()
    overrides = body.get("overrides") if isinstance(body.get("overrides"), dict) else {}

    adapter = get_adapter(str(catalog["vendor"]), str(catalog["plan_family"]))
    adapter.validate_key(api_key, str(catalog["plan_family"]))

    caps = body.get("bound_capabilities") or body.get("boundCapabilities")
    if not isinstance(caps, list) or not caps:
        caps = tier_entitlements(catalog, tier_id)
    caps = [str(c) for c in caps]

    # Drop capabilities the tier does not include (e.g. video on Small).
    allowed = set(tier_entitlements(catalog, tier_id))
    caps = [c for c in caps if c in allowed]

    draft = {
        "id": str(body.get("id") or uuid.uuid4()),
        "catalog_id": catalog_id,
        "vendor": catalog["vendor"],
        "plan_family": catalog["plan_family"],
        "tier_id": tier_id,
        "api_key": api_key,
        "display_name": display_name,
        "bound_capabilities": caps,
        "overrides": overrides,
        "status": "active",
    }
    materialize_meta = adapter.materialize(draft, catalog)
    draft["linked_connection_ids"] = materialize_meta.get("linked_connection_ids") or []
    _reload_chat_models()

    row = bindings_store.insert_binding(draft)
    row["materialized"] = materialize_meta.get("materialized") or {}
    return row


def patch_binding(binding_id: str, body: dict[str, Any]) -> dict[str, Any]:
    existing = bindings_store.get_binding_secret(binding_id)
    if not existing:
        raise PlanError(
            PlanErrorCode.BINDING_NOT_FOUND,
            f"绑定不存在：{binding_id}",
            details={"binding_id": binding_id},
        )

    catalog = get_catalog_entry(str(existing["catalog_id"]))
    patch: dict[str, Any] = {}
    if "tier_id" in body or "tierId" in body:
        patch["tier_id"] = str(body.get("tier_id") or body.get("tierId") or "").strip() or None
    if "display_name" in body or "displayName" in body:
        patch["display_name"] = str(body.get("display_name") or body.get("displayName") or "").strip()
    if "status" in body:
        patch["status"] = str(body.get("status") or "").strip() or existing["status"]
    if "overrides" in body and isinstance(body["overrides"], dict):
        patch["overrides"] = body["overrides"]
    if "api_key" in body or "apiKey" in body:
        patch["api_key"] = str(body.get("api_key") or body.get("apiKey") or "").strip()

    # Recompute capabilities when tier changes (unless explicitly provided).
    if "bound_capabilities" in body or "boundCapabilities" in body:
        caps = body.get("bound_capabilities") or body.get("boundCapabilities") or []
        patch["bound_capabilities"] = [str(c) for c in caps]
    elif "tier_id" in patch:
        patch["bound_capabilities"] = tier_entitlements(catalog, patch.get("tier_id"))

    rematerialize = (
        bool(patch.get("api_key"))
        or "tier_id" in patch
        or "bound_capabilities" in patch
        or bool(body.get("rematerialize"))
    )
    updated = bindings_store.update_binding(binding_id, patch)

    if rematerialize and updated.get("status") == "active":
        secret = bindings_store.get_binding_secret(binding_id)
        assert secret is not None
        adapter = get_adapter(str(secret["vendor"]), str(secret["plan_family"]))
        if secret.get("api_key"):
            adapter.validate_key(str(secret["api_key"]), str(secret["plan_family"]))
            meta = adapter.materialize(secret, catalog)
            updated = bindings_store.update_binding(
                binding_id,
                {"linked_connection_ids": meta.get("linked_connection_ids") or []},
            )
            updated["materialized"] = meta.get("materialized") or {}
            _reload_chat_models()

    return updated


def delete_binding(binding_id: str) -> dict[str, Any]:
    existing = bindings_store.get_binding(binding_id, mask_key=True)
    if not existing:
        raise PlanError(
            PlanErrorCode.BINDING_NOT_FOUND,
            f"绑定不存在：{binding_id}",
            details={"binding_id": binding_id},
        )
    bindings_store.delete_binding_row(binding_id)
    return {"ok": True, "id": binding_id}


def resolve_capability(
    capability: str,
    *,
    vendor: str | None = None,
    binding_id: str | None = None,
    allow_missing: bool = True,
    redact_key: bool = True,
) -> dict[str, Any] | None:
    route = _resolve_capability(
        capability,
        vendor=vendor,
        binding_id=binding_id,
        allow_missing=allow_missing,
    )
    if route is None:
        return None
    out = dict(route)
    if redact_key and out.get("api_key"):
        key = str(out["api_key"])
        out["api_key"] = ("*" * min(max(len(key) - 4, 0), 12)) + key[-4:]
        out["api_key_configured"] = True
    return out


async def verify_binding(
    binding_id: str,
    *,
    capabilities: list[str] | None = None,
    model_ids: list[str] | None = None,
) -> dict[str, Any]:
    from evoflow.plans.verify import verify_binding as _verify

    return await _verify(
        binding_id,
        capabilities=capabilities,
        model_ids=model_ids,
    )
