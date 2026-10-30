"""Builtin tool tier/type catalog for DB sync, Gateway metadata, and EvoPanel UI.

Tiers (工具类型):
- runtime: 系统核心 — scenario / tool_search / ask_clarification
- core: 日常常驻 — CORE_TOOL_NAMES minus runtime spine
- workspace: 工作区场景 — activate agent 后可用（含联网）
- plan: 规划协作 — activate plan 后可用（plan / supervisor / collab 等）
- goal: 目标模式 — EvoPanel goal_mode 注入（propose_goal / goal_report）
- optional: 扩展可选 — 按需或 Agent 白名单
- retired: 已退役 — 不进 LLM（CLI/技能替代）
"""

from __future__ import annotations

import functools
from typing import Any, Literal

ToolTier = Literal["runtime", "core", "workspace", "plan", "goal", "optional", "retired"]

TOOL_TIER_ORDER: tuple[ToolTier, ...] = (
    "runtime",
    "core",
    "workspace",
    "plan",
    "goal",
    "optional",
    "retired",
)

TOOL_TIER_LABELS_ZH: dict[ToolTier, str] = {
    "runtime": "系统核心",
    "core": "日常常驻",
    "workspace": "工作区",
    "plan": "规划协作",
    "goal": "目标模式",
    "optional": "扩展可选",
    "retired": "已退役",
}

# EvoPanel role editor: only workspace + optional are user-configurable per agent.
# runtime / core / plan / goal tiers are mode-injected at runtime.
ROLE_EDITOR_CONFIGURABLE_TOOL_TIERS: frozenset[ToolTier] = frozenset({"workspace", "optional"})

# Session spine — always mode-managed; never shown in role editor or gated by agent whitelist.
# CORE_TOOL_NAMES (tool_search / mode_set) + deferred system tools (ask_clarification) +
# legacy aliases ``scenario`` / ``scenario_activation``.
SESSION_SYSTEM_TOOL_NAMES: frozenset[str] = frozenset(
    {
        "tool_search",
        "mode_set",
        "scenario",
        "scenario_activation",
        "ask_clarification",
    }
)

# Wire names for conversation mode activation (ask / agent / plan).
MODE_SET_TOOL_WIRE_NAMES: frozenset[str] = frozenset(
    {
        "mode_set",
        "scenario",
        "scenario_activation",
    }
)

# Alias kept for tier classification (same set as SESSION_SYSTEM_TOOL_NAMES).
RUNTIME_TOOL_NAMES: frozenset[str] = SESSION_SYSTEM_TOOL_NAMES

# Hosted goal mode — injected by EvoPanel goal flow; not role-configurable.
# goal_report retired: completion detection now handled solely by goal_reply_interpreter.
# Distinct from plan scenario (plan / supervisor / collab).
GOAL_MODE_SYSTEM_TOOL_NAMES: frozenset[str] = frozenset(
    {
        "propose_goal",
    }
)

# Plan-phase collaboration helpers (not in NON_CORE_TOOL_GROUPS).
_PLAN_COLLAB_TOOL_NAMES: frozenset[str] = frozenset(
    {
        "done",
        "progress",
        "checklist",
        "peer_send",
        "peer_read",
        "peer_reply",
    }
)

# Explicit optional overrides (not scenario-gated in profiles).
# Also merged into agent-mode deferred catalog (tool_search / pending activation).
_OPTIONAL_TOOL_NAMES: frozenset[str] = frozenset(
    {
        "invoke_acp_agent",
        "send_message",
        "session_workspace",
        # Knowledge: role-editor checkboxes must land in deferred catalogs or the
        # system prompt ``available-deferred-tools`` intersection drops them.
        "knowledge",
        # search_knowledge_base retired with uploaded-doc RAG
    }
)

# Agent 模式系统工具：``platform``（平台行政 + 右侧面板 ui.show/hide）。
# 原独立 ``panel_set`` 已并入 platform ``ui.*``，不再单独挂载。
# 自动挂载范围见 ``should_auto_mount_agent_mode_system_tools``：
#   main / 小V 默认带；普通员工与其它角色默认不带（``mount_platform_tools`` opt-in）；
#   IM 进线（ChannelManager 打标 channel）强制带，否则无法 channels.send_message。
AGENT_MODE_SYSTEM_TOOL_NAMES: frozenset[str] = frozenset({"platform"})

# Keep in sync with app.channels.manager.IM_CHANNEL_NAMES /
# evoflow.agents.lead_agent.prompt._IM_CHANNEL_NAMES.
_IM_CHANNEL_NAMES_FOR_PLATFORM: frozenset[str] = frozenset(
    {"feishu", "slack", "telegram", "weixin", "wecom", "dingtalk"}
)

# 中间件注入工具：不在原生工具注册表（get_available_tools）里，由 agent 中间件在
# 建图时挂载。按角色白名单按需注入：勾选才挂（未配置白名单 = 全量继承时默认挂），
# 子智能体按白名单勾选后由 SubagentExecutor 挂载。归 workspace tier 以进入角色编辑器清单。
MIDDLEWARE_TOOL_NAMES: frozenset[str] = frozenset({"todo_write"})

AGENT_OPTIONAL_DEFERRED_TOOL_NAMES: tuple[str, ...] = tuple(sorted(_OPTIONAL_TOOL_NAMES))


@functools.lru_cache(maxsize=1)
def _core_tool_names() -> frozenset[str]:
    from evoflow.agents.lead_agent.intent_tool_profile import CORE_TOOL_NAMES

    return frozenset(x.strip().lower() for x in CORE_TOOL_NAMES if x.strip())


@functools.lru_cache(maxsize=1)
def _plan_scenario_extra_tools() -> frozenset[str]:
    from evoflow.agents.lead_agent.intent_tool_profile import resolve_tools_for_scenarios

    return frozenset(resolve_tools_for_scenarios(["plan"])) - _core_tool_names()


@functools.lru_cache(maxsize=1)
def _workspace_scenario_extra_tools() -> frozenset[str]:
    from evoflow.agents.lead_agent.intent_tool_profile import resolve_tools_for_scenarios

    return frozenset(resolve_tools_for_scenarios(["agent"])) - _core_tool_names()


@functools.lru_cache(maxsize=1)
def _retired_tool_names() -> frozenset[str]:
    from evoflow.tools.tools import REMOVED_LEGACY_TOOL_NAMES

    return frozenset(str(x).strip().lower() for x in REMOVED_LEGACY_TOOL_NAMES)


def normalize_tool_name(name: str | None) -> str:
    return str(name or "").strip().lower()


def is_session_system_tool(name: str | None) -> bool:
    """True for ask-spine tools (clarify / mode_set / deferred tool search)."""
    return normalize_tool_name(name) in SESSION_SYSTEM_TOOL_NAMES


def is_mode_set_tool(name: str | None) -> bool:
    """True for conversation mode activation tool (``mode_set`` and legacy aliases)."""
    return normalize_tool_name(name) in MODE_SET_TOOL_WIRE_NAMES


def is_goal_mode_system_tool(name: str | None) -> bool:
    """True for EvoPanel hosted goal tools (propose card)."""
    return normalize_tool_name(name) in GOAL_MODE_SYSTEM_TOOL_NAMES


def is_agent_mode_system_tool(name: str | None) -> bool:
    """True for agent-mode system tools (``platform``, includes ui.* panels)."""
    return normalize_tool_name(name) in AGENT_MODE_SYSTEM_TOOL_NAMES


def is_im_inbound_channel(channel: str | None) -> bool:
    """True when ``channel`` is a stamped IM inbound origin (not Panel / voice)."""
    return str(channel or "").strip().lower() in _IM_CHANNEL_NAMES_FOR_PLATFORM


def should_auto_mount_agent_mode_system_tools(
    agent_name: str | None,
    *,
    mount_platform_tools: bool = False,
    im_channel: str | None = None,
) -> bool:
    """Whether ``platform`` should be auto-injected (no tools[] checkbox needed).

    - ``main`` (and legacy lead aliases): always
    - 小V (``xiaomi``): always (also force-merged in xiaomi tool_policy)
    - IM inbound (ChannelManager stamps ``channel``): always — need
      ``channels.send_message`` to push text/files back to the origin chat
    - employees / custom / subagent: only when ``mount_platform_tools=True``
      (or when ``platform`` is explicitly checked in ``agent.tools`` — see callers)
    """
    if mount_platform_tools:
        return True
    if is_im_inbound_channel(im_channel):
        return True
    code = str(agent_name or "").strip().lower()
    if code in {"main", "lead_agent", "default"}:
        return True
    try:
        from evoflow.agents.xiaomi.identity import is_xiaomi_agent

        if is_xiaomi_agent(agent_name):
            return True
    except Exception:
        pass
    return False


def tools_whitelist_requests_platform(tools: list[str] | tuple[str, ...] | None) -> bool:
    """True when role ``tools[]`` explicitly includes ``platform`` (opt-in for employees)."""
    if not tools:
        return False
    return any(is_agent_mode_system_tool(x) for x in tools)


def should_mount_platform_tool(
    agent_name: str | None,
    *,
    mount_platform_tools: bool = False,
    tools_whitelist: list[str] | tuple[str, ...] | None = None,
    im_channel: str | None = None,
) -> bool:
    """Runtime: mount ``platform`` for main/小V/IM inbound, kb opt-in, or tools[] check."""
    if should_auto_mount_agent_mode_system_tools(
        agent_name,
        mount_platform_tools=mount_platform_tools,
        im_channel=im_channel,
    ):
        return True
    return tools_whitelist_requests_platform(tools_whitelist)


def is_mode_managed_tool(name: str | None) -> bool:
    """True when runtime/mode injects the tool — excluded from role editor & whitelist.

    ``platform`` is **not** mode-managed for the editor: employees can opt-in via
    the tools checklist; auto-mount remains main/小V only.
    """
    if is_agent_mode_system_tool(name):
        return False
    if is_session_system_tool(name) or is_goal_mode_system_tool(name):
        return True
    tier = resolve_tool_tier(name)
    return tier in ("runtime", "core", "plan", "goal", "retired")


def is_role_editor_configurable_tool(name: str | None) -> bool:
    """True when a tool may appear in the agent role editor checklist."""
    if is_agent_mode_system_tool(name):
        return True
    if is_mode_managed_tool(name):
        return False
    tier = resolve_tool_tier(name)
    if tier == "retired":
        return False
    return tier in ROLE_EDITOR_CONFIGURABLE_TOOL_TIERS


def normalize_agent_tools_whitelist(tools: list[str] | None) -> list[str] | None:
    """Drop system/mode tool names from a role whitelist (``None`` = all configurable)."""
    if tools is None:
        return None
    out: list[str] = []
    seen: set[str] = set()
    for raw in tools:
        n = normalize_tool_name(raw)
        if not n or n in seen or not is_role_editor_configurable_tool(n):
            continue
        seen.add(n)
        out.append(n)
    return out


def resolve_tool_tier(name: str | None) -> ToolTier:
    """Classify a tool name into a display/runtime tier."""
    n = normalize_tool_name(name)
    if not n:
        return "optional"
    if n in _retired_tool_names():
        return "retired"
    if n in RUNTIME_TOOL_NAMES:
        return "runtime"
    if n in _core_tool_names():
        return "core"
    if n in _PLAN_COLLAB_TOOL_NAMES:
        return "plan"
    if n in GOAL_MODE_SYSTEM_TOOL_NAMES:
        return "goal"
    if n in AGENT_MODE_SYSTEM_TOOL_NAMES:
        # platform：workspace 分组，可勾选；默认不自动挂（main/小V 除外）
        return "workspace"
    if n in MIDDLEWARE_TOOL_NAMES:
        # Middleware-injected (todo_write): workspace tier so it shows in the role
        # editor "Agent" group; actual mounting is middleware-driven.
        return "workspace"
    if n in _OPTIONAL_TOOL_NAMES:
        return "optional"

    in_workspace = n in _workspace_scenario_extra_tools()
    in_plan = n in _plan_scenario_extra_tools()
    if in_workspace and in_plan:
        # e.g. search_code_index — workspace write path is primary.
        return "workspace"
    if in_workspace:
        return "workspace"
    if in_plan:
        return "plan"
    return "optional"


def tool_tier_label_zh(tier: ToolTier | str | None) -> str:
    key = str(tier or "optional").strip().lower()
    if key not in TOOL_TIER_LABELS_ZH:
        return TOOL_TIER_LABELS_ZH["optional"]
    return TOOL_TIER_LABELS_ZH[key]  # type: ignore[index]


def role_editor_tier_label_zh(tier: ToolTier | str | None) -> str:
    """Labels for EvoPanel role editor (workspace tier → Agent, not legacy「工作区」)."""
    key = str(tier or "optional").strip().lower()
    if key == "workspace":
        return "Agent"
    if key == "optional":
        return "扩展可选"
    return tool_tier_label_zh(key)  # type: ignore[arg-type]


def enrich_tool_catalog_fields(doc: dict[str, Any]) -> dict[str, Any]:
    """Add ``tool_type`` + ``tool_type_label`` to a tool document (DB / API)."""
    out = dict(doc)
    name = str(out.get("name") or "").strip()
    tier = resolve_tool_tier(name)
    out["tool_type"] = tier
    out["tool_type_label"] = tool_tier_label_zh(tier)
    out["role_editor_type_label"] = role_editor_tier_label_zh(tier)
    return out


def catalog_fields_for_tool_name(name: str) -> dict[str, str]:
    tier = resolve_tool_tier(name)
    return {
        "tool_type": tier,
        "tool_type_label": tool_tier_label_zh(tier),
        "role_editor_type_label": role_editor_tier_label_zh(tier),
    }


def tier_sort_key(tier: str | None) -> int:
    t = str(tier or "optional").strip().lower()
    try:
        return TOOL_TIER_ORDER.index(t)  # type: ignore[arg-type]
    except ValueError:
        return len(TOOL_TIER_ORDER)
