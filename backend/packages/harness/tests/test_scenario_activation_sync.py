"""Scenario ContextVar ↔ mission_state disk alignment across multi-step model calls."""

from __future__ import annotations

from unittest.mock import MagicMock, patch

from evoflow.agents.middlewares.scenario_activation_sync_middleware import ScenarioActivationSyncMiddleware
from evoflow.agents.mission_state.models import MissionState
from evoflow.collab.models import ThreadCollabState
from evoflow.tools.builtins.scenario_activation import (
    get_activated_scenarios,
    replace_activated_scenarios_from_mission_list,
    sync_activated_scenarios_from_mission_storage,
)


def test_replace_overwrites_and_normalizes() -> None:
    replace_activated_scenarios_from_mission_list(["plan", "agent", "plan"])
    assert get_activated_scenarios() == ["plan"]
    replace_activated_scenarios_from_mission_list(["agent", "web"])
    assert get_activated_scenarios() == ["agent"]
    replace_activated_scenarios_from_mission_list([])
    assert get_activated_scenarios() == []


def test_sync_loads_from_thread_task_state_first() -> None:
    cc = ThreadCollabState(activated_scenarios=["plan"])
    rt = MagicMock()
    rt.context = {"thread_id": "tid-sync"}
    with patch("evoflow.collab.thread_collab.load_thread_collab_state", return_value=cc):
        sync_activated_scenarios_from_mission_storage(rt)
    assert get_activated_scenarios() == ["plan"]


def test_sync_falls_back_to_mission_when_thread_has_no_scenarios() -> None:
    cc = ThreadCollabState(activated_scenarios=[])
    ms = MissionState(
        thread_id="tid-sync",
        primary_objective="x",
        activated_scenarios=["plan"],
        intent_hint="ask",
        change_type="update",
        version=1,
    )
    rt = MagicMock()
    rt.context = {"thread_id": "tid-sync"}
    with patch("evoflow.collab.thread_collab.load_thread_collab_state", return_value=cc):
        with patch("evoflow.agents.mission_state.storage.load_mission_state", return_value=ms):
            sync_activated_scenarios_from_mission_storage(rt)
    assert get_activated_scenarios() == ["plan"]


def test_middleware_before_model_invokes_sync() -> None:
    mw = ScenarioActivationSyncMiddleware()
    rt = MagicMock()
    with patch("evoflow.tools.builtins.scenario_activation.sync_activated_scenarios_from_mission_storage") as m:
        mw.before_model({"messages": []}, rt)
        m.assert_called_once_with(rt)
