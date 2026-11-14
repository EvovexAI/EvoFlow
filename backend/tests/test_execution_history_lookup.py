"""execution-history must point-lookup via load_task_bundle (no full project scan)."""

from __future__ import annotations

from typing import Any
from unittest.mock import patch

import pytest
from fastapi import HTTPException


@pytest.mark.asyncio
async def test_execution_history_uses_bundle_not_list_projects() -> None:
    from app.gateway.routers import tasks as tasks_mod

    bundle = {
        "tasks": [
            {
                "id": "task-abc",
                "thread_id": "thread-1",
                "origin_session_key": "proactive:x:task:task-abc",
                "execution_history": [{"execution_id": "e1", "status": "completed"}],
            }
        ]
    }

    class _Req:
        pass

    with (
        patch.object(tasks_mod, "require_task_visible", return_value=None),
        patch(
            "evoflow.persistence.task_repositories.load_task_bundle",
            return_value=bundle,
        ) as load_bundle,
        patch.object(tasks_mod, "get_project_storage") as get_storage,
    ):
        get_storage.return_value.list_projects.side_effect = AssertionError(
            "must not scan all projects"
        )
        out = await tasks_mod.get_execution_history(_Req(), "task-abc")

    assert out["task_id"] == "task-abc"
    assert out["current_thread_id"] == "thread-1"
    assert out["session_key"] == "proactive:x:task:task-abc"
    assert out["total_executions"] == 1
    load_bundle.assert_called_once_with("task-abc")


@pytest.mark.asyncio
async def test_execution_history_missing_task_raises() -> None:
    from app.gateway.routers import tasks as tasks_mod

    class _Req:
        pass

    with (
        patch.object(tasks_mod, "require_task_visible", return_value=None),
        patch(
            "evoflow.persistence.task_repositories.load_task_bundle",
            return_value=None,
        ),
    ):
        with pytest.raises(HTTPException) as ei:
            await tasks_mod.get_execution_history(_Req(), "missing")
    assert int(ei.value.status_code) == 404
