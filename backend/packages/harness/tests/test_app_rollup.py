"""Tests for workflow final rollup (app_rollup module)."""

from __future__ import annotations

import pytest


# ──────────────────────── answer_node_only mode ────────────────────────


class TestAnswerNodeOnlyRollup:
    def _make_task(self, *, answer_ref="2", step_statuses=None):
        """Build a minimal app-sourced task with subtasks."""
        if step_statuses is None:
            step_statuses = {"1": "completed", "2": "completed"}
        subtasks = []
        for ref, status in step_statuses.items():
            subtasks.append({
                "id": f"sub_{ref}",
                "ref": ref,
                "name": f"Step {ref}",
                "status": status,
                "task_report": f"Report for step {ref}",
                "outputs": [{"type": "file", "key": f"f{ref}", "value": f"out/step{ref}.md"}],
            })
        return {
            "id": "task_test",
            "source_app_id": "App_test",
            "final_rollup": "answer_node_only",
            "answer_from_ref": answer_ref,
            "subtasks": subtasks,
        }

    def test_applies_when_all_terminal_and_answer_completed(self):
        from evoflow.collab.app_rollup import apply_answer_node_rollup

        task = self._make_task()
        patch = apply_answer_node_rollup(task)
        assert patch is not None
        assert patch["result_summary"] == "Report for step 2"
        assert len(patch["outputs"]) == 1  # answer-node outputs only
        assert str(patch["outputs"][0]["value"]).replace("\\", "/").endswith("out/step2.md")
        assert patch["rollup_mode"] == "answer_node_only"
        assert patch["rollup_source_ref"] == "2"

    def test_skips_when_not_all_terminal(self):
        from evoflow.collab.app_rollup import apply_answer_node_rollup

        task = self._make_task(step_statuses={"1": "completed", "2": "executing"})
        patch = apply_answer_node_rollup(task)
        assert patch is None

    def test_skips_when_answer_step_failed(self):
        from evoflow.collab.app_rollup import apply_answer_node_rollup

        task = self._make_task(step_statuses={"1": "completed", "2": "failed"})
        patch = apply_answer_node_rollup(task)
        assert patch is None

    def test_skips_when_no_answer_ref(self):
        from evoflow.collab.app_rollup import apply_answer_node_rollup

        task = self._make_task(answer_ref="")
        patch = apply_answer_node_rollup(task)
        assert patch is None

    def test_skips_non_app_task(self):
        from evoflow.collab.app_rollup import maybe_rollup_main_task

        task = self._make_task()
        task["source_app_id"] = ""
        patch = maybe_rollup_main_task(task)
        assert patch is None

    def test_off_mode_still_rolls_up(self):
        """Legacy 'off' must NOT disable rollup — multi-step workflows always roll up.

        The effective rollup mode resolves to 'auto' (not 'off'), and a task in
        auto mode without a rollup subtask yet is considered "pending rollup"
        (app_runner appends the rollup subtask at run start, so the full-path
        behavior is covered by the e2e tests).
        """
        from evoflow.collab.app_rollup import _app_rollup_mode, maybe_rollup_main_task

        task = self._make_task()
        task["final_rollup"] = "off"
        assert _app_rollup_mode(task) == "auto"
        # In auto mode without a rollup subtask present yet, maybe_rollup waits
        # (returns None) rather than skipping rollup entirely.
        patch = maybe_rollup_main_task(task)
        assert patch is None


# ──────────────────────── auto rollup spec ────────────────────────


class TestBuildRollupSubtaskSpec:
    def _make_app(self, n_steps=3):
        steps = []
        for i in range(1, n_steps + 1):
            step = {
                "ref": str(i),
                "name": f"Step {i}",
                "goal": f"Do step {i}",
                "assigned_agent": "general-purpose",
                "depends_on": [str(i - 1)] if i > 1 else [],
            }
            steps.append(step)
        return {
            "id": "App_test",
            "name": "Test App",
            "final_rollup": "auto",
            "steps": steps,
            "validation_template": ["Must have output", "Must pass tests"],
        }

    def test_needs_auto_rollup_multi_step(self):
        from evoflow.collab.app_rollup import needs_auto_rollup

        app = self._make_app(3)
        assert needs_auto_rollup(app) is True

    def test_skips_single_step(self):
        from evoflow.collab.app_rollup import needs_auto_rollup

        app = self._make_app(1)
        assert needs_auto_rollup(app) is False

    def test_multi_step_rolls_up_even_with_off(self):
        """Rollup is mandatory for multi-step workflows — 'off' does not disable it."""
        from evoflow.collab.app_rollup import needs_auto_rollup

        app = self._make_app(3)
        app["final_rollup"] = "off"
        assert needs_auto_rollup(app) is True

    def test_build_spec_has_rollup_ref(self):
        from evoflow.collab.app_rollup import build_rollup_subtask_spec, ROLLUP_REF

        app = self._make_app(3)
        spec = build_rollup_subtask_spec(app, goal="Test goal", validation=["Check A"])
        assert spec["ref"] == ROLLUP_REF
        assert spec["is_rollup_step"] is True
        # depends on ALL steps (not just leaves) for full context injection
        assert "1" in spec["depends_on"]
        assert "2" in spec["depends_on"]
        assert "3" in spec["depends_on"]
        assert "验收标准" in spec["instruction"]
        assert "Check A" in spec["instruction"]

    def test_custom_agent(self):
        from evoflow.collab.app_rollup import build_rollup_subtask_spec

        app = self._make_app(3)
        app["final_rollup_agent"] = "writer-agent"
        spec = build_rollup_subtask_spec(app)
        assert spec["assigned_agent"] == "writer-agent"

    def test_custom_instruction(self):
        from evoflow.collab.app_rollup import build_rollup_subtask_spec

        app = self._make_app(3)
        app["final_rollup_instruction"] = "Always end with 'Thanks!'"
        spec = build_rollup_subtask_spec(app)
        assert "Thanks!" in spec["instruction"]

    def test_none_app_is_safe(self):
        from evoflow.collab.app_rollup import build_rollup_subtask_spec, needs_auto_rollup

        assert needs_auto_rollup(None) is False  # type: ignore[arg-type]
        spec = build_rollup_subtask_spec(None)  # type: ignore[arg-type]
        assert spec["ref"]
        assert spec["depends_on"] == []


# ──────────────────────── is_rollup_subtask ────────────────────────


class TestIsRollupSubtask:
    def test_by_ref(self):
        from evoflow.collab.app_rollup import is_rollup_subtask, ROLLUP_REF

        assert is_rollup_subtask({"ref": ROLLUP_REF}) is True

    def test_by_worker_profile(self):
        from evoflow.collab.app_rollup import is_rollup_subtask

        assert is_rollup_subtask({
            "ref": "custom",
            "worker_profile": {"is_rollup_step": True},
        }) is True

    def test_normal_subtask(self):
        from evoflow.collab.app_rollup import is_rollup_subtask

        assert is_rollup_subtask({"ref": "1", "name": "Step 1"}) is False

    def test_none(self):
        from evoflow.collab.app_rollup import is_rollup_subtask

        assert is_rollup_subtask(None) is False


# ──────────────────────── apply_rollup_result ────────────────────────


class TestApplyRollupResult:
    def test_merges_all_outputs(self):
        from evoflow.collab.app_rollup import apply_rollup_result_to_main_task, ROLLUP_REF

        rollup_st = {
            "id": "sub_rollup",
            "ref": ROLLUP_REF,
            "status": "completed",
            "task_report": "Final summary report",
            "outputs": [{"type": "file", "key": "report", "value": "out/final.md"}],
        }
        all_subs = [
            rollup_st,
            {"id": "s1", "ref": "1", "status": "completed", "task_report": "s1",
             "outputs": [{"type": "file", "key": "a", "value": "out/a.md"}]},
            {"id": "s2", "ref": "2", "status": "completed", "task_report": "s2",
             "outputs": [{"type": "file", "key": "b", "value": "out/b.md"}]},
        ]
        task = {"id": "t1", "subtasks": all_subs}
        patch = apply_rollup_result_to_main_task(task, rollup_st, all_subtasks=all_subs)
        assert patch["result_summary"] == "Final summary report"
        # Prefer rollup deliverables only (not intermediate step files).
        assert len(patch["outputs"]) == 1
        assert str(patch["outputs"][0]["value"]).replace("\\", "/").endswith("out/final.md")
        assert patch["rollup_mode"] == "auto"


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
