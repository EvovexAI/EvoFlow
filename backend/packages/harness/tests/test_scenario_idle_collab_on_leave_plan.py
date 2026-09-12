"""Leaving plan scenario should persist collab_phase=idle (Python 3.11+ import chain)."""

from __future__ import annotations

from unittest.mock import patch

import pytest

import evoflow.config.paths as evo_paths_mod

pytest.importorskip("tomllib")

from evoflow.collab import thread_collab as thread_collab_mod
from evoflow.collab.models import CollabPhase, ThreadCollabState
from evoflow.config.paths import Paths
from evoflow.tools.builtins import scenario_activation as scenario_activation_mod


def test_idle_collab_when_no_plan_scenario_writes_disk(tmp_path, monkeypatch) -> None:
    paths = Paths(base_dir=tmp_path)
    monkeypatch.setattr(evo_paths_mod, "get_paths", lambda: paths)
    tid = "thread-idle-test"
    thread_collab_mod.save_thread_collab_state(paths, tid, ThreadCollabState(collab_phase=CollabPhase.PLANNING, bound_task_id="x"))

    def _cfg():
        return {"configurable": {"thread_id": tid}}

    with patch("langgraph.config.get_config", _cfg):
        scenario_activation_mod._idle_thread_collab_when_no_plan_scenario([])
    disk = thread_collab_mod.load_thread_collab_state(paths, tid)
    assert disk.collab_phase == CollabPhase.IDLE
    assert disk.bound_task_id is None


def test_idle_collab_skipped_when_plan_still_active(tmp_path, monkeypatch) -> None:
    paths = Paths(base_dir=tmp_path)
    monkeypatch.setattr(evo_paths_mod, "get_paths", lambda: paths)
    tid = "thread-keep-plan"
    thread_collab_mod.save_thread_collab_state(paths, tid, ThreadCollabState(collab_phase=CollabPhase.PLANNING))

    def _cfg():
        return {"configurable": {"thread_id": tid}}

    with patch("langgraph.config.get_config", _cfg):
        scenario_activation_mod._idle_thread_collab_when_no_plan_scenario(["plan"])
    disk = thread_collab_mod.load_thread_collab_state(paths, tid)
    assert disk.collab_phase == CollabPhase.PLANNING
