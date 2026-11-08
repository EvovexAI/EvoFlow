"""Regression: output_schema must be findable and missing JSON must not be vacuously valid."""

from __future__ import annotations

from typing import Any
from unittest.mock import MagicMock

from evoflow.collab.schema_enforcement import resolve_schema_policy
from evoflow.collab.step_prompt_builder import (
    _coerce_resolved_to_input_schema,
    build_core_prompt,
    format_output_schema_for_prompt,
)
from evoflow.collab.structured_output import (
    get_step_output_schema,
    process_step_output,
)
from evoflow.tools.builtins.supervisor.execution import _build_subtask_enriched_prompt


SCHEMA = {
    "type": "object",
    "properties": {
        "topic": {"type": "string"},
        "points": {"type": "array"},
    },
    "required": ["topic", "points"],
}


def test_get_step_output_schema_matches_semantic_plan_ref():
    """Runtime row is numeric; plan may still carry semantic ref (pre-normalize)."""
    st = {"ref": "1", "semantic_ref": "collect"}
    plan = [{"ref": "collect", "output_schema": SCHEMA}]
    assert get_step_output_schema(st, plan_steps=plan) == SCHEMA


def test_get_step_output_schema_matches_normalized_numeric_plan_ref():
    st = {"ref": "1", "semantic_ref": "collect"}
    plan = [{"ref": "1", "semantic_ref": "collect", "output_schema": SCHEMA}]
    assert get_step_output_schema(st, plan_steps=plan) == SCHEMA


def test_get_step_output_schema_prefers_row_copy():
    row_schema = {"type": "object", "properties": {"x": {"type": "string"}}}
    st = {"ref": "1", "output_schema": row_schema}
    plan = [{"ref": "1", "output_schema": SCHEMA}]
    assert get_step_output_schema(st, plan_steps=plan) == row_schema


def test_missing_structured_output_with_schema_is_invalid():
    result = process_step_output("散文摘要，没有 JSON。", SCHEMA)
    assert result["structured_output"] is None
    assert result["schema_valid"] is False
    assert result["extraction_source"] == "none"
    assert result["schema_errors"]


def test_missing_structured_output_without_schema_stays_valid():
    result = process_step_output("散文摘要，没有 JSON。", None)
    assert result["structured_output"] is None
    assert result["schema_valid"] is True


def test_trailing_empty_object_fails_required_fields():
    result = process_step_output("done\n{}", SCHEMA)
    assert result["structured_output"] == {}
    assert result["schema_valid"] is False


def test_prompt_injects_output_schema_contract():
    step = {
        "ref": "1",
        "description": "收集要点",
        "output_schema": SCHEMA,
    }
    built = build_core_prompt(step=step, params={}, mode="production")
    assert "结构化产出契约" in built["prompt"]
    assert "structured_output" in built["prompt"]
    assert '"points"' in built["prompt"]


def test_format_output_schema_for_prompt_empty_when_missing():
    assert format_output_schema_for_prompt(None) == ""
    assert format_output_schema_for_prompt({}) == ""
    assert format_output_schema_for_prompt("x") == ""


def test_enriched_prompt_injects_output_schema_without_input_bindings(monkeypatch):
    """Production path must inject the contract even when only output_schema is set.

    Regression: ``_build_subtask_enriched_prompt`` used to call ``build_core_prompt``
    only when ``input_bindings`` existed, and even then only appended the resolved
    inputs block — dropping the schema contract entirely.
    """
    plan_steps = [
        {
            "ref": "1",
            "semantic_ref": "collect",
            "name": "collect",
            "description": "收集要点",
            "output_schema": SCHEMA,
            # intentionally no input_bindings
        }
    ]
    task = {
        "id": "main1",
        "subtasks": [
            {
                "id": "st1",
                "ref": "1",
                "semantic_ref": "collect",
                "name": "collect",
                "description": "收集要点",
                "status": "pending",
            }
        ],
        "run_parameters": {"topic": "demo", "count": "4"},
        "plan_steps_json": plan_steps,
    }

    monkeypatch.setattr(
        "evoflow.collab.storage.find_main_task",
        lambda _storage, _tid: ({}, task),
    )
    monkeypatch.setattr(
        "evoflow.collab.plan_task_storage.load_plan_steps",
        lambda _task: plan_steps,
    )
    # Keep mandate / checklist / peer / workspace scan from exploding the assertion.
    monkeypatch.setattr(
        "evoflow.collab.subtask_reporting.resolve_subtask_reporting_mode",
        lambda **_k: "light",
    )
    monkeypatch.setattr(
        "evoflow.collab.subtask_reporting.format_subtask_progress_mandate_block",
        lambda **_k: "",
    )
    monkeypatch.setattr(
        "evoflow.collab.subtask_reporting.format_subtask_outcome_mandate_block",
        lambda **_k: "## done mandate",
    )

    prompt = _build_subtask_enriched_prompt(
        subtask_row=dict(task["subtasks"][0]),
        main_task_id="main1",
        subtask_id="st1",
        storage=MagicMock(),
    )
    assert "结构化产出契约" in prompt
    assert "structured_output" in prompt
    assert '"points"' in prompt


def test_enriched_prompt_injects_schema_even_when_bindings_present(monkeypatch):
    plan_steps = [
        {
            "ref": "1",
            "name": "collect",
            "description": "收集要点",
            "input_bindings": {"topic": "{{params.topic}}"},
            "output_schema": SCHEMA,
        }
    ]
    task: dict[str, Any] = {
        "id": "main1",
        "subtasks": [
            {
                "id": "st1",
                "ref": "1",
                "name": "collect",
                "description": "收集要点",
                "status": "pending",
            }
        ],
        "run_parameters": {"topic": "demo"},
    }
    monkeypatch.setattr(
        "evoflow.collab.storage.find_main_task",
        lambda _storage, _tid: ({}, task),
    )
    monkeypatch.setattr(
        "evoflow.collab.plan_task_storage.load_plan_steps",
        lambda _task: plan_steps,
    )
    monkeypatch.setattr(
        "evoflow.collab.subtask_reporting.resolve_subtask_reporting_mode",
        lambda **_k: "light",
    )
    monkeypatch.setattr(
        "evoflow.collab.subtask_reporting.format_subtask_progress_mandate_block",
        lambda **_k: "",
    )
    monkeypatch.setattr(
        "evoflow.collab.subtask_reporting.format_subtask_outcome_mandate_block",
        lambda **_k: "## done mandate",
    )

    prompt = _build_subtask_enriched_prompt(
        subtask_row=dict(task["subtasks"][0]),
        main_task_id="main1",
        subtask_id="st1",
        storage=MagicMock(),
    )
    assert "结构化产出契约" in prompt
    assert "structured_output" in prompt


def test_schema_enforcement_defaults_to_strict():
    assert resolve_schema_policy() == "strict"
    assert resolve_schema_policy(step={}, app_def={}, task_row={}) == "strict"
    assert resolve_schema_policy(step={"schema_enforcement": "warn"}) == "warn"


def test_input_schema_coerces_numeric_param_strings():
    resolved = {"target_count": "4", "topic": "EvoFlow"}
    schema = {
        "type": "object",
        "properties": {
            "target_count": {"type": "number"},
            "topic": {"type": "string"},
        },
    }
    _coerce_resolved_to_input_schema(resolved, schema)
    assert resolved["target_count"] == 4
    assert isinstance(resolved["target_count"], int)
    assert resolved["topic"] == "EvoFlow"
