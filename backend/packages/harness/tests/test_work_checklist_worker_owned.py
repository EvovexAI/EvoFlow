"""Worker-owned checklist: start_execution does not require Lead pre-seeding."""

from __future__ import annotations

import pytest

from evoflow.collab.storage import find_subtask_by_ids, get_project_storage, new_project_bundle_root_task
from evoflow.collab.work_checklist import get_subtask_work_checklist
from evoflow.tools.builtins.supervisor.execution import _build_subtask_enriched_prompt


@pytest.fixture
def task_no_checklist(tmp_path, monkeypatch):
    monkeypatch.setenv("EVOFLOW_DATA_DIR", str(tmp_path))
    storage = get_project_storage()
    project, task = new_project_bundle_root_task("main", "x" * 30, thread_id="t_wc_worker")
    task_id = str(task["id"])
    subtask_id = "Subtask_worker_01"
    task["subtasks"] = [
        {
            "id": subtask_id,
            "name": "implement",
            "description": "Build the API",
            "status": "pending",
            "assigned_to": "general-purpose",
        }
    ]
    storage.save_project(project)
    return storage, task_id, subtask_id


def test_no_checklist_allowed_at_prompt(task_no_checklist):
    storage, task_id, subtask_id = task_no_checklist
    st = find_subtask_by_ids(storage, task_id, subtask_id)
    assert st is not None
    assert get_subtask_work_checklist(st) == []
    prompt = _build_subtask_enriched_prompt(
        subtask_row=st,
        main_task_id=task_id,
        subtask_id=subtask_id,
        storage=storage,
    )
    assert "subtask_work_checklist" in prompt
    assert "set_subtask_work_checklist" not in prompt or "Lead" in prompt
