"""Shared helpers for Gateway cron / automation LangGraph runs (no interactive user)."""

from __future__ import annotations

import logging
import os

from langgraph.runtime import Runtime

logger = logging.getLogger(__name__)

AUTOMATION_TRIGGER = "automation_scheduler"
PROACTIVE_TRIGGER = "proactive_engine"
UNATTENDED_TASK_QUEUE_TRIGGER = "unattended_task_queue"
_UNATTENDED_TRIGGERS = frozenset({AUTOMATION_TRIGGER, PROACTIVE_TRIGGER, UNATTENDED_TASK_QUEUE_TRIGGER})
# Cron runs cannot rely on the model calling scenario(activate) first; pre-bind common tool sets.
AUTOMATION_DEFAULT_SCENARIOS: tuple[str, ...] = ("agent",)


def runtime_context_dict(runtime: Runtime | None) -> dict:
    from evoflow.agents.lead_agent.runtime_context import runtime_context_mapping

    return runtime_context_mapping(runtime)


def is_unattended_automation(runtime: Runtime | None) -> bool:
    return triggered_by_automation(runtime_context_dict(runtime))


def triggered_by_automation(context: dict | None) -> bool:
    """True for Gateway cron/manual automation **or** proactive (无人值守) runs.

    Proactive uses ``triggered_by=proactive_engine``; treating it as unattended
    enables AutomationRunGuard (cap tool rounds) and skips interactive gates.
    """
    if not isinstance(context, dict):
        return False
    return str(context.get("triggered_by") or "").strip() in _UNATTENDED_TRIGGERS


def triggered_by_proactive(context: dict | None) -> bool:
    if not isinstance(context, dict):
        return False
    return str(context.get("triggered_by") or "").strip() == PROACTIVE_TRIGGER


def automation_default_scenario_keys() -> list[str]:
    """Scenario keys to pre-activate for unattended automation (override via env)."""
    from evoflow.agents.lead_agent.intent_tool_profile import normalize_scenario_key

    raw = (os.getenv("EVOFLOW_AUTOMATION_SCENARIOS") or "").strip()
    source = raw.split(",") if raw else list(AUTOMATION_DEFAULT_SCENARIOS)
    out: list[str] = []
    for part in source:
        key = normalize_scenario_key(str(part or "").strip())
        if key and key != "chat" and key not in out:
            out.append(key)
    return out or list(AUTOMATION_DEFAULT_SCENARIOS)


def bootstrap_unattended_automation_scenarios(
    *,
    thread_id: str | None = None,
    session_key: str | None = None,
    scenarios: list[str] | None = None,
) -> list[str]:
    """Persist + hydrate workspace (etc.) so cron runs skip ScenarioNotActivated gates."""
    keys = scenarios if scenarios is not None else automation_default_scenario_keys()
    sk = str(session_key or "").strip()
    if sk:
        try:
            from evoflow.persistence.session_repositories import (
                derive_session_mode,
                set_session_mode,
            )

            # session_mode is the single source of truth after the v75 migration
            # (the legacy scenario JSON column was dropped).
            set_session_mode(sk, derive_session_mode(keys))
        except Exception:
            logger.debug("bootstrap automation scenarios: session persist failed", exc_info=True)
    try:
        from evoflow.tools.builtins.scenario_activation import (
            hydrate_activated_scenarios_context_var_from_disk,
            replace_activated_scenarios_from_mission_list,
        )

        replace_activated_scenarios_from_mission_list(keys)
        tid = str(thread_id or "").strip()
        if tid:
            hydrate_activated_scenarios_context_var_from_disk(tid)
    except Exception:
        logger.debug("bootstrap automation scenarios: context hydrate failed", exc_info=True)
    logger.info(
        "automation scenarios bootstrapped keys=%s session_key=%s thread_id=%s",
        keys,
        sk or "(none)",
        str(thread_id or "").strip() or "(none)",
    )
    return keys
