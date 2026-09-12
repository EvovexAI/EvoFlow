from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field, model_validator

from evoflow.agents.lead_agent.intent_tool_profile import normalize_scenario_key


class MissionSubproblem(BaseModel):
    id: str = Field(default="")
    title: str = Field(default="")
    status: Literal["pending", "in_progress", "blocked", "done"] = Field(default="pending")
    priority: int = Field(default=3)
    evidence: str = Field(default="")
    suggested_tools: list[str] = Field(default_factory=list)


class MissionState(BaseModel):
    thread_id: str
    turn_id: str = ""
    ts_ms: int = 0
    primary_objective: str = ""
    objective_confidence: float = 0.0
    success_criteria: list[str] = Field(default_factory=list)
    constraints: list[str] = Field(default_factory=list)
    active_subproblems: list[MissionSubproblem] = Field(default_factory=list)
    done_subproblems: list[str] = Field(default_factory=list)
    out_of_scope: list[str] = Field(default_factory=list)
    # Backward compatible:
    # - legacy intent keys: general/implement/debug/plan/review/chat
    # - scenario keys: chat/plan/workspace (legacy web/manage/evolve/trae → workspace or chat)
    # - supports comma-separated multi-scenario (e.g. "plan,web")
    intent_hint: str = "chat"
    # Persisted activated scenarios — survive across request boundaries.
    # Populated by the agent's scenario() tool calls and restored on next make_lead_agent.
    activated_scenarios: list[str] = Field(default_factory=list)
    # Latest successful ``plan`` tool submission for this thread (used to bind root tasks at creation).
    bound_plan_markdown: str = ""
    bound_plan_ts_ms: int = 0
    change_type: Literal["noop", "update", "reset"] = "update"
    version: int = 1
    exploration_summary: str = Field(
        default="",
        description="3-5 bullets: key code findings from read_registry + conversation (not tool steps).",
    )
    exploration_gaps: list[str] = Field(
        default_factory=list,
        description="Open questions or paths still needed to complete the objective.",
    )
    task_type: str = Field(
        default="",
        description="Heuristic task class: locate_file|understand_code|data_bug|implement|runtime|general",
    )

    @model_validator(mode="after")
    def _normalize_fields(self) -> MissionState:
        """Normalize legacy intent_hint values and ensure activated_scenarios are valid."""
        # Normalize intent_hint: support legacy literal values and comma-separated multi-scenario
        if self.intent_hint:
            parts = [normalize_scenario_key(p.strip()) for p in self.intent_hint.replace("|", ",").split(",") if p.strip()]
            # Deduplicate while preserving order
            seen: set[str] = set()
            unique: list[str] = []
            for p in parts:
                if p not in seen:
                    seen.add(p)
                    unique.append(p)
            self.intent_hint = ",".join(unique) if unique else "chat"
        # Normalize activated_scenarios
        if self.activated_scenarios:
            self.activated_scenarios = [normalize_scenario_key(s) for s in self.activated_scenarios if s and s.strip()]
        return self
