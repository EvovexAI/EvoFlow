"""Task detail must expose per-subtask results + timing.

Regression for the 员工 page showing 「已完成」 with nothing underneath:
workflow tasks whose rollup step never ran kept ``result_json = NULL`` on the
main task, and ``get_task`` only returned subtask name/status/progress — so the
completed steps' actual output (the only real deliverable) was invisible.
"""

from __future__ import annotations

from types import SimpleNamespace

import pytest

from evoflow.admin import tasks as admin_tasks
from evoflow.persistence import repositories as repo_mod


def _fake_task() -> dict:
    return {
        "id": "T1",
        "name": "工作流连通性验证",
        "description": "两步：提炼 + 扩写",
        "status": "completed",
        "progress": 100,
        "result": None,
        "created_at": "2026-10-23T20:10:18+08:00",
        "started_at": "2026-10-23T20:10:18+08:00",
        "completed_at": "2026-10-23T20:14:38+08:00",
        "subtasks": [
            {
                "id": "S1",
                "name": "Step 1: 提炼要点",
                "status": "completed",
                "progress": 100,
                "result": "三条核心要点……",
                "started_at": "2026-10-23T20:10:20+08:00",
                "completed_at": "2026-10-23T20:12:00+08:00",
            },
            {
                "id": "S2",
                "name": "Step 2: 扩写说明",
                "status": "completed",
                "progress": 100,
                "result": "84 字扩写说明……",
                "started_at": "2026-10-23T20:12:05+08:00",
                "completed_at": "2026-10-23T20:14:30+08:00",
            },
        ],
    }


@pytest.fixture()
def patched(monkeypatch: pytest.MonkeyPatch):
    task = _fake_task()
    monkeypatch.setattr(
        admin_tasks,
        "find_main_task",
        lambda *_a, **_kw: (SimpleNamespace(id="p1"), task),
    )
    monkeypatch.setattr(repo_mod, "list_child_task_ids", lambda _tid: [], raising=False)
    return task


def test_get_task_includes_subtask_result_and_timing(patched) -> None:
    detail = admin_tasks.get_task("T1")

    subs = detail["subtasks"]
    assert [s["subtask_id"] for s in subs] == ["S1", "S2"]

    # The core regression: per-step output must survive into the payload.
    assert subs[0]["result"] == "三条核心要点……"
    assert subs[1]["result"] == "84 字扩写说明……"

    # Timing is needed for the 「耗时」 labels.
    assert subs[0]["started_at"] == "2026-10-23T20:10:20+08:00"
    assert subs[0]["completed_at"] == "2026-10-23T20:12:00+08:00"

    # Main task legitimately has no rollup result here.
    assert detail["result"] is None
    assert detail["status"] == "completed"


def test_get_task_subtask_result_tolerates_missing_fields(monkeypatch: pytest.MonkeyPatch) -> None:
    task = _fake_task()
    task["subtasks"] = [{"id": "S1", "name": "Step 1", "status": "completed"}]
    monkeypatch.setattr(admin_tasks, "find_main_task", lambda *_a, **_kw: (SimpleNamespace(id="p1"), task))
    monkeypatch.setattr(repo_mod, "list_child_task_ids", lambda _tid: [], raising=False)

    subs = admin_tasks.get_task("T1")["subtasks"]
    assert subs[0]["result"] is None
    assert subs[0]["started_at"] is None
    assert subs[0]["summary"] is None
