"""Regression: subtask DAG uses numeric refs (auto 1,2,3…), not display names."""

from __future__ import annotations

import asyncio
import importlib
import json
import tempfile
from pathlib import Path
from types import SimpleNamespace

import evoflow.collab.storage as cs
from evoflow.collab.storage import ProjectStorage, find_main_task
from evoflow.config.paths import Paths

supervisor_mod = importlib.import_module("evoflow.tools.builtins.supervisor_tool")


def _run_supervisor(storage: ProjectStorage, paths: Paths, **kwargs) -> str:
    supervisor_mod.get_project_storage = lambda: storage
    cs.get_project_storage = lambda: storage
    supervisor_mod.get_paths = lambda: paths

    async def _fake_delegate(_runtime, _storage, _main_task_id, subtask_ids, **_kw):
        return [{"subtaskId": sid, "ok": True} for sid in subtask_ids]

    supervisor_mod.delegate_collab_subtasks_for_start_execution = _fake_delegate
    supervisor_mod.get_available_subagent_names = lambda: ["general-purpose"]

    async def _go(call_kwargs: dict):
        call_kwargs = {"tool_call_id": "tc-test", **call_kwargs}
        return await supervisor_mod.supervisor_tool.coroutine(**call_kwargs)

    return asyncio.run(_go(kwargs))


def test_auto_ref_and_numeric_depends_on():
    tmpdir = tempfile.mkdtemp()
    storage = ProjectStorage(Path(tmpdir))
    paths = Paths(base_dir=str(Path(tmpdir) / "home"))
    runtime = SimpleNamespace(
        context={"thread_id": "thread-deps"},
        config={"configurable": {"thread_id": "thread-deps"}},
    )

    out = _run_supervisor(
        storage,
        paths,
        runtime=runtime,
        action="create_task_with_subtasks",
        task_name="Dep test",
        task_description="x" * 25,
        subtasks=[
            {
                "name": "任意显示名 A",
                "description": "first subtask long enough",
                "assigned_to": "general-purpose",
            },
            {
                "name": "完全不同的名字 B",
                "description": "second subtask long enough",
                "assigned_to": "general-purpose",
                "depends_on": ["1"],
            },
        ],
    )
    data = json.loads(out)
    assert data["success"] is True
    created = {int(r["subtaskIndex"]): r for r in data["created"]}
    assert created[0]["ref"] == "1"
    assert created[1]["ref"] == "2"

    row = find_main_task(storage, data["taskId"])
    assert row is not None
    _proj, task = row
    subs = sorted(task["subtasks"], key=lambda s: str(s.get("ref") or ""))
    assert subs[0]["ref"] == "1"
    assert subs[1]["ref"] == "2"
    assert subs[1]["worker_profile"]["depends_on"] == [subs[0]["id"]]

    start_out = json.loads(
        _run_supervisor(
            storage,
            paths,
            runtime=runtime,
            action="start_execution",
            task_id=data["taskId"],
            authorized_by="lead",
        )
    )
    assert len(start_out["subtaskIds"]) == 1
    assert any(b.get("reason") == "waiting_on_dependencies" for b in (start_out.get("blockedSubtasks") or []))


def test_name_in_depends_on_is_not_resolved():
    """Display names must not be used as dependency edges."""
    tmpdir = tempfile.mkdtemp()
    storage = ProjectStorage(Path(tmpdir))
    paths = Paths(base_dir=str(Path(tmpdir) / "home"))
    runtime = SimpleNamespace(
        context={"thread_id": "thread-name"},
        config={"configurable": {"thread_id": "thread-name"}},
    )

    out = _run_supervisor(
        storage,
        paths,
        runtime=runtime,
        action="create_task_with_subtasks",
        task_name="Name dep",
        task_description="y" * 25,
        subtasks=[
            {
                "name": "OnlyName",
                "description": "first subtask long enough",
                "assigned_to": "general-purpose",
            },
            {
                "name": "Second",
                "description": "second subtask long enough",
                "assigned_to": "general-purpose",
                "depends_on": ["OnlyName"],
            },
        ],
    )
    data = json.loads(out)
    row = find_main_task(storage, data["taskId"])
    _proj, task = row
    second = [s for s in task["subtasks"] if s.get("ref") == "2"][0]
    assert second["worker_profile"].get("depends_on") in (None, [])
    warnings = (data["created"][1].get("warnings") or []) if len(data.get("created") or []) > 1 else []
    assert any("droppedDependsOn" in str(w) for w in warnings) or not second["worker_profile"].get("depends_on")


def test_dependencies_alias_uses_numeric_ref():
    tmpdir = tempfile.mkdtemp()
    storage = ProjectStorage(Path(tmpdir))
    paths = Paths(base_dir=str(Path(tmpdir) / "home"))
    runtime = SimpleNamespace(
        context={"thread_id": "thread-alias"},
        config={"configurable": {"thread_id": "thread-alias"}},
    )

    out = _run_supervisor(
        storage,
        paths,
        runtime=runtime,
        action="create_task_with_subtasks",
        task_name="Alias",
        task_description="z" * 25,
        subtasks=[
            {"name": "s1", "description": "first subtask long enough", "assigned_to": "general-purpose"},
            {
                "name": "s2",
                "description": "second subtask long enough",
                "assigned_to": "general-purpose",
                "dependencies": ["1"],
            },
        ],
    )
    data = json.loads(out)
    row = find_main_task(storage, data["taskId"])
    _proj, task = row
    by_ref = {str(s["ref"]): s for s in task["subtasks"]}
    assert by_ref["2"]["worker_profile"]["depends_on"] == [by_ref["1"]["id"]]
