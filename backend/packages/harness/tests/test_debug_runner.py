"""Tests for the workflow debug runner module.

Tests the pure helper functions (prompt building, mock input conversion,
step lookup, downstream computation) without requiring full app execution.
"""

from __future__ import annotations

import pytest

from evoflow.collab.debug_runner import (
    _build_debug_prompt,
    _build_mock_steps_output,
    _find_step_by_ref,
)


# ── _find_step_by_ref ─────────────────────────────────────────────────


class TestFindStepByRef:
    def test_found(self):
        steps = [{"ref": "1"}, {"ref": "2"}, {"ref": "3"}]
        assert _find_step_by_ref(steps, "2") == {"ref": "2"}

    def test_not_found(self):
        steps = [{"ref": "1"}, {"ref": "2"}]
        assert _find_step_by_ref(steps, "99") is None

    def test_empty_steps(self):
        assert _find_step_by_ref([], "1") is None

    def test_whitespace_ref(self):
        steps = [{"ref": " 1 "}]
        assert _find_step_by_ref(steps, "1") == {"ref": " 1 "}

    def test_int_ref_coerced(self):
        """Refs stored as int should still match string queries."""
        steps = [{"ref": 1}]
        assert _find_step_by_ref(steps, "1") == {"ref": 1}

    def test_none_ref_in_step(self):
        steps = [{"ref": None}, {"ref": "2"}]
        assert _find_step_by_ref(steps, "2") == {"ref": "2"}

    def test_empty_query_ref(self):
        steps = [{"ref": "1"}, {"ref": ""}]
        assert _find_step_by_ref(steps, "") is None
        assert _find_step_by_ref(steps, "   ") is None
        assert _find_step_by_ref(steps, None) is None  # type: ignore[arg-type]


# ── _build_mock_steps_output ──────────────────────────────────────────


class TestBuildMockStepsOutput:
    def test_empty(self):
        assert _build_mock_steps_output(None) == {}
        assert _build_mock_steps_output({}) == {}

    def test_basic(self):
        mock = {
            "1": {"output": {"x": 1}, "summary": "step 1 done"},
        }
        result = _build_mock_steps_output(mock)
        assert "1" in result
        assert result["1"]["output"] == {"x": 1}
        assert result["1"]["summary"] == "step 1 done"
        assert result["1"]["artifacts"] == []
        assert result["1"]["artifacts_keyed"] == {}

    def test_with_artifacts(self):
        mock = {
            "2": {
                "output": {"y": 2},
                "summary": "step 2",
                "artifacts": [{"key": "file", "value": "/path/to/file"}],
            },
        }
        result = _build_mock_steps_output(mock)
        assert result["2"]["artifacts"] == [{"key": "file", "value": "/path/to/file"}]

    def test_missing_fields_defaults(self):
        mock = {"1": {}}
        result = _build_mock_steps_output(mock)
        assert result["1"]["output"] == {}
        assert result["1"]["summary"] == ""
        assert result["1"]["artifacts"] == []

    def test_non_dict_value_skipped(self):
        mock = {"1": "not a dict", "2": {"output": {}}}
        result = _build_mock_steps_output(mock)
        assert "1" not in result
        assert "2" in result

    def test_empty_ref_skipped(self):
        mock = {"": {"output": {}}, "1": {"output": {}}}
        result = _build_mock_steps_output(mock)
        assert "" not in result
        assert "1" in result


# ── _build_debug_prompt ───────────────────────────────────────────────


class TestBuildDebugPrompt:
    def test_basic_prompt(self):
        step = {
            "ref": "1",
            "description": "Analyze the data",
            "goal": "Understand patterns",
        }
        prompt, resolved = _build_debug_prompt(
            step,
            params={},
            mock_steps_output={},
            goal="Overall workflow goal",
        )
        assert "Analyze the data" in prompt
        assert "Overall workflow goal" in prompt
        assert "Understand patterns" in prompt
        assert resolved == {}

    def test_with_goal_fallback(self):
        """If description is empty, goal is used."""
        step = {"ref": "1", "goal": "Do something"}
        prompt, _ = _build_debug_prompt(
            step,
            params={},
            mock_steps_output={},
        )
        assert "Do something" in prompt

    def test_with_input_bindings(self):
        step = {
            "ref": "2",
            "description": "Process data",
            "input_bindings": {
                "upstream_data": "{{steps.1.output.result}}",
            },
        }
        mock_output = {
            "1": {"output": {"result": "hello"}, "summary": "done"},
        }
        prompt, resolved = _build_debug_prompt(
            step,
            params={},
            mock_steps_output=mock_output,
        )
        assert "upstream_data" in resolved
        assert resolved["upstream_data"] == "hello"
        # The resolved value should appear in the prompt
        assert "hello" in prompt

    def test_with_params_binding(self):
        step = {
            "ref": "1",
            "description": "Search for {{params.topic}}",
            "input_bindings": {
                "query": "{{params.topic}}",
            },
        }
        prompt, resolved = _build_debug_prompt(
            step,
            params={"topic": "AI agents"},
            mock_steps_output={},
        )
        assert resolved["query"] == "AI agents"
        assert "AI agents" in prompt

    def test_no_bindings_uses_mock_summaries(self):
        step = {"ref": "2", "description": "Step 2"}
        mock_output = {
            "1": {"output": {"x": 42}, "summary": "Step 1 completed successfully"},
        }
        prompt, _ = _build_debug_prompt(
            step,
            params={},
            mock_steps_output=mock_output,
        )
        assert "Step 1 completed successfully" in prompt
        assert "42" in prompt  # output should be in prompt

    def test_step_context_fields(self):
        step = {
            "ref": "1",
            "description": "Main task",
            "inputs": "Input data",
            "outputs": "Output data",
            "acceptance": "Must be valid",
        }
        prompt, _ = _build_debug_prompt(
            step,
            params={},
            mock_steps_output={},
        )
        assert "Input data" in prompt
        assert "Output data" in prompt
        assert "Must be valid" in prompt

    def test_debug_mode_notice(self):
        step = {"ref": "1", "description": "Test"}
        prompt, _ = _build_debug_prompt(
            step,
            params={},
            mock_steps_output={},
        )
        assert "调试模式" in prompt or "debug" in prompt.lower()


def test_extract_parameters_from_plan_none_steps() -> None:
    from evoflow.collab.app_extractor import extract_parameters_from_plan

    plan, parameters = extract_parameters_from_plan("some goal", None)  # type: ignore[arg-type]
    assert plan["steps"] == []
    assert parameters == []


def test_debug_run_step_rejects_empty_app_id() -> None:
    from evoflow.collab.debug_runner import debug_run_step

    result = debug_run_step("", "1")
    assert result["status"] == "error"
    assert "required" in result["error"].lower()


def test_debug_run_from_step_rejects_empty_base_run_id(monkeypatch: pytest.MonkeyPatch) -> None:
    from evoflow.collab import debug_runner

    monkeypatch.setattr(
        debug_runner.app_repositories,
        "load_app",
        lambda _app_id: {"id": "App_x", "steps": [{"ref": "1", "name": "A", "goal": "g"}]},
    )
    result = debug_runner.debug_run_from_step("App_x", "1", base_run_id="   ")
    assert "empty" in str(result.get("error") or "").lower()
