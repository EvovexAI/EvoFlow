"""Shared step prompt builder for unified Debug / Production prompt assembly.

P0.5-5: Eliminates the dual-track prompt assembly between ``debug_runner.py``
and ``execution.py`` by extracting the common core into a single function.

Both paths now call :func:`build_core_prompt` for the shared parts:
  1. Base description from step
  2. Goal context (optional)
  3. Resolved input_bindings (via ``expression_resolver``)
  4. Step metadata (goal, inputs, outputs, acceptance)

P0.5-2: The builder also detects unresolved ``{{...}}`` expressions after
binding resolution. In ``production`` mode, unresolved bindings are logged
and flagged on the result so the caller can decide to fail the subtask.
In ``debug`` mode, unresolved bindings are left as-is for inspection.
"""

from __future__ import annotations

import json
import logging
from typing import Any

from evoflow.collab.expression_resolver import (
    BindingError,
    detect_binding_errors,
    detect_unresolved_bindings,
    format_resolved_inputs_for_prompt,
    resolve_bindings,
    resolve_step_inputs,
)

logger = logging.getLogger(__name__)


def build_core_prompt(
    *,
    step: dict[str, Any],
    params: dict[str, str],
    steps_output: dict[str, dict[str, Any]] | None = None,
    subtasks: list[dict[str, Any]] | None = None,
    goal: str = "",
    mode: str = "production",
    subtask_row: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Build the core prompt for a workflow step, shared by debug and production.

    This function handles the *common* prompt assembly. Callers may add
    additional blocks (retry context, worker_profile, self-check, etc.)
    on top of the returned ``prompt``.

    Args:
        step: The plan step dict (carries ``input_bindings``, ``goal``, etc.).
        params: Run-time parameters.
        steps_output: Pre-built steps_output dict (debug mode uses mock data).
            If None, will be built from ``subtasks`` via ``resolve_step_inputs``.
        subtasks: Upstream subtask rows (production mode). Ignored if
            ``steps_output`` is provided.
        goal: Overall workflow goal text for context.
        mode: ``"production"`` or ``"debug"``. Controls unresolved binding
            behavior.
        subtask_row: The subtask row dict (production mode). If provided,
            ``_has_resolved_input_bindings`` and ``_has_unresolved_bindings``
            flags are set on it for the caller to read.

    Returns:
        A dict with:
        - ``prompt``: str – the assembled core prompt text.
        - ``resolved``: dict – resolved input_bindings.
        - ``has_bindings``: bool – whether the step had explicit input_bindings.
        - ``unresolved``: list[str] – warnings for unresolved bindings (human-readable).
        - ``unresolved_count``: int – number of unresolved bindings.
        - ``binding_errors``: list[dict] – structured binding errors with codes (for trace / dispatch gating).
        - ``input_schema_valid``: bool – whether resolved inputs pass input_schema type validation.
    """
    parts: list[str] = []

    # 1. Base description
    desc = str(step.get("description") or step.get("goal") or "").strip()
    if not desc:
        ref = step.get("ref", "?")
        desc = f"Step {ref}" if mode == "debug" else f"Complete step {ref}"
    parts.append(desc)

    # 2. Goal context
    if goal:
        parts.append(f"\n## 整体目标\n{goal}")

    # 3. Resolve input_bindings
    bindings = step.get("input_bindings")
    resolved: dict[str, Any] = {}
    has_bindings = False
    unresolved: list[str] = []
    binding_errors: list[dict[str, Any]] = []
    # Track the steps_output used (for structured error classification)
    _steps_output_used: dict[str, dict[str, Any]] = {}
    _subtasks_used: list[dict[str, Any]] | None = None

    if isinstance(bindings, dict) and bindings:
        has_bindings = True
        if steps_output is not None:
            # Debug path: use pre-built mock steps_output
            resolved = resolve_bindings(
                bindings,
                params=params,
                steps_output=steps_output,
            )
            _steps_output_used = steps_output
        elif subtasks is not None:
            # Production path: build steps_output from subtask rows
            resolve_result = resolve_step_inputs(
                step,
                params=params,
                subtasks=subtasks,
            )
            resolved = resolve_result["resolved"]
            _steps_output_used = resolve_result.get("steps_output", {})
            _subtasks_used = subtasks
        else:
            resolved = resolve_bindings(
                bindings,
                params=params,
                steps_output={},
            )

        # P0.5-2: Detect unresolved bindings (structured error codes)
        unresolved = detect_unresolved_bindings(resolved)
        if unresolved:
            from evoflow.collab.expression_resolver import detect_binding_errors

            structured_errors = detect_binding_errors(
                resolved,
                bindings=bindings,
                params=params,
                steps_output=_steps_output_used,
                subtasks=_subtasks_used,
            )
            binding_errors = [e.to_dict() for e in structured_errors]

        # P0.5-3: Validate resolved bindings against input_schema (type contract)
        input_schema = step.get("input_schema")
        type_errors: list[str] = []
        input_schema_valid = True
        if isinstance(input_schema, dict) and input_schema:
            type_errors = _validate_input_types(resolved, input_schema)
            if type_errors:
                input_schema_valid = False
                if mode == "production":
                    logger.warning(
                        "build_core_prompt: %d type errors in step ref=%s: %s",
                        len(type_errors),
                        step.get("ref"),
                        "; ".join(type_errors),
                    )
                unresolved.extend(type_errors)
                # Add TYPE_MISMATCH errors to structured list
                for te in type_errors:
                    binding_errors.append({
                        "code": "TYPE_MISMATCH",
                        "binding_key": te.split(":")[0] if ":" in te else "unknown",
                        "expression": "",
                        "message": te,
                        "detail": {"input_schema": input_schema},
                    })

        if unresolved:
            if mode == "production":
                logger.warning(
                    "build_core_prompt: %d unresolved bindings in step ref=%s: %s",
                    len(unresolved),
                    step.get("ref"),
                    "; ".join(unresolved),
                )
                if subtask_row is not None:
                    subtask_row["_has_unresolved_bindings"] = True
                    subtask_row["_unresolved_binding_warnings"] = unresolved
            else:
                # Debug mode: log for visibility but don't flag
                logger.info(
                    "build_core_prompt (debug): %d unresolved bindings in step ref=%s",
                    len(unresolved),
                    step.get("ref"),
                )

        inputs_block = format_resolved_inputs_for_prompt(resolved)
        if inputs_block:
            parts.append(f"\n{inputs_block}")

        # Signal caller that bindings were resolved (skip legacy fallback)
        if subtask_row is not None and not unresolved:
            subtask_row["_has_resolved_input_bindings"] = True
    else:
        # No explicit bindings: inject upstream summaries as context
        if steps_output is not None:
            # Debug path: inject mock upstream data
            mock_ctx = _format_upstream_context(steps_output, label="Mock 数据")
            if mock_ctx:
                parts.append(f"\n## 上游步骤输出（Mock 数据）\n{mock_ctx}")

    # 4. Step metadata
    for label, key in [
        ("步骤目标", "goal"),
        ("输入说明", "inputs"),
        ("期望产出", "outputs"),
        ("验收标准", "acceptance"),
    ]:
        val = str(step.get(key) or "").strip()
        if val:
            parts.append(f"\n**{label}**: {val}")

    prompt = "\n".join(parts)

    return {
        "prompt": prompt,
        "resolved": resolved,
        "has_bindings": has_bindings,
        "unresolved": unresolved,
        "unresolved_count": len(unresolved),
        "binding_errors": binding_errors,
        "input_schema_valid": input_schema_valid if has_bindings else True,
    }


def _format_upstream_context(
    steps_output: dict[str, dict[str, Any]],
    *,
    label: str = "上游步骤输出",
    max_summary_len: int = 500,
) -> str:
    """Format upstream step outputs as a readable context block.

    Used when a step has no explicit input_bindings – all upstream
    outputs are injected as context (legacy fallback behavior).
    """
    if not steps_output:
        return ""
    from evoflow.collab.workflow_handoff_sanitize import (
        json_for_handoff_prompt,
        sanitize_string_for_handoff,
    )

    lines: list[str] = [
        f"## {label}",
        "（大文件/图片仅传路径引用；请 read 工作区文件，勿假定 base64 已在上下文中。）",
    ]
    for ref, data in steps_output.items():
        summary = sanitize_string_for_handoff(
            str(data.get("summary") or "").strip(),
            max_summary_len,
        )
        output = data.get("output") or {}
        artifacts = data.get("artifacts") if isinstance(data.get("artifacts"), list) else []
        entry_lines = [f"- 上游步骤 #{ref}:"]
        if summary:
            entry_lines.append(f"  摘要: {summary}")
        artifact_paths = [
            str(a.get("value") or "").strip()
            for a in artifacts
            if isinstance(a, dict) and str(a.get("value") or "").strip()
        ]
        if artifact_paths:
            entry_lines.append("  产出路径:")
            for p in artifact_paths[:12]:
                entry_lines.append(f"    - `{p}`")
        if output:
            formatted = json_for_handoff_prompt(output, max_chars=max_summary_len)
            entry_lines.append(f"  输出: {formatted}")
        lines.append("\n".join(entry_lines))
    return "\n".join(lines)


def _validate_input_types(
    resolved: dict[str, Any],
    input_schema: dict[str, Any],
) -> list[str]:
    """Validate resolved binding values against an input_schema type contract.

    The ``input_schema`` can be either:

    1. A flat dict mapping binding names to type declarations::

        {
            "companies": {"type": "array"},
            "max_count": {"type": "integer"},
            "name": {"type": "string"}
        }

    2. A JSON Schema object with ``properties``::

        {
            "type": "object",
            "properties": {
                "companies": {"type": "array"},
                "max_count": {"type": "integer"}
            }
        }

    Returns a list of error messages for type mismatches. Empty list = OK.

    Only basic type checking is performed (no full JSON Schema validation).
    Unresolved bindings (still containing ``{{...}}``) are skipped – they're
    already flagged by :func:`detect_unresolved_bindings`.
    """
    errors: list[str] = []
    _expr_re = __import__("re").compile(r"\{\{(.+?)\}\}")

    # Unwrap JSON Schema {type: "object", properties: {...}} to flat dict
    if isinstance(input_schema.get("properties"), dict):
        input_schema = input_schema["properties"]

    type_map = {
        "string": str,
        "integer": int,
        "number": (int, float),
        "boolean": bool,
        "array": list,
        "object": dict,
        "null": type(None),
    }

    for key, value in resolved.items():
        # Skip unresolved bindings (still have {{...}})
        if isinstance(value, str) and _expr_re.search(value):
            continue

        schema_entry = input_schema.get(key)
        if not isinstance(schema_entry, dict):
            continue

        expected_type = str(schema_entry.get("type") or "").strip().lower()
        if not expected_type or expected_type not in type_map:
            continue

        expected = type_map[expected_type]

        # Special case: bool is subclass of int in Python
        if expected_type == "integer" and isinstance(value, bool):
            errors.append(f"{key}: expected integer, got boolean")
        elif expected_type == "number" and isinstance(value, bool):
            errors.append(f"{key}: expected number, got boolean")
        elif not isinstance(value, expected):
            actual = type(value).__name__
            errors.append(f"{key}: expected {expected_type}, got {actual}")

    return errors


__all__ = [
    "build_core_prompt",
]
