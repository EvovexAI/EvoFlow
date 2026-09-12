"""Tests for step_prompt_builder.py and new expression_resolver functions."""

from __future__ import annotations

from evoflow.collab.expression_resolver import (
    detect_unresolved_bindings,
    detect_unresolved_in_step,
)
from evoflow.collab.step_prompt_builder import build_core_prompt


class TestDetectUnresolvedBindings:
    def test_all_resolved(self) -> None:
        resolved = {"name": "OpenAI", "count": 5}
        assert detect_unresolved_bindings(resolved) == []

    def test_single_unresolved(self) -> None:
        resolved = {"data": "{{steps.5.output.missing}}"}
        warnings = detect_unresolved_bindings(resolved)
        assert len(warnings) == 1
        assert "data" in warnings[0]
        assert "steps.5.output.missing" in warnings[0]

    def test_mixed_resolved_unresolved(self) -> None:
        resolved = {"name": "test", "missing": "{{steps.99.output.x}}"}
        warnings = detect_unresolved_bindings(resolved)
        assert len(warnings) == 1
        assert "missing" in warnings[0]

    def test_empty_dict(self) -> None:
        assert detect_unresolved_bindings({}) == []

    def test_non_string_values_not_flagged(self) -> None:
        resolved = {"list": [1, 2, 3], "dict": {"a": 1}, "num": 42}
        assert detect_unresolved_bindings(resolved) == []

    def test_multiple_unresolved_in_one_value(self) -> None:
        resolved = {"text": "Hello {{steps.1.output.x}} and {{steps.2.output.y}}"}
        warnings = detect_unresolved_bindings(resolved)
        assert len(warnings) == 2


class TestDetectUnresolvedInStep:
    def test_step_with_resolved_bindings(self) -> None:
        step = {
            "ref": "2",
            "input_bindings": {"name": "{{params.topic}}"},
        }
        result = detect_unresolved_in_step(step, params={"topic": "AI News"}, subtasks=[])
        assert result["unresolved_count"] == 0
        assert result["resolved"]["name"] == "AI News"

    def test_step_with_unresolved_step_ref(self) -> None:
        step = {
            "ref": "3",
            "input_bindings": {"data": "{{steps.99.output.missing}}"},
        }
        result = detect_unresolved_in_step(step, params={}, subtasks=[])
        assert result["unresolved_count"] == 1
        assert "data" in result["unresolved"][0]

    def test_step_without_bindings(self) -> None:
        step = {"ref": "1", "goal": "Do something"}
        result = detect_unresolved_in_step(step, params={}, subtasks=[])
        assert result["has_bindings"] is False
        assert result["unresolved_count"] == 0


class TestBuildCorePrompt:
    def test_basic_prompt_with_description(self) -> None:
        step = {"ref": "1", "description": "Analyze data"}
        result = build_core_prompt(step=step, params={}, mode="production")
        assert "Analyze data" in result["prompt"]
        assert result["has_bindings"] is False

    def test_goal_context_included(self) -> None:
        step = {"ref": "1", "description": "Step 1"}
        result = build_core_prompt(step=step, params={}, goal="Overall goal", mode="production")
        assert "Overall goal" in result["prompt"]

    def test_with_resolved_bindings(self) -> None:
        step = {
            "ref": "2",
            "description": "Process data",
            "input_bindings": {"name": "{{params.topic}}"},
        }
        result = build_core_prompt(step=step, params={"topic": "AI"}, mode="production")
        assert result["has_bindings"] is True
        assert result["resolved"]["name"] == "AI"
        assert "输入数据" in result["prompt"]
        assert result["unresolved_count"] == 0

    def test_unresolved_bindings_in_production_mode(self) -> None:
        step = {
            "ref": "2",
            "description": "Process data",
            "input_bindings": {"data": "{{steps.99.output.x}}"},
        }
        subtask_row: dict = {}
        result = build_core_prompt(
            step=step, params={}, mode="production", subtask_row=subtask_row,
        )
        assert result["unresolved_count"] == 1
        assert subtask_row.get("_has_unresolved_bindings") is True

    def test_unresolved_bindings_in_debug_mode_no_flag(self) -> None:
        step = {
            "ref": "2",
            "description": "Process data",
            "input_bindings": {"data": "{{steps.99.output.x}}"},
        }
        subtask_row: dict = {}
        result = build_core_prompt(
            step=step, params={}, mode="debug", subtask_row=subtask_row,
        )
        assert result["unresolved_count"] == 1
        # Debug mode should NOT set the flag (allows inspection)
        assert subtask_row.get("_has_unresolved_bindings") is None

    def test_resolved_bindings_sets_flag_on_subtask_row(self) -> None:
        step = {
            "ref": "2",
            "description": "Process",
            "input_bindings": {"x": "{{params.val}}"},
        }
        subtask_row: dict = {}
        build_core_prompt(
            step=step, params={"val": "hello"}, mode="production", subtask_row=subtask_row,
        )
        assert subtask_row.get("_has_resolved_input_bindings") is True

    def test_no_bindings_uses_mock_upstream_in_debug(self) -> None:
        step = {"ref": "2", "description": "Process", "goal": "Do thing"}
        mock_output = {"1": {"output": {"x": 1}, "summary": "Step 1 done"}}
        result = build_core_prompt(
            step=step, params={}, steps_output=mock_output, mode="debug",
        )
        assert "上游步骤" in result["prompt"]
        assert "Mock 数据" in result["prompt"]

    def test_step_metadata_included(self) -> None:
        step = {
            "ref": "1",
            "description": "Step 1",
            "goal": "Analyze",
            "inputs": "data file",
            "outputs": "report.md",
            "acceptance": "file exists",
        }
        result = build_core_prompt(step=step, params={}, mode="production")
        assert "步骤目标" in result["prompt"]
        assert "输入说明" in result["prompt"]
        assert "期望产出" in result["prompt"]
        assert "验收标准" in result["prompt"]


class TestInputSchemaValidation:
    def test_valid_types_pass(self) -> None:
        """Params are always strings; string type should pass."""
        step = {
            "ref": "2",
            "description": "Process",
            "input_bindings": {
                "name": "{{params.topic}}",
                "source": "{{params.src}}",
            },
            "input_schema": {
                "name": {"type": "string"},
                "source": {"type": "string"},
            },
        }
        result = build_core_prompt(
            step=step, params={"topic": "AI", "src": "web"}, mode="production",
        )
        assert result["unresolved_count"] == 0

    def test_type_mismatch_flagged(self) -> None:
        """String value flagged when schema expects integer."""
        step = {
            "ref": "2",
            "description": "Process",
            "input_bindings": {
                "count": "{{params.val}}",
            },
            "input_schema": {
                "count": {"type": "integer"},
            },
        }
        result = build_core_prompt(
            step=step, params={"val": "not_a_number"}, mode="production",
        )
        # The binding resolves to "not_a_number" (string), but schema expects integer
        assert result["unresolved_count"] == 1
        assert any("expected integer" in w for w in result["unresolved"])

    def test_no_input_schema_skips_validation(self) -> None:
        step = {
            "ref": "2",
            "description": "Process",
            "input_bindings": {"x": "{{params.val}}"},
        }
        result = build_core_prompt(
            step=step, params={"val": "anything"}, mode="production",
        )
        assert result["unresolved_count"] == 0
