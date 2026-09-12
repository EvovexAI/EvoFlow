"""Tests for supervisor task_id / subtask_id resolution from runtime context."""

from __future__ import annotations

from types import SimpleNamespace

import pytest

from evoflow.collab.storage import get_project_storage, new_project_bundle_root_task
from evoflow.persistence.db import reset_db_for_tests
from evoflow.tools.builtins.supervisor.utils import resolve_supervisor_task_subtask_ids


@pytest.fixture
def storage_with_subtask(tmp_path, monkeypatch):
    monkeypatch.setenv("EVOFLOW_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("EVOFLOW_HOME", str(tmp_path))
    reset_db_for_tests()
    storage = get_project_storage()
    project, task = new_project_bundle_root_task(
        "main",
        "resolve ids test task" + "x" * 10,
        thread_id="thread_resolve_test",
    )
    task_id = str(task["id"])
    subtask_id = "Subtask_resolve_001"
    task["subtasks"] = [{"id": subtask_id, "name": "step", "status": "executing", "assigned_to": "project-implementer"}]
    storage.save_project(project)
    return storage, task_id, subtask_id


def test_resolve_from_subtask_id_only(storage_with_subtask):
    storage, task_id, subtask_id = storage_with_subtask
    mid, sid = resolve_supervisor_task_subtask_ids(storage, None, None, subtask_id)
    assert mid == task_id
    assert sid == subtask_id


def test_resolve_task_id_from_runtime_context(storage_with_subtask):
    storage, task_id, subtask_id = storage_with_subtask
    runtime = SimpleNamespace(
        context={"collab_task_id": task_id},
        config={"configurable": {}},
    )
    mid, sid = resolve_supervisor_task_subtask_ids(storage, runtime, None, subtask_id)
    assert mid == task_id
    assert sid == subtask_id
