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
    from evoflow.tools.tool_aliases import augment_worker_tool_allowlist, resolve_tools_against_catalog

    matched, unknown = resolve_tools_against_catalog(names, catalog_names)
    if unknown:
        logger.warning("worker tool allowlist names not in catalog (dropped): %s", unknown)
    return augment_worker_tool_allowlist(matched, catalog_names)


def resolve_worker_tool_allowlist(
    *,
    profile_tools: list[str] | None = None,
    assignee_agent_code: str | None = None,
    base_subagent: str,
    subagent_config_tools: list[str] | None = None,
    catalog_names: set[str],
    session_key: str | None = None,
    session_mode: str | None = None,
) -> list[str]:
    """Return an explicit tool allowlist for a worker (never the raw global catalog).

    Priority:
    1. ``worker_profile.tools``
    2. ``assigned_to`` AgentConfig.tools (when assignee differs from base)
    3. SubagentConfig.tools (builtin template allowlist)
    4. ``base_subagent`` AgentConfig.tools
    5. Parent session agent ∩ worker execution mode (bound∪deferred)
    """
    allowed = {str(n).strip() for n in catalog_names if str(n or "").strip()}

    if profile_tools is not None:
        out = _intersect_catalog(list(profile_tools), allowed)
        if out:
            return out
        logger.warning(
            "worker_profile.tools empty after catalog filter; falling back to agent inheritance"
        )

    assignee = str(assignee_agent_code or "").strip()
    base = str(base_subagent or "").strip()
    if assignee and assignee != base:
        wl = _load_agent_tools_whitelist(assignee)
        if wl is not None:
            out = _intersect_catalog(wl, allowed)
            if out:
                logger.info(
                    "worker tools from AgentConfig(%s): %d tool(s)",
                    assignee,
                    len(out),
                )
                return out

    if subagent_config_tools is not None:
        out = _intersect_catalog(list(subagent_config_tools), allowed)
        if out:
            logger.info(
                "worker tools from SubagentConfig(%s): %d tool(s)",
                base_subagent,
                len(out),
            )
            return out

    wl = _load_agent_tools_whitelist(base)
    if wl is not None:
        out = _intersect_catalog(wl, allowed)
        if out:
            logger.info(
                "worker tools from AgentConfig(%s): %d tool(s)",
                base,
                len(out),
            )
            return out

    # Inherit corresponding agent capability under execution mode — not get_available_tools().
    if assignee and assignee != base:
        inherited = _agent_mode_catalog_for_agent(assignee, session_mode)
        source = f"assignee:{assignee}"
    elif str(session_key or "").strip():
        inherited = _session_agent_mode_catalog(str(session_key).strip(), session_mode)
        source = f"session:{session_key}"
    else:
        inherited = _agent_mode_catalog_for_agent(base or "general-purpose", session_mode)
        source = f"base:{base_subagent}"

    out = _intersect_catalog(inherited, allowed)
    if not out:
        # Last resort: agent-mode bound tools only (still not the global dump).
        from evoflow.agents.lead_agent.intent_tool_profile import bound_tools_for_session_mode

        out = _intersect_catalog(list(bound_tools_for_session_mode("agent")), allowed)
        source = "agent-mode-bound-fallback"
    logger.info("worker tools inherited (%s): %d tool(s)", source, len(out))
    return out


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
