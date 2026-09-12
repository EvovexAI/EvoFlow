from __future__ import annotations

import functools
from collections.abc import Iterable
from dataclasses import dataclass


@dataclass(frozen=True)
class TaskScenarioProfile:
    key: str
    zh_description: str
    tool_groups: tuple[str, ...]
    extra_tool_names: tuple[str, ...] = ()
    signals: str = ""
    boundaries: str = ""


ScenarioKey = str


def normalize_scenario_key(value: str | None) -> ScenarioKey:
    """Normalize any legacy intent/scenario hint into current mode key (ask / agent / plan).

  Mode keys (canonical, match UI Ask / Agent / Plan):
    - ask: 默认对话
    - plan: 规划与调度执行（`plan` 提交正文 + `supervisor` 编排）
    - agent: Agent 模式（本地代码检索、读写改删、命令执行、联网检索）

    Legacy aliases ``chat`` / ``workspace`` / ``web`` are still accepted.

    治理/自我进化走 evoflow-admin 技能 + terminal + evoflow CLI，无独立 manage/evolve 模式。
    """
    raw = (value or "").strip().lower()
    if raw in {"trae", "trae_window", "trae-runtime", "trae_runtime"}:
        return "ask"
    if raw in {"evolve", "evolution", "self_evolve", "self-improve", "self_improve", "improve", "optimize"}:
        return "ask"
    if raw in {"work", "do", "task", "execute", "plan"}:
        return "plan"
    if raw in {"agent", "workspace", "workspaces", "file", "files", "file_ops", "filesystem", "edit_file"}:
        return "agent"
    if raw in {"web", "search", "research", "browse"}:
        return "agent"
    if raw in {"manage", "admin", "govern"}:
        return "ask"
    if raw in {"ask", "chat", "qa", "question"}:
        return "ask"
    if raw in {"creative", "media", "video", "image", "art", "design", "short_video", "short-video"}:
        return "ask"
    if raw in {"planning", "debug", "debugging", "troubleshoot", "implement", "coding", "code", "edit", "review", "audit", "general"}:
        return "plan"
    return "ask"


# UI session modes → mode keys (see gateway chat_sessions _SESSION_MODE_DEFINITIONS)
SESSION_MODE_SCENARIO_MAP: dict[str, str] = {
    "ask": "ask",
    "agent": "agent",
    "plan": "plan",
}

# Mode keys → UI labels (Ask / Agent / Plan)
SCENARIO_KEY_MODE_LABEL: dict[str, str] = {
    "ask": "Ask",
    "agent": "Agent",
    "plan": "Plan",
}


def scenario_key_to_mode_label(key: str | None) -> str:
    """Map mode key (ask/agent/plan) to UI label."""
    k = normalize_scenario_key(str(key or "").strip())
    return SCENARIO_KEY_MODE_LABEL.get(k, k or "Ask")


def format_active_modes_for_display(active_keys: Iterable[str]) -> str:
    """Comma-separated Ask / Agent / Plan line for ``<session_mode_policy>``."""
    ordered = ordered_scenario_keys_for_display(active_keys)
    if not ordered:
        return "Ask (baseline)"
    return ", ".join(scenario_key_to_mode_label(k) for k in ordered)


def scenario_keys_from_session_mode(session_mode: str | None) -> list[str]:
    """Map persisted UI mode to scenario key(s) when activated_scenarios row is empty."""
    sm = str(session_mode or "").strip().lower()
    key = SESSION_MODE_SCENARIO_MAP.get(sm)
    if not key or key == "ask":
        return []
    return [key]


def resolve_active_scenario_keys_for_display(
    *,
    intent_hint: str | None = None,
    session_mode: str | None = None,
    activated_keys: Iterable[str] | None = None,
) -> list[str]:
    """Ordered non-chat scenario keys for mode display (maps to Ask / Agent / Plan)."""
    seen: set[str] = set()
    collected: list[str] = []

    def _push(raw: str) -> None:
        k = normalize_scenario_key(str(raw or "").strip())
        if not k or k == "ask" or k in seen:
            return
        seen.add(k)
        collected.append(k)

    for raw in activated_keys or []:
        _push(str(raw))
    if collected:
        return ordered_scenario_keys_for_display(collected)

    raw_hint = str(intent_hint or "").strip()
    if raw_hint:
        for part in raw_hint.split(","):
            _push(part.strip())
    if collected:
        return ordered_scenario_keys_for_display(collected)

    for k in scenario_keys_from_session_mode(session_mode):
        _push(k)
    return ordered_scenario_keys_for_display(collected)


# 基础 chat 工具：ask_clarification 改为延迟加载（见 DEFERRED_SYSTEM_TOOL_NAMES）
# 读文件、rg、terminal、worker、subagent、todo 等随 session_mode / 白名单绑定
CORE_TOOL_NAMES: tuple[str, ...] = (
    # "mode_set",  # 暂不常驻：用户在界面切 plan/agent；逻辑保留在 scenario_activation
)

# 系统级延迟加载工具
DEFERRED_SYSTEM_TOOL_NAMES: tuple[str, ...] = (
    "ask_clarification",
)

# 冷启动首轮：当前无核心工具，全部走 deferred + tool_search
BOOTSTRAP_TOOL_NAMES: tuple[str, ...] = (*CORE_TOOL_NAMES,)

# Plan 协作：除 CORE 外须 eager 绑定 schema（与 plan_guard PLANNING_ALLOWED / prompt 一致）。
# propose_goal 仍 deferred（EvoPanel 外层触发）；plan 模式执行期 terminal/rg 等仍走 deferred + tool_search。
PLAN_SCENARIO_EAGER_TOOL_NAMES: tuple[str, ...] = (
    "plan",
    "supervisor",
    "subagent",
    "read",
    "list_agents",
    "collab_peer_send",
    "collab_peer_read",
    "collab_peer_reply",
    "search_code_index",
)

# P1 渐进加载：scenario 激活后仅 eager 工具立即绑定 schema；其余进 deferred（tool_search 按需加载）。
# 全量并集仍见 ``resolve_tools_for_scenarios`` / ``NON_CORE_TOOL_GROUPS``。
# Agent 模式系统必带：``platform``（平台行政）+ ``panel_set``（右侧面板）— 不可 deferred / 不可被角色白名单摘掉。
SCENARIO_EAGER_TOOL_NAMES: dict[str, tuple[str, ...]] = {
    "agent": (
        "read",
        "rg",
        "replace",
        "write",
        "delete",
        "mind_map",
        "tasks",
        "platform",
        "panel_set",
        "terminal",
        "search_code_index",
    ),
    "plan": PLAN_SCENARIO_EAGER_TOOL_NAMES,
}

# UI session_mode → bound / deferred tool enums (binding table + runtime; no tool_groups indirection).
SESSION_MODE_CATALOG: tuple[str, ...] = ("ask", "agent", "plan")
DEFAULT_SESSION_MODE = "ask"


def _dedupe_tool_names(*groups: Iterable[str]) -> tuple[str, ...]:
    out: list[str] = []
    seen: set[str] = set()
    for group in groups:
        for raw in group:
            n = str(raw or "").strip().lower()
            if not n or n in seen:
                continue
            seen.add(n)
            out.append(n)
    return tuple(out)


SESSION_MODE_BOUND_TOOLS: dict[str, tuple[str, ...]] = {
    "ask": CORE_TOOL_NAMES,
    "agent": _dedupe_tool_names(CORE_TOOL_NAMES, SCENARIO_EAGER_TOOL_NAMES["agent"]),
    "plan": _dedupe_tool_names(CORE_TOOL_NAMES, SCENARIO_EAGER_TOOL_NAMES["plan"]),
}

def _agent_mode_deferred_tool_names() -> tuple[str, ...]:
    from evoflow.tools.tool_catalog import AGENT_OPTIONAL_DEFERRED_TOOL_NAMES

    return _dedupe_tool_names(
        (
            # "worker",  # temporarily unregistered (code retained)
            "process",
            "browser",
            "web_search",
            "fetch_url",
            "subagent",
            "todo",
            "find",
            "view_image",
            "trace_call_chain",
            "read_lints",
            "assets",
        ),
        AGENT_OPTIONAL_DEFERRED_TOOL_NAMES,
    )


SESSION_MODE_DEFERRED_CATALOG: dict[str, tuple[str, ...]] = {
    # Ask: keep spine small, but allow docs/RAG tools when the role whitelist includes them.
    "ask": _dedupe_tool_names(
        DEFERRED_SYSTEM_TOOL_NAMES,
        ("knowledge", "assets"),
    ),
    "agent": _dedupe_tool_names(_agent_mode_deferred_tool_names(), DEFERRED_SYSTEM_TOOL_NAMES),
    "plan": _dedupe_tool_names(
        (
            "propose_goal",
            "terminal",
            "bash",
            "process",
            "rg",
            "find",
            "mind_map",
            # "worker",  # temporarily unregistered (code retained)
            "todo",
            "knowledge",
        ),
        DEFERRED_SYSTEM_TOOL_NAMES,
    ),
}


def normalize_session_mode(mode: str | None) -> str:
    m = str(mode or "").strip().lower()
    if m in ("", "auto", "chat"):
        return DEFAULT_SESSION_MODE
    if m in SESSION_MODE_CATALOG:
        return m
    return DEFAULT_SESSION_MODE


def bound_tools_for_session_mode(mode: str | None) -> tuple[str, ...]:
    return SESSION_MODE_BOUND_TOOLS[normalize_session_mode(mode)]


def deferred_catalog_for_session_mode(mode: str | None) -> tuple[str, ...]:
    return SESSION_MODE_DEFERRED_CATALOG[normalize_session_mode(mode)]


def flat_bound_tool_names_for_session_mode(mode: str | None) -> tuple[str, ...]:
    """Full mode grant when deferred loading is disabled.

    Union of SESSION_MODE_BOUND + SESSION_MODE_DEFERRED.
    """
    m = normalize_session_mode(mode)
    return tuple(
        _dedupe_tool_names(
            bound_tools_for_session_mode(m),
            deferred_catalog_for_session_mode(m),
        )
    )


def resolve_eager_tool_names_for_scenarios(scenarios: Iterable[str]) -> frozenset[str]:
    """Names bound to the model when scenarios are active (CORE + Tier-1 eager per mode)."""
    names: set[str] = set(CORE_TOOL_NAMES)
    for raw in scenarios:
        key = normalize_scenario_key(str(raw or "").strip())
        if not key or key == "ask":
            continue
        for tool_name in SCENARIO_EAGER_TOOL_NAMES.get(key, ()):
            n = str(tool_name or "").strip()
            if n:
                names.add(n)
    return frozenset(x.strip().lower() for x in names if str(x or "").strip())


def _agent_scenario_active(scenarios: list[str]) -> bool:
    return any(normalize_scenario_key(str(s or "").strip()) == "agent" for s in scenarios)


def _merge_agent_optional_deferred(names: Iterable[str]) -> list[str]:
    from evoflow.tools.tool_catalog import AGENT_OPTIONAL_DEFERRED_TOOL_NAMES

    return sorted({str(t).strip().lower() for t in names if str(t or "").strip()} | set(AGENT_OPTIONAL_DEFERRED_TOOL_NAMES))


def resolve_deferred_tool_names_for_scenarios(scenarios: list[str]) -> list[str]:
    """Scenario-granted tools that are not Tier-1 eager (for docs/tests)."""
    granted = {str(t).strip().lower() for t in resolve_tools_for_scenarios(scenarios)}
    eager = resolve_eager_tool_names_for_scenarios(scenarios)
    deferred = sorted(granted - eager)
    if _agent_scenario_active(scenarios):
        deferred = _merge_agent_optional_deferred(deferred)
    return deferred


def _scenario_eager_tools_enabled() -> bool:
    import os

    raw = str(os.getenv("EVOFLOW_SCENARIO_EAGER_TOOLS", "1") or "").strip().lower()
    return raw not in {"0", "false", "no", "off"}


def build_scenario_tools_payload(
    scenarios: list[str],
    *,
    session_key: str | None = None,
    loaded_deferred: list[str] | None = None,
) -> dict[str, list[str]]:
    """Tool lists for ``scenario`` tool JSON (eager bound vs deferred vs full grant)."""
    sk = str(session_key or "").strip()
    if sk:
        try:
            from evoflow.session_tool_binding.agent_tools import (
                bound_tools_for_session_agent,
                deferred_catalog_for_session_agent,
                pending_activation_for_session_agent,
            )
            from evoflow.session_tool_binding.service import resolve_current_binding_mode

            mode = resolve_current_binding_mode(sk, scenarios)
            activated = bound_tools_for_session_agent(sk, mode)
            deferred = pending_activation_for_session_agent(sk, mode, loaded_deferred=loaded_deferred)
            granted = sorted({*activated, *deferred_catalog_for_session_agent(sk, mode)})
            return {
                "activated_tools": activated,
                "deferred_tools": deferred,
                "all_granted_tools": granted,
            }
        except Exception:
            pass

    granted = resolve_tools_for_scenarios(scenarios)
    if _agent_scenario_active(scenarios):
        granted = _merge_agent_optional_deferred(granted)
    if _scenario_eager_tools_enabled():
        activated = sorted(resolve_eager_tool_names_for_scenarios(scenarios))
        deferred = resolve_deferred_tool_names_for_scenarios(scenarios)
    else:
        activated = granted
        deferred = []
    return {
        "activated_tools": activated,
        "deferred_tools": deferred,
        "all_granted_tools": granted,
    }


# 非基础工具分类（便于你分析"总工具"）
# 说明：这里只放"除基础能力之外"的工具。
NON_CORE_TOOL_GROUPS: dict[str, dict[str, tuple[str, ...] | str]] = {
    "workspace_baseline": {
        "zh_description": "工作区基础：read/rg/find/terminal/todo/subagent/mind_map/tasks（须 activate workspace）",
        "tools": (
            "read",
            "rg",
            "find",
            "terminal",
            # "worker",  # temporarily unregistered (code retained)
            "todo",
            "subagent",
            "mind_map",
        ),
    },
    "plan_orchestration": {
        "zh_description": "规划与调度：提交 Plan 与 supervisor 编排；只读摸底可 subagent",
        "tools": ("plan", "supervisor", "subagent"),
    },
    "file_ops": {
        "zh_description": "工作区写删与进程：read+replace/write/delete；多文件改写委派 subagent；search_code_index、trace_call_chain、read_lints、process",
        "tools": (
            "write",
            "replace",
            "delete",
            "search_code_index",
            "trace_call_chain",
            "read_lints",
            "process",
        ),
    },
    "file_ops_read_present": {
        "zh_description": "规划阶段只读检索：索引 search_code_index（大结果路径用 read；rg 在 workspace_baseline）",
        "tools": (
            "search_code_index",
        ),
    },
    "web_research": {
        "zh_description": "联网检索（agent 场景）：搜索、网页拉取、交互式浏览器（browser 工具，延迟激活）；截图理解用 view_image",
        "tools": (
            "web_search",
            "fetch_url",
            "browser",
            "view_image",
        ),
    },
    "orchestration": {
        "zh_description": "任务编排与多代理协作：调度、跨平台消息",
        "tools": ("supervisor", "send_message", "claude-code"),
    },
    "memory_profile": {
        "zh_description": "实体资产（记忆/过程/反思/经验）：统一 assets(search|read|list|note)",
        "tools": ("assets",),
    },
    "entity_assets": {
        "zh_description": "实体资产（记忆/过程/反思/经验）：统一 assets(search|read|list|note)",
        "tools": ("assets",),
    },
    "agent_governance": {
        "zh_description": "智能体与技能治理（已迁移至 evoflow-admin 技能 + evoflow CLI + terminal）",
        "tools": (),
    },
    "visual": {
        "zh_description": "视觉理解：本地路径或 http/https 图片 URL 均用 view_image",
        "tools": ("view_image",),
    },
    "messaging": {
        "zh_description": "跨平台消息发送：Telegram、Discord、Slack",
        "tools": ("send_message",),
    },
    "external_agent": {
        "zh_description": "外部 ACP 智能体调用",
        "tools": ("invoke_acp_agent",),
    },
    "hosted_panel": {
        "zh_description": "EvoPanel 目标方案卡片（无服务端副作用，用户在客户端确认后启动目标）",
        "tools": ("propose_goal",),
    },
    "hosted_goal": {
        "zh_description": "目标模式运行时工具（goal_report 已下线，完成检测由判定模型处理）",
        "tools": (),
    },
}


# 会话模式配置（键 ask / agent / plan，与 UI Ask / Agent / Plan 一致）
# zh_description / signals / boundaries 为 scenario 工具与枚举的单一数据源；
# system prompt 的 <session_mode_policy> 只保留精简路由，细则见 scenario_key 枚举。
TASK_SCENARIO_PROFILES: dict[str, TaskScenarioProfile] = {
    "ask": TaskScenarioProfile(
        key="ask",
        zh_description="**Ask**（默认）：问答与轻量对话；仅核心工具。",
        tool_groups=("entity_assets",),
        signals="概念解释、普通问答、非执行型交流。",
        boundaries="用户要求落地执行时须 activate agent 或 plan，勿停留 ask。",
    ),
    "plan": TaskScenarioProfile(
        key="plan",
        zh_description="**Plan**：`plan` 落库并经执行确认后，再用 `supervisor` 编排；文件只读。",
        tool_groups=("plan_orchestration", "file_ops_read_present", "hosted_panel", "entity_assets"),
        extra_tool_names=(
            "read",
            "list_agents",
            "collab_peer_send",
            "collab_peer_read",
            "collab_peer_reply",
        ),
        signals="先规划后执行、多子任务编排与监督推进。",
        boundaries=(
            "plan 独占（激活会清 agent）。"
            "全流程 done 后系统自动切 agent。"
            "卡壳或用户要换模式：须先 supervisor 取消/失败主任务，勿半途 bypass。"
            "Gateway 定时 automation 不是 plan，用 tool_search 后直接调，勿 activate plan。"
        ),
    ),
    "agent": TaskScenarioProfile(
        key="agent",
        zh_description="**Agent**：项目代码/仓库的检索、读写、命令与联网（含 web_search/web_fetch）。",
        tool_groups=("workspace_baseline", "file_ops", "web_research", "entity_assets"),
        extra_tool_names=("tasks", "platform", "panel_set"),
        signals="改文件、跑命令、查代码、联网调研或任何项目仓库落地操作。",
        boundaries="任务编排优先 plan；无 agent 时禁止代码操作与 web_search/web_fetch。",
    ),
}


def format_scenario_key_enum_description() -> str:
    """Per-enum descriptions for ``mode_set`` tool ``mode`` JSON schema field."""
    lines: list[str] = [
        "模式键 ask / agent / plan（与 UI 一致；plan 独占；以每次返回的 activated_tools 为准）。",
        "",
    ]
    for key in ACTIVATABLE_SCENARIO_KEYS:
        profile = TASK_SCENARIO_PROFILES[key]
        names = resolve_tools_for_scenarios([key])
        extra = [f"`{t}`" for t in names if t not in CORE_TOOL_NAMES]
        lines.append(f"- **{key}**：{profile.zh_description}")
        if extra:
            lines.append(f"  工具：{', '.join(extra)}")
        if profile.signals:
            lines.append(f"  何时启用：{profile.signals}")
        if profile.boundaries:
            lines.append(f"  边界：{profile.boundaries}")
        lines.append("")
    lines.append("按下一步要用的工具 activate 对应键；细则见 workspace-code-workflow / evoflow-plan-workflow 等技能。")
    return "\n".join(lines)


def format_scenario_tool_description() -> str:
    """Short ``mode_set`` tool description; details live in ``mode`` enum."""
    return (
        "激活或停用 Ask / Agent / Plan 对话模式（非 panel_set 右侧面板）。"
        "未激活时非核心工具返回 ScenarioNotActivated，须先 activate 再重试。"
        "activate ask 清空其它模式；plan 独占。返回 JSON：all_active_scenarios、activated_tools（已绑 schema）、"
        "deferred_tools、all_granted_tools（模式授权全量）。"
        "各模式工具、启用信号与边界见参数 mode 枚举。"
    )


def is_pure_chat_scenarios(scenarios: list[str] | None) -> bool:
    """True when no non-ask mode is active (日常对话 / activate ask)."""
    for s in scenarios or []:
        key = normalize_scenario_key(str(s or "").strip())
        if key and key != "ask":
            return False
    return True


def resolve_prompt_scenario_csv(
    *,
    intent_hint: str | None,
    local_workspace_root: str | None,  # noqa: ARG001  kept for backward compat
) -> str:
    """Scenario key(s) for system-prompt assembly and tool profile.

    Only explicit scenario activation (via ``scenario(activate)`` or persisted
    ``activated_scenarios``) determines the scenario — **not** merely binding a
    workspace directory.  ``local_workspace_root`` is accepted for backward
    compatibility but no longer auto-resolves to ``workspace``.
    plan 独占：有 plan 时不叠 workspace。
    """
    keys: list[str] = []
    raw = str(intent_hint or "").strip()
    if raw:
        for part in raw.split(","):
            k = normalize_scenario_key(part.strip())
            if k and k not in keys:
                keys.append(k)
    non_ask = [k for k in keys if k != "ask"]
    if "plan" in non_ask:
        return "plan"
    if "agent" in non_ask:
        return "agent"
    return "ask"


def ordered_scenario_keys_for_display(keys: Iterable[str]) -> list[str]:
    """按 ``TASK_SCENARIO_PROFILES`` 声明顺序排列（排除 ask）；未知键按字母序缀于末尾。"""
    key_set: set[str] = set()
    for k in keys:
        nk = normalize_scenario_key(str(k or "").strip())
        if nk and nk != "ask":
            key_set.add(nk)
    ordered = [k for k in TASK_SCENARIO_PROFILES if k != "ask" and k in key_set]
    tail = sorted(k for k in key_set if k not in TASK_SCENARIO_PROFILES)
    return ordered + tail


def resolve_tools_for_scenarios(scenarios: list[str]) -> list[str]:
    """Union of LangChain tool names for the given scenario keys (always includes ``CORE_TOOL_NAMES``)."""
    out: list[str] = []
    seen: set[str] = set()

    def _push(name: str) -> None:
        n = str(name or "").strip()
        if not n or n in seen:
            return
        seen.add(n)
        out.append(n)

    for n in (*CORE_TOOL_NAMES, *DEFERRED_SYSTEM_TOOL_NAMES):
        _push(n)

    for key in scenarios:
        profile = TASK_SCENARIO_PROFILES.get(key)
        if not profile:
            continue
        for group in profile.tool_groups:
            meta = NON_CORE_TOOL_GROUPS.get(group) or {}
            for tool_name in meta.get("tools") or ():
                _push(str(tool_name))
        for extra in profile.extra_tool_names:
            _push(str(extra))

    return sorted(out)


# 与 ``scenario`` 工具 ``scenario_key`` 枚举一致（ask 为默认回退，不可 activate）
ACTIVATABLE_SCENARIO_KEYS: tuple[str, ...] = ("plan", "agent")


@functools.lru_cache(maxsize=1)
def all_scenario_governed_tool_names() -> frozenset[str]:
    """Non-core tool names that require at least one activatable scenario (union over profiles)."""
    names: set[str] = set()
    for key in ACTIVATABLE_SCENARIO_KEYS:
        for t in resolve_tools_for_scenarios([key]):
            if t not in CORE_TOOL_NAMES and t not in DEFERRED_SYSTEM_TOOL_NAMES:
                names.add(t)
    return frozenset(names)


def scenarios_granting_tool(tool_name: str) -> list[str]:
    """Mode keys whose tool union includes ``tool_name`` (profile order, excludes ask)."""
    n = str(tool_name or "").strip()
    if not n:
        return []
    keys: list[str] = []
    for key in ACTIVATABLE_SCENARIO_KEYS:
        if n in resolve_tools_for_scenarios([key]):
            keys.append(key)
    return ordered_scenario_keys_for_display(keys)


_WORKSPACE_FILE_TOOL_NAMES = frozenset(
    resolve_tools_for_scenarios(["agent"]) + resolve_tools_for_scenarios(["plan"])
)
_WEB_TOOL_NAMES = frozenset(NON_CORE_TOOL_GROUPS["web_research"]["tools"])  # type: ignore[arg-type]
_PLAN_ORCHESTRATION_TOOL_NAMES = frozenset({"plan", "supervisor"})


def recommended_scenario_for_tool(tool_name: str, candidate_scenarios: list[str] | None) -> str:
    """Pick the scenario to suggest when a tool is not activated (may differ from profile declaration order)."""
    scenarios = ordered_scenario_keys_for_display(candidate_scenarios or [])
    if not scenarios:
        return "agent"
    n = str(tool_name or "").strip().lower()
    preference: tuple[str, ...]
    if n in _PLAN_ORCHESTRATION_TOOL_NAMES:
        preference = ("plan", "agent")
    elif n in _WORKSPACE_FILE_TOOL_NAMES:
        preference = ("agent", "plan")
    elif n in _WEB_TOOL_NAMES:
        preference = ("agent",)
    else:
        preference = tuple(scenarios)
    for key in preference:
        if key in scenarios:
            return key
    return scenarios[0]
