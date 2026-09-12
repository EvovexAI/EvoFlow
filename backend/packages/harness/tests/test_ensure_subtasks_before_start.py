"""start_execution pre-sync: plan steps on task but empty subtasks list."""

from __future__ import annotations

from pathlib import Path

import pytest

from evoflow.collab.plan_subtasks_sync import ensure_subtasks_synced_before_start_execution
from evoflow.collab.plan_task_storage import persist_plan_steps
from evoflow.collab.storage import ProjectStorage, find_main_task, new_project_bundle_root_task
from evoflow.tools.builtins.supervisor.dependency import _resolve_subtasks_for_start_execution


@pytest.fixture
def storage_and_task(tmp_path, monkeypatch):
    monkeypatch.setenv("EVOFLOW_DATA_DIR", str(tmp_path))
    storage = ProjectStorage(Path(tmp_path))
    project, task = new_project_bundle_root_task("t", "description long enough for test", thread_id="t1")
    task_id = str(task["id"])
    steps = [
        {
            "ref": 1,
            "name": "执行任务1",
            "goal": "write task1",
            "assigned_agent": "bash",
            "depends_on": [],
        },
        {
            "ref": 2,
            "name": "执行任务2",
            "goal": "write task2",
            "assigned_agent": "bash",
            "depends_on": ["1"],
        },
    ]
    persist_plan_steps(task, steps)
    task["execution_authorized"] = True
    task["subtasks"] = []
    storage.save_project(project)
    return storage, task_id


def test_ensure_sync_creates_subtasks_then_start_execution_finds_wave1(storage_and_task) -> None:
    storage, task_id = storage_and_task
    meta = ensure_subtasks_synced_before_start_execution(task_id, storage=storage)
    assert meta["attempted"] is True
    assert meta["subtaskCountAfter"] == 2

    runnable, _blocked = _resolve_subtasks_for_start_execution(storage, task_id, None)
    row = find_main_task(storage, task_id)
    assert row is not None
    subs = row[1]["subtasks"]
    id_by_ref = {str(s["ref"]): str(s["id"]) for s in subs}
    assert runnable == [id_by_ref["1"]]
