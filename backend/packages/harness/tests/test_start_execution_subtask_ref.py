"""start_execution accepts plan step refs (e.g. \"1\") as subtask_ids tokens."""

from __future__ import annotations

from evoflow.tools.builtins.supervisor.dependency import resolve_explicit_subtask_tokens


class _FakeStorage:
    def __init__(self, task: dict, project: dict | None = None) -> None:
        self._task = task
        self._project = project or {"id": "proj-1", "tasks": [task]}

    def load_project(self, pid: str):
        return self._project if str(pid) == "proj-1" else None


def test_resolve_explicit_subtask_tokens_accepts_step_ref(monkeypatch) -> None:
    task = {
        "id": "Task_test_001",
        "subtasks": [
            {
                "id": "Subtask_20260602120000_000001",
                "ref": "1",
                "name": "Step 1: First",
                "status": "planned",
                "assigned_to": "general-purpose",
                "worker_profile": {"depends_on": []},
            },
            {
                "id": "Subtask_20260602120000_000002",
                "ref": "2",
                "name": "Step 2: Second",
                "status": "planned",
                "assigned_to": "general-purpose",
                "worker_profile": {"depends_on": ["1"]},
            },
        ],
    }

    def fake_find(storage, task_id: str):
        if task_id == "Task_test_001":
            return (_FakeStorage(task)._project, task)
        return None

    monkeypatch.setattr(
        "evoflow.collab.storage.find_main_task",
        fake_find,
    )

    resolved, missing = resolve_explicit_subtask_tokens(None, "Task_test_001", ["1"])
    assert missing == []
    assert resolved == ["Subtask_20260602120000_000001"]

    resolved2, missing2 = resolve_explicit_subtask_tokens(None, "Task_test_001", ["Subtask_20260602120000_000002"])
    assert missing2 == []
    assert resolved2 == ["Subtask_20260602120000_000002"]

    _r3, missing3 = resolve_explicit_subtask_tokens(None, "Task_test_001", ["99"])
    assert missing3 == ["99"]
