"""continue_subtask_session must not revive terminal steps."""

from __future__ import annotations

import pytest


@pytest.mark.asyncio
async def test_continue_refuses_completed_subtask(monkeypatch: pytest.MonkeyPatch):
    from evoflow.collab import continue_subtask_session as mod

    sub = {"id": "s1", "status": "completed", "progress": 100, "assigned_to": "general-purpose"}
    task = {"id": "mt1", "subtasks": [sub], "thread_id": "t1"}
    project = {"id": "p1", "tasks": [task]}
    storage = type("S", (), {"save_project": lambda self, p: True})()

    monkeypatch.setattr(mod, "find_main_task", lambda *_a, **_k: (project, task))

    out = await mod.continue_subtask_session(
        storage=storage,
        task_id="mt1",
        subtask_id="s1",
        agent_message="follow up",
    )
    assert out["success"] is False
    assert "cannot continue" in str(out.get("error") or "")
    assert "terminal" in str(out.get("error") or "")
    assert sub["status"] == "completed"
