"""Resolve explicit tool allowlists for task_tool / collab workers.

``tools=None`` on WorkerProfile / SubagentConfig means "inherit the corresponding
agent's tools", **not** the global ``get_available_tools()`` dump.
"""

from __future__ import annotations

import logging
from typing import Any

logger = logging.getLogger(__name__)


def _load_agent_tools_whitelist(agent_code: str | None) -> list[str] | None:
    code = str(agent_code or "").strip()
    if not code:
        return None
    try:
        from evoflow.config.agents_config import load_agent_config

        cfg = load_agent_config(code)
    except (FileNotFoundError, ValueError):
        return None
    except Exception:
        logger.debug("load_agent_config(%r) failed for worker tools", code, exc_info=True)
        return None
    if cfg is None or cfg.tools is None:
        return None
    return [str(t).strip() for t in cfg.tools if str(t or "").strip()]


def _worker_execution_mode(session_mode: str | None) -> str:
    """Plan-mode lead only binds planning tools; workers need agent execution tools."""
    from evoflow.agents.lead_agent.intent_tool_profile import normalize_session_mode

    mode = normalize_session_mode(session_mode)
    return "agent" if mode == "plan" else mode


def _agent_mode_catalog_for_agent(agent_code: str, session_mode: str | None) -> list[str]:
    """bound ∪ deferred for worker mode ∩ that agent's configured universe."""
    from evoflow.agents.lead_agent.intent_tool_profile import (
        bound_tools_for_session_mode,
        deferred_catalog_for_session_mode,
    )
    from evoflow.session_tool_binding.agent_tools import resolve_agent_tool_names_for_agent

    worker_mode = _worker_execution_mode(session_mode)
    universe = resolve_agent_tool_names_for_agent(agent_code)
    catalog = {
        *bound_tools_for_session_mode(worker_mode),
        *deferred_catalog_for_session_mode(worker_mode),
    }
    if not universe:
        return sorted(catalog)
    return sorted({n for n in catalog if n in universe})


def _session_agent_mode_catalog(session_key: str, session_mode: str | None) -> list[str]:
    from evoflow.session_tool_binding.agent_tools import (
        bound_tools_for_session_agent,
        deferred_catalog_for_session_agent,
        resolve_session_agent_id,
    )

    worker_mode = _worker_execution_mode(session_mode)
    sk = str(session_key or "").strip()
    if not sk:
        # No session: fall back to raw mode catalog (still far smaller than global dump).
        from evoflow.agents.lead_agent.intent_tool_profile import (
            bound_tools_for_session_mode,
            deferred_catalog_for_session_mode,
        )

        return sorted({*bound_tools_for_session_mode(worker_mode), *deferred_catalog_for_session_mode(worker_mode)})

    # Prefer assignee-less inherit: parent session agent ∩ worker mode catalogs.
    bound = bound_tools_for_session_agent(sk, worker_mode)
    deferred = deferred_catalog_for_session_agent(sk, worker_mode)
    names = sorted({*bound, *deferred})
    if names:
        return names
    # Empty intersection (misconfigured agent): still scope to that agent id's mode catalog.
    return _agent_mode_catalog_for_agent(resolve_session_agent_id(sk), session_mode)


def _intersect_catalog(names: list[str], catalog_names: set[str]) -> list[str]:
    from evoflow.collab.collab_tool_names import canonicalize_tool_names
    from evoflow.tools.tool_aliases import augment_worker_tool_allowlist, resolve_tools_against_catalog

    # Old agent YAML may still list subtask_outcome_report / collab_peer_* — rewrite first.
    names = canonicalize_tool_names(names)
    matched, unknown = resolve_tools_against_catalog(names, catalog_names)
    if unknown:
        logger.warning("worker tool allowlist names not in catalog (dropped): %s", unknown)
    return augment_worker_tool_allowlist(matched, catalog_names)


def _mcp_tool_names_for_agent(agent_code: str | None, catalog_names: set[str]) -> list[str]:
    """Native MCP tool names bound on AgentConfig.mcp_servers (lead-agent parity).

    Worker allowlists historically only copied ``AgentConfig.tools``, so an employee
    with ``mcp_servers=["ecommerce-shangce"]`` but no ``mcp__…`` entries in ``tools``
    would run workflow steps **without** MCP — falling back to curl/terminal.
    ``mcp_servers is None`` → all MCP names in catalog; ``[]`` → none.
    """
    code = str(agent_code or "").strip()
    if not code:
        return []
    try:
        from evoflow.config.agents_config import load_agent_config
        from evoflow.mcp.binding import mcp_server_from_tool_name

        cfg = load_agent_config(code)
    except (FileNotFoundError, ValueError):
        return []
    except Exception:
        logger.debug("load_agent_config(%r) failed for worker MCP mount", code, exc_info=True)
        return []
    if cfg is None:
        return []
    mcp_servers = cfg.mcp_servers
    if mcp_servers is not None and not list(mcp_servers):
        return []
    allowed_servers = None if mcp_servers is None else {str(s).strip() for s in mcp_servers if str(s).strip()}
    out: list[str] = []
    for name in catalog_names:
        n = str(name or "").strip()
        server = mcp_server_from_tool_name(n)
        if not server:
            continue
        if allowed_servers is None or server in allowed_servers:
            out.append(n)
    return out


def _agent_mcp_servers_binding(agent_code: str | None) -> list[str] | None:
    """Return bound MCP server names, ``None`` = all enabled, ``[]`` = explicitly none."""
    code = str(agent_code or "").strip()
    if not code:
        return []
    try:
        from evoflow.config.agents_config import load_agent_config

        cfg = load_agent_config(code)
    except Exception:
        return []
    if cfg is None:
        return []
    servers = cfg.mcp_servers
    if servers is None:
        return None
    return [str(s).strip() for s in servers if str(s).strip()]


def _mcp_tool_names_for_servers(
    mcp_servers: list[str] | None,
    catalog_names: set[str],
) -> list[str]:
    """Filter catalog MCP tools by server whitelist. ``None`` = all; ``[]`` = none."""
    if mcp_servers is not None and not list(mcp_servers):
        return []
    try:
        from evoflow.mcp.binding import mcp_server_from_tool_name
    except Exception:
        return []
    allowed_servers = None if mcp_servers is None else {str(s).strip() for s in mcp_servers if str(s).strip()}
    out: list[str] = []
    for name in catalog_names:
        n = str(name or "").strip()
        server = mcp_server_from_tool_name(n)
        if not server:
            continue
        if allowed_servers is None or server in allowed_servers:
            out.append(n)
    return out


def _with_agent_mcp_tools(
    tools: list[str],
    *,
    agent_code: str | None,
    catalog_names: set[str],
    profile_mcp_servers: list[str] | None = None,
    profile_mcp_override: bool = False,
) -> list[str]:
    """Append bound MCP tools onto an explicit worker allowlist (deduped, stable order).

    When ``profile_mcp_override`` is True, ``profile_mcp_servers`` replaces AgentConfig
    binding (``None`` = all enabled MCP; ``[]`` = none; list = whitelist).
    """
    base = [str(t).strip() for t in (tools or []) if str(t or "").strip()]
    seen = {t.lower() for t in base}
    catalog = set(catalog_names)

    def _append(names: list[str]) -> int:
        n_added = 0
        for name in names:
            key = name.lower()
            if key in seen:
                continue
            base.append(name)
            seen.add(key)
            catalog.add(name)
            n_added += 1
        return n_added

    if profile_mcp_override:
        extra = _mcp_tool_names_for_servers(profile_mcp_servers, catalog)
        binding = None if profile_mcp_servers is None else list(profile_mcp_servers)
        source = "worker_profile.mcp_servers"
    else:
        extra = _mcp_tool_names_for_agent(agent_code, catalog)
        binding = _agent_mcp_servers_binding(agent_code)
        source = f"AgentConfig({agent_code}).mcp_servers"

    added = _append(extra)

    # Catalog missed MCP (stale LRU / cold sync get) but process cache is warm —
    # heal names from peek so remount matches lead-agent mcp_servers semantics.
    expects_mcp = binding is None or bool(binding)
    if expects_mcp and added == 0:
        try:
            from evoflow.mcp.binding import mcp_server_from_tool_name
            from evoflow.mcp.cache import peek_cached_mcp_tools

            peeked_names = [
                str(getattr(t, "name", "") or "").strip()
                for t in (peek_cached_mcp_tools() or [])
                if str(getattr(t, "name", "") or "").strip()
            ]
            if peeked_names:
                allowed_servers = None if binding is None else set(binding)
                heal = [
                    n
                    for n in peeked_names
                    if (server := mcp_server_from_tool_name(n))
                    and (allowed_servers is None or server in allowed_servers)
                ]
                healed = _append(heal)
                if healed:
                    added += healed
                    logger.warning(
                        "worker tools: healed %d MCP tool(s) from warm peek for AgentConfig(%s) "
                        "(catalog had 0 mcp__* — likely stale get_available_tools LRU)",
                        healed,
                        agent_code,
                    )
        except Exception:
            logger.debug("worker MCP peek heal skipped", exc_info=True)

    if added:
        logger.info(
            "worker tools: mounted %d MCP tool(s) from %s",
            added,
            source,
        )
    elif expects_mcp:
        logger.error(
            "worker tools: mcp_unavailable agent=%s mcp_servers=%s catalog_mcp=0 — "
            "bound MCP will not be visible; worker may fall back to HTTP/bash",
            agent_code,
            "all" if binding is None else binding,
        )
    return base


def resolve_worker_tool_allowlist(
    *,
    profile_tools: list[str] | None = None,
    assignee_agent_code: str | None = None,
    base_subagent: str,
    subagent_config_tools: list[str] | None = None,
    catalog_names: set[str],
    session_key: str | None = None,
    session_mode: str | None = None,
    profile_mcp_servers: list[str] | None = None,
    profile_mcp_override: bool = False,
) -> list[str]:
    """Return an explicit tool allowlist for a worker (never the raw global catalog).

    Priority:
    1. ``worker_profile.tools``
    2. ``assigned_to`` AgentConfig.tools (when assignee differs from base)
    3. SubagentConfig.tools (builtin template allowlist)
    4. ``base_subagent`` AgentConfig.tools
    5. Parent session agent ∩ worker execution mode (bound∪deferred)

    After the above, MCP tools from ``worker_profile.mcp_servers`` (when set) or the
    assignee/base agent's ``mcp_servers`` are mounted (lead ``mount_agent_mcp_tools`` parity).
    """
    allowed = {str(n).strip() for n in catalog_names if str(n or "").strip()}
    mcp_agent = str(assignee_agent_code or "").strip() or str(base_subagent or "").strip()

    def _finish(out: list[str], *, source: str) -> list[str]:
        mounted = _with_agent_mcp_tools(
            out,
            agent_code=mcp_agent,
            catalog_names=allowed,
            profile_mcp_servers=profile_mcp_servers,
            profile_mcp_override=profile_mcp_override,
        )
        logger.info("worker tools resolved (%s): %d tool(s)", source, len(mounted))
        return mounted

    if profile_tools is not None:
        out = _intersect_catalog(list(profile_tools), allowed)
        if out:
            return _finish(out, source=f"profile+mcp:{mcp_agent}")
        logger.warning("worker_profile.tools empty after catalog filter; falling back to agent inheritance")

    assignee = str(assignee_agent_code or "").strip()
    base = str(base_subagent or "").strip()
    if assignee and assignee != base:
        wl = _load_agent_tools_whitelist(assignee)
        if wl is not None:
            out = _intersect_catalog(wl, allowed)
            if out:
                return _finish(out, source=f"AgentConfig({assignee})")

    if subagent_config_tools is not None:
        out = _intersect_catalog(list(subagent_config_tools), allowed)
        if out:
            return _finish(out, source=f"SubagentConfig({base_subagent})")

    wl = _load_agent_tools_whitelist(base)
    if wl is not None:
        out = _intersect_catalog(wl, allowed)
        if out:
            return _finish(out, source=f"AgentConfig({base})")

    # Inherit corresponding agent capability under execution mode — not get_available_tools().
    if assignee and assignee != base:
        inherited = _agent_mode_catalog_for_agent(assignee, session_mode)
        source = f"assignee:{assignee}"
    elif str(session_key or "").strip():
        inherited = _session_agent_mode_catalog(str(session_key).strip(), session_mode)
        source = f"session:{session_key}"
    else:
        inherited = _agent_mode_catalog_for_agent(base or "agent", session_mode)
        source = f"base:{base_subagent}"

    out = _intersect_catalog(inherited, allowed)
    if not out:
        # Last resort: agent-mode bound tools only (still not the global dump).
        from evoflow.agents.lead_agent.intent_tool_profile import bound_tools_for_session_mode

        out = _intersect_catalog(list(bound_tools_for_session_mode("agent")), allowed)
        source = "agent-mode-bound-fallback"
    return _finish(out, source=source)


def session_tool_context_from_runtime(runtime: Any | None) -> tuple[str | None, str | None]:
    """Extract ``(session_key, session_mode)`` from a LangGraph tool runtime."""
    if runtime is None:
        return None, None
    try:
        from evoflow.agents.lead_agent.runtime_context import runtime_context_mapping

        ctx = runtime_context_mapping(runtime)
    except Exception:
        ctx = {}
    if not isinstance(ctx, dict):
        ctx = {}
    session_key = str(ctx.get("session_key") or "").strip() or None
    session_mode = str(ctx.get("session_mode") or "").strip() or None
    if not session_mode:
        conf = getattr(getattr(runtime, "config", None), "get", lambda *_: None)("configurable") or {}
        if isinstance(conf, dict):
            session_mode = str(conf.get("session_mode") or "").strip() or None
            if not session_key:
                session_key = str(conf.get("session_key") or "").strip() or None
    return session_key, session_mode
