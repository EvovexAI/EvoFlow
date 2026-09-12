"""Tests for schema_enforcement.py - Schema Enforcement Policy."""

from __future__ import annotations

import pytest

from evoflow.collab.schema_enforcement import (
    enforce_schema_on_outcome,
    resolve_schema_policy,
)


class TestResolveSchemaPolicy:
    """Tests for policy resolution priority."""

    def test_step_level_overrides_app_level(self) -> None:
        step = {"schema_enforcement": "strict"}
        app_def = {"schema_enforcement": "warn"}
        assert resolve_schema_policy(step=step, app_def=app_def) == "strict"

    def test_app_level_used_when_no_step(self) -> None:
        app_def = {"schema_enforcement": "ignore"}
        assert resolve_schema_policy(step=None, app_def=app_def) == "ignore"

    def test_default_warn_when_nothing_set(self) -> None:
        assert resolve_schema_policy(step=None, app_def=None) == "warn"

    def test_task_row_fallback(self) -> None:
        task_row = {"schema_enforcement": "strict"}
        assert resolve_schema_policy(step=None, app_def=None, task_row=task_row) == "strict"

    def test_step_overrides_task_row(self) -> None:
        step = {"schema_enforcement": "warn"}
        task_row = {"schema_enforcement": "strict"}
        assert resolve_schema_policy(step=step, task_row=task_row) == "warn"

    def test_invalid_value_falls_through(self) -> None:
        step = {"schema_enforcement": "bogus"}
        app_def = {"schema_enforcement": "strict"}
        assert resolve_schema_policy(step=step, app_def=app_def) == "strict"

    def test_empty_string_treated_as_unset(self) -> None:
        step = {"schema_enforcement": ""}
        assert resolve_schema_policy(step=step) == "warn"

    def test_none_sources(self) -> None:
        assert resolve_schema_policy(step=None, app_def=None, task_row=None) == "warn"


class TestEnforceSchemaOnOutcome:
    """Tests for enforce_schema_on_outcome behavior."""

    def _valid_result(self) -> dict:
        return {
            "structured_output": {"name": "test"},
            "schema_valid": True,
            "schema_errors": [],
            "extraction_source": "fence",
        }

    def _invalid_result(self) -> dict:
        return {
            "structured_output": {"name": 123},
            "schema_valid": False,
            "schema_errors": ["name: expected string, got integer"],
            "extraction_source": "fence",
        }

    def test_strict_blocks_on_validation_failure(self) -> None:
        result = enforce_schema_on_outcome(
            outcome="completed",
            structured_result=self._invalid_result(),
            policy="strict",
            has_output_schema=True,
        )
        assert result["outcome"] == "failed"
        assert result["enforcement_action"] == "block"
        assert "expected string" in result["error"]

    def test_strict_passes_on_valid_output(self) -> None:
        result = enforce_schema_on_outcome(
            outcome="completed",
            structured_result=self._valid_result(),
            policy="strict",
            has_output_schema=True,
        )
        assert result["outcome"] == "completed"
        assert result["enforcement_action"] == "pass"

    def test_warn_preserves_outcome_on_failure(self) -> None:
        result = enforce_schema_on_outcome(
            outcome="completed",
            structured_result=self._invalid_result(),
            policy="warn",
            has_output_schema=True,
        )
        assert result["outcome"] == "completed"
        assert result["enforcement_action"] == "warn"

    def test_ignore_skips_validation(self) -> None:
        result = enforce_schema_on_outcome(
            outcome="completed",
            structured_result=self._invalid_result(),
            policy="ignore",
            has_output_schema=True,
        )
        assert result["outcome"] == "completed"
        assert result["enforcement_action"] == "pass"

    def test_no_schema_skips_enforcement(self) -> None:
        result = enforce_schema_on_outcome(
            outcome="completed",
            structured_result=self._invalid_result(),
            policy="strict",
            has_output_schema=False,
        )
        assert result["outcome"] == "completed"
        assert result["enforcement_action"] == "pass"

    def test_strict_does_not_rewrite_already_failed(self) -> None:
        """If outcome is already 'failed', strict should not change it."""
        result = enforce_schema_on_outcome(
            outcome="failed",
            structured_result=self._invalid_result(),
            policy="strict",
            has_output_schema=True,
        )
        assert result["outcome"] == "failed"
        assert result["enforcement_action"] == "block"

    def test_strict_blocks_cancelled_with_schema_failure(self) -> None:
        result = enforce_schema_on_outcome(
            outcome="cancelled",
            structured_result=self._invalid_result(),
            policy="strict",
            has_output_schema=True,
        )
        # cancelled is not in success set, so it stays as-is
        assert result["outcome"] == "cancelled"
        assert result["enforcement_action"] == "block"
