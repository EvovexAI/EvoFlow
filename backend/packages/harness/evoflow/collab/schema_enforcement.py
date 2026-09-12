"""Schema Enforcement Policy for workflow node output contracts.

Determines what happens when a step's ``structured_output`` fails validation
against its declared ``output_schema``.

## Policies

- ``strict``  – Schema validation failure **blocks** the subtask from completing.
  The outcome is rewritten to ``failed`` with a schema error, and downstream
  dependents are not dispatched.
- ``warn``    – Schema validation failure is recorded (``schema_valid=False``,
  ``schema_errors`` populated) but the subtask still completes. Downstream
  steps proceed. (Default for backward compat.)
- ``ignore``  – No schema validation is performed at all.

## Policy resolution

The policy is read from (in priority order):

1. The step's own ``schema_enforcement`` field (per-step override).
2. The App document's ``schema_enforcement`` field (app-level default).
3. ``"warn"`` (system default).

## Integration point

``enforce_schema_on_outcome`` is called from ``apply_subtask_outcome_report``
*after* structured output extraction + validation, but *before* the outcome is
persisted. When policy is ``strict`` and validation failed, it rewrites the
outcome to ``failed`` so downstream DAG logic naturally blocks.
"""

from __future__ import annotations

import logging
from typing import Any, Literal

logger = logging.getLogger(__name__)

SchemaPolicy = Literal["strict", "warn", "ignore"]

_VALID_POLICIES = frozenset({"strict", "warn", "ignore"})
_DEFAULT_POLICY: SchemaPolicy = "warn"


def resolve_schema_policy(
    *,
    step: dict[str, Any] | None = None,
    app_def: dict[str, Any] | None = None,
    task_row: dict[str, Any] | None = None,
) -> SchemaPolicy:
    """Resolve the effective schema enforcement policy.

    Priority: step.schema_enforcement > app_def.schema_enforcement > "warn".

    Args:
        step: The plan step dict (may carry ``schema_enforcement``).
        app_def: The App document (may carry ``schema_enforcement``).
        task_row: The main task row (may carry ``schema_enforcement`` stamped
            from the app at run creation time).

    Returns:
        One of ``"strict"``, ``"warn"``, ``"ignore"``.
    """
    for source in (step, app_def, task_row):
        if not isinstance(source, dict):
            continue
        raw = str(source.get("schema_enforcement") or "").strip().lower()
        if raw in _VALID_POLICIES:
            return raw  # type: ignore[return-value]
    return _DEFAULT_POLICY


def enforce_schema_on_outcome(
    *,
    outcome: str,
    structured_result: dict[str, Any],
    policy: SchemaPolicy,
    has_output_schema: bool,
) -> dict[str, Any]:
    """Apply schema enforcement policy to a subtask outcome.

    Called after ``process_step_output`` has extracted and validated the
    structured output. Returns a dict with possibly-overridden fields:

    - ``outcome``: The (possibly rewritten) terminal outcome.
    - ``error``: Error text to attach if blocked (empty string otherwise).
    - ``enforcement_action``: One of ``"pass"``, ``"warn"``, ``"block"``.
    - ``enforcement_reason``: Human-readable explanation.

    When ``policy == "strict"`` and the step declared an ``output_schema`` and
    validation failed (``schema_valid == False``), the outcome is rewritten to
    ``"failed"`` so the DAG naturally blocks downstream dispatch.

    Args:
        outcome: The original outcome from the worker (e.g. ``"completed"``).
        structured_result: The dict returned by ``process_step_output``.
        policy: The resolved schema enforcement policy.
        has_output_schema: Whether the step declared an ``output_schema``.
    """
    action = "pass"
    reason = ""
    final_outcome = outcome
    error_text = ""

    schema_valid = structured_result.get("schema_valid", True)
    schema_errors = structured_result.get("schema_errors") or []

    # Only enforce when there IS a schema to validate against
    if not has_output_schema:
        return {
            "outcome": final_outcome,
            "error": error_text,
            "enforcement_action": "pass",
            "enforcement_reason": "no output_schema declared; enforcement skipped",
        }

    if policy == "ignore":
        return {
            "outcome": final_outcome,
            "error": error_text,
            "enforcement_action": "pass",
            "enforcement_reason": "policy=ignore; validation skipped",
        }

    if schema_valid:
        return {
            "outcome": final_outcome,
            "error": error_text,
            "enforcement_action": "pass",
            "enforcement_reason": "schema validation passed",
        }

    # Schema validation FAILED
    error_detail = "; ".join(schema_errors[:5]) if schema_errors else "unknown schema error"

    if policy == "strict":
        # Block: rewrite outcome to failed
        if outcome in ("completed", "done", "success"):
            final_outcome = "failed"
            error_text = f"Schema enforcement (strict): output failed validation — {error_detail}"
            action = "block"
            reason = f"strict policy blocked completion: {error_detail}"
            logger.warning(
                "schema_enforcement: blocked subtask completion (strict) — errors=%s",
                error_detail,
            )
        else:
            # Already failing — just record the action
            action = "block"
            reason = f"strict policy: outcome already non-success, schema also failed: {error_detail}"
    else:
        # warn
        action = "warn"
        reason = f"warn policy: schema validation failed but outcome preserved — {error_detail}"
        logger.info(
            "schema_enforcement: warning (warn policy) — errors=%s",
            error_detail,
        )

    return {
        "outcome": final_outcome,
        "error": error_text,
        "enforcement_action": action,
        "enforcement_reason": reason,
    }


__all__ = [
    "SchemaPolicy",
    "resolve_schema_policy",
    "enforce_schema_on_outcome",
]
