"""Plan guard: disk-backed plan / execution flags survive message trimming."""

from __future__ import annotations

import json

import pytest
from langchain_core.messages import HumanMessage

from evoflow.agents.middlewares import plan_guard_middleware as pgm
from evoflow.agents.middlewares.plan_guard_middleware import (
    AWAITING_EXEC_ALLOWED_TOOL_NAMES,
    PLANNING_ALLOWED_TOOL_NAMES,
    STRICT_PLAN_LEAD_TOOL_NAMES,
    PlanGuardMiddleware,
)


@pytest.fixture
def no_mission_state(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("evoflow.agents.mission_state.storage.load_mission_state", lambda _tid: None)


def test_persistence_committed_plan_from_bound_task(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        "evoflow.collab.plan_on_task.thread_has_committed_plan_on_task",
        lambda tid, disk_bound="": tid == "t-ms",
    )
    assert pgm._persistence_indicates_committed_plan("t-ms", "") is True


def test_persistence_committed_plan_from_main_task(no_mission_state: None, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        "evoflow.collab.plan_on_task.thread_has_committed_plan_on_task",
        lambda tid, disk_bound="": tid == "t-task" and disk_bound == "Task_root",
    )
    assert pgm._persistence_indicates_committed_plan("t-task", "Task_root") is True


def test_persistence_execution_authorized(no_mission_state: None, monkeypatch: pytest.MonkeyPatch) -> None:
    def _resolve(*, thread_id: str, disk_bound: str):
        return "Task_root", {"status": "planned", "execution_authorized": True}

    monkeypatch.setattr(pgm, "_resolve_collab_main_task_id_and_row", _resolve)
    assert pgm._persistence_indicates_execution_authorized("thr", "Task_root") is True


def test_persistence_execution_not_terminal_gate(no_mission_state: None, monkeypatch: pytest.MonkeyPatch) -> None:
    def _resolve(*, thread_id: str, disk_bound: str):
        return "Task_root", {"status": "completed", "execution_authorized": True}

    monkeypatch.setattr(pgm, "_resolve_collab_main_task_id_and_row", _resolve)
    assert pgm._persistence_indicates_execution_authorized("thr", "Task_root") is False


def test_planning_phases_allow_subagent_for_orchestrator_delegate_recon() -> None:
    assert "subagent" in PLANNING_ALLOWED_TOOL_NAMES
    assert "subagent" in AWAITING_EXEC_ALLOWED_TOOL_NAMES
    assert "task" in PLANNING_ALLOWED_TOOL_NAMES
    assert "task" in AWAITING_EXEC_ALLOWED_TOOL_NAMES
    assert "propose_goal" not in PLANNING_ALLOWED_TOOL_NAMES
    assert "propose_goal" not in AWAITING_EXEC_ALLOWED_TOOL_NAMES
    assert "propose_goal" not in STRICT_PLAN_LEAD_TOOL_NAMES


def test_structured_exec_confirmation_accepts_persisted_plan_prefix(monkeypatch: pytest.MonkeyPatch) -> None:
    """When prior turns were summarized away, disk plan still satisfies the guard before「开始执行」."""
    monkeypatch.setattr(
        pgm,
        "_persistence_indicates_committed_plan",
        lambda tid, _db: tid == "t-trim",
    )
    payload = {"answers": [{"selected_option_labels": ["开始执行"]}]}
    text = "__EVF_CLARIFY_ANS_V1__:" + json.dumps(payload, ensure_ascii=False)
    msgs = [HumanMessage(content=text)]
    assert PlanGuardMiddleware._has_structured_execution_confirmation(msgs) is False
    assert PlanGuardMiddleware._has_structured_execution_confirmation(msgs, thread_id="t-trim", disk_bound="") is True
