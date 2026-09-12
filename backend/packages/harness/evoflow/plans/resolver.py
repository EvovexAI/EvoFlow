"""Capability → ResolvedRoute."""

from __future__ import annotations

from typing import Any

from evoflow.plans import bindings as bindings_store
from evoflow.plans.adapters import get_adapter
from evoflow.plans.catalog import get_catalog_entry, tier_allows_capability
from evoflow.plans.errors import PlanError, PlanErrorCode
from evoflow.plans.types import ResolvedRoute


def resolve_capability(
    capability: str,
    *,
    vendor: str | None = None,
    binding_id: str | None = None,
    allow_missing: bool = True,
) -> ResolvedRoute | None:
    """Resolve a capability to a Plan route.

    When no binding matches and ``allow_missing`` is True, returns None
    (caller falls back to BYOK). When False, raises ``plan_not_bound``.
    """
    cap = str(capability or "").strip()
    if not cap:
        raise PlanError(PlanErrorCode.INVALID_REQUEST, "capability 必填")

    binding: dict[str, Any] | None = None
    if binding_id:
        binding = bindings_store.get_binding_secret(binding_id)
        if not binding or binding.get("status") != "active":
            binding = None
    else:
        binding = bindings_store.find_active_binding(
            vendor=vendor,
            capability=cap,
            mask_key=False,
        )

    if not binding:
        if allow_missing:
            return None
        raise PlanError(
            PlanErrorCode.PLAN_NOT_BOUND,
            f"未绑定可用的 Plan（需要能力：{cap}）",
            details={"capability": cap},
        )

    overrides = binding.get("overrides") or {}
    disabled = overrides.get("disable_capabilities") or []
    if cap in disabled:
        raise PlanError(
            PlanErrorCode.CAPABILITY_NOT_IN_TIER,
            f"当前绑定已禁用能力：{cap}",
            details={"capability": cap, "binding_id": binding.get("id")},
        )

    if cap == "embedding" and overrides.get("prefer_local_embedding"):
        return {
            "capability": "embedding",  # type: ignore[typeddict-item]
            "binding_id": binding.get("id"),
            "base_url": "",
            "api_key": "",
            "headers": {},
            "model_hint": "local",
            "meter_tags": {
                "vendor": binding.get("vendor"),
                "plan_family": binding.get("plan_family"),
                "capability": "embedding",
                "local": True,
            },
            "source": "plan",
        }

    catalog = get_catalog_entry(str(binding["catalog_id"]))
    if not tier_allows_capability(catalog, binding.get("tier_id"), cap):
        raise PlanError(
            PlanErrorCode.CAPABILITY_NOT_IN_TIER,
            _tier_message(catalog, binding.get("tier_id"), cap),
            details={
                "capability": cap,
                "tier_id": binding.get("tier_id"),
                "catalog_id": catalog.get("id"),
            },
        )

    if cap not in (binding.get("bound_capabilities") or []):
        raise PlanError(
            PlanErrorCode.CAPABILITY_NOT_IN_TIER,
            f"当前绑定未启用能力：{cap}",
            details={"capability": cap, "binding_id": binding.get("id")},
        )

    adapter = get_adapter(str(binding["vendor"]), str(binding["plan_family"]))
    return adapter.build_route(binding, catalog, cap)  # type: ignore[return-value]


def assert_vendor_plan_allows(
    capability: str,
    *,
    vendor: str,
    plan_family: str | None = None,
) -> None:
    """Raise if an active binding for vendor forbids this capability.

    Unlike ``resolve_capability(..., capability=...)``, this still finds the
    binding when the capability was stripped from ``bound_capabilities`` (e.g.
    Small tier without video) so callers can show a product-level message.
    """
    cap = str(capability or "").strip()
    binding = bindings_store.find_active_binding(
        vendor=vendor,
        plan_family=plan_family,
        capability=None,
        mask_key=True,
    )
    if not binding:
        return
    overrides = binding.get("overrides") or {}
    disabled = overrides.get("disable_capabilities") or []
    if cap in disabled:
        raise PlanError(
            PlanErrorCode.CAPABILITY_NOT_IN_TIER,
            f"当前绑定已禁用能力：{cap}",
            details={"capability": cap, "binding_id": binding.get("id")},
        )
    catalog = get_catalog_entry(str(binding["catalog_id"]))
    if not tier_allows_capability(catalog, binding.get("tier_id"), cap):
        raise PlanError(
            PlanErrorCode.CAPABILITY_NOT_IN_TIER,
            _tier_message(catalog, binding.get("tier_id"), cap),
            details={
                "capability": cap,
                "tier_id": binding.get("tier_id"),
                "catalog_id": catalog.get("id"),
            },
        )
    if cap not in (binding.get("bound_capabilities") or []):
        raise PlanError(
            PlanErrorCode.CAPABILITY_NOT_IN_TIER,
            _tier_message(catalog, binding.get("tier_id"), cap),
            details={"capability": cap, "binding_id": binding.get("id")},
        )


def _tier_message(catalog: dict[str, Any], tier_id: str | None, capability: str) -> str:
    name = catalog.get("name") or catalog.get("id")
    tier = tier_id or "未选档位"
    if capability == "video":
        return (
            f"「{name}」当前档位（{tier}）不含视频生成。"
            "请升级到 Medium 及以上，或在绑定中更换档位。"
        )
    return f"「{name}」当前档位（{tier}）不含能力：{capability}"
