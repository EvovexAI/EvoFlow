"""Capability packs — curated tool allowlists for agent / employee create.

Product rule: create via ``capability_pack`` (or a short ``tools`` list). Do not dump
``agents.bindings`` wholesale into a role. ``tools: null`` (inherit-all) is opt-in and
forbidden for employee create unless explicitly confirmed.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

# Soft ceiling: longer allowlists need ``confirm_wide_tools=true``.
MAX_ALLOWLIST_TOOLS = 12

# Known pack ids (``custom`` / ``none`` are special).
PACK_NONE = "none"
PACK_CUSTOM = "custom"


@dataclass(frozen=True)
class CapabilityPack:
    """Named capability bundle for create-time binding."""

    id: str
    label_zh: str
    description: str
    tools: tuple[str, ...]
    skills: tuple[str, ...] = ()
    mcp_servers: tuple[str, ...] = ()
    risk: str = "low"  # low | medium | high


# Curated packs map onto role-editor configurable tools (see tool_catalog tiers).
# Runtime system tools (platform / panel_set / mode_set / …) are not listed here.
CAPABILITY_PACKS: dict[str, CapabilityPack] = {
    PACK_NONE: CapabilityPack(
        id=PACK_NONE,
        label_zh="无业务工具",
        description="空白名单；仅运行时系统工具。适合只对话或后续再绑。",
        tools=(),
        risk="low",
    ),
    "research": CapabilityPack(
        id="research",
        label_zh="调研检索",
        description="联网搜索与只读查阅；无写盘、无终端。",
        tools=("web_search", "fetch_url", "read", "knowledge"),
        risk="low",
    ),
    "writer": CapabilityPack(
        id="writer",
        label_zh="文案文档",
        description="读写文档与知识库；无终端、无删库级危险操作以外的 shell。",
        tools=("read", "write", "replace", "knowledge"),
        risk="medium",
    ),
    "duty": CapabilityPack(
        id="duty",
        label_zh="值班运维",
        description="岗位工单与轻量只读；适合智能员工巡检交班。",
        tools=("tasks", "todo", "read", "knowledge"),
        risk="low",
    ),
    "coding": CapabilityPack(
        id="coding",
        label_zh="工程编码",
        description="工作区读写、终端与代码检索；权限最宽的常用包。",
        tools=(
            "bash",
            "taskoutput",
            "taskstop",
            "read",
            "write",
            "replace",
            # "delete",  # retired — 删除走 Bash rm（审批兜底），对齐 ZCode
            "search_code_index",
            # "read_lints",  # retired — 诊断走 Bash（pyright/ruff）
            "todo",
            "subagent",
        ),
        risk="high",
    ),
    PACK_CUSTOM: CapabilityPack(
        id=PACK_CUSTOM,
        label_zh="自定义",
        description="由调用方传入 tools / tools_extra；勿把 bindings 全表灌入。",
        tools=(),
        risk="medium",
    ),
}


def list_capability_packs() -> list[dict[str, Any]]:
    """Rows for ``agents.bindings`` — packs are the preferred create entry."""
    rows: list[dict[str, Any]] = []
    for pack in CAPABILITY_PACKS.values():
        rows.append(
            {
                "id": pack.id,
                "label": pack.label_zh,
                "description": pack.description,
                "tools": list(pack.tools),
                "skills": list(pack.skills),
                "mcp_servers": list(pack.mcp_servers),
                "risk": pack.risk,
                "tool_count": len(pack.tools),
            }
        )
    return rows


def get_capability_pack(pack_id: str | None) -> CapabilityPack | None:
    key = str(pack_id or "").strip().lower()
    if not key:
        return None
    return CAPABILITY_PACKS.get(key)


def _dedupe_preserve(names: list[str]) -> list[str]:
    out: list[str] = []
    seen: set[str] = set()
    for raw in names:
        n = str(raw or "").strip()
        if not n:
            continue
        low = n.lower()
        if low in seen:
            continue
        seen.add(low)
        out.append(n)
    return out


def _as_str_list(value: Any) -> list[str]:
    if value is None:
        return []
    if isinstance(value, str):
        parts = [p.strip() for p in value.replace(";", ",").split(",")]
        return _dedupe_preserve([p for p in parts if p])
    if isinstance(value, (list, tuple)):
        return _dedupe_preserve([str(x) for x in value])
    raise ValueError(f"expected string or list of tool names, got {type(value).__name__}")


def _truthy_flag(data: dict[str, Any], *keys: str) -> bool:
    for key in keys:
        if key not in data:
            continue
        val = data.get(key)
        if val is True or val == 1:
            return True
        if isinstance(val, str) and val.strip().lower() in {"1", "true", "yes", "y", "on"}:
            return True
    return False


def apply_capability_pack_to_create_payload(
    data: dict[str, Any],
    *,
    forbid_inherit_all: bool = False,
) -> dict[str, Any]:
    """Normalize create payload: resolve ``capability_pack`` / ``tools_extra`` / wide-list guards.

    Returns a shallow copy. Create-time-only keys are consumed and removed from the copy
    so they are not persisted onto AgentConfig.

    Raises:
        ValueError: invalid pack, conflicting fields, inherit-all / wide-list without confirm.
    """
    if not isinstance(data, dict):
        raise ValueError("payload must be a JSON object")

    out = dict(data)
    pack_raw = out.pop("capability_pack", None)
    if pack_raw is None and "capabilityPack" in out:
        pack_raw = out.pop("capabilityPack", None)

    tools_extra_raw = out.pop("tools_extra", None)
    if tools_extra_raw is None and "toolsExtra" in out:
        tools_extra_raw = out.pop("toolsExtra", None)

    confirm_inherit = _truthy_flag(out, "confirm_inherit_all", "confirmInheritAll")
    confirm_wide = _truthy_flag(out, "confirm_wide_tools", "confirmWideTools")
    # Do not persist confirm flags onto agent config.
    for k in (
        "confirm_inherit_all",
        "confirmInheritAll",
        "confirm_wide_tools",
        "confirmWideTools",
    ):
        out.pop(k, None)

    pack_id = str(pack_raw or "").strip().lower() or None
    pack = get_capability_pack(pack_id) if pack_id else None
    if pack_id and pack is None:
        known = ", ".join(sorted(CAPABILITY_PACKS))
        raise ValueError(f"unknown capability_pack '{pack_id}'. Known: {known}")

    try:
        tools_extra = _as_str_list(tools_extra_raw) if tools_extra_raw is not None else []
    except ValueError as exc:
        raise ValueError(f"tools_extra: {exc}") from exc

    has_tools_key = "tools" in out
    tools_val = out.get("tools") if has_tools_key else None

    # --- Resolve tools ---
    if pack is not None and pack.id not in {PACK_CUSTOM}:
        if has_tools_key and tools_val is not None:
            raise ValueError(
                "capability_pack already supplies tools; omit tools or use tools_extra to extend, "
                "or set capability_pack=custom with an explicit tools allowlist"
            )
        if has_tools_key and tools_val is None:
            raise ValueError(
                "cannot combine capability_pack with tools:null; "
                "omit tools and use the pack (or capability_pack=custom + confirm_inherit_all)"
            )
        merged = _dedupe_preserve([*pack.tools, *tools_extra])
        out["tools"] = merged
        out["_capability_pack_applied"] = pack.id
        # Soft-fill skills / mcp only when omitted.
        if "skills" not in out and pack.skills:
            out["skills"] = list(pack.skills)
        if "mcp_servers" not in out and pack.mcp_servers:
            out["mcp_servers"] = list(pack.mcp_servers)
    elif pack is not None and pack.id == PACK_CUSTOM:
        out["_capability_pack_applied"] = PACK_CUSTOM
        if tools_extra and has_tools_key and tools_val is not None:
            base = _as_str_list(tools_val)
            out["tools"] = _dedupe_preserve([*base, *tools_extra])
        elif tools_extra and not has_tools_key:
            out["tools"] = tools_extra
        # else: leave tools as caller set (including null / omit)
    elif tools_extra:
        # No pack: tools_extra extends explicit tools, or becomes the allowlist.
        if has_tools_key and tools_val is None:
            raise ValueError("tools_extra cannot be combined with tools:null")
        if has_tools_key and tools_val is not None:
            out["tools"] = _dedupe_preserve([*_as_str_list(tools_val), *tools_extra])
        else:
            out["tools"] = tools_extra

    # --- Inherit-all guard ---
    if "tools" in out and out.get("tools") is None:
        if forbid_inherit_all and not confirm_inherit:
            raise ValueError(
                "employees must not use tools:null (inherit-all). "
                "Pass capability_pack (research|writer|duty|coding|none) or a short tools allowlist; "
                "or confirm_inherit_all=true if you truly need every configurable tool"
            )
        if not forbid_inherit_all and not confirm_inherit:
            # agents.create: still allow, but require confirm to reduce accidental dumps
            raise ValueError(
                "tools:null inherits all configurable tools. "
                "Prefer capability_pack or a short tools allowlist; "
                "pass confirm_inherit_all=true only when intentional"
            )

    # --- Wide allowlist guard ---
    resolved = out.get("tools")
    if isinstance(resolved, list) and len(resolved) > MAX_ALLOWLIST_TOOLS and not confirm_wide:
        raise ValueError(
            f"tools allowlist has {len(resolved)} entries (max {MAX_ALLOWLIST_TOOLS} without confirm). "
            f"Prefer capability_pack, or pass confirm_wide_tools=true after reviewing agents.bindings packs"
        )

    return out


def pack_hint_for_bindings() -> str:
    return (
        "优先传 capability_pack（research|writer|duty|coding|none），"
        f"可用 tools_extra 少量追加；自定义再用 tools 白名单（≤{MAX_ALLOWLIST_TOOLS}）。"
        "禁止把本目录 tools 全表灌进员工；tools:null 需 confirm_inherit_all。"
    )
