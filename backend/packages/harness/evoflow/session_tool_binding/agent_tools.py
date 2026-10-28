"""Resolve per-session agent tool universe (intersect with mode catalogs)."""

from __future__ import annotations

import logging
from functools import lru_cache

from evoflow.agents.lead_agent.intent_tool_profile import (
    bound_tools_for_session_mode,
    deferred_catalog_for_session_mode,
    flat_bound_tool_names_for_session_mode,
    normalize_session_mode,
)
from evoflow.config.agents_config import AgentConfig, load_agent_config
from evoflow.persistence.session_context_fields import agent_id_from_session_key

logger = logging.getLogger(__name__)


def _mcp_use_skill_binding() -> bool:
    from evoflow.mcp.binding import warn_if_legacy_mcp_skill_binding_env

    warn_if_legacy_mcp_skill_binding_env()
    return False


def _agent_mcp_skill_mode_enabled(agent_config: AgentConfig | None) -> bool:
    _mcp_use_skill_binding()
    return False


def _strip_mind_map_tool_names(names: set[str]) -> set[str]:
    try:
        from evoflow.exploration_graph.config import is_exploration_graph_enabled

        if is_exploration_graph_enabled():
            return names
    except Exception:
        pass
    return {n for n in names if n != "mind_map"}


def resolve_session_agent_id(session_key: str) -> str:
    """Resolve which agent config gates tools for this session.

    Prefer the flat ``agent_id`` column (set by in-session preset-role switch) over
    the agent embedded in ``session_key`` (``agent:main:…``), so switching roles
    actually narrows ``<available-deferred-tools>``.
    """
    sk = str(session_key or "").strip()
    try:
        from evoflow.persistence.db import get_db

        row = (
            get_db()
            .execute(
                "SELECT agent_id FROM evoflow_chat_sessions WHERE session_key = ? AND is_deleted = 0",
                (sk,),
            )
            .fetchone()
        )
        if row and str(row[0] or "").strip():
            return str(row[0]).strip()
    except Exception:
        pass
    from_key = agent_id_from_session_key(sk)
    if from_key:
        return from_key
    return "main"


def _session_runtime_tool_flags(session_key: str) -> tuple[bool, bool, str | None]:
    sk = str(session_key or "").strip()
    subagent_enabled = False
    include_search = True
    model_name: str | None = None
    if not sk:
        return subagent_enabled, include_search, model_name
    try:
        from evoflow.persistence.db import get_db

        row = (
            get_db()
            .execute(
                """
                SELECT subagent_enabled, include_search, model_name
                FROM evoflow_chat_sessions
                WHERE session_key = ? AND is_deleted = 0
                """,
                (sk,),
            )
            .fetchone()
        )
        if row:
            subagent_enabled = bool(row[0])
            include_search = bool(row[1]) if row[1] is not None else True
            model_name = str(row[2] or "").strip() or None
    except Exception:
        pass
    return subagent_enabled, include_search, model_name


@lru_cache(maxsize=64)
def _cached_agent_tool_names(
    agent_id: str,
    subagent_enabled: bool,
    include_search: bool,
    model_name: str | None,
    tools_whitelist_key: tuple[str, ...] | None,
    disallowed_key: tuple[str, ...] | None,
    mcp_servers_key: tuple[str, ...] | None,
    mount_platform_tools: bool = False,
) -> frozenset[str]:
    del model_name  # get_available_tools caches by model; keep signature for cache key stability
    # mcp_servers_key: None = unrestricted; () = explicitly none; ("srv",…) = bound servers
    try:
        load_agent_config(agent_id)
    except Exception:
        pass

    from evoflow.tools import get_available_tools
    from evoflow.tools.tool_aliases import canonical_tool_name
    from evoflow.tools.tool_catalog import (
        AGENT_MODE_SYSTEM_TOOL_NAMES,
        normalize_tool_name,
        should_mount_platform_tool,
    )

    platform_names = {canonical_tool_name(n) for n in AGENT_MODE_SYSTEM_TOOL_NAMES}
    mount_platform = should_mount_platform_tool(
        agent_id,
        mount_platform_tools=bool(mount_platform_tools),
        tools_whitelist=list(tools_whitelist_key) if tools_whitelist_key is not None else None,
    )

    try:
        tools = get_available_tools(
            subagent_enabled=subagent_enabled,
            include_search=include_search,
            include_mcp=True,
        )
    except Exception as exc:
        logger.warning("[AgentTools] get_available_tools failed agent=%s: %s", agent_id, exc)
        return frozenset()

    from evoflow.mcp.binding import (
        filter_tools_by_mcp_servers,
        is_mcp_tool_name,
        mcp_server_from_tool_name,
        mount_agent_mcp_tools,
    )

    # Snapshot MCP before tools allowlist drops mcp__* (optional tier).
    mcp_catalog = [t for t in tools if is_mcp_tool_name(str(getattr(t, "name", "") or ""))]

    if tools_whitelist_key is not None:
        # Configs still use legacy names (read_file); runtime catalog is host-direct (read).
        whitelist = {canonical_tool_name(normalize_tool_name(x)) for x in tools_whitelist_key if str(x or "").strip()}
        whitelist.discard("")
        # terminal/rg/find alias to bash. Background control ships with the shell.
        if "bash" in whitelist:
            whitelist.update({"taskoutput", "taskstop"})
        # Explicit agent.tools = allowlist. ``tool_search`` 可旁路；``platform`` 靠勾选或 main/小V。
        # Bound MCP is remounted below from mcp_servers — do not require mcp__ in tools[].
        tools = [
            t
            for t in tools
            if (
                (name := canonical_tool_name(normalize_tool_name(getattr(t, "name", None))))
                and (
                    name in whitelist
                    or name == "tool_search"
                    or (name in platform_names and mount_platform)
                )
            )
        ]
    if disallowed_key:
        blocked = {canonical_tool_name(normalize_tool_name(x)) for x in disallowed_key if str(x or "").strip()}
        blocked.discard("")
        # main/小V（或已勾选）的 platform 不可被 disallowed 摘掉
        if mount_platform:
            blocked -= platform_names
        tools = [t for t in tools if canonical_tool_name(normalize_tool_name(getattr(t, "name", None))) not in blocked]

    # tools=None（继承全量）时：员工未勾选也不自动带 platform
    if not mount_platform and platform_names:
        tools = [
            t
            for t in tools
            if canonical_tool_name(normalize_tool_name(getattr(t, "name", None))) not in platform_names
        ]

    mcp_cfg = None if mcp_servers_key is None else list(mcp_servers_key)
    mcp_source = filter_tools_by_mcp_servers(mcp_catalog, mcp_cfg)
    if mcp_servers_key is None:
        remount_servers = sorted(
            {
                str(mcp_server_from_tool_name(str(getattr(t, "name", "") or "")) or "")
                for t in mcp_source
            }
            - {""}
        )
        if remount_servers:
            tools = mount_agent_mcp_tools(tools, mcp_source, remount_servers)
    elif mcp_servers_key:
        tools = mount_agent_mcp_tools(tools, mcp_source, list(mcp_servers_key))
    else:
        tools = [t for t in tools if not is_mcp_tool_name(str(getattr(t, "name", "") or ""))]

    names = {str(getattr(t, "name", "") or "").strip().lower() for t in tools}
    names.discard("")
    return frozenset(_strip_mind_map_tool_names(names))


def invalidate_agent_tool_names_cache(agent_id: str | None = None) -> None:
    """Clear cached per-agent tool name sets (call after agent config edits)."""
    del agent_id  # lru_cache has no per-key eviction; clear all entries
    _cached_agent_tool_names.cache_clear()


def resolve_agent_tool_names_for_agent(
    agent_id: str,
    *,
    subagent_enabled: bool = False,
    include_search: bool = True,
    model_name: str | None = None,
) -> frozenset[str]:
    """Tool names an agent code may use (runtime catalog ∩ agent config)."""
    aid = str(agent_id or "").strip() or "main"
    try:
        agent_config = load_agent_config(aid)
    except Exception:
        agent_config = None

    _agent_mcp_skill_mode_enabled(agent_config)  # legacy env warn only
    whitelist_key = tuple(sorted(str(t).strip() for t in agent_config.tools if str(t or "").strip())) if agent_config and agent_config.tools is not None else None
    disallowed_key = tuple(sorted(str(t).strip() for t in agent_config.disallowed_tools if str(t or "").strip())) if agent_config and agent_config.disallowed_tools else None
    if agent_config is None or agent_config.mcp_servers is None:
        mcp_servers_key: tuple[str, ...] | None = None
    else:
        mcp_servers_key = tuple(sorted(str(s).strip() for s in agent_config.mcp_servers if str(s).strip()))
    mount_platform = False
    try:
        from evoflow.config.agents_config import get_agent_kb_injection_config

        mount_platform = bool(get_agent_kb_injection_config(aid).mount_platform_tools)
    except Exception:
        mount_platform = False
    names = _cached_agent_tool_names(
        aid,
        subagent_enabled,
        include_search,
        model_name,
        whitelist_key,
        disallowed_key,
        mcp_servers_key,
        mount_platform,
    )
    # 小V：白名单含 bash + 全量 MCP；前台 xiaomi_* / platform 不在 catalog 里，强制并入。
    try:
        from evoflow.agents.xiaomi.identity import is_xiaomi_agent
        from evoflow.agents.xiaomi.tool_policy import (
            is_xiaomi_mcp_tool_name,
            xiaomi_bound_tool_name_set,
        )

        if is_xiaomi_agent(aid):
            bound = set(xiaomi_bound_tool_name_set())
            kept = {n for n in names if n in bound or is_xiaomi_mcp_tool_name(n)}
            return frozenset(kept | bound)
    except Exception:
        logger.debug("xiaomi tool universe resolve skipped agent=%s", aid, exc_info=True)
    return names


def resolve_agent_tool_names_for_session(session_key: str) -> frozenset[str]:
    """Tool names this session's agent may use (runtime catalog ∩ agent config)."""
    sk = str(session_key or "").strip()
    agent_id = resolve_session_agent_id(sk)
    subagent_enabled, include_search, model_name = _session_runtime_tool_flags(sk)
    return resolve_agent_tool_names_for_agent(
        agent_id,
        subagent_enabled=subagent_enabled,
        include_search=include_search,
        model_name=model_name,
    )


def _intersect_mode_tools(mode_tools: tuple[str, ...], agent_tools: frozenset[str]) -> list[str]:
    out: list[str] = []
    seen: set[str] = set()
    for raw in mode_tools:
        n = str(raw or "").strip().lower()
        if not n or n in seen:
            continue
        # Strict: mode lists must be subset of agent universe (whitelist − disallowed).
        # Do not re-inject ask_clarification / mode_set when the agent omitted or banned them.
        if agent_tools and n not in agent_tools:
            continue
        seen.add(n)
        out.append(n)
    return out


def _tool_search_enabled() -> bool:
    try:
        from evoflow.config.tool_search_config import is_tool_search_enabled

        return is_tool_search_enabled()
    except Exception:
        return False


def bound_tools_for_session_agent(session_key: str, mode: str | None) -> list[str]:
    m = normalize_session_mode(mode)
    try:
        from evoflow.agents.xiaomi.identity import is_xiaomi_agent
        from evoflow.agents.xiaomi.tool_policy import xiaomi_bound_tool_name_set

        if is_xiaomi_agent(resolve_session_agent_id(session_key)):
            # Front-desk + bash always bound; MCP stays in agent universe for mount.
            return sorted(xiaomi_bound_tool_name_set())
    except Exception:
        logger.debug("xiaomi bound tools resolve skipped", exc_info=True)

    agent_tools = resolve_agent_tool_names_for_session(session_key)
    mode_tools = flat_bound_tool_names_for_session_mode(m) if not _tool_search_enabled() else bound_tools_for_session_mode(m)
    result = _intersect_mode_tools(mode_tools, agent_tools)

    # DEBUG: 只在 debug 级别打印，且只在 tool_search 启用时才打（避免循环）
    if _tool_search_enabled():
        agent_id = resolve_session_agent_id(session_key)
        # 用简单的计数器防刷屏（每 session 只打前 3 次）
        _debug_print_count.setdefault(session_key, 0)
        if _debug_print_count[session_key] < 3:
            _debug_print_count[session_key] += 1
            print(
                f"[TOOL_BINDING] session={session_key} agent={agent_id} mode={m} "
                f"tool_search=enabled iter={_debug_print_count[session_key]}"
            )
            print(f"  mode_tools ({len(mode_tools)}): {list(mode_tools)}")
            print(f"  agent_whitelist ({len(agent_tools)}): {sorted(agent_tools)}")
            print(f"  RESULT ({len(result)}): {result}")
            if agent_tools:
                missing = [t for t in mode_tools if t not in agent_tools]
                if missing:
                    print(f"  [交集过滤] 不在 agent_whitelist: {missing}")

    return result


# 模块级防刷屏计数器
_debug_print_count: dict[str, int] = {}
_defer_debug_count: dict[str, int] = {}
_eff_debug_count: dict[str, int] = {}


def deferred_catalog_for_session_agent(session_key: str, mode: str | None) -> list[str]:
    try:
        from evoflow.agents.xiaomi.identity import is_xiaomi_agent

        if is_xiaomi_agent(resolve_session_agent_id(session_key)):
            return []
    except Exception:
        logger.debug("xiaomi deferred catalog resolve skipped", exc_info=True)

    if not _tool_search_enabled():
        return []
    m = normalize_session_mode(mode)
    mode_deferred = deferred_catalog_for_session_mode(m)
    agent = resolve_agent_tool_names_for_session(session_key)
    result = _intersect_mode_tools(mode_deferred, agent)

    # DEBUG: deferred 工具加载
    agent_id = resolve_session_agent_id(session_key)
    _defer_debug_count.setdefault(session_key, 0)
    if _defer_debug_count[session_key] < 3:
        _defer_debug_count[session_key] += 1
        print(
            f"[DEFER_TOOLS] session={session_key} agent={agent_id} mode={m} "
            f"iter={_defer_debug_count[session_key]}"
        )
        print(f"  mode_deferred ({len(mode_deferred)}): {list(mode_deferred)}")
        print(f"  agent_whitelist ({len(agent)}): {sorted(agent)}")
        print(f"  RESULT ({len(result)}): {result}")

    return result


# 模块级防刷屏计数器
_defer_debug_count: dict[str, int] = {}


def filter_loaded_for_agent_mode(
    session_key: str,
    mode: str | None,
    names: list[str] | None,
) -> list[str]:
    if not _tool_search_enabled():
        return []
    allowed = set(deferred_catalog_for_session_agent(session_key, mode))
    if not allowed:
        return []
    out: list[str] = []
    seen: set[str] = set()
    for raw in names or []:
        n = str(raw or "").strip().lower()
        if not n or n in seen or n not in allowed:
            continue
        seen.add(n)
        out.append(n)
    return out


def effective_bound_tools_for_session_agent(
    session_key: str,
    mode: str | None,
    *,
    loaded_deferred: list[str] | None,
) -> list[str]:
    bound = bound_tools_for_session_agent(session_key, mode)
    if not _tool_search_enabled():
        return sorted(bound)
    loaded = filter_loaded_for_agent_mode(session_key, mode, list(loaded_deferred or []))
    result = sorted({*bound, *loaded})

    # DEBUG: 最终工具列表合并
    agent_id = resolve_session_agent_id(session_key)
    _eff_debug_count.setdefault(session_key, 0)
    if _eff_debug_count[session_key] < 3:
        _eff_debug_count[session_key] += 1
        print(
            f"[EFFECTIVE_TOOLS] session={session_key} agent={agent_id} mode={mode} "
            f"iter={_eff_debug_count[session_key]}"
        )
        print(f"  bound ({len(bound)}): {bound}")
        print(f"  loaded_deferred_in ({list(loaded_deferred or []): 50s})")
        print(f"  loaded_filtered ({len(loaded)}): {loaded}")
        print(f"  RESULT ({len(result)}): {result}")

    return result


# 模块级防刷屏计数器


def pending_activation_for_session_agent(
    session_key: str,
    mode: str | None,
    *,
    loaded_deferred: list[str] | None,
) -> list[str]:
    if not _tool_search_enabled():
        return []
    catalog = set(deferred_catalog_for_session_agent(session_key, mode))
    loaded = {str(x).strip().lower() for x in (loaded_deferred or []) if str(x or "").strip()}
    return sorted(catalog - loaded)
