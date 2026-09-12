"""Gateway dispatch after authorize calls supervisor start_execution.

``POST /tasks/{id}/authorize-execution`` invokes the same
``dispatch_authorized_main_task_execution`` helper so UI「开始执行」starts workers
without waiting for Lead ``supervisor(start_execution)``.
"""

from __future__ import annotations

import asyncio
import importlib
import weakref

import evoflow.collab.storage as cs
from evoflow.collab.authorize_execution import authorize_main_task_execution
from evoflow.collab.dispatch_authorized_execution import (
    dispatch_authorized_main_task_execution,
    gateway_tool_runtime,
)
from evoflow.collab.storage import ProjectStorage, new_project_bundle_root_task
from evoflow.config.paths import Paths

supervisor_mod = importlib.import_module("evoflow.tools.builtins.supervisor_tool")


def test_gateway_tool_runtime_supports_weakref() -> None:
    rt = gateway_tool_runtime("thread-weakref")
    ref = weakref.ref(rt)
    assert ref() is rt


def test_register_collab_lead_runtime_tolerates_non_weakrefable() -> None:
    from types import SimpleNamespace

    from evoflow.tools.builtins.supervisor import execution as exec_mod

    exec_mod._collab_lead_runtime_by_task.clear()
    bad = SimpleNamespace()
    exec_mod._register_collab_lead_runtime("Task_weakref_guard", bad)  # must not raise
    assert "Task_weakref_guard" not in exec_mod._collab_lead_runtime_by_task


def test_dispatch_requires_subtasks(tmp_path) -> None:
    storage = ProjectStorage(tmp_path / "bundles")
    project, task = new_project_bundle_root_task("t", "description long enough here", thread_id="t1")
    task["status"] = "planned"
    storage.save_project(project)
    tid = str(task["id"])
    authorize_main_task_execution(storage, tid, "user")

    out = asyncio.run(dispatch_authorized_main_task_execution(tid, thread_id="t1"))
    assert out.get("success") is False
    assert out.get("error") == "no_subtasks"


def test_dispatch_calls_supervisor_when_subtasks_exist(tmp_path) -> None:
    storage = ProjectStorage(tmp_path / "bundles")
    paths = Paths(base_dir=str(tmp_path / "home"))
    project, task = new_project_bundle_root_task("t", "description long enough here", thread_id="t2")
    task["status"] = "planned"
    task["subtasks"] = [
        {
            "id": "sub-1",
            "name": "Step 1",
            "description": "do step one with enough chars",
            "status": "pending",
            "assigned_to": "general-purpose",
        },
    ]
    storage.save_project(project)
    tid = str(task["id"])
    authorize_main_task_execution(storage, tid, "user")

    supervisor_mod.get_project_storage = lambda: storage
    cs.get_project_storage = lambda: storage
    supervisor_mod.get_paths = lambda: paths

    async def _fake_delegate(_runtime, _storage, _main_task_id, subtask_ids, **_kw):
        return [{"subtaskId": sid, "ok": True, "detached": True} for sid in subtask_ids]

    supervisor_mod.delegate_collab_subtasks_for_start_execution = _fake_delegate
    supervisor_mod.get_available_subagent_names = lambda: ["general-purpose"]

    out = asyncio.run(dispatch_authorized_main_task_execution(tid, thread_id="t2"))
    assert out.get("success") is True
    assert out.get("action") == "start_execution"
