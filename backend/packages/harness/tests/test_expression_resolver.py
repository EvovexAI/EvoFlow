"""Unit tests for expression_resolver.

Covers:
    - Simple param references {{params.topic}}
    - Step output references {{steps.1.output.companies}}
    - Step summary references {{steps.2.summary}}
    - Artifact path references {{steps.1.artifacts[0].path}}
    - Artifact keyed access {{steps.1.artifacts.report.path}}
    - Mixed text + expressions (string interpolation)
    - Single expression returns raw value (not stringified)
    - Unresolvable expressions left as-is
    - Legacy bare {{topic}} compat
    - resolve_bindings / resolve_step_inputs helpers
    - build_steps_output_from_subtasks
    - format_resolved_inputs_for_prompt
"""

from __future__ import annotations

import json

import pytest

from evoflow.collab.expression_resolver import (
    resolve_expression,
    resolve_bindings,
    resolve_step_inputs,
    build_steps_output_from_subtasks,
    format_resolved_inputs_for_prompt,
)


# ── Test fixtures ──────────────────────────────────────────────────────

PARAMS = {"topic": "AI Agent", "count": "5", "language": "zh"}

STEPS_OUTPUT = {
    "1": {
        "output": {
            "companies": [
                {"name": "OpenAI", "domain": "openai.com", "country": "US"},
                {"name": "Anthropic", "domain": "anthropic.com", "country": "US"},
            ],
            "total": 2,
        },
        "summary": "Found 2 companies in AI Agent space.",
        "artifacts": [
            {"type": "file", "key": "report", "value": "/data/report.md", "label": "调研报告"},
        ],
        "artifacts_keyed": {
            "report": {"type": "file", "key": "report", "value": "/data/report.md", "label": "调研报告"},
        },
    },
    "2": {
        "output": {"score": 85, "verdict": "positive"},
        "summary": "The sentiment score is 85, indicating positive reception.",
        "artifacts": [],
        "artifacts_keyed": {},
    },
}


# ── resolve_expression: param references ──────────────────────────────


class TestParamReferences:
    def test_simple_param(self):
        assert resolve_expression("{{params.topic}}", params=PARAMS, steps_output=STEPS_OUTPUT) == "AI Agent"

    def test_param_in_mixed_text(self):
        result = resolve_expression("分析主题: {{params.topic}}", params=PARAMS, steps_output=STEPS_OUTPUT)
        assert result == "分析主题: AI Agent"

    def test_multiple_params_in_text(self):
        result = resolve_expression(
            "为 {{params.topic}} 创作 {{params.count}} 篇内容",
            params=PARAMS,
            steps_output=STEPS_OUTPUT,
        )
        assert result == "为 AI Agent 创作 5 篇内容"

    def test_missing_param_left_as_is(self):
        result = resolve_expression("{{params.missing}}", params=PARAMS, steps_output=STEPS_OUTPUT)
        assert result == "{{params.missing}}"


# ── resolve_expression: step output references ────────────────────────


class TestStepOutputReferences:
    def test_step_output_dict(self):
        """Single expression -> returns raw dict, not stringified."""
        result = resolve_expression("{{steps.1.output}}", params=PARAMS, steps_output=STEPS_OUTPUT)
        assert isinstance(result, dict)
        assert "companies" in result

    def test_step_output_array(self):
        """Returns raw array."""
        result = resolve_expression("{{steps.1.output.companies}}", params=PARAMS, steps_output=STEPS_OUTPUT)
        assert isinstance(result, list)
        assert len(result) == 2
        assert result[0]["name"] == "OpenAI"

    def test_step_output_scalar(self):
        """Returns raw scalar."""
        result = resolve_expression("{{steps.1.output.total}}", params=PARAMS, steps_output=STEPS_OUTPUT)
        assert result == 2

    def test_step_output_nested_field(self):
        result = resolve_expression(
            "{{steps.1.output.companies[0].name}}",
            params=PARAMS,
            steps_output=STEPS_OUTPUT,
        )
        assert result == "OpenAI"

    def test_step_output_index_via_dot(self):
        """steps.1.output.companies.0.name should also work (dot-separated index)."""
        result = resolve_expression(
            "{{steps.1.output.companies.0.name}}",
            params=PARAMS,
            steps_output=STEPS_OUTPUT,
        )
        assert result == "OpenAI"

    def test_step_summary(self):
        result = resolve_expression("{{steps.1.summary}}", params=PARAMS, steps_output=STEPS_OUTPUT)
        assert "Found 2 companies" in result

    def test_step_output_number(self):
        """Numeric output returns as int, not string."""
        result = resolve_expression("{{steps.2.output.score}}", params=PARAMS, steps_output=STEPS_OUTPUT)
        assert result == 85
        assert isinstance(result, int)

    def test_missing_step(self):
        result = resolve_expression("{{steps.99.output.x}}", params=PARAMS, steps_output=STEPS_OUTPUT)
        assert result == "{{steps.99.output.x}}"

    def test_missing_field_in_step(self):
        result = resolve_expression("{{steps.1.output.missing}}", params=PARAMS, steps_output=STEPS_OUTPUT)
        assert result == "{{steps.1.output.missing}}"

    def test_nested_dict_field(self):
        nested = {
            "1": {
                "output": {"meta": {"nested": {"field": "ok"}}},
                "summary": "",
                "artifacts": [],
            }
        }
        result = resolve_expression("{{steps.1.output.meta.nested.field}}", params={}, steps_output=nested)
        assert result == "ok"

    def test_empty_expression_string(self):
        assert resolve_expression("") == ""
        assert resolve_expression("   ") == "   "
        assert resolve_expression(None) == ""  # type: ignore[arg-type]

    def test_traverse_none_root_does_not_raise(self):
        from evoflow.collab.expression_resolver import _traverse

        found, value = _traverse(None, ["a", "b"])
        assert found is False
        assert value is None


# ── resolve_expression: artifact references ───────────────────────────


class TestArtifactReferences:
    def test_artifact_by_index(self):
        """Artifacts items use 'value' as the path field. Test value access via index."""
        result = resolve_expression(
            "{{steps.1.artifacts[0].value}}",
            params=PARAMS,
            steps_output=STEPS_OUTPUT,
        )
        assert result == "/data/report.md"

    def test_artifact_value_field(self):
        """Artifacts items have {type, key, value, label}. Test value access."""
        result = resolve_expression(
            "{{steps.1.artifacts[0].value}}",
            params=PARAMS,
            steps_output=STEPS_OUTPUT,
        )
        assert result == "/data/report.md"

    def test_artifact_label_field(self):
        result = resolve_expression(
            "{{steps.1.artifacts[0].label}}",
            params=PARAMS,
            steps_output=STEPS_OUTPUT,
        )
        assert result == "调研报告"


# ── resolve_expression: mixed text ────────────────────────────────────


class TestMixedText:
    def test_text_with_multiple_step_refs(self):
        result = resolve_expression(
            "基于 {{params.count}} 条数据，平均分 {{steps.2.output.score}}",
            params=PARAMS,
            steps_output=STEPS_OUTPUT,
        )
        assert result == "基于 5 条数据，平均分 85"

    def test_dict_value_in_mixed_text_becomes_json(self):
        """When a dict is interpolated into text, it becomes JSON string."""
        result = resolve_expression(
            "结果: {{steps.1.output.companies}}",
            params=PARAMS,
            steps_output=STEPS_OUTPUT,
        )
        assert result.startswith("结果: ")
        assert "OpenAI" in result
        # Should be valid JSON in the substituted part
        json_part = result.replace("结果: ", "", 1)
        parsed = json.loads(json_part)
        assert isinstance(parsed, list)


# ── resolve_expression: legacy compat ─────────────────────────────────


class TestLegacyCompat:
    def test_bare_param_name(self):
        """Bare {{topic}} (no prefix) should resolve from params as fallback."""
        result = resolve_expression("{{topic}}", params=PARAMS, steps_output=STEPS_OUTPUT)
        assert result == "AI Agent"

    def test_no_expressions(self):
        """Plain text with no expressions returns as-is."""
        result = resolve_expression("just some text", params=PARAMS, steps_output=STEPS_OUTPUT)
        assert result == "just some text"

    def test_empty_string(self):
        result = resolve_expression("", params=PARAMS, steps_output=STEPS_OUTPUT)
        assert result == ""


# ── resolve_bindings ──────────────────────────────────────────────────


class TestResolveBindings:
    def test_basic_bindings(self):
        bindings = {
            "companies": "{{steps.1.output.companies}}",
            "max_count": "{{params.count}}",
            "context": "{{steps.2.summary}}",
        }
        result = resolve_bindings(bindings, params=PARAMS, steps_output=STEPS_OUTPUT)
        assert isinstance(result["companies"], list)
        assert len(result["companies"]) == 2
        assert result["max_count"] == "5"
        assert "positive" in result["context"].lower() or "85" in result["context"]

    def test_none_bindings(self):
        assert resolve_bindings(None, params=PARAMS, steps_output=STEPS_OUTPUT) == {}

    def test_empty_bindings(self):
        assert resolve_bindings({}, params=PARAMS, steps_output=STEPS_OUTPUT) == {}

    def test_binding_with_unresolvable(self):
        bindings = {"x": "{{steps.99.output.missing}}"}
        result = resolve_bindings(bindings, params=PARAMS, steps_output=STEPS_OUTPUT)
        assert result["x"] == "{{steps.99.output.missing}}"


# ── build_steps_output_from_subtasks ──────────────────────────────────


class TestBuildStepsOutput:
    def test_from_completed_subtasks(self):
        subtasks = [
            {
                "ref": "1",
                "status": "completed",
                "structured_output": '{"companies": [{"name": "TestCorp"}]}',
                "result_summary": "Found 1 company",
                "outputs": [{"type": "file", "key": "report", "value": "/data/test.md"}],
            },
            {
                "ref": "2",
                "status": "executing",
                "result_summary": "Still running...",
            },
        ]
        result = build_steps_output_from_subtasks(subtasks)
        # Only completed step should be included
        assert "1" in result
        assert "2" not in result
        assert result["1"]["output"] == {"companies": [{"name": "TestCorp"}]}
        assert result["1"]["summary"] == "Found 1 company"
        assert len(result["1"]["artifacts"]) == 1
        assert result["1"]["artifacts_keyed"]["report"]["value"] == "/data/test.md"

    def test_dict_structured_output(self):
        """structured_output already a dict (not JSON string)."""
        subtasks = [
            {
                "ref": "1",
                "status": "completed",
                "structured_output": {"score": 42},
                "result_summary": "Done",
            },
        ]
        result = build_steps_output_from_subtasks(subtasks)
        assert result["1"]["output"] == {"score": 42}

    def test_invalid_structured_output_json(self):
        subtasks = [
            {
                "ref": "1",
                "status": "completed",
                "structured_output": "not valid json",
                "result_summary": "Done",
            },
        ]
        result = build_steps_output_from_subtasks(subtasks)
        assert result["1"]["output"] == {}

    def test_no_structured_output(self):
        """Legacy subtask without structured_output -> empty dict."""
        subtasks = [
            {"ref": "1", "status": "completed", "result_summary": "Legacy result"},
        ]
        result = build_steps_output_from_subtasks(subtasks)
        assert result["1"]["output"] == {}
        assert result["1"]["summary"] == "Legacy result"


# ── resolve_step_inputs ───────────────────────────────────────────────


class TestResolveStepInputs:
    def test_step_with_bindings(self):
        step = {
            "ref": "3",
            "input_bindings": {
                "companies": "{{steps.1.output.companies}}",
                "count": "{{params.count}}",
            },
        }
        subtasks = [
            {
                "ref": "1",
                "status": "completed",
                "structured_output": '{"companies": [{"name": "CorpA"}]}',
                "result_summary": "Done",
            },
        ]
        result = resolve_step_inputs(step, params=PARAMS, subtasks=subtasks)
        assert result["has_bindings"] is True
        assert isinstance(result["resolved"]["companies"], list)
        assert result["resolved"]["count"] == "5"
        assert "1" in result["steps_output"]

    def test_step_without_bindings(self):
        step = {"ref": "3"}
        result = resolve_step_inputs(step, params=PARAMS, subtasks=[])
        assert result["has_bindings"] is False
        assert result["resolved"] == {}

    def test_step_with_empty_bindings(self):
        step = {"ref": "3", "input_bindings": {}}
        result = resolve_step_inputs(step, params=PARAMS, subtasks=[])
        assert result["has_bindings"] is False


# ── format_resolved_inputs_for_prompt ─────────────────────────────────


class TestFormatForPrompt:
    def test_empty(self):
        assert format_resolved_inputs_for_prompt({}) == ""

    def test_scalar_values(self):
        result = format_resolved_inputs_for_prompt({"count": 5, "topic": "AI"})
        assert "count" in result
        assert "5" in result
        assert "topic" in result
        assert "AI" in result

    def test_dict_value(self):
        result = format_resolved_inputs_for_prompt(
            {"companies": [{"name": "OpenAI"}]}
        )
        assert "companies" in result
        assert "```json" in result
        assert "OpenAI" in result

    def test_none_value(self):
        result = format_resolved_inputs_for_prompt({"x": None})
        assert "未解析" in result


# ── Edge cases ────────────────────────────────────────────────────────


class TestEdgeCases:
    def test_whitespace_in_expression(self):
        result = resolve_expression("{{ params.topic }}", params=PARAMS, steps_output=STEPS_OUTPUT)
        assert result == "AI Agent"

    def test_nested_braces_not_confused(self):
        """Ensure we don't break on JSON-like content that has braces."""
        text = "Some text with {single brace"
        result = resolve_expression(text, params=PARAMS, steps_output=STEPS_OUTPUT)
        assert result == text

    def test_empty_expression(self):
        result = resolve_expression("{{}}", params=PARAMS, steps_output=STEPS_OUTPUT)
        # Empty expression -> unresolvable -> left as-is
        assert result == "{{}}"

    def test_env_reference(self):
        result = resolve_expression(
            "{{env.WORKSPACE}}",
            params=PARAMS,
            steps_output=STEPS_OUTPUT,
            env={"WORKSPACE": "/workspace"},
        )
        assert result == "/workspace"
