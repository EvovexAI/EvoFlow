"""LangGraph state for in-graph hosted goal orchestration."""

from __future__ import annotations

from typing import Annotated, Any, Literal

try:
    from typing import NotRequired, TypedDict
except ImportError:
    from typing import NotRequired

    from typing_extensions import TypedDict

from langchain_core.messages import BaseMessage
from langgraph.graph.message import add_messages

# Goal lifecycle (long-lived objective).
GoalLifecycleStatus = Literal["active", "paused", "completed", "cleared"]
GoalStatus = GoalLifecycleStatus

# Single lead-agent execution within a goal.
RunStatus = Literal["idle", "running", "finished", "cancelled", "stopped"]

RunTrigger = Literal["goal_created", "goal_continuation", "user_steering", "goal_resume"]

# Controller routing outcome after a run finishes.
ControllerOutcome = Literal[
    "running",
    "interrupted",
    "waiting_user",
    "continuing",
    "completed",
    "failed",
]

GOAL_CONTROLLER_SOURCE = "goal_controller"
GOAL_SYNTHETIC_USER_NAME = GOAL_CONTROLLER_SOURCE


def merge_goal_events(existing: list[dict[str, Any]] | None, new: list[dict[str, Any]] | None) -> list[dict[str, Any]]:
    if existing is None:
        return list(new or [])
    if new is None:
        return list(existing)
    return [*existing, *new]


def merge_completed_steps(existing: list[str] | None, new: list[str] | None) -> list[str]:
    if existing is None:
        return list(new or [])
    if new is None:
        return list(existing)
    return list(dict.fromkeys([*existing, *new]))


class GoalState(TypedDict, total=False):
    """Checkpoint state for ``goal_agent`` (separate from lead chat transcript)."""

    messages: Annotated[list[BaseMessage], add_messages]

    goal_id: str
    goal_text: str
    goal_revision: int
    planner_system_prompt: str

    goal_status: GoalLifecycleStatus
    run_status: RunStatus
    run_trigger: RunTrigger
    continuation_suppressed: bool

    # Controller outcome for routing (not the same as goal_status).
    status: ControllerOutcome
    completed_steps: Annotated[list[str], merge_completed_steps]
    remaining_steps: NotRequired[list[str]]

    pending_continuation: str | None
    goal_events: Annotated[list[dict[str, Any]], merge_goal_events]

    current_step: int
    max_steps: int
    last_agent_reply: str
    last_error: str
    clarification_prompt: str
    stop_reason: str

    started_at: float
    goal_session_id: str
    session_key: str
    lead_thread_id: str
    frontend_chat_done: bool
    single_lead_run: bool
