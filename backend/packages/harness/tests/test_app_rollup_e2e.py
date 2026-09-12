"""L3 end-to-end tests for app rollup: runtime layer with manual subtask manipulation."""

from __future__ import annotations

import os
import tempfile
from pathlib import Path

import pytest

from evoflow.persistence.db import get_db, reset_db_for_tests


@pytest.fixture
def sqlite_tmp(monkeypatch: pytest.MonkeyPatch):
    with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
        monkeypatch.setenv("EVOFLOW_HOME", tmp)
        reset_db_for_tests()
        yield Path(tmp)
        reset_db_for_tests()
        import gc

        gc.collect()


def _make_app(
    app_id: str,
    *,
    final_rollup: str = "auto",
    final_rollup_agent: str = "",
    final_rollup_instruction: str = "",
    steps: list[dict] | None = None,
    answer_from_ref: str = "",
) -> dict:
    """Build a minimal app dict for testing.

    Rollup is mandatory for multi-step workflows, so the default is ``auto``.
    """
    return {
        "name": app_id,
        "steps": steps or [
            {"ref": "1", "goal": "Step 1", "tools": [], "depends_on": []},
            {"ref": "2", "goal": "Step 2", "tools": [], "depends_on": []},
        ],
        "parameters": [{"name": "topic", "label": "主题"}],
        "goal_template": "do {{topic}}",
        "execution_mode": "workflow",
        "version": 1,
        "status": "published",
        "final_rollup": final_rollup,
        "final_rollup_agent": final_rollup_agent,
        "final_rollup_instruction": final_rollup_instruction,
        "answer_from_ref": answer_from_ref,
    }


def _find_subtask_by_ref(subtasks: list[dict], ref: str) -> dict | None:
    """Find a subtask by its 'ref' field."""
    for st in subtasks:
        if isinstance(st, dict) and str(st.get("ref") or "").strip() == ref:
            return st
    return None


def _mark_subtask_completed(
    subtask: dict,
    *,
    task_report: str = "",
    outputs: list[dict] | None = None,
) -> None:
    """Mark a single subtask as completed with optional report and outputs.

    Sets both status and outcome_reported_at so DAG dependency checks
    (is_upstream_subtask_dependency_met) treat the step as done.
    """
    from evoflow.timeutil import utc_now_iso_z

    subtask["status"] = "completed"
    subtask["progress"] = 100
    subtask["outcome_reported_at"] = utc_now_iso_z()
    if task_report:
        subtask["task_report"] = task_report
    if outputs:
        subtask["outputs"] = outputs
    # Ensure the subtask has a worker_profile for output extraction
    if "worker_profile" not in subtask:
        subtask["worker_profile"] = {"assigned_agent": "researcher"}


# ──────────────────────────── test cases ────────────────────────────


def test_answer_node_only_mode_e2e(sqlite_tmp: Path) -> None:
    """answer_node_only mode: rollup copies answer step's report + its outputs to main task."""
    del sqlite_tmp
    from evoflow.collab import app_runner
    from evoflow.collab.storage import get_project_storage, find_main_task
    from evoflow.collab.task_progress import sync_main_task_from_subtasks
    from evoflow.persistence import app_repositories

    get_db()
    app_id = "App_rollup_ans_node_e2e"
    app = _make_app(
        app_id,
        final_rollup="answer_node_only",
        answer_from_ref="2",
        steps=[
            {"ref": "1", "goal": "Step 1", "tools": [], "depends_on": []},
            {"ref": "2", "goal": "Step 2", "tools": [], "depends_on": []},
        ],
    )
    app_repositories.save_app(app_id, app)

    # Start workflow — this creates the task bundle and syncs subtasks
    result = app_runner.run_app_workflow(app_id, {"topic": "test"}, auto_authorize=True)
    task_id = str(result.get("task_id") or "").strip()
    assert task_id, f"No task_id in result: {result}"

    storage = get_project_storage()
    found = find_main_task(storage, task_id)
    assert found is not None, f"Task {task_id} not found"
    _project, task = found

    subtasks = task.get("subtasks") or []
    assert len(subtasks) >= 2, f"Expected at least 2 subtasks, got {len(subtasks)}"

    # Manually mark both subtasks as completed
    for st in subtasks:
        ref = st.get("ref", "")
        _mark_subtask_completed(
            st,
            task_report=f"Step {ref} report",
            outputs=[{"type": "file", "key": f"output_{ref}", "value": f"/tmp/output_{ref}.txt", "label": f"Output from step {ref}"}],
        )

    # Save changes back
    storage.save_project(_project)

    # Trigger rollup via sync
    sync_res = sync_main_task_from_subtasks(storage, task_id)
    assert sync_res["ok"] is True

    # Reload and verify
    refound = find_main_task(storage, task_id)
    assert refound is not None
    _project2, task2 = refound

    # answer_node_only: result_summary should be from step 2 (the answer node)
    assert task2.get("result_summary"), "result_summary should not be empty"
    assert "Step 2 report" in task2["result_summary"], (
        f"Expected result_summary to contain 'Step 2 report', got: {task2.get('result_summary')}"
    )
    # outputs should prefer the answer node (step 2) only
    outputs = task2.get("outputs") or []
    assert len(outputs) == 1, f"Expected 1 answer-node output, got {len(outputs)}: {outputs}"
    assert "output_2" in str(outputs[0].get("key") or outputs[0].get("value") or "")
    assert task2.get("rollup_mode") == "answer_node_only"


def test_auto_mode_adds_rollup_subtask(sqlite_tmp: Path) -> None:
    """auto mode: append_rollup_subtask adds a 4th subtask with ref=__rollup__."""
    del sqlite_tmp
    from evoflow.collab import app_runner
    from evoflow.collab.storage import get_project_storage, find_main_task
    from evoflow.persistence import app_repositories

    get_db()
    app_id = "App_rollup_auto_add_e2e"
    app = _make_app(
        app_id,
        final_rollup="auto",
        steps=[
            {"ref": "1", "goal": "Step 1", "tools": [], "depends_on": []},
            {"ref": "2", "goal": "Step 2", "tools": [], "depends_on": ["1"]},
            {"ref": "3", "goal": "Step 3", "tools": [], "depends_on": ["2"]},
        ],
    )
    app_repositories.save_app(app_id, app)

    result = app_runner.run_app_workflow(app_id, {"topic": "test"}, auto_authorize=True)
    task_id = str(result.get("task_id") or "").strip()
    assert task_id

    storage = get_project_storage()
    found = find_main_task(storage, task_id)
    assert found is not None
    _project, task = found

    subtasks = task.get("subtasks") or []
    # 3 user steps + 1 rollup = 4
    assert len(subtasks) == 4, f"Expected 4 subtasks (3 steps + 1 rollup), got {len(subtasks)}"

    rollup_st = _find_subtask_by_ref(subtasks, "__rollup__")
    assert rollup_st is not None, "Rollup subtask with ref='__rollup__' not found"

    # depends_on should include all 3 step refs
    deps = rollup_st.get("dependencies") or []
    dep_refs = set(str(d).strip() for d in deps)
    assert "1" in dep_refs, f"Rollup should depend on step 1, deps={dep_refs}"
    assert "2" in dep_refs, f"Rollup should depend on step 2, deps={dep_refs}"
    assert "3" in dep_refs, f"Rollup should depend on step 3, deps={dep_refs}"

    # worker_profile.is_rollup_step should be True
    wp = rollup_st.get("worker_profile") or {}
    assert wp.get("is_rollup_step") is True, "worker_profile.is_rollup_step should be True"

    # is_rollup_step flag on the subtask itself
    assert rollup_st.get("is_rollup_step") is True, "subtask.is_rollup_step should be True"


def test_auto_mode_rollup_step_executes_after_all_steps(sqlite_tmp: Path) -> None:
    """auto mode: rollup step stays blocked until all user steps complete."""
    del sqlite_tmp
    from evoflow.collab import app_runner
    from evoflow.collab.storage import get_project_storage, find_main_task
    from evoflow.collab.task_progress import sync_main_task_from_subtasks
    from evoflow.tools.builtins.supervisor.dependency import _resolve_subtasks_for_start_execution
    from evoflow.persistence import app_repositories

    get_db()
    app_id = "App_rollup_dep_e2e"
    app = _make_app(
        app_id,
        final_rollup="auto",
        steps=[
            {"ref": "1", "goal": "Step 1", "tools": [], "depends_on": []},
            {"ref": "2", "goal": "Step 2", "tools": [], "depends_on": []},
        ],
    )
    app_repositories.save_app(app_id, app)

    result = app_runner.run_app_workflow(app_id, {"topic": "test"}, auto_authorize=True)
    task_id = str(result.get("task_id") or "").strip()
    assert task_id

    storage = get_project_storage()
    found = find_main_task(storage, task_id)
    assert found is not None
    _project, task = found

    subtasks = task.get("subtasks") or []
    rollup_st = _find_subtask_by_ref(subtasks, "__rollup__")
    assert rollup_st is not None
    assert rollup_st.get("status") == "planned"

    # Step 1: mark only step 1 as completed, rollup should still be blocked
    step1 = _find_subtask_by_ref(subtasks, "1")
    assert step1 is not None
    _mark_subtask_completed(step1, task_report="Step 1 done")
    storage.save_project(_project)

    sync_main_task_from_subtasks(storage, task_id)

    # Resolve runnable subtasks — rollup should NOT be runnable yet
    runnable, blocked = _resolve_subtasks_for_start_execution(storage, task_id, explicit=None)
    # Re-fetch to get current state (normalize changes dependencies from refs to IDs)
    refound1 = find_main_task(storage, task_id)
    assert refound1 is not None
    _project1, task1 = refound1
    rollup_st1 = _find_subtask_by_ref(task1.get("subtasks") or [], "__rollup__")
    assert rollup_st1 is not None
    rollup_id = rollup_st1.get("id", "")
    assert rollup_id not in runnable, (
        f"Rollup should not be runnable when step 2 is still pending, runnable={runnable}"
    )

    # Step 2: mark step 2 as completed too
    refound = find_main_task(storage, task_id)
    assert refound is not None
    _project2, task2 = refound
    step2 = _find_subtask_by_ref(task2.get("subtasks") or [], "2")
    assert step2 is not None
    _mark_subtask_completed(step2, task_report="Step 2 done")
    storage.save_project(_project2)

    sync_main_task_from_subtasks(storage, task_id)

    # Now rollup should be runnable (both deps met)
    runnable2, blocked2 = _resolve_subtasks_for_start_execution(storage, task_id, explicit=None)
    # Re-fetch to get current state after normalize
    refound3 = find_main_task(storage, task_id)
    assert refound3 is not None
    _project3, task3 = refound3
    rollup_st3 = _find_subtask_by_ref(task3.get("subtasks") or [], "__rollup__")
    assert rollup_st3 is not None
    rollup_id2 = rollup_st3.get("id", "")
    assert rollup_id2 in runnable2, (
        f"Rollup should be runnable after all steps complete, runnable={runnable2}, blocked={blocked2}"
    )


def test_auto_mode_rollup_result_writes_to_main_task(sqlite_tmp: Path) -> None:
    """auto mode: when rollup subtask completes, its result is promoted to the main task."""
    del sqlite_tmp
    from evoflow.collab import app_runner
    from evoflow.collab.storage import get_project_storage, find_main_task
    from evoflow.collab.task_progress import sync_main_task_from_subtasks
    from evoflow.persistence import app_repositories

    get_db()
    app_id = "App_rollup_result_e2e"
    app = _make_app(
        app_id,
        final_rollup="auto",
        steps=[
            {"ref": "1", "goal": "Step 1", "tools": [], "depends_on": []},
            {"ref": "2", "goal": "Step 2", "tools": [], "depends_on": []},
        ],
    )
    app_repositories.save_app(app_id, app)

    result = app_runner.run_app_workflow(app_id, {"topic": "test"}, auto_authorize=True)
    task_id = str(result.get("task_id") or "").strip()
    assert task_id

    storage = get_project_storage()

    # Mark all user steps completed
    found = find_main_task(storage, task_id)
    assert found is not None
    _project, task = found

    for st in task.get("subtasks") or []:
        ref = st.get("ref", "")
        if ref in ("1", "2"):
            _mark_subtask_completed(
                st,
                task_report=f"Step {ref} done",
                outputs=[{"type": "file", "key": f"user_{ref}", "value": f"/tmp/user_{ref}.txt", "label": f"User step {ref}"}],
            )

    # Also mark the rollup step completed
    rollup_st = _find_subtask_by_ref(task.get("subtasks") or [], "__rollup__")
    assert rollup_st is not None, "Rollup subtask not found"
    _mark_subtask_completed(
        rollup_st,
        task_report="Final rollup report",
        outputs=[{"type": "file", "key": "rollup_summary", "value": "/tmp/rollup_summary.txt", "label": "Rollup summary"}],
    )

    storage.save_project(_project)

    # Trigger sync — this should promote rollup result
    sync_res = sync_main_task_from_subtasks(storage, task_id)
    assert sync_res["ok"] is True

    # Reload
    refound = find_main_task(storage, task_id)
    assert refound is not None
    _project2, task2 = refound

    # result_summary should be the rollup's task_report
    assert task2.get("result_summary") == "Final rollup report", (
        f"Expected result_summary='Final rollup report', got: {task2.get('result_summary')}"
    )

    # outputs should prefer the rollup summary file only
    # After normalization, each output is {type, key, value, label?}
    # where value is the path. Compare by basename for cross-platform safety.
    outputs = task2.get("outputs") or []
    output_names = {os.path.basename(str(o.get("value", ""))) for o in outputs}
    assert "rollup_summary.txt" in output_names, f"Outputs missing rollup file: {output_names}"
    assert "user_1.txt" not in output_names, f"Intermediate step outputs should not surface: {output_names}"
    assert "user_2.txt" not in output_names, f"Intermediate step outputs should not surface: {output_names}"
    assert len(outputs) == 1, f"Expected rollup-only outputs, got {len(outputs)}: {output_names}"

    assert task2.get("rollup_mode") == "auto"
    assert task2.get("status") == "completed"


def test_off_mode_still_rolls_up(sqlite_tmp: Path) -> None:
    """legacy 'off' must NOT disable rollup — multi-step workflows always roll up."""
    del sqlite_tmp
    from evoflow.collab import app_runner
    from evoflow.collab.storage import get_project_storage, find_main_task
    from evoflow.collab.task_progress import sync_main_task_from_subtasks
    from evoflow.persistence import app_repositories

    get_db()
    app_id = "App_rollup_off_e2e"
    app = _make_app(
        app_id,
        final_rollup="off",
        steps=[
            {"ref": "1", "goal": "Step 1", "tools": [], "depends_on": []},
            {"ref": "2", "goal": "Step 2", "tools": [], "depends_on": []},
        ],
    )
    app_repositories.save_app(app_id, app)

    result = app_runner.run_app_workflow(app_id, {"topic": "test"}, auto_authorize=True)
    task_id = str(result.get("task_id") or "").strip()
    assert task_id

    storage = get_project_storage()

    found = find_main_task(storage, task_id)
    assert found is not None
    _project, task = found

    subtasks = task.get("subtasks") or []
    # even with 'off', multi-step workflow still gets a rollup subtask
    user_step_refs = {st.get("ref", "") for st in subtasks}
    assert "__rollup__" in user_step_refs, (
        f"multi-step workflow with 'off' should still have a rollup subtask, refs={user_step_refs}"
    )

    # Mark all user steps + rollup completed
    for st in subtasks:
        ref = st.get("ref", "")
        if ref == "__rollup__":
            _mark_subtask_completed(
                st,
                task_report="Final rollup report",
                outputs=[{"type": "file", "key": "rollup_summary", "value": "/tmp/rollup_summary.txt", "label": "Rollup summary"}],
            )
        else:
            _mark_subtask_completed(st, task_report=f"Step {ref} done")

    storage.save_project(_project)

    # Sync
    sync_res = sync_main_task_from_subtasks(storage, task_id)
    assert sync_res["ok"] is True

    # Reload
    refound = find_main_task(storage, task_id)
    assert refound is not None
    _project2, task2 = refound

    # rollup is mandatory: result_summary should be promoted (not empty)
    result_summary = task2.get("result_summary") or ""
    assert result_summary == "Final rollup report", (
        f"multi-step 'off' should still promote rollup result, got: {result_summary!r}"
    )

    assert task2.get("status") == "completed", (
        f"main task should be completed, got: {task2.get('status')}"
    )
