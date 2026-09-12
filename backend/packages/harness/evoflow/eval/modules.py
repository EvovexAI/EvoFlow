"""Eval case module taxonomy (产品七大模块 + 平台门禁 + 观测).

Case design SSOT lives in ``evoflow.eval.case_spec``; this module keeps
labels / resolve / enrich helpers used by API + UI.
"""

from __future__ import annotations

from typing import Any

from evoflow.eval.case_spec import (
    CASE_CATALOG,
    FLOW_LABELS,
    LEVEL_LABELS,
    PRIORITY_LABELS,
    catalog_by_id,
    is_smoke_case,
    module_case_design_view,
)

# Stable module keys used in DB params + UI filters
MODULE_LABELS: dict[str, str] = {
    "knowledge": "知识库",
    "agents": "智能体",
    "employees": "智能体员工",
    "skills": "技能",
    "mcp": "MCP",
    "workflow": "工作流",
    "tasks": "任务中心",
    "items": "待办事项",
    "platform": "平台门禁",
    "cross": "跨模块",
    "obs_business": "观测·业务",
    "obs_security": "观测·安全",
    "obs_performance": "观测·性能",
    "other": "其他",
}

# Built from catalog + legacy observational fallbacks
_CASE_MODULE: dict[str, str] = {
    str(c["id"]): str(c["module"]) for c in CASE_CATALOG
}

MODULE_CASE_DESIGN: dict[str, list[dict[str, str]]] = module_case_design_view()

MODULE_ORDER: list[str] = [
    "knowledge",
    "agents",
    "employees",
    "skills",
    "mcp",
    "workflow",
    "tasks",
    "items",
    "platform",
    "cross",
    "obs_business",
    "obs_security",
    "obs_performance",
    "other",
]


def resolve_module(case_id: str, *, category: str = "", params: dict[str, Any] | None = None) -> str:
    """Resolve module key for a case."""
    if isinstance(params, dict):
        m = str(params.get("module") or "").strip()
        if m in MODULE_LABELS:
            return m
    cid = str(case_id or "").strip()
    if cid in _CASE_MODULE:
        return _CASE_MODULE[cid]
    cat = str(category or "").strip().lower()
    if cat == "business":
        return "obs_business"
    if cat == "security":
        return "obs_security"
    if cat == "performance":
        return "obs_performance"
    if cid.startswith("sc_module_"):
        tail = cid[len("sc_module_") :]
        if tail.endswith("_detail"):
            tail = tail[: -len("_detail")]
        if tail in MODULE_LABELS:
            return tail
    return "other"


def module_label(module: str) -> str:
    return MODULE_LABELS.get(module, module or "其他")


def enrich_case_row(case: dict[str, Any]) -> dict[str, Any]:
    """Attach module / design / priority / flow onto a case dict."""
    params = case.get("params") if isinstance(case.get("params"), dict) else {}
    cid = str(case.get("id") or case.get("case_id") or "")
    mod = resolve_module(cid, category=str(case.get("category") or ""), params=params)
    case["module"] = mod
    case["module_label"] = module_label(mod)

    design = params.get("design") if isinstance(params.get("design"), dict) else None
    spec = catalog_by_id().get(cid)
    if design is None and spec:
        design = dict(spec.get("design") or {})
        # keep params in sync for API consumers
        params = {**params, "module": mod, "design": design, "priority": design.get("priority"), "flow": design.get("flow")}
        case["params"] = params
    if design:
        case["design"] = design
        case["priority"] = str(params.get("priority") or design.get("priority") or "")
        case["flow"] = str(params.get("flow") or design.get("flow") or "")
        case["flow_label"] = FLOW_LABELS.get(case["flow"], case["flow"])
        case["priority_label"] = PRIORITY_LABELS.get(case["priority"], case["priority"])
        case["level_label"] = LEVEL_LABELS.get(str(case.get("level") or ""), str(case.get("level") or ""))
    else:
        case.setdefault("design", {})
        case.setdefault("priority", str(params.get("priority") or ""))
        case.setdefault("flow", str(params.get("flow") or ""))
    return case


__all__ = [
    "CASE_CATALOG",
    "FLOW_LABELS",
    "LEVEL_LABELS",
    "MODULE_CASE_DESIGN",
    "MODULE_LABELS",
    "MODULE_ORDER",
    "PRIORITY_LABELS",
    "enrich_case_row",
    "is_smoke_case",
    "module_label",
    "resolve_module",
]
