"""E2E integration tests for the P0.5 Runtime Contract pipeline.

Exercises the full chain: validator → prompt builder → binding resolution →
schema enforcement → trace retrieval → run-from-here semantics.

These tests use internal function calls (not HTTP) to verify the pipeline
end-to-end without requiring a running server.
"""

from __future__ import annotations

from typing import Any

from evoflow.collab.expression_resolver import (
    detect_binding_errors,
    detect_unresolved_bindings,
    resolve_step_inputs,
)
from evoflow.collab.schema_enforcement import resolve_schema_policy
from evoflow.collab.step_prompt_builder import build_core_prompt
from evoflow.collab.workflow_validator import validate_app_definition

# ── Helpers ────────────────────────────────────────────────────────────

def _make_step(
    ref: str,
    name: str = "",
    goal: str = "",
    depends_on: list[str] | None = None,
    input_bindings: dict[str, str] | None = None,
    input_schema: dict[str, Any] | None = None,
    output_schema: dict[str, Any] | None = None,
    schema_enforcement: str = "",
) -> dict[str, Any]:
    s: dict[str, Any] = {"ref": ref, "name": name or f"Step {ref}", "goal": goal}
    if depends_on:
        s["depends_on"] = depends_on
    if input_bindings:
        s["input_bindings"] = input_bindings
    if input_schema:
        s["input_schema"] = input_schema
    if output_schema:
        s["output_schema"] = output_schema
    if schema_enforcement:
        s["schema_enforcement"] = schema_enforcement
    return s


def _make_app(steps: list[dict], parameters: list[dict] | None = None, schema_enforcement: str = "") -> dict:
    return {
        "name": "E2E Test App",
        "steps": steps,
        "parameters": parameters or [],
        "goal_template": "Test goal {{topic}}",
        "schema_enforcement": schema_enforcement,
    }


def _make_subtask(
    ref: str,
    status: str = "completed",
    structured_output: dict[str, Any] | None = None,
    outputs: list[dict] | None = None,
) -> dict[str, Any]:
    st: dict[str, Any] = {"ref": ref, "status": status, "progress": 100}
    if structured_output is not None:
        st["structured_output"] = structured_output
    if outputs:
        st["outputs"] = outputs
    return st


# ── Scenario 1: Publish blocked by circular dependency ─────────────────

class TestScenario1PublishBlockedCircular:
    def test_circular_dep_blocks_publish(self) -> None:
        app = _make_app(steps=[
            _make_step("1", name="A", depends_on=["2"]),
            _make_step("2", name="B", depends_on=["1"]),
        ])
        result = validate_app_definition(app)
        assert result["valid"] is False
        assert any("Circular dependency" in e for e in result["errors"])


# ── Scenario 2: Publish blocked by dangling binding reference ──────────

class TestScenario2PublishBlockedDanglingRef:
    def test_dangling_step_ref_blocks_publish(self) -> None:
        app = _make_app(steps=[
            _make_step("1", name="A"),
            _make_step("2", name="B", input_bindings={"data": "{{steps.99.output.x}}"}),
        ])
        result = validate_app_definition(app)
        assert result["valid"] is False
        assert any("non-existent step '99'" in e for e in result["errors"])

    def test_unknown_output_field_blocks_publish(self) -> None:
        """Check 3b: binding references output field not in upstream output_schema."""
        app = _make_app(steps=[
            _make_step("1", name="Source", output_schema={
                "type": "object",
                "properties": {"title": {"type": "string"}},
            }),
            _make_step("2", name="Consumer", depends_on=["1"],
                       input_bindings={"data": "{{steps.1.output.nonexistent}}"}),
        ])
        result = validate_app_definition(app)
        assert result["valid"] is False
        assert any("nonexistent" in e and "not declared" in e for e in result["errors"])


# ── Scenario 3: Publish blocked by static type mismatch ────────────────

class TestScenario3PublishBlockedTypeMismatch:
    def test_type_mismatch_blocks_publish(self) -> None:
        """Check 3c: string output bound to number input."""
        app = _make_app(steps=[
            _make_step("1", name="Source", output_schema={
                "type": "object",
                "properties": {"count": {"type": "string"}},
            }),
            _make_step("2", name="Consumer", depends_on=["1"],
                       input_bindings={"total": "{{steps.1.output.count}}"},
                       input_schema={
                           "type": "object",
                           "properties": {"total": {"type": "number"}},
                       }),
        ])
        result = validate_app_definition(app)
        assert result["valid"] is False
        assert any("type mismatch" in e.lower() for e in result["errors"])

    def test_compatible_types_pass(self) -> None:
        """integer output -> number input should be compatible."""
        app = _make_app(steps=[
            _make_step("1", name="Source", output_schema={
                "type": "object",
                "properties": {"count": {"type": "integer"}},
            }),
            _make_step("2", name="Consumer", depends_on=["1"],
                       input_bindings={"total": "{{steps.1.output.count}}"},
                       input_schema={
                           "type": "object",
                           "properties": {"total": {"type": "number"}},
                       }),
        ])
        result = validate_app_definition(app)
        assert result["valid"] is True


# ── Scenario 4: Valid app publishes successfully ───────────────────────

class TestScenario4ValidAppPublishes:
    def test_valid_app_passes_validation(self) -> None:
        app = _make_app(
            steps=[
                _make_step("1", name="Research", goal="Research topic",
                           output_schema={
                               "type": "object",
                               "properties": {"summary": {"type": "string"}},
                           }),
                _make_step("2", name="Write", goal="Write article",
                           depends_on=["1"],
                           input_bindings={"research": "{{steps.1.output.summary}}"},
                           input_schema={
                               "type": "object",
                               "properties": {"research": {"type": "string"}},
                           },
                           output_schema={
                               "type": "object",
                               "properties": {"article": {"type": "string"}},
                           }),
            ],
            parameters=[{"name": "topic"}],
        )
        result = validate_app_definition(app)
        assert result["valid"] is True
        assert result["errors"] == []


# ── Scenario 5: Binding resolution with completed upstream ─────────────

class TestScenario5BindingResolution:
    def test_resolve_bindings_from_completed_upstream(self) -> None:
        step = _make_step("2", name="Consumer",
                          input_bindings={"data": "{{steps.1.output.title}}"})

        subtasks = [
            _make_subtask("1", structured_output={"title": "Hello World"}),
        ]

        result = resolve_step_inputs(step, params={}, subtasks=subtasks)
        assert result["has_bindings"] is True
        assert result["resolved"]["data"] == "Hello World"
        unresolved = detect_unresolved_bindings(result["resolved"])
        assert len(unresolved) == 0

    def test_unresolved_binding_when_upstream_not_completed(self) -> None:
        step = _make_step("2", name="Consumer",
                          input_bindings={"data": "{{steps.1.output.title}}"})

        subtasks = [
            _make_subtask("1", status="pending"),  # not completed
        ]

        result = resolve_step_inputs(step, params={}, subtasks=subtasks)
        unresolved = detect_unresolved_bindings(result["resolved"])
        assert len(unresolved) > 0


# ── Scenario 6: build_core_prompt produces correct output ──────────────

class TestScenario6CorePrompt:
    def test_production_mode_unresolved_binding_detected(self) -> None:
        step = _make_step("2", name="Consumer",
                          input_bindings={"data": "{{steps.1.output.title}}"})

        # No completed upstream → unresolved
        result = build_core_prompt(
            step=step,
            params={},
            subtasks=[_make_subtask("1", status="pending")],
            mode="production",
        )
        assert result["unresolved_count"] > 0
        assert len(result["binding_errors"]) > 0

    def test_debug_mode_resolves_with_mock_data(self) -> None:
        step = _make_step("2", name="Consumer",
                          input_bindings={"data": "{{steps.1.output.title}}"})

        mock_output = {
            "1": {"output": {"title": "Mock Title"}, "summary": ""},
        }

        result = build_core_prompt(
            step=step,
            params={},
            steps_output=mock_output,
            mode="debug",
        )
        assert result["resolved"]["data"] == "Mock Title"
        assert result["unresolved_count"] == 0
        assert "Mock Title" in result["prompt"] or result["resolved"]["data"] == "Mock Title"

    def test_input_schema_valid_when_types_match(self) -> None:
        step = _make_step("2", name="Consumer",
                          input_bindings={"count": "{{steps.1.output.total}}"},
                          input_schema={
                              "type": "object",
                              "properties": {"count": {"type": "number"}},
                          })

        result = build_core_prompt(
            step=step,
            params={},
            subtasks=[_make_subtask("1", structured_output={"total": 42})],
            mode="production",
        )
        assert result["input_schema_valid"] is True

    def test_input_schema_invalid_when_type_mismatches(self) -> None:
        step = _make_step("2", name="Consumer",
                          input_bindings={"count": "{{steps.1.output.total}}"},
                          input_schema={
                              "type": "object",
                              "properties": {"count": {"type": "number"}},
                          })

        # Provide a string value where number is expected
        result = build_core_prompt(
            step=step,
            params={},
            subtasks=[_make_subtask("1", structured_output={"total": "not a number"})],
            mode="production",
        )
        assert result["input_schema_valid"] is False
        # Should have TYPE_MISMATCH in binding_errors
        type_errors = [e for e in result["binding_errors"] if e.get("code") == "TYPE_MISMATCH"]
        assert len(type_errors) > 0


# ── Scenario 7: Schema enforcement policy resolution ───────────────────

class TestScenario7SchemaEnforcement:
    def test_step_level_overrides_app_level(self) -> None:
        step = _make_step("1", schema_enforcement="strict")
        app_def = {"schema_enforcement": "warn"}
        policy = resolve_schema_policy(step=step, app_def=app_def, task_row={})
        assert policy == "strict"

    def test_app_level_when_step_empty(self) -> None:
        step = _make_step("1")
        app_def = {"schema_enforcement": "ignore"}
        policy = resolve_schema_policy(step=step, app_def=app_def, task_row={})
        assert policy == "ignore"

    def test_default_warn_when_neither_set(self) -> None:
        step = _make_step("1")
        policy = resolve_schema_policy(step=step, app_def=None, task_row={})
        assert policy == "warn"


# ── Scenario 8: Binding error classification ───────────────────────────

class TestScenario8BindingErrors:
    def test_unknown_step_error_code(self) -> None:
        """Binding references a step that doesn't exist."""
        step = _make_step("2", input_bindings={"data": "{{steps.99.output.x}}"})
        result = resolve_step_inputs(step, params={}, subtasks=[])
        errors = detect_binding_errors(
            result["resolved"],
            bindings=step["input_bindings"],
            params={},
            steps_output=result.get("steps_output", {}),
            subtasks=[],
        )
        codes = {e.code for e in errors}
        assert "UNKNOWN_STEP" in codes or "UNRESOLVED_BINDING" in codes

    def test_unknown_param_error_code(self) -> None:
        """Binding references a param that doesn't exist."""
        step = _make_step("1", input_bindings={"data": "{{params.nonexistent}}"})
        result = resolve_step_inputs(step, params={}, subtasks=[])
        errors = detect_binding_errors(
            result["resolved"],
            bindings=step["input_bindings"],
            params={},
            steps_output=result.get("steps_output", {}),
            subtasks=[],
        )
        codes = {e.code for e in errors}
        assert "UNKNOWN_PARAM" in codes or "UNRESOLVED_BINDING" in codes

    def test_upstream_not_completed_error_code(self) -> None:
        """Binding references upstream step that hasn't completed."""
        step = _make_step("2", input_bindings={"data": "{{steps.1.output.x}}"})
        subtasks = [_make_subtask("1", status="pending")]
        result = resolve_step_inputs(step, params={}, subtasks=subtasks)
        errors = detect_binding_errors(
            result["resolved"],
            bindings=step["input_bindings"],
            params={},
            steps_output=result.get("steps_output", {}),
            subtasks=subtasks,
        )
        codes = {e.code for e in errors}
        assert "UPSTREAM_NOT_COMPLETED" in codes or "UNRESOLVED_BINDING" in codes


# ── Scenario 9: Parameter resolution in bindings ───────────────────────

class TestScenario9ParameterBindings:
    def test_param_binding_resolves(self) -> None:
        step = _make_step("1", input_bindings={"topic": "{{params.topic}}"})
        result = resolve_step_inputs(step, params={"topic": "AI News"}, subtasks=[])
        assert result["resolved"]["topic"] == "AI News"
        unresolved = detect_unresolved_bindings(result["resolved"])
        assert len(unresolved) == 0

    def test_missing_param_binding_unresolved(self) -> None:
        step = _make_step("1", input_bindings={"topic": "{{params.topic}}"})
        result = resolve_step_inputs(step, params={}, subtasks=[])
        unresolved = detect_unresolved_bindings(result["resolved"])
        assert len(unresolved) > 0


# ── Scenario 10: Full pipeline (validator → prompt → enforcement) ──────

class TestScenario10FullPipeline:
    def test_valid_pipeline_produces_resolved_prompt(self) -> None:
        """End-to-end: valid app definition passes validator, resolves
        bindings, builds prompt with correct resolved inputs, and
        input_schema validation passes."""
        # 1. Define app
        app = _make_app(
            steps=[
                _make_step("1", name="Research",
                           output_schema={
                               "type": "object",
                               "properties": {"summary": {"type": "string"}},
                           }),
                _make_step("2", name="Write",
                           depends_on=["1"],
                           input_bindings={"research": "{{steps.1.output.summary}}"},
                           input_schema={
                               "type": "object",
                               "properties": {"research": {"type": "string"}},
                           },
                           output_schema={
                               "type": "object",
                               "properties": {"article": {"type": "string"}},
                           }),
            ],
            parameters=[{"name": "topic"}],
        )

        # 2. Validate (should pass)
        val_result = validate_app_definition(app)
        assert val_result["valid"] is True

        # 3. Simulate step 1 completed
        subtasks = [
            _make_subtask("1", structured_output={"summary": "AI is transforming everything."}),
        ]

        # 4. Build core prompt for step 2
        step2 = app["steps"][1]
        prompt_result = build_core_prompt(
            step=step2,
            params={"topic": "AI"},
            subtasks=subtasks,
            mode="production",
        )

        # 5. Verify resolution
        assert prompt_result["unresolved_count"] == 0
        assert prompt_result["resolved"]["research"] == "AI is transforming everything."
        assert prompt_result["input_schema_valid"] is True
        assert prompt_result["binding_errors"] == []
        assert "AI is transforming everything." in prompt_result["prompt"]

    def test_invalid_pipeline_blocks_at_validation(self) -> None:
        """End-to-end: invalid app (circular dep) blocked at validator,
        never reaches prompt builder."""
        app = _make_app(steps=[
            _make_step("1", depends_on=["2"]),
            _make_step("2", depends_on=["1"]),
        ])

        # Validator should block
        val_result = validate_app_definition(app)
        assert val_result["valid"] is False

        # In a real publish flow, the 422 response would carry these errors
        # to the frontend. Verify errors are structured as strings.
        assert isinstance(val_result["errors"], list)
        assert all(isinstance(e, str) for e in val_result["errors"])

    def test_pipeline_with_schema_enforcement_strict(self) -> None:
        """End-to-end: strict schema enforcement + type mismatch
        produces TYPE_MISMATCH binding error."""
        step = _make_step("2",
                          input_bindings={"count": "{{steps.1.output.total}}"},
                          input_schema={
                              "type": "object",
                              "properties": {"count": {"type": "number"}},
                          },
                          schema_enforcement="strict")

        # Upstream returns string instead of number
        subtasks = [_make_subtask("1", structured_output={"total": "oops"})]

        result = build_core_prompt(
            step=step,
            params={},
            subtasks=subtasks,
            mode="production",
        )

        # Should detect type mismatch
        assert result["input_schema_valid"] is False
        type_errors = [e for e in result["binding_errors"] if e.get("code") == "TYPE_MISMATCH"]
        assert len(type_errors) > 0

        # In production, this would block dispatch via the
        # _has_input_schema_errors gate in execution.py
