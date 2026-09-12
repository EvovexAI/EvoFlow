"""Regression: stop→resume must not mark Step2 executing before Step1 completes."""

from __future__ import annotations

from pathlib import Path
from typing import Any
from unittest.mock import MagicMock

import pytest

from evoflow.collab.plan_subtasks_sync import sync_subtasks_from_plan_steps
from evoflow.collab.storage import ProjectStorage, find_main_task, new_project_bundle_root_task
from evoflow.tools.builtins.supervisor.dependency import _resolve_subtasks_for_start_execution


@pytest.fixture
def plan_chain_storage(tmp_path, monkeypatch):
    monkeypatch.setenv("EVOFLOW_DATA_DIR", str(tmp_path))
    storage = ProjectStorage(Path(tmp_path))
    project, task = new_project_bundle_root_task(
        "resume-dag",
        "description long enough for test",
        thread_id="t_resume_dag",
    )
    task_id = str(task["id"])
    storage.save_project(project)
    return storage, task_id


def _two_step_chain() -> list[dict]:
    return [
        {
            "ref": 1,
            "name": "step1",
            "description": "First step",
            "assigned_agent": "general-purpose",
        },
        {
            "ref": 2,
            "name": "step2",
            "description": "Second step",
            "assigned_agent": "general-purpose",
            "depends_on": ["1"],
        },
    ]


def test_explicit_start_still_respects_depends_on(plan_chain_storage) -> None:
    storage, task_id = plan_chain_storage
    sync = sync_subtasks_from_plan_steps(task_id, _two_step_chain(), storage=storage)
    assert sync["success"] is True

    row = find_main_task(storage, task_id)
    assert row is not None
    _proj, task = row
    subs = sorted(task["subtasks"], key=lambda s: int(str(s.get("ref") or "0")))
    id_by_ref = {str(s["ref"]): str(s["id"]) for s in subs}

    # Lead/UI passes both ids — Step2 must stay blocked until Step1 completes.
    runnable, blocked = _resolve_subtasks_for_start_execution(
        storage, task_id, [id_by_ref["1"], id_by_ref["2"]]
    )
    assert runnable == [id_by_ref["1"]]
    blocked_ids = {b.get("subtaskId") for b in blocked}
    assert id_by_ref["2"] in blocked_ids
    step2_block = next(b for b in blocked if b.get("subtaskId") == id_by_ref["2"])
    assert step2_block.get("reason") == "waiting_on_dependencies"
    assert id_by_ref["1"] in (step2_block.get("unmetDependencies") or [])


def test_pause_run_only_marks_inflight_subtasks_paused(monkeypatch) -> None:
    from evoflow.collab import app_runner as ar

    stored: dict[str, Any] = {}
    bundle = {
        "tasks": [
            {
                "id": "main-1",
                "status": "executing",
                "subtasks": [
                    {"id": "st-1", "status": "executing"},
                    {"id": "st-2", "status": "pending"},
                ],
            }
        ]
    }

    monkeypatch.setattr(
        ar.app_repositories, "load_run", lambda _rid: {"task_id": "main-1", "status": "running"}
    )
    monkeypatch.setattr(ar.app_repositories, "update_run_status", lambda *_a, **_k: None)
    monkeypatch.setattr(
        "evoflow.persistence.task_repositories.load_task_bundle",
        lambda _tid: bundle,
    )
    monkeypatch.setattr(
        "evoflow.persistence.task_repositories.save_task_bundle",
        lambda _tid, b: stored.update(bundle=b),
    )

    assert ar.pause_run("run-1") is True
    subs = stored["bundle"]["tasks"][0]["subtasks"]
    assert subs[0]["status"] == "paused"
    assert subs[1]["status"] == "pending"


def test_resume_run_resets_paused_to_pending_not_executing(monkeypatch) -> None:
    from evoflow.collab import app_runner as ar

    stored: dict[str, Any] = {}
    bundle = {
        "tasks": [
            {
                "id": "main-1",
                "status": "paused",
                "subtasks": [
                    {"id": "st-1", "status": "paused"},
                    {"id": "st-2", "status": "paused"},
                ],
            }
        ]
    }

    monkeypatch.setattr(
        ar.app_repositories, "load_run", lambda _rid: {"task_id": "main-1", "status": "paused"}
    )
    monkeypatch.setattr(ar.app_repositories, "update_run_status", lambda *_a, **_k: None)
    monkeypatch.setattr(
        "evoflow.persistence.task_repositories.load_task_bundle",
        lambda _tid: bundle,
    )
    monkeypatch.setattr(
        "evoflow.persistence.task_repositories.save_task_bundle",
        lambda _tid, b: stored.update(bundle=b),
    )
    monkeypatch.setattr("threading.Thread", lambda *a, **k: MagicMock(start=lambda: None))

    assert ar.resume_run("run-1") is True
    main = stored["bundle"]["tasks"][0]
    assert main["status"] == "executing"
    assert all(st["status"] == "pending" for st in main["subtasks"])
