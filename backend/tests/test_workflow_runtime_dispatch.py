"""dispatch_for_task routes App vs Lead."""

from __future__ import annotations

from unittest.mock import AsyncMock

import pytest

from evoflow.collab.workflow_runtime import dispatch_for_task


@pytest.mark.asyncio
async def test_dispatch_for_task_app_uses_start(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(
        "evoflow.collab.workflow_runtime._load_main_task",
        lambda _tid: {"id": "wf1", "source_app_id": "App_x"},
    )
    start = AsyncMock(
        return_value={
            "ok": True,
            "dispatch": {"success": True, "delegatedSubtasks": [{"ok": True, "subtaskId": "s1"}]},
        }
    )
    monkeypatch.setattr("evoflow.collab.workflow_runtime.start", start)
    lead = AsyncMock()
    monkeypatch.setattr(
        "evoflow.collab.dispatch_authorized_execution.dispatch_authorized_main_task_execution",
        lead,
    )

    out = await dispatch_for_task("wf1", authorized_by="api")
    assert out["success"] is True
    start.assert_awaited_once()
    lead.assert_not_awaited()


@pytest.mark.asyncio
async def test_dispatch_for_task_lead_uses_authorized(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(
        "evoflow.collab.workflow_runtime._load_main_task",
        lambda _tid: {"id": "lead1"},
    )
    start = AsyncMock()
    monkeypatch.setattr("evoflow.collab.workflow_runtime.start", start)
    lead = AsyncMock(return_value={"success": True, "taskId": "lead1"})
    monkeypatch.setattr(
        "evoflow.collab.dispatch_authorized_execution.dispatch_authorized_main_task_execution",
        lead,
    )

    out = await dispatch_for_task("lead1", authorized_by="user", thread_id="t1")
    assert out["success"] is True
    start.assert_not_awaited()
    lead.assert_awaited_once()
