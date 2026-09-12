"""Regression: plan sync stores depends_on as step refs; runtime must resolve to subtask ids."""

from __future__ import annotations

from pathlib import Path

import pytest

from evoflow.collab.plan_subtasks_sync import sync_subtasks_from_plan_steps
from evoflow.collab.storage import ProjectStorage, find_main_task, new_project_bundle_root_task
from evoflow.tools.builtins.supervisor.dependency import (
    _resolve_subtasks_for_start_execution,
    normalize_subtask_depends_on_refs,
    requeue_failed_subtasks_ready_for_retry,
)


@pytest.fixture
def plan_chain_storage(tmp_path, monkeypatch):
    monkeypatch.setenv("EVOFLOW_DATA_DIR", str(tmp_path))
    storage = ProjectStorage(Path(tmp_path))
    project, task = new_project_bundle_root_task("smoke", "description long enough for test", thread_id="t_plan_chain")
    task_id = str(task["id"])
    storage.save_project(project)
    return storage, task_id


def _three_step_chain_steps() -> list[dict]:
    return [
        {
            "ref": 1,
            "name": "write",
            "description": "Write outputs/smoke-test.txt with bash",
            "assigned_agent": "general-purpose",
        },
        {
            "ref": 2,
            "name": "read",
            "description": "Read outputs/smoke-test.txt",
            "assigned_agent": "general-purpose",
            "depends_on": ["1"],
        },
        {
            "ref": 3,
            "name": "validate",
            "description": "Validate file contents",
            "assigned_agent": "general-purpose",
            "depends_on": ["2"],
        },
    ]


def test_plan_sync_normalizes_depends_on_refs_to_subtask_ids(plan_chain_storage) -> None:
    storage, task_id = plan_chain_storage
    sync = sync_subtasks_from_plan_steps(task_id, _three_step_chain_steps(), storage=storage)
    assert sync["success"] is True
    assert len(sync["created"]) == 3

    row = find_main_task(storage, task_id)
    assert row is not None
    _proj, task = row
    subs = sorted(task["subtasks"], key=lambda s: int(str(s.get("ref") or "0")))
    assert len(subs) == 3
    id_by_ref = {str(s["ref"]): str(s["id"]) for s in subs}

    assert subs[0]["worker_profile"]["depends_on"] == []
    assert subs[1]["worker_profile"]["depends_on"] == [id_by_ref["1"]]
    assert subs[2]["worker_profile"]["depends_on"] == [id_by_ref["2"]]

    runnable, blocked = _resolve_subtasks_for_start_execution(storage, task_id, None)
    assert runnable == [id_by_ref["1"]]
    assert not any("invalid_dep:" in str(u) for b in blocked for u in (b.get("unmetDependencies") or []))


def test_workflow_semantic_refs_resolve_to_serial_chain(plan_chain_storage) -> None:
    """App/workflow steps use semantic refs (brief, prompts); sync must still chain."""
    storage, task_id = plan_chain_storage
    steps = [
        {"ref": "brief", "name": "分镜", "assigned_agent": "media-screenwriter", "depends_on": []},
        {
            "ref": "prompts",
            "name": "Prompt",
            "assigned_agent": "media-visual-planner",
            "depends_on": ["brief"],
        },
        {
            "ref": "images",
            "name": "生图",
            "assigned_agent": "media-artist",
            "depends_on": ["prompts"],
        },
    ]
    sync = sync_subtasks_from_plan_steps(task_id, steps, storage=storage)
    assert sync["success"] is True
    assert len(sync["created"]) == 3

    row = find_main_task(storage, task_id)
    assert row is not None
    _proj, task = row
    subs = sorted(task["subtasks"], key=lambda s: int(str(s.get("ref") or "0")))
    id_by_ref = {str(s["ref"]): str(s["id"]) for s in subs}

    assert subs[0]["worker_profile"]["depends_on"] == []
    assert subs[1]["worker_profile"]["depends_on"] == [id_by_ref["1"]]
    assert subs[2]["worker_profile"]["depends_on"] == [id_by_ref["2"]]

    runnable, blocked = _resolve_subtasks_for_start_execution(storage, task_id, None)
    assert runnable == [id_by_ref["1"]]
    assert id_by_ref["2"] in {b.get("subtaskId") for b in blocked}
    assert id_by_ref["3"] in {b.get("subtaskId") for b in blocked}


def test_requeue_failed_root_before_redispatch(plan_chain_storage) -> None:
    storage, task_id = plan_chain_storage
    sync_subtasks_from_plan_steps(task_id, _three_step_chain_steps(), storage=storage)
    row = find_main_task(storage, task_id)
    assert row is not None
    proj, task = row
    subs = sorted(task["subtasks"], key=lambda s: int(str(s.get("ref") or "0")))
    id_by_ref = {str(s["ref"]): str(s["id"]) for s in subs}

    subs[0]["status"] = "failed"
    subs[0]["error"] = "delegation failed"
    task["execution_authorized"] = True
    storage.save_project(proj)

    requeued = requeue_failed_subtasks_ready_for_retry(storage, task_id)
    assert requeued == [id_by_ref["1"]]

    runnable, blocked = _resolve_subtasks_for_start_execution(storage, task_id, None)
    assert runnable == [id_by_ref["1"]]
    assert id_by_ref["2"] in {b.get("subtaskId") for b in blocked}


def _fan_out_steps() -> list[dict]:
    return [
        {
            "ref": 1,
            "name": "write",
            "description": "Write outputs/smoke-test.txt with bash",
            "assigned_agent": "general-purpose",
            "outputs": "outputs/smoke-test.txt",
        },
        {
            "ref": 2,
            "name": "read",
            "description": "Read outputs/smoke-test.txt",
            "assigned_agent": "general-purpose",
            "depends_on": ["1"],
            "inputs": "outputs/smoke-test.txt",
        },
        {
            "ref": 3,
            "name": "validate",
            "description": "Validate file contents",
            "assigned_agent": "general-purpose",
            "depends_on": ["1"],
            "inputs": "outputs/smoke-test.txt",
        },
    ]


def test_fan_out_parallel_runnable_after_step1_completed(plan_chain_storage) -> None:
    storage, task_id = plan_chain_storage
    sync_subtasks_from_plan_steps(task_id, _fan_out_steps(), storage=storage)
    row = find_main_task(storage, task_id)
    assert row is not None
    _proj, task = row
    subs = sorted(task["subtasks"], key=lambda s: int(str(s.get("ref") or "0")))
    id_by_ref = {str(s["ref"]): str(s["id"]) for s in subs}

    assert subs[1]["worker_profile"]["depends_on"] == [id_by_ref["1"]]
    assert subs[2]["worker_profile"]["depends_on"] == [id_by_ref["1"]]

    subs[0]["status"] = "completed"
    subs[0]["completed_at"] = "2026-01-01T00:00:00Z"
    subs[0]["outcome_reported_at"] = "2026-01-01T00:00:00Z"
    task["execution_authorized"] = True
    storage.save_project(_proj)

    runnable, blocked = _resolve_subtasks_for_start_execution(storage, task_id, None)
    assert runnable == [id_by_ref["2"], id_by_ref["3"]]
    assert not blocked


def test_follow_up_wave_after_step1_completed(plan_chain_storage) -> None:
    storage, task_id = plan_chain_storage
    sync_subtasks_from_plan_steps(task_id, _three_step_chain_steps(), storage=storage)
    row = find_main_task(storage, task_id)
    assert row is not None
    _proj, task = row
    subs = sorted(task["subtasks"], key=lambda s: int(str(s.get("ref") or "0")))
    id_by_ref = {str(s["ref"]): str(s["id"]) for s in subs}

    subs[0]["status"] = "completed"
    subs[0]["completed_at"] = "2026-01-01T00:00:00Z"
    subs[0]["outcome_reported_at"] = "2026-01-01T00:00:00Z"
    task["execution_authorized"] = True
    storage.save_project(_proj)

    runnable, blocked = _resolve_subtasks_for_start_execution(storage, task_id, None)
    assert runnable == [id_by_ref["2"]]
    assert id_by_ref["3"] in {b.get("subtaskId") for b in blocked}


def test_normalize_idempotent_when_already_subtask_ids(plan_chain_storage) -> None:
    storage, task_id = plan_chain_storage
    sync_subtasks_from_plan_steps(task_id, _three_step_chain_steps(), storage=storage)
    first = normalize_subtask_depends_on_refs(storage, task_id)
    second = normalize_subtask_depends_on_refs(storage, task_id)
    assert first.get("changed") in (True, False)
    assert second.get("changed") is False
