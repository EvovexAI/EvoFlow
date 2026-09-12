"""Refresh scenario ContextVar from mission_state disk before each model call."""

from __future__ import annotations

try:
    from typing import override
except ImportError:
    from typing import override

from langchain.agents import AgentState
from langchain.agents.middleware import AgentMiddleware


class ScenarioActivationSyncMiddleware(AgentMiddleware[AgentState]):
    """Align in-memory activated scenarios with persisted mission_state.

    LangGraph tool execution may not propagate ContextVar updates to the main agent loop;
    scenario() still persists — reload here so traces, tool filtering, and guards stay consistent.
    """

    state_schema = AgentState

    @override
    def before_model(self, state: AgentState, runtime) -> dict[str, object] | None:
        # Lazy import: agent.py imports this module during startup; avoid importing scenario_activation at module scope (cycles via lead_agent package).
        from evoflow.tools.builtins.scenario_activation import sync_activated_scenarios_from_mission_storage

        sync_activated_scenarios_from_mission_storage(runtime)
        return None

    @override
    async def abefore_model(self, state: AgentState, runtime) -> dict[str, object] | None:
        return self.before_model(state, runtime)
