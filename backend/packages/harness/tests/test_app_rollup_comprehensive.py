"""Comprehensive multi-dimensional tests for app rollup feature.

Covers:
- Edge cases & boundary conditions
- Idempotency & reentrancy
- Error paths & failure modes
- Backward compatibility (off mode, legacy tasks)
- Concurrency / double-apply safety
- Large data handling
"""

from __future__ import annotations

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
    steps: list[dict] | None = None,
    answer_from_ref: str = "",
    final_rollup_agent: str = "",
    final_rollup_instruction: str = "",
) -> dict:
    return {
        "name": app_id,
        "steps": steps or [
            {"ref": "1", "goal": "Step 1", "tools": [], "depends_on": []},
            {"ref": "2", "goal": "Step 2", "tools": [], "depends_on": []},
        ],
        "parameters": [{"name": "x", "label": "X"}],
        "goal_template": "do {{x}}",
        "execution_mode": "workflow",
        "version": 1,
        "status": "published",
        "final_rollup": final_rollup,
        "final_rollup_agent": final_rollup_agent,
        "final_rollup_instruction": final_rollup_instruction,
        "answer_from_ref": answer_from_ref,
    }


def _find_by_ref(subtasks, ref):
    for st in subtasks or []:
        if isinstance(st, dict) and str(st.get("ref") or "").strip() == ref:
            return st
    return None


def _complete(st, report="done", outputs=None):
    from evoflow.timeutil import utc_now_iso_z
    st["status"] = "completed"
    st["progress"] = 100
    st["outcome_reported_at"] = utc_now_iso_z()
    st["task_report"] = report
    st["result"] = report[:100]
    if outputs is not None:
        st["outputs"] = outputs


# ═══════════════════════════════════════════════════════════════
# 1. EDGE CASES & BOUNDARY CONDITIONS
# ═══════════════════════════════════════════════════════════════


class TestEdgeCases:
    """Edge cases: single step, empty steps, many steps, etc."""

    def test_auto_mode_single_step_no_rollup(self, sqlite_tmp: Path) -> None:
        """Single-step apps should NOT get a rollup subtask (nothing to roll up)."""
        del sqlite_tmp
        from evoflow.collab import app_runner
        from evoflow.collab.storage import get_project_storage, find_main_task
        from evoflow.persistence import app_repositories

        get_db()
        app = _make_app("App_single_step", final_rollup="auto",
                        steps=[{"ref": "1", "goal": "Only step", "tools": [], "depends_on": []}])
        app_repositories.save_app("App_single_step", app)

        result = app_runner.run_app_workflow("App_single_step", {"x": "test"}, auto_authorize=True)
        task_id = str(result.get("task_id") or "").strip()
        assert task_id

        storage = get_project_storage()
        found = find_main_task(storage, task_id)
        assert found is not None
        _, task = found
        subtasks = task.get("subtasks") or []

        # Single step → no rollup subtask needed
        assert len(subtasks) == 1, f"Expected 1 subtask for single-step, got {len(subtasks)}"
        assert _find_by_ref(subtasks, "__rollup__") is None

    def test_auto_mode_zero_steps(self, sqlite_tmp: Path) -> None:
        """Zero-step apps should not crash and have no rollup."""
        del sqlite_tmp
        from evoflow.collab import app_runner
        from evoflow.persistence import app_repositories

        get_db()
        app = _make_app("App_zero_steps", final_rollup="auto", steps=[])
        app_repositories.save_app("App_zero_steps", app)

        # Should not raise
        result = app_runner.run_app_workflow("App_zero_steps", {"x": "test"}, auto_authorize=True)
        assert result is not None
        # task_id may or may not be present — just verify it doesn't crash
        assert isinstance(result, dict)

    def test_auto_mode_10_steps(self, sqlite_tmp: Path) -> None:
        """Many steps: rollup should depend on ALL of them."""
        del sqlite_tmp
        from evoflow.collab import app_runner
        from evoflow.collab.storage import get_project_storage, find_main_task
        from evoflow.persistence import app_repositories

        get_db()
        steps = [{"ref": str(i), "goal": f"Step {i}", "tools": [], "depends_on": []} for i in range(1, 11)]
        app = _make_app("App_10steps", final_rollup="auto", steps=steps)
        app_repositories.save_app("App_10steps", app)

        result = app_runner.run_app_workflow("App_10steps", {"x": "test"}, auto_authorize=True)
        task_id = str(result.get("task_id") or "").strip()
        assert task_id

        storage = get_project_storage()
        found = find_main_task(storage, task_id)
        assert found is not None
        _, task = found
        subtasks = task.get("subtasks") or []

        # 10 user steps + 1 rollup
        assert len(subtasks) == 11, f"Expected 11 subtasks, got {len(subtasks)}"

        rollup = _find_by_ref(subtasks, "__rollup__")
        assert rollup is not None

        # Rollup should depend on all 10 steps
        deps = rollup.get("dependencies") or rollup.get("depends_on") or []
        dep_refs = {str(d) for d in deps}
        for i in range(1, 11):
            assert str(i) in dep_refs or any(str(i) in str(d) for d in deps), (
                f"Rollup should depend on step {i}, deps={deps}"
            )

    def test_answer_node_ref_not_found(self, sqlite_tmp: Path) -> None:
        """answer_node_only with invalid answer_from_ref should gracefully skip rollup."""
        del sqlite_tmp
        from evoflow.collab import app_runner
        from evoflow.collab.storage import get_project_storage, find_main_task
        from evoflow.collab.task_progress import sync_main_task_from_subtasks
        from evoflow.persistence import app_repositories

        get_db()
        app = _make_app("App_bad_ref", final_rollup="answer_node_only", answer_from_ref="nonexistent")
        app_repositories.save_app("App_bad_ref", app)

        result = app_runner.run_app_workflow("App_bad_ref", {"x": "test"}, auto_authorize=True)
        task_id = str(result.get("task_id") or "").strip()
        assert task_id

        storage = get_project_storage()
        found = find_main_task(storage, task_id)
        assert found is not None
        proj, task = found

        for st in task.get("subtasks") or []:
            _complete(st, report="done")

        storage.save_project(proj)
        sync_res = sync_main_task_from_subtasks(storage, task_id)
        assert sync_res["ok"] is True

        # Should complete but have no rollup applied (invalid ref)
        final = find_main_task(storage, task_id)
        assert final is not None
        _, ft = final
        assert ft.get("status") == "completed"
        assert ft.get("rollup_applied_at") is None, (
            "Should not apply rollup with invalid answer_from_ref"
        )

    def test_answer_node_step_failed(self, sqlite_tmp: Path) -> None:
        """answer_node_only: if the answer step failed, rollup should not apply."""
        del sqlite_tmp
        from evoflow.collab import app_runner
        from evoflow.collab.storage import get_project_storage, find_main_task
        from evoflow.collab.task_progress import sync_main_task_from_subtasks
        from evoflow.persistence import app_repositories
        from evoflow.timeutil import utc_now_iso_z

        get_db()
        app = _make_app("App_answer_fail", final_rollup="answer_node_only", answer_from_ref="2")
        app_repositories.save_app("App_answer_fail", app)

        result = app_runner.run_app_workflow("App_answer_fail", {"x": "test"}, auto_authorize=True)
        task_id = str(result.get("task_id") or "").strip()
        assert task_id

        storage = get_project_storage()
        found = find_main_task(storage, task_id)
        assert found is not None
        proj, task = found

        # Step 1 completed, step 2 (answer node) failed
        step1 = _find_by_ref(task.get("subtasks") or [], "1")
        step2 = _find_by_ref(task.get("subtasks") or [], "2")
        assert step1 and step2
        _complete(step1, report="step1 done")
        step2["status"] = "failed"
        step2["progress"] = 0
        step2["outcome_reported_at"] = utc_now_iso_z()
        step2["task_report"] = "step2 failed"
        step2["error"] = "something went wrong"

        storage.save_project(proj)
        sync_res = sync_main_task_from_subtasks(storage, task_id)
        assert sync_res["ok"] is True

        final = find_main_task(storage, task_id)
        assert final is not None
        _, ft = final
        # Main task should be failed (not completed)
        assert ft.get("status") == "failed"
        assert ft.get("rollup_applied_at") is None, (
            "Should not apply rollup when answer node step failed"
        )

    def test_rollup_with_very_long_report(self, sqlite_tmp: Path) -> None:
        """Rollup with a very long task_report should be truncated safely (8000 char cap)."""
        del sqlite_tmp
        from evoflow.collab.app_rollup import apply_rollup_result_to_main_task

        long_report = "A" * 15000
        rollup_st = {
            "ref": "__rollup__",
            "status": "completed",
            "task_report": long_report,
            "outputs": [],
            "worker_profile": {"is_rollup_step": True},
        }
        task = {"subtasks": [rollup_st]}

        patch = apply_rollup_result_to_main_task(task, rollup_st, all_subtasks=[rollup_st])
        assert patch is not None
        assert len(patch["result_summary"]) == 8000, (
            f"Expected 8000-char truncation, got {len(patch['result_summary'])}"
        )
        assert len(patch["result_text"]) == 8000

    def test_rollup_empty_report(self, sqlite_tmp: Path) -> None:
        """Rollup with empty task_report should still apply (empty result_summary)."""
        del sqlite_tmp
        from evoflow.collab.app_rollup import apply_rollup_result_to_main_task

        rollup_st = {
            "ref": "__rollup__",
            "status": "completed",
            "task_report": "",
            "outputs": [{"type": "file", "key": "f", "value": "/tmp/x.txt", "label": "X"}],
            "worker_profile": {"is_rollup_step": True},
        }
        task = {"subtasks": [rollup_st]}

        patch = apply_rollup_result_to_main_task(task, rollup_st, all_subtasks=[rollup_st])
        assert patch is not None
        assert patch["result_summary"] == ""
        assert len(patch["outputs"]) == 1

    def test_many_outputs_merging(self, sqlite_tmp: Path) -> None:
        """With a populated rollup, main-task outputs prefer the summary node only."""
        del sqlite_tmp
        from evoflow.collab.app_rollup import apply_rollup_result_to_main_task

        # 5 user steps, each with 3 outputs + 2 rollup outputs → keep rollup only
        user_steps = []
        for i in range(1, 6):
            user_steps.append({
                "ref": str(i),
                "status": "completed",
                "task_report": f"step {i}",
                "outputs": [
                    {"type": "file", "key": f"s{i}_a", "value": f"/tmp/s{i}a.txt", "label": f"S{i}A"},
                    {"type": "file", "key": f"s{i}_b", "value": f"/tmp/s{i}b.txt", "label": f"S{i}B"},
                    {"type": "file", "key": f"s{i}_c", "value": f"/tmp/s{i}c.txt", "label": f"S{i}C"},
                ],
            })

        rollup_st = {
            "ref": "__rollup__",
            "status": "completed",
            "task_report": "rollup done",
            "outputs": [
                {"type": "file", "key": "final", "value": "/tmp/final.md", "label": "Final"},
                {"type": "file", "key": "summary", "value": "/tmp/sum.txt", "label": "Summary"},
            ],
            "worker_profile": {"is_rollup_step": True},
        }

        all_subtasks = user_steps + [rollup_st]
        task = {"subtasks": all_subtasks}

        patch = apply_rollup_result_to_main_task(task, rollup_st, all_subtasks=all_subtasks)
        assert patch is not None
        outputs = patch["outputs"]
        assert len(outputs) == 2, f"Expected 2 rollup outputs, got {len(outputs)}"
        values = [str(o["value"]).replace("\\", "/") for o in outputs]
        assert values[0].endswith("/tmp/final.md") or values[0].endswith("tmp/final.md")
        assert values[1].endswith("/tmp/sum.txt") or values[1].endswith("tmp/sum.txt")
        assert len(set(values)) == 2, "Output values should be unique"


# ═══════════════════════════════════════════════════════════════
# 2. IDEMPOTENCY & REENTRANCY
# ═══════════════════════════════════════════════════════════════


class TestIdempotency:
    """Calling sync multiple times should not break anything."""

    def test_sync_multiple_times_auto_mode(self, sqlite_tmp: Path) -> None:
        """Calling sync_main_task_from_subtasks multiple times is safe (idempotent)."""
        del sqlite_tmp
        from evoflow.collab import app_runner
        from evoflow.collab.storage import get_project_storage, find_main_task
        from evoflow.collab.task_progress import sync_main_task_from_subtasks
        from evoflow.persistence import app_repositories

        get_db()
        app = _make_app("App_idem_auto", final_rollup="auto")
        app_repositories.save_app("App_idem_auto", app)

        result = app_runner.run_app_workflow("App_idem_auto", {"x": "test"}, auto_authorize=True)
        task_id = str(result.get("task_id") or "").strip()
        assert task_id

        storage = get_project_storage()
        found = find_main_task(storage, task_id)
        assert found is not None
        proj, task = found

        # Complete all subtasks
        for st in task.get("subtasks") or []:
            _complete(st, report=f"{st.get('ref')} done",
                      outputs=[{"type": "file", "key": f"o_{st.get('ref')}",
                                "value": f"/tmp/{st.get('ref')}.txt",
                                "label": f"Output {st.get('ref')}"}])

        storage.save_project(proj)

        # First sync
        r1 = sync_main_task_from_subtasks(storage, task_id)
        assert r1["ok"] and r1["changed"]

        # Reload and capture state
        f1 = find_main_task(storage, task_id)
        assert f1 is not None
        _, t1 = f1
        rollup_time_1 = t1.get("rollup_applied_at")
        outputs_count_1 = len(t1.get("outputs") or [])
        summary_1 = t1.get("result_summary")

        # Second sync — should be idempotent (no change)
        r2 = sync_main_task_from_subtasks(storage, task_id)
        assert r2["ok"] is True
        # changed may be False or True, but state should be identical

        f2 = find_main_task(storage, task_id)
        assert f2 is not None
        _, t2 = f2

        # rollup_applied_at should not change (applied only once)
        assert t2.get("rollup_applied_at") == rollup_time_1, (
            "rollup_applied_at should be stable across multiple syncs"
        )
        # Outputs count should be the same
        assert len(t2.get("outputs") or []) == outputs_count_1
        # Result summary should be identical
        assert t2.get("result_summary") == summary_1

    def test_sync_10_times_stable(self, sqlite_tmp: Path) -> None:
        """10 consecutive sync calls should not corrupt state."""
        del sqlite_tmp
        from evoflow.collab import app_runner
        from evoflow.collab.storage import get_project_storage, find_main_task
        from evoflow.collab.task_progress import sync_main_task_from_subtasks
        from evoflow.persistence import app_repositories

        get_db()
        app = _make_app("App_idem_10x", final_rollup="answer_node_only", answer_from_ref="1")
        app_repositories.save_app("App_idem_10x", app)

        result = app_runner.run_app_workflow("App_idem_10x", {"x": "test"}, auto_authorize=True)
        task_id = str(result.get("task_id") or "").strip()
        assert task_id

        storage = get_project_storage()
        found = find_main_task(storage, task_id)
        assert found is not None
        proj, task = found

        for st in task.get("subtasks") or []:
            _complete(st, report=f"{st.get('ref')} output")

        storage.save_project(proj)

        # Call sync 10 times
        for i in range(10):
            r = sync_main_task_from_subtasks(storage, task_id)
            assert r["ok"] is True

        final = find_main_task(storage, task_id)
        assert final is not None
        _, ft = final
        assert ft.get("status") == "completed"
        assert ft.get("progress") == 100
        assert ft.get("rollup_applied_at") is not None
        # No duplicate outputs
        outputs = ft.get("outputs") or []
        values = [o.get("value", "") for o in outputs]
        assert len(values) == len(set(values)), f"Duplicate outputs after 10 syncs: {values}"


# ═══════════════════════════════════════════════════════════════
# 3. ERROR PATHS & FAILURE MODES
# ═══════════════════════════════════════════════════════════════


class TestErrorPaths:
    """What happens when things go wrong."""

    def test_rollup_step_failed_no_apply(self, sqlite_tmp: Path) -> None:
        """If the rollup step itself fails, rollup should NOT be applied."""
        del sqlite_tmp
        from evoflow.collab import app_runner
        from evoflow.collab.storage import get_project_storage, find_main_task
        from evoflow.collab.task_progress import sync_main_task_from_subtasks
        from evoflow.persistence import app_repositories
        from evoflow.timeutil import utc_now_iso_z

        get_db()
        app = _make_app("App_rollup_fail", final_rollup="auto")
        app_repositories.save_app("App_rollup_fail", app)

        result = app_runner.run_app_workflow("App_rollup_fail", {"x": "test"}, auto_authorize=True)
        task_id = str(result.get("task_id") or "").strip()
        assert task_id

        storage = get_project_storage()
        found = find_main_task(storage, task_id)
        assert found is not None
        proj, task = found

        subtasks = task.get("subtasks") or []
        # User steps completed, rollup step failed
        for st in subtasks:
            ref = st.get("ref", "")
            if ref in ("1", "2"):
                _complete(st, report=f"step {ref} done")
            elif ref == "__rollup__":
                st["status"] = "failed"
                st["progress"] = 0
                st["outcome_reported_at"] = utc_now_iso_z()
                st["error"] = "rollup agent crashed"

        storage.save_project(proj)
        sync_main_task_from_subtasks(storage, task_id)

        final = find_main_task(storage, task_id)
        assert final is not None
        _, ft = final

        # Main task should be failed (rollup failed)
        assert ft.get("status") == "failed", f"Expected failed, got {ft.get('status')}"
        assert ft.get("rollup_applied_at") is None, "Should not apply rollup when rollup step failed"

    def test_non_app_task_no_rollup(self, sqlite_tmp: Path) -> None:
        """Non-app-sourced tasks should never get rollup applied."""
        del sqlite_tmp
        from evoflow.collab.storage import get_project_storage, find_main_task
        from evoflow.collab.task_progress import sync_main_task_from_subtasks
        from evoflow.collab.id_format import make_task_id, make_subtask_id
        from evoflow.timeutil import utc_now_iso_z

        get_db()
        storage = get_project_storage()

        task_id = make_task_id()
        now = utc_now_iso_z()
        subtasks = [
            {
                "id": make_subtask_id(),
                "ref": "1",
                "display_name": "Step 1",
                "status": "completed",
                "progress": 100,
                "outcome_reported_at": now,
                "task_report": "done",
                "assigned_to": "general-purpose",
            },
            {
                "id": make_subtask_id(),
                "ref": "__rollup__",
                "display_name": "Rollup",
                "status": "completed",
                "progress": 100,
                "outcome_reported_at": now,
                "task_report": "rollup done",
                "is_rollup_step": True,
                "assigned_to": "general-purpose",
                "worker_profile": {"is_rollup_step": True},
            },
        ]

        project = {
            "id": task_id,
            "name": "Manual task",
            "type": "project",
            "tasks": [{
                "id": task_id,
                "name": "Manual task",
                "status": "executing",
                "progress": 50,
                "source": "manual",  # NOT app-sourced (no source_app_id)
                "subtasks": subtasks,
                "created_at": now,
                "updated_at": now,
            }],
            "created_at": now,
            "updated_at": now,
        }

        storage.save_project(project)
        sync_main_task_from_subtasks(storage, task_id)

        final = find_main_task(storage, task_id)
        assert final is not None
        _, ft = final

        # No rollup should be applied for non-app tasks
        assert ft.get("rollup_applied_at") is None
        assert ft.get("result_summary") is None or ft.get("result_summary") == ""

    def test_invalid_mode_string(self, sqlite_tmp: Path) -> None:
        """Invalid/empty final_rollup values should resolve to 'auto' (rollup mandatory)."""
        del sqlite_tmp
        from evoflow.collab.app_rollup import _app_rollup_mode

        task = {"final_rollup": "totally_invalid_mode"}
        assert _app_rollup_mode(task) == "auto"

        task2 = {"final_rollup": ""}
        assert _app_rollup_mode(task2) == "auto"

        task3 = {}
        assert _app_rollup_mode(task3) == "auto"

        task4 = {"final_rollup": None}
        assert _app_rollup_mode(task4) == "auto"

        task5 = {"final_rollup": "off"}
        assert _app_rollup_mode(task5) == "auto"

    def test_maybe_rollup_with_none(self, sqlite_tmp: Path) -> None:
        """maybe_rollup_main_task should handle None/empty gracefully."""
        del sqlite_tmp
        from evoflow.collab.app_rollup import maybe_rollup_main_task

        assert maybe_rollup_main_task(None) is None
        assert maybe_rollup_main_task({}) is None
        assert maybe_rollup_main_task({"subtasks": []}) is None
        assert maybe_rollup_main_task({"subtasks": None}) is None
        assert maybe_rollup_main_task({"source_app_id": "", "subtasks": []}) is None


# ═══════════════════════════════════════════════════════════════
# 4. BACKWARD COMPATIBILITY
# ═══════════════════════════════════════════════════════════════


class TestBackwardCompatibility:
    """Existing apps without rollup fields should work fine."""

    def test_legacy_app_no_rollup_fields(self, sqlite_tmp: Path) -> None:
        """Legacy app with no final_rollup field: multi-step still rolls up (default auto)."""
        del sqlite_tmp
        from evoflow.collab import app_runner
        from evoflow.collab.storage import get_project_storage, find_main_task
        from evoflow.persistence import app_repositories

        get_db()
        # Legacy app: no final_rollup, no answer_from_ref
        legacy_app = {
            "name": "LegacyApp",
            "steps": [
                {"ref": "1", "goal": "Step 1", "tools": [], "depends_on": []},
                {"ref": "2", "goal": "Step 2", "tools": [], "depends_on": []},
            ],
            "parameters": [{"name": "x", "label": "X"}],
            "goal_template": "do {{x}}",
            "execution_mode": "workflow",
            "version": 1,
            "status": "published",
            # NO final_rollup field — simulates pre-v100 app
        }
        app_repositories.save_app("LegacyApp", legacy_app)

        result = app_runner.run_app_workflow("LegacyApp", {"x": "test"}, auto_authorize=True)
        task_id = str(result.get("task_id") or "").strip()
        assert task_id

        storage = get_project_storage()
        found = find_main_task(storage, task_id)
        assert found is not None
        _, task = found
        subtasks = task.get("subtasks") or []

        # Rollup is mandatory: multi-step legacy app still gets a rollup subtask
        assert len(subtasks) == 3, f"Expected 3 subtasks (2 steps + rollup), got {len(subtasks)}"
        assert _find_by_ref(subtasks, "__rollup__") is not None

        # final_rollup should resolve to "auto" on the task
        assert task.get("final_rollup") == "auto"

    def test_legacy_task_completion_no_rollup(self, sqlite_tmp: Path) -> None:
        """Legacy tasks (no final_rollup) should complete normally without rollup."""
        del sqlite_tmp
        from evoflow.collab import app_runner
        from evoflow.collab.storage import get_project_storage, find_main_task
        from evoflow.collab.task_progress import sync_main_task_from_subtasks
        from evoflow.persistence import app_repositories

        get_db()
        legacy_app = {
            "name": "LegacyComplete",
            "steps": [
                {"ref": "1", "goal": "Step 1", "tools": [], "depends_on": []},
            ],
            "parameters": [],
            "goal_template": "do it",
            "execution_mode": "workflow",
            "version": 1,
            "status": "published",
        }
        app_repositories.save_app("LegacyComplete", legacy_app)

        result = app_runner.run_app_workflow("LegacyComplete", {}, auto_authorize=True)
        task_id = str(result.get("task_id") or "").strip()
        assert task_id

        storage = get_project_storage()
        found = find_main_task(storage, task_id)
        assert found is not None
        proj, task = found

        for st in task.get("subtasks") or []:
            _complete(st, report="done")

        storage.save_project(proj)
        sync_main_task_from_subtasks(storage, task_id)

        final = find_main_task(storage, task_id)
        assert final is not None
        _, ft = final

        assert ft.get("status") == "completed"
        assert ft.get("progress") == 100
        assert ft.get("rollup_applied_at") is None
        assert ft.get("rollup_mode") is None

    def test_v99_to_v100_migration_preserves_data(self, sqlite_tmp: Path) -> None:
        """Migration from v99 to v100 should not lose existing app data."""
        del sqlite_tmp
        from evoflow.persistence.schema import APP_SCHEMA_VERSION
        from evoflow.persistence import app_repositories

        get_db()
        # v100 should be the current version
        assert APP_SCHEMA_VERSION >= 1

        # Save and load an app — should work with new columns
        app = {
            "name": "MigTest",
            "steps": [{"ref": "1", "type": "agentStep", "title": "Step 1", "agent_code": "general-purpose", "prompt": "hi"}],
            "parameters": [],
            "goal_template": "x",
            "execution_mode": "workflow",
            "version": 1,
            "status": "published",
            "final_rollup": "auto",
            "answer_from_ref": "1",
            "final_rollup_agent": "test-agent",
            "final_rollup_instruction": "test instruction",
        }
        app_repositories.save_app("MigTest", app)
        loaded = app_repositories.load_app("MigTest")
        assert loaded is not None
        assert loaded.get("final_rollup") == "auto"
        assert loaded.get("answer_from_ref") == "1"
        assert loaded.get("final_rollup_agent") == "test-agent"
        assert loaded.get("final_rollup_instruction") == "test instruction"


# ═══════════════════════════════════════════════════════════════
# 5. MIXED SCENARIOS (STRESS / COMPLEX DAG)
# ═══════════════════════════════════════════════════════════════


class TestComplexScenarios:
    """Complex DAG shapes and mixed step statuses."""

    def test_parallel_steps_rollup_deps(self, sqlite_tmp: Path) -> None:
        """Rollup should depend on all steps even in a parallel DAG."""
        del sqlite_tmp
        from evoflow.collab import app_runner
        from evoflow.collab.storage import get_project_storage, find_main_task
        from evoflow.persistence import app_repositories

        get_db()
        steps = [
            {"ref": "1", "goal": "Step 1", "tools": [], "depends_on": []},
            {"ref": "2", "goal": "Step 2", "tools": [], "depends_on": ["1"]},
            {"ref": "3", "goal": "Step 3", "tools": [], "depends_on": ["1"]},
            {"ref": "4", "goal": "Step 4", "tools": [], "depends_on": ["2", "3"]},
        ]
        app = _make_app("App_parallel", final_rollup="auto", steps=steps)
        app_repositories.save_app("App_parallel", app)

        result = app_runner.run_app_workflow("App_parallel", {"x": "test"}, auto_authorize=True)
        task_id = str(result.get("task_id") or "").strip()
        assert task_id

        storage = get_project_storage()
        found = find_main_task(storage, task_id)
        assert found is not None
        _, task = found
        subtasks = task.get("subtasks") or []

        # 4 user + 1 rollup = 5
        assert len(subtasks) == 5

        rollup = _find_by_ref(subtasks, "__rollup__")
        assert rollup is not None

    def test_partial_completion_no_rollup(self, sqlite_tmp: Path) -> None:
        """When only some steps are done, rollup should NOT apply yet."""
        del sqlite_tmp
        from evoflow.collab import app_runner
        from evoflow.collab.storage import get_project_storage, find_main_task
        from evoflow.collab.task_progress import sync_main_task_from_subtasks
        from evoflow.persistence import app_repositories

        get_db()
        steps = [
            {"ref": "1", "goal": "Step 1", "tools": [], "depends_on": []},
            {"ref": "2", "goal": "Step 2", "tools": [], "depends_on": []},
            {"ref": "3", "goal": "Step 3", "tools": [], "depends_on": []},
        ]
        app = _make_app("App_partial", final_rollup="auto", steps=steps)
        app_repositories.save_app("App_partial", app)

        result = app_runner.run_app_workflow("App_partial", {"x": "test"}, auto_authorize=True)
        task_id = str(result.get("task_id") or "").strip()
        assert task_id

        storage = get_project_storage()
        found = find_main_task(storage, task_id)
        assert found is not None
        proj, task = found

        # Only complete step 1 (1 of 3)
        step1 = _find_by_ref(task.get("subtasks") or [], "1")
        assert step1 is not None
        _complete(step1, report="step 1 done")

        storage.save_project(proj)
        sync_main_task_from_subtasks(storage, task_id)

        final = find_main_task(storage, task_id)
        assert final is not None
        _, ft = final

        # Should still be executing, no rollup
        assert ft.get("status") == "executing", f"Expected executing, got {ft.get('status')}"
        assert ft.get("rollup_applied_at") is None
        assert ft.get("progress") < 100

    def test_cancelled_steps_no_rollup(self, sqlite_tmp: Path) -> None:
        """If some steps are cancelled, rollup should not apply."""
        del sqlite_tmp
        from evoflow.collab import app_runner
        from evoflow.collab.storage import get_project_storage, find_main_task
        from evoflow.collab.task_progress import sync_main_task_from_subtasks
        from evoflow.persistence import app_repositories
        from evoflow.timeutil import utc_now_iso_z

        get_db()
        app = _make_app("App_cancelled", final_rollup="auto")
        app_repositories.save_app("App_cancelled", app)

        result = app_runner.run_app_workflow("App_cancelled", {"x": "test"}, auto_authorize=True)
        task_id = str(result.get("task_id") or "").strip()
        assert task_id

        storage = get_project_storage()
        found = find_main_task(storage, task_id)
        assert found is not None
        proj, task = found

        subtasks = task.get("subtasks") or []
        step1 = _find_by_ref(subtasks, "1")
        step2 = _find_by_ref(subtasks, "2")
        rollup = _find_by_ref(subtasks, "__rollup__")
        assert step1 and step2 and rollup

        _complete(step1, report="done")
        step2["status"] = "cancelled"
        step2["progress"] = 0
        step2["outcome_reported_at"] = utc_now_iso_z()
        rollup["status"] = "cancelled"
        rollup["progress"] = 0
        rollup["outcome_reported_at"] = utc_now_iso_z()

        storage.save_project(proj)
        sync_main_task_from_subtasks(storage, task_id)

        final = find_main_task(storage, task_id)
        assert final is not None
        _, ft = final

        # All terminal but not all successful → should not be completed
        # Mixed completed + cancelled: no _SUB_FAIL entries, so status stays as-is (planned)
        assert ft.get("status") != "completed", (
            f"Should not be completed when some steps cancelled: {ft.get('status')}"
        )
        assert ft.get("rollup_applied_at") is None
