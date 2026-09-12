"""Plan 全流程 done 后才切 agent；executing/开始执行仍保持 plan 场景。"""

from __future__ import annotations

import pytest

from evoflow.agents.middlewares import plan_guard_middleware as pgm
from evoflow.agents.middlewares.plan_guard_middleware import PlanGuardMiddleware
from evoflow.tools.builtins.scenario_activation import (
    get_activated_scenarios,
    reset_activated_scenario,
    sync_agent_scenario_after_plan_done,
    sync_plan_scenario_with_session_policy,
    _add_scenario,
)


@pytest.fixture(autouse=True)
def _clear_scenario_state() -> None:
    reset_activated_scenario()
    yield
    reset_activated_scenario()


def test_sync_plan_activates_on_ui_plan_mode_idle() -> None:
    changes = sync_plan_scenario_with_session_policy(session_mode="plan", collab_phase="idle")
    assert "activated:plan" in changes
    assert get_activated_scenarios() == ["plan"]


def test_sync_plan_still_runs_during_executing() -> None:
    changes = sync_plan_scenario_with_session_policy(session_mode="plan", collab_phase="executing")
    assert "activated:plan" in changes
    assert get_activated_scenarios() == ["plan"]


def test_sync_agent_does_not_switch_during_executing() -> None:
    _add_scenario("plan")
    changes = sync_agent_scenario_after_plan_done(collab_phase="executing", thread_id="t-exec")
    assert changes == []
    assert get_activated_scenarios() == ["plan"]


def test_sync_agent_does_not_switch_when_authorized_but_executing_flow() -> None:
    _add_scenario("plan")
    changes = sync_agent_scenario_after_plan_done(collab_phase="awaiting_exec", thread_id="t-await")
    assert changes == []
    assert get_activated_scenarios() == ["plan"]


def test_sync_agent_replaces_plan_on_done() -> None:
    _add_scenario("plan")
    changes = sync_agent_scenario_after_plan_done(collab_phase="done", thread_id="t-done")
    assert "activated:agent" in changes
    assert get_activated_scenarios() == ["agent"]


def test_strict_plan_on_during_awaiting_exec(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        "evoflow.tools.builtins.scenario_activation.get_activated_scenarios",
        lambda: ["plan"],
    )
    monkeypatch.setattr(
        "evoflow.agents.middlewares.plan_guard_middleware.load_merged_collab_phase",
        lambda _paths, _tid, _ctx: "awaiting_exec",
    )
    assert pgm.is_strict_plan_collaboration_for_thread("t-await", "awaiting_exec") is True


def test_strict_plan_off_during_executing(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        "evoflow.tools.builtins.scenario_activation.get_activated_scenarios",
        lambda: ["plan"],
    )
    monkeypatch.setattr(
        "evoflow.agents.middlewares.plan_guard_middleware.load_merged_collab_phase",
        lambda _paths, _tid, _ctx: "executing",
    )
    assert pgm.is_strict_plan_collaboration_for_thread("t-exec", "executing") is False


def test_done_phase_not_virtual_promoted_to_planning(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        "evoflow.agents.middlewares.plan_guard_middleware.effective_activated_scenario_keys",
        lambda _runtime, _msgs: {"plan"},
    )
    monkeypatch.setattr(
        "evoflow.agents.middlewares.plan_guard_middleware.load_merged_collab_phase",
        lambda _paths, _tid, _ctx: "done",
    )
    from unittest.mock import MagicMock

    mw = PlanGuardMiddleware()
    runtime = MagicMock()
    runtime.context = {"collab_phase": "done", "thread_id": "t-done"}
    phase = mw._effective_collab_phase_for_guard(runtime, [])
    assert phase == "done"
