"""Unit tests for structured_output extraction and schema validation."""

from __future__ import annotations

import pytest

from evoflow.collab.structured_output import (
    extract_structured_output,
    validate_against_schema,
    process_step_output,
    get_step_output_schema,
)


# ── extract_structured_output ──────────────────────────────────────────


class TestExtract:
    def test_explicit_dict(self):
        data, source = extract_structured_output("some text", explicit={"x": 1})
        assert data == {"x": 1}
        assert source == "explicit"

    def test_explicit_json_string(self):
        data, source = extract_structured_output("text", explicit='{"x": 1}')
        assert data == {"x": 1}
        assert source == "explicit"

    def test_explicit_list_wrapped(self):
        data, source = extract_structured_output("text", explicit='[1, 2, 3]')
        assert data == {"items": [1, 2, 3]}
        assert source == "explicit"

    def test_fenced_json_block(self):
        text = """Here are the results:

```json
{"companies": [{"name": "OpenAI"}], "total": 1}
```

That's all."""
        data, source = extract_structured_output(text)
        assert data["companies"][0]["name"] == "OpenAI"
        assert data["total"] == 1
        assert source == "fence"

    def test_fenced_without_language(self):
        text = "Results:\n```\n{\"x\": 42}\n```\nDone."
        data, source = extract_structured_output(text)
        assert data == {"x": 42}
        assert source == "fence"

    def test_trailing_json(self):
        text = 'The analysis is complete. {"score": 85, "verdict": "positive"}'
        data, source = extract_structured_output(text)
        assert data == {"score": 85, "verdict": "positive"}
        assert source == "trailing"

    def test_no_json_found(self):
        data, source = extract_structured_output("Just plain text, no JSON here.")
        assert data is None
        assert source == "none"

    def test_empty_text(self):
        data, source = extract_structured_output("")
        assert data is None
        assert source == "none"

    def test_none_text(self):
        data, source = extract_structured_output(None)
        assert data is None
        assert source == "none"

    def test_explicit_takes_priority_over_fenced(self):
        text = '```json\n{"from_fence": true}\n```'
        data, source = extract_structured_output(text, explicit={"from_explicit": True})
        assert data == {"from_explicit": True}
        assert source == "explicit"

    def test_invalid_json_in_fence_falls_through(self):
        text = "```json\n{not valid json}\n```\n{\"valid\": true}"
        data, source = extract_structured_output(text)
        assert data == {"valid": True}
        assert source == "trailing"


# ── validate_against_schema ────────────────────────────────────────────


class TestValidate:
    def test_no_schema_always_valid(self):
        is_valid, errors = validate_against_schema({"x": 1}, None)
        assert is_valid is True
        assert errors == []

    def test_valid_object(self):
        schema = {
            "type": "object",
            "properties": {"name": {"type": "string"}, "age": {"type": "integer"}},
            "required": ["name"],
        }
        is_valid, errors = validate_against_schema({"name": "Alice", "age": 30}, schema)
        assert is_valid is True
        assert errors == []

    def test_missing_required(self):
        schema = {
            "type": "object",
            "properties": {"name": {"type": "string"}},
            "required": ["name"],
        }
        is_valid, errors = validate_against_schema({}, schema)
        assert is_valid is False
        assert any("name" in e for e in errors)

    def test_wrong_type(self):
        schema = {"type": "object", "properties": {"age": {"type": "integer"}}}
        is_valid, errors = validate_against_schema({"age": "thirty"}, schema)
        assert is_valid is False
        assert any("integer" in e for e in errors)

    def test_array_validation(self):
        schema = {
            "type": "object",
            "properties": {
                "items": {
                    "type": "array",
                    "items": {"type": "string"},
                }
            },
        }
        is_valid, errors = validate_against_schema({"items": ["a", "b", "c"]}, schema)
        assert is_valid is True

    def test_array_wrong_item_type(self):
        schema = {
            "type": "object",
            "properties": {
                "items": {
                    "type": "array",
                    "items": {"type": "string"},
                }
            },
        }
        is_valid, errors = validate_against_schema({"items": ["a", 123, "c"]}, schema)
        assert is_valid is False

    def test_nested_object(self):
        schema = {
            "type": "object",
            "properties": {
                "company": {
                    "type": "object",
                    "properties": {"name": {"type": "string"}},
                    "required": ["name"],
                }
            },
            "required": ["company"],
        }
        is_valid, _ = validate_against_schema({"company": {"name": "OpenAI"}}, schema)
        assert is_valid is True

        is_valid, errors = validate_against_schema({"company": {}}, schema)
        assert is_valid is False


# ── process_step_output ────────────────────────────────────────────────


class TestProcessStepOutput:
    def test_with_schema_valid(self):
        schema = {
            "type": "object",
            "properties": {"score": {"type": "integer"}},
            "required": ["score"],
        }
        result = process_step_output(
            "The score is 85.\n```json\n{\"score\": 85}\n```",
            schema,
        )
        assert result["structured_output"] == {"score": 85}
        assert result["schema_valid"] is True
        assert result["schema_errors"] == []
        assert result["extraction_source"] == "fence"

    def test_with_schema_invalid(self):
        schema = {
            "type": "object",
            "properties": {"score": {"type": "integer"}},
            "required": ["score"],
        }
        result = process_step_output(
            "Done.\n```json\n{\"verdict\": \"good\"}\n```",
            schema,
        )
        assert result["structured_output"] == {"verdict": "good"}
        assert result["schema_valid"] is False
        assert len(result["schema_errors"]) > 0

    def test_no_schema_extracts_anyway(self):
        result = process_step_output(
            "Results:\n```json\n{\"x\": 1}\n```",
            None,
        )
        assert result["structured_output"] == {"x": 1}
        assert result["schema_valid"] is True

    def test_no_json_found(self):
        result = process_step_output("Just text, nothing structured.", None)
        assert result["structured_output"] is None
        assert result["schema_valid"] is True
        assert result["extraction_source"] == "none"

    def test_explicit_overrides_extraction(self):
        result = process_step_output(
            "```json\n{\"from_fence\": true}\n```",
            None,
            explicit_structured_output={"from_explicit": True},
        )
        assert result["structured_output"] == {"from_explicit": True}
        assert result["extraction_source"] == "explicit"


# ── get_step_output_schema ─────────────────────────────────────────────


class TestGetStepOutputSchema:
    def test_from_subtask_directly(self):
        subtask = {"ref": "1", "output_schema": {"type": "object", "properties": {"x": {"type": "string"}}}}
        schema = get_step_output_schema(subtask)
        assert schema is not None
        assert "properties" in schema

    def test_from_plan_steps(self):
        subtask = {"ref": "2"}
        plan_steps = [
            {"ref": "1", "output_schema": {"type": "object"}},
            {"ref": "2", "output_schema": {"type": "object", "properties": {"y": {"type": "integer"}}}},
        ]
        schema = get_step_output_schema(subtask, plan_steps=plan_steps)
        assert schema is not None
        assert "y" in schema.get("properties", {})

    def test_no_schema_found(self):
        subtask = {"ref": "3"}
        plan_steps = [{"ref": "1"}]
        schema = get_step_output_schema(subtask, plan_steps=plan_steps)
        assert schema is None

    def test_empty_subtask(self):
        schema = get_step_output_schema({})
        assert schema is None
