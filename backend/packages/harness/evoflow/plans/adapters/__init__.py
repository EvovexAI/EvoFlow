"""Vendor adapter protocol + registry."""

from __future__ import annotations

from typing import Any, Protocol

from evoflow.plans.adapters.volc_agent_plan import VolcAgentPlanAdapter
from evoflow.plans.errors import PlanError, PlanErrorCode


class VendorPlanAdapter(Protocol):
    vendor: str
    families: list[str]

    def validate_key(self, key: str, family: str) -> None: ...

    def materialize(self, binding: dict[str, Any], catalog: dict[str, Any]) -> dict[str, Any]: ...

    def build_route(
        self,
        binding: dict[str, Any],
        catalog: dict[str, Any],
        capability: str,
    ) -> dict[str, Any]: ...

    def map_error(self, text: str) -> PlanError | None: ...


_ADAPTERS: list[VendorPlanAdapter] = [
    VolcAgentPlanAdapter(),
]


def get_adapter(vendor: str, plan_family: str) -> VendorPlanAdapter:
    v = str(vendor or "").strip()
    f = str(plan_family or "").strip()
    for adapter in _ADAPTERS:
        if adapter.vendor == v and f in adapter.families:
            return adapter
    raise PlanError(
        PlanErrorCode.CATALOG_NOT_FOUND,
        f"暂不支持的套餐适配器：{v}/{f}",
        details={"vendor": v, "plan_family": f},
    )
