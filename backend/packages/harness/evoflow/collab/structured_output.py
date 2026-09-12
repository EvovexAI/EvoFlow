"""Structured output extraction and JSON Schema validation for workflow steps.

When a step declares ``output_schema`` (JSON Schema), the workflow engine:

1. Extracts a structured JSON object from the worker's final response
2. Validates it against the schema
3. Stores it as ``structured_output`` on the subtask row
4. Makes it available for downstream ``input_bindings`` resolution

Extraction strategy (in priority order):
    a. ``structured_output`` parameter on ``subtask_outcome_report`` (explicit)
    b. JSON code block in ``task_report`` / ``summary`` (`` ```json ... ``` ``)
    c. Trailing JSON object after the summary text
    d. None (no structured output; step only has text summary)

Validation:
    - Uses ``jsonschema`` library if available; otherwise basic type checking
    - On validation failure, records ``schema_valid=False`` and ``schema_errors``
    - Does NOT block the subtask from completing (caller decides retry policy)
"""

from __future__ import annotations

import json
import logging
import re
from typing import Any

logger = logging.getLogger(__name__)

# Regex: find ```json ... ``` fenced code blocks
_JSON_FENCE_RE = re.compile(r"```(?:json)?\s*\n([\s\S]*?)\n```", re.IGNORECASE)

# Regex: find a bare JSON object/array at end of text
_TRAILING_JSON_RE = re.compile(r"([\[{][\s\S]*[\]}])\s*$")


def _extract_trailing_json(text: str) -> tuple[dict[str, Any] | list, str] | None:
    """Find the shortest valid JSON object/array at the end of ``text``.

    Uses balanced bracket scanning: starts from the last ``}`` or ``]``,
    walks backward to find the matching opener, then tries to parse.
    """
    text = text.rstrip()
    if not text:
        return None

    closers = {"}": "{", "]": "["}
    # Find the last closing bracket
    for end_idx in range(len(text) - 1, -1, -1):
        if text[end_idx] not in closers:
            continue
        closer = text[end_idx]
        opener = closers[closer]
        # Scan backward to find balanced opener
        depth = 1
        start_idx = end_idx - 1
        while start_idx >= 0 and depth > 0:
            ch = text[start_idx]
            if ch == closer:
                depth += 1
            elif ch == opener:
                depth -= 1
            start_idx -= 1
        if depth != 0:
            continue
        candidate = text[start_idx + 1 : end_idx + 1].strip()
        parsed = _try_parse_json(candidate)
        if isinstance(parsed, dict):
            return parsed, "trailing"
        if isinstance(parsed, list):
            return {"items": parsed}, "trailing"
        # This bracket pair didn't yield valid JSON; continue looking
    return None


def extract_structured_output(
    text: str | None,
    *,
    explicit: Any = None,
) -> tuple[dict[str, Any] | None, str]:
    """Extract a structured JSON dict from worker output.

    Args:
        text: The task_report / summary text from the worker.
        explicit: Explicit ``structured_output`` parameter if the worker
            passed one directly (dict or JSON string).

    Returns:
        (structured_output or None, extraction_source)
        extraction_source is one of: "explicit", "fence", "trailing", "none"
    """
    # Priority 1: explicit parameter
    if explicit is not None:
        parsed = _coerce_json(explicit)
        if isinstance(parsed, dict):
            return parsed, "explicit"
        if isinstance(parsed, list):
            # Wrap arrays in a standard key
            return {"items": parsed}, "explicit"

    if not text:
        return None, "none"

    text_stripped = text.strip()

    # Priority 2: fenced JSON code block
    for m in _JSON_FENCE_RE.finditer(text_stripped):
        candidate = m.group(1).strip()
        parsed = _try_parse_json(candidate)
        if isinstance(parsed, dict):
            return parsed, "fence"
        if isinstance(parsed, list):
            return {"items": parsed}, "fence"

    # Priority 3: trailing JSON object/array
    # Find shortest valid JSON suffix using balanced bracket scanning
    result = _extract_trailing_json(text_stripped)
    if result is not None:
        parsed, source = result
        return parsed, source

    return None, "none"


def _coerce_json(value: Any) -> Any:
    """Coerce a value to parsed JSON (accepts dict, list, or JSON string)."""
    if isinstance(value, (dict, list)):
        return value
    if isinstance(value, str):
        return _try_parse_json(value.strip())
    return None


def _try_parse_json(text: str) -> Any:
    """Try to parse JSON; return None on failure."""
    if not text:
        return None
    try:
        return json.loads(text)
    except (json.JSONDecodeError, TypeError):
        return None


def validate_against_schema(
    data: Any,
    schema: dict[str, Any] | None,
) -> tuple[bool, list[str]]:
    """Validate ``data`` against a JSON Schema.

    Returns:
        (is_valid, error_messages)
        If schema is None, always returns (True, []).
    """
    if not schema:
        return True, []

    if not isinstance(schema, dict):
        return False, ["Schema is not a valid dict"]

    errors: list[str] = []

    # Try jsonschema library first (full validation)
    try:
        import jsonschema

        validator = jsonschema.Draft7Validator(schema)
        for error in validator.iter_errors(data):
            field_path = ".".join(str(p) for p in error.absolute_path) or "(root)"
            errors.append(f"{field_path}: {error.message}")
        return len(errors) == 0, errors
    except ImportError:
        pass

    # Fallback: basic type validation
    return _basic_validate(data, schema, errors, path="")


def _basic_validate(
    data: Any,
    schema: dict[str, Any],
    errors: list[str],
    *,
    path: str,
) -> tuple[bool, list[str]]:
    """Minimal fallback validation when jsonschema is not installed."""
    schema_type = schema.get("type")

    if schema_type:
        type_map = {
            "string": str,
            "integer": int,
            "number": (int, float),
            "boolean": bool,
            "array": list,
            "object": dict,
            "null": type(None),
        }
        expected = type_map.get(schema_type)
        if expected and not isinstance(data, expected):
            # Special case: bool is subclass of int in Python
            if schema_type == "integer" and isinstance(data, bool):
                errors.append(f"{path or '(root)'}: expected integer, got boolean")
            elif schema_type == "number" and isinstance(data, bool):
                errors.append(f"{path or '(root)'}: expected number, got boolean")
            else:
                errors.append(f"{path or '(root)'}: expected {schema_type}, got {type(data).__name__}")
                return len(errors) == 0, errors

    if schema_type == "object" and isinstance(data, dict):
        required = schema.get("required", [])
        for req in required:
            if req not in data:
                errors.append(f"{path or '(root)'}: missing required property '{req}'")

        properties = schema.get("properties", {})
        for key, value in data.items():
            if key in properties:
                _basic_validate(value, properties[key], errors, path=f"{path}.{key}" if path else key)

    if schema_type == "array" and isinstance(data, list):
        items_schema = schema.get("items")
        if items_schema:
            for i, item in enumerate(data):
                _basic_validate(item, items_schema, errors, path=f"{path}[{i}]")

    return len(errors) == 0, errors


def process_step_output(
    task_report: str,
    output_schema: dict[str, Any] | None,
    *,
    explicit_structured_output: Any = None,
) -> dict[str, Any]:
    """Full pipeline: extract + validate structured output from a step result.

    Returns a dict with:
        - ``structured_output``: dict or None
        - ``schema_valid``: bool (True if no schema or validation passed)
        - ``schema_errors``: list[str]
        - ``extraction_source``: str
    """
    structured, source = extract_structured_output(
        task_report,
        explicit=explicit_structured_output,
    )

    if structured is None:
        return {
            "structured_output": None,
            "schema_valid": True,  # No structured output = vacuously valid
            "schema_errors": [],
            "extraction_source": "none",
        }

    if output_schema:
        is_valid, errors = validate_against_schema(structured, output_schema)
        return {
            "structured_output": structured,
            "schema_valid": is_valid,
            "schema_errors": errors,
            "extraction_source": source,
        }

    # No schema declared but structured output was extracted - store it anyway
    return {
        "structured_output": structured,
        "schema_valid": True,
        "schema_errors": [],
        "extraction_source": source,
    }


def get_step_output_schema(
    subtask: dict[str, Any],
    *,
    plan_steps: list[dict[str, Any]] | None = None,
) -> dict[str, Any] | None:
    """Look up the output_schema for a subtask's step from plan_steps.

    Falls back to None if not found (legacy steps without schema).
    """
    # Direct on subtask (if synced during dispatch)
    schema = subtask.get("output_schema")
    if isinstance(schema, dict) and schema:
        return schema

    # Look up from plan_steps by ref
    ref = str(subtask.get("ref") or "").strip()
    if ref and plan_steps:
        for step in plan_steps:
            if isinstance(step, dict) and str(step.get("ref") or "").strip() == ref:
                schema = step.get("output_schema")
                if isinstance(schema, dict) and schema:
                    return schema
    return None


__all__ = [
    "extract_structured_output",
    "validate_against_schema",
    "process_step_output",
    "get_step_output_schema",
]
