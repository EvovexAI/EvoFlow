"""WorkflowScheduler: App DAG waves enter one facade; Lead collab stays outside."""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock

import pytest

from evoflow.collab.workflow_scheduler import (
    advance_dag,
    advance_followup_if_workflow,
    is_workflow_scheduler_task,
)


def test_is_workflow_scheduler_task_by_source_app():
    assert is_workflow_scheduler_task({"id": "t1", "source_app_id": "App_x"}) is True
    assert is_workflow_scheduler_task({"id": "t1"}) is False
    assert is_workflow_scheduler_task(None) is False


@pytest.mark.asyncio
async def test_advance_dag_rejects_lead_collab_task(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(
        "evoflow.collab.workflow_scheduler._load_main_task",
        lambda _tid: {"id": "lead1", "title": "chat plan"},
    )
    out = await advance_dag("lead1", reason="initial")
    assert out["ok"] is False
    assert out["error"] == "not_workflow_scheduler_task"


@pytest.mark.asyncio
async def test_advance_dag_initial_dispatches_and_pushes(monkeypatch: pytest.MonkeyPatch):
    pushes: list[str] = []

    monkeypatch.setattr(
        "evoflow.collab.workflow_scheduler._load_main_task",
        lambda _tid: {"id": "wf1", "source_app_id": "App_x"},
    )

    async def _dispatch(tid, *, thread_id=None, authorized_by="api"):
        return {"success": True, "taskId": tid, "delegatedSubtasks": ["s1"]}

    monkeypatch.setattr(
        "evoflow.collab.dispatch_authorized_execution.dispatch_authorized_main_task_execution",
        _dispatch,
    )
    monkeypatch.setattr(
        "evoflow.collab.workflow_scheduler._push_app_run",
        lambda tid: pushes.append(tid),
    )

    out = await advance_dag("wf1", reason="initial", authorized_by="api")
    assert out["ok"] is True
    assert out["action"] == "start_execution"
    assert out["dispatch"]["delegatedSubtasks"] == ["s1"]
    assert pushes == ["wf1"]


@pytest.mark.asyncio
async def test_advance_dag_followup_delegates_and_pushes(monkeypatch: pytest.MonkeyPatch):
    pushes: list[str] = []
    called: list[tuple] = []

    monkeypatch.setattr(
        "evoflow.collab.workflow_scheduler._load_main_task",
        lambda _tid: {"id": "wf1", "source_app_id": "App_x"},
    )

    async def _followup(runtime, tid):
        called.append((runtime, tid))

    monkeypatch.setattr(
        "evoflow.tools.builtins.supervisor.execution.auto_delegate_collab_followup_wave",
        _followup,
    )
    monkeypatch.setattr(
        "evoflow.collab.workflow_scheduler._push_app_run",
        lambda tid: pushes.append(tid),
    )

    rt = MagicMock()
    out = await advance_dag("wf1", reason="followup", runtime=rt)
    assert out["ok"] is True
    assert out["action"] == "followup_wave"
    assert called == [(rt, "wf1")]
    assert pushes == ["wf1"]


@pytest.mark.asyncio
async def test_advance_followup_if_workflow_skips_lead(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(
        "evoflow.collab.workflow_scheduler._load_main_task",
        lambda _tid: {"id": "lead1"},
    )
    assert await advance_followup_if_workflow(None, "lead1") is False


@pytest.mark.asyncio
async def test_emit_followup_prefers_scheduler(monkeypatch: pytest.MonkeyPatch):
    from evoflow.tools.builtins import collab_bridge as bridge

    handled = AsyncMock(return_value=True)
    lead = AsyncMock()
    monkeypatch.setattr(
        "evoflow.collab.workflow_scheduler.advance_followup_if_workflow",
        handled,
    )
    prev = bridge._followup_handler_ref
    bridge._followup_handler_ref = lead
    try:
        await bridge.emit_followup_wave_needed(None, "wf1")
    finally:
        bridge._followup_handler_ref = prev
    handled.assert_awaited_once()
    lead.assert_not_awaited()
