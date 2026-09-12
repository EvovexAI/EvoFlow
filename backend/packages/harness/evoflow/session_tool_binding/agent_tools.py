"""Resolve per-session agent tool universe (intersect with mode catalogs)."""

from __future__ import annotations

import logging
import os
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
    tool_groups_key: tuple[str, ...] | None,
    tools_whitelist_key: tuple[str, ...] | None,
    disallowed_key: tuple[str, ...] | None,
    mcp_skill_mode: bool,
) -> frozenset[str]:
    del model_name  # get_available_tools caches by model; keep signature for cache key stability
    del mcp_skill_mode  # native-style: MCP always native in tool catalog
    try:
        agent_config = load_agent_config(agent_id)
    except Exception:
        agent_config = None

    from evoflow.tools import get_available_tools

    groups = list(tool_groups_key) if tool_groups_key else (agent_config.tool_groups if agent_config else None)
    try:
        tools = get_available_tools(
            groups=groups,
            subagent_enabled=subagent_enabled,
            include_search=include_search,
            include_mcp=True,
        )
    except Exception as exc:
        logger.warning("[AgentTools] get_available_tools failed agent=%s: %s", agent_id, exc)
        return frozenset()

    if tools_whitelist_key is not None:
        from evoflow.tools.tool_aliases import canonical_tool_name
        from evoflow.tools.tool_catalog import normalize_tool_name

        # Configs still use legacy names (read_file); runtime catalog is host-direct (read).
        whitelist = {
            canonical_tool_name(normalize_tool_name(x))
            for x in tools_whitelist_key
            if str(x or "").strip()
        }
        whitelist.discard("")
        # Explicit agent.tools = allowlist. ``tool_search`` + agent-mode system tools
        # (platform / panel_set) may bypass; ask_clarification is NOT auto-injected.
        from evoflow.tools.tool_catalog import AGENT_MODE_SYSTEM_TOOL_NAMES

        tools = [
            t
            for t in tools
            if (
                (name := canonical_tool_name(normalize_tool_name(getattr(t, "name", None))))
                and (
                    name in whitelist
                    or name == "tool_search"
                    or name in AGENT_MODE_SYSTEM_TOOL_NAMES
                )
            )
        ]
    if disallowed_key:
        from evoflow.tools.tool_aliases import canonical_tool_name
        from evoflow.tools.tool_catalog import AGENT_MODE_SYSTEM_TOOL_NAMES, normalize_tool_name

        blocked = {
            canonical_tool_name(normalize_tool_name(x))
            for x in disallowed_key
            if str(x or "").strip()
        }
        blocked.discard("")
        # Agent-mode system tools cannot be banned via disallowed_tools.
        blocked -= {canonical_tool_name(n) for n in AGENT_MODE_SYSTEM_TOOL_NAMES}
        tools = [
            t
            for t in tools
            if canonical_tool_name(normalize_tool_name(getattr(t, "name", None))) not in blocked
        ]

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
    # 小V：config.tools=[] is intentional (no role-editor tools). Runtime surface is
    # fixed xiaomi_* — must not treat empty whitelist as “no tools”.
    try:
        from evoflow.agents.xiaomi.identity import is_xiaomi_agent
        from evoflow.agents.xiaomi.tool_policy import XIAOMI_SYSTEM_TOOL_NAMES

        if is_xiaomi_agent(aid):
            return frozenset(XIAOMI_SYSTEM_TOOL_NAMES)
    except Exception:
        logger.debug("xiaomi tool universe resolve skipped agent=%s", aid, exc_info=True)

    try:
        agent_config = load_agent_config(aid)
    except Exception:
        agent_config = None

    mcp_skill_mode = _agent_mcp_skill_mode_enabled(agent_config)
    groups_key = tuple(sorted(agent_config.tool_groups)) if agent_config and agent_config.tool_groups else None
    whitelist_key = (
        tuple(sorted(str(t).strip() for t in agent_config.tools if str(t or "").strip()))
        if agent_config and agent_config.tools is not None
        else None
    )
    disallowed_key = (
        tuple(sorted(str(t).strip() for t in agent_config.disallowed_tools if str(t or "").strip()))
        if agent_config and agent_config.disallowed_tools
        else None
    )
    return _cached_agent_tool_names(
        aid,
        subagent_enabled,
        include_search,
        model_name,
        groups_key,
        whitelist_key,
        disallowed_key,
        mcp_skill_mode,
    )


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
        from evoflow.agents.xiaomi.tool_policy import XIAOMI_SYSTEM_TOOL_NAMES

        if is_xiaomi_agent(resolve_session_agent_id(session_key)):
            return sorted(XIAOMI_SYSTEM_TOOL_NAMES)
    except Exception:
        logger.debug("xiaomi bound tools resolve skipped", exc_info=True)

    agent = resolve_agent_tool_names_for_session(session_key)
    if not _tool_search_enabled():
        return _intersect_mode_tools(flat_bound_tool_names_for_session_mode(m), agent)
    return _intersect_mode_tools(bound_tools_for_session_mode(m), agent)


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
    agent = resolve_agent_tool_names_for_session(session_key)
    return _intersect_mode_tools(deferred_catalog_for_session_mode(m), agent)


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
    return sorted({*bound, *loaded})


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
