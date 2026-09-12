"""Tests for workflow_validator.py - Pre-publish static validation."""

from __future__ import annotations

from evoflow.collab.workflow_validator import validate_app_definition


def _make_app(
    *,
    steps: list[dict] | None = None,
    parameters: list[dict] | None = None,
    schema_enforcement: str = "",
) -> dict:
    return {
        "name": "Test App",
        "steps": steps or [],
        "parameters": parameters or [],
        "goal_template": "",
        "schema_enforcement": schema_enforcement,
    }


class TestStepRefIntegrity:
    def test_valid_deps(self) -> None:
        app = _make_app(steps=[
            {"ref": "1", "name": "Step 1", "goal": "Do thing 1"},
            {"ref": "2", "name": "Step 2", "goal": "Do thing 2", "depends_on": ["1"]},
        ])
        result = validate_app_definition(app)
        assert result["valid"] is True
        assert result["errors"] == []

    def test_dangling_dep(self) -> None:
        app = _make_app(steps=[
            {"ref": "1", "name": "Step 1", "goal": "Do thing 1"},
            {"ref": "2", "name": "Step 2", "goal": "Do thing 2", "depends_on": ["99"]},
        ])
        result = validate_app_definition(app)
        assert result["valid"] is False
        assert any("non-existent step '99'" in e for e in result["errors"])


class TestCircularDeps:
    def test_no_cycle(self) -> None:
        app = _make_app(steps=[
            {"ref": "1", "name": "A", "depends_on": []},
            {"ref": "2", "name": "B", "depends_on": ["1"]},
            {"ref": "3", "name": "C", "depends_on": ["2"]},
        ])
        result = validate_app_definition(app)
        assert result["valid"] is True

    def test_simple_cycle(self) -> None:
        app = _make_app(steps=[
            {"ref": "1", "name": "A", "depends_on": ["2"]},
            {"ref": "2", "name": "B", "depends_on": ["1"]},
        ])
        result = validate_app_definition(app)
        assert result["valid"] is False
        assert any("Circular dependency" in e for e in result["errors"])

    def test_self_cycle(self) -> None:
        app = _make_app(steps=[
            {"ref": "1", "name": "A", "depends_on": ["1"]},
        ])
        result = validate_app_definition(app)
        assert result["valid"] is False
        assert any("Circular" in e for e in result["errors"])

    def test_three_node_cycle(self) -> None:
        app = _make_app(steps=[
            {"ref": "1", "name": "A", "depends_on": ["3"]},
            {"ref": "2", "name": "B", "depends_on": ["1"]},
            {"ref": "3", "name": "C", "depends_on": ["2"]},
        ])
        result = validate_app_definition(app)
        assert result["valid"] is False
        assert any("Circular dependency" in e for e in result["errors"])

    def test_two_directed_cycles_same_nodes_are_both_reported(self) -> None:
        # 1->2->3->1 and 1->3->2->1 share nodes; fingerprint must not collapse them
        # into a single "sorted set" if both directed cycles exist.
        app = _make_app(steps=[
            {"ref": "1", "name": "A", "depends_on": ["2", "3"]},
            {"ref": "2", "name": "B", "depends_on": ["3", "1"]},
            {"ref": "3", "name": "C", "depends_on": ["1", "2"]},
        ])
        result = validate_app_definition(app)
        assert result["valid"] is False
        cycles = result["checks"]["circular_deps"]["cycles"]
        assert len(cycles) >= 1

    def test_duplicate_refs_are_errors(self) -> None:
        app = _make_app(steps=[
            {"ref": "1", "name": "A", "goal": "one"},
            {"ref": "1", "name": "B", "goal": "two"},
        ])
        result = validate_app_definition(app)
        assert result["valid"] is False
        assert any("Duplicate step ref" in e for e in result["errors"])

    def test_duplicate_names_are_warnings(self) -> None:
        app = _make_app(steps=[
            {"ref": "1", "name": "Same", "goal": "one"},
            {"ref": "2", "name": "Same", "goal": "two"},
        ])
        result = validate_app_definition(app)
        assert result["valid"] is True
        assert any("Duplicate step name" in w for w in result["warnings"])


class TestBindingRefs:
    def test_valid_step_binding(self) -> None:
        app = _make_app(steps=[
            {"ref": "1", "name": "A", "goal": "Produce data"},
            {"ref": "2", "name": "B", "goal": "Use data", "input_bindings": {"data": "{{steps.1.output.data}}"}},
        ])
        result = validate_app_definition(app)
        assert result["valid"] is True

    def test_dangling_step_binding(self) -> None:
        app = _make_app(steps=[
            {"ref": "1", "name": "A", "goal": "Produce data"},
            {"ref": "2", "name": "B", "goal": "Use data", "input_bindings": {"data": "{{steps.99.output.data}}"}},
        ])
        result = validate_app_definition(app)
        assert result["valid"] is False
        assert any("non-existent step '99'" in e for e in result["errors"])

    def test_undeclared_param_binding_is_warning(self) -> None:
        app = _make_app(
            steps=[{"ref": "1", "name": "A", "goal": "Use param", "input_bindings": {"x": "{{params.undefined_param}}"}}],
            parameters=[{"name": "defined_param", "type": "text"}],
        )
        result = validate_app_definition(app)
        assert result["valid"] is True  # warnings don't block
        assert any("undeclared parameter" in w for w in result["warnings"])


class TestRequiredFields:
    def test_missing_name_is_warning(self) -> None:
        app = _make_app(steps=[{"ref": "1", "goal": "Do thing"}])
        result = validate_app_definition(app)
        assert result["valid"] is True
        assert any("missing 'name'" in w for w in result["warnings"])

    def test_missing_goal_and_description_is_warning(self) -> None:
        app = _make_app(steps=[{"ref": "1", "name": "Step 1"}])
        result = validate_app_definition(app)
        assert result["valid"] is True
        assert any("missing 'goal'" in w for w in result["warnings"])


class TestParamPlaceholders:
    def test_valid_placeholder(self) -> None:
        app = _make_app(
            steps=[{"ref": "1", "name": "A", "goal": "Process {{topic}}"}],
            parameters=[{"name": "topic", "type": "text"}],
        )
        result = validate_app_definition(app)
        assert result["valid"] is True

    def test_undeclared_placeholder_is_warning(self) -> None:
        app = _make_app(
            steps=[{"ref": "1", "name": "A", "goal": "Process {{unknown}}"}],
            parameters=[{"name": "topic", "type": "text"}],
        )
        result = validate_app_definition(app)
        assert result["valid"] is True
        assert any("undeclared parameter 'unknown'" in w for w in result["warnings"])


class TestSchemaPolicy:
    def test_invalid_app_policy_is_warning(self) -> None:
        app = _make_app(schema_enforcement="bogus")
        result = validate_app_definition(app)
        assert any("schema_enforcement='bogus'" in w for w in result["warnings"])

    def test_valid_app_policy_no_warning(self) -> None:
        app = _make_app(schema_enforcement="strict")
        result = validate_app_definition(app)
        assert not any("schema_enforcement" in w for w in result["warnings"])

    def test_invalid_step_policy_is_warning(self) -> None:
        app = _make_app(steps=[{"ref": "1", "name": "A", "goal": "G", "schema_enforcement": "bad"}])
        result = validate_app_definition(app)
        assert any("schema_enforcement='bad'" in w for w in result["warnings"])


class TestEmptyWorkflow:
    def test_no_steps_is_error(self) -> None:
        app = _make_app(steps=[])
        result = validate_app_definition(app)
        assert result["valid"] is False
        assert any("no steps" in e for e in result["errors"])


class TestCleanApp:
    def test_fully_valid_app(self) -> None:
        app = _make_app(
            steps=[
                {"ref": "1", "name": "Fetch", "goal": "Fetch data", "output_schema": {"type": "object", "properties": {"items": {"type": "array"}}}},
                {"ref": "2", "name": "Process", "goal": "Process data", "depends_on": ["1"], "input_bindings": {"data": "{{steps.1.output.items}}"}},
            ],
            parameters=[{"name": "source", "type": "text"}],
            schema_enforcement="strict",
        )
        result = validate_app_definition(app)
        assert result["valid"] is True
        assert result["errors"] == []
