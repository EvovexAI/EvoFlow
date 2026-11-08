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

import logging
from typing import Any

from evoflow.collab.expression_resolver import (
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

        # P0.5-3: Coerce then validate resolved bindings against input_schema
        input_schema = step.get("input_schema")
        type_errors: list[str] = []
        input_schema_valid = True
        if isinstance(input_schema, dict) and input_schema:
            _coerce_resolved_to_input_schema(resolved, input_schema)
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
                    binding_errors.append(
                        {
                            "code": "TYPE_MISMATCH",
                            "binding_key": te.split(":")[0] if ":" in te else "unknown",
                            "expression": "",
                            "message": te,
                            "detail": {"input_schema": input_schema},
                        }
                    )

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

    # 5. Structured output contract — without this, workers emit prose only and
    # downstream ``{{steps.X.output.field}}`` bindings stay unresolved.
    schema_block = format_output_schema_for_prompt(step.get("output_schema"))
    if schema_block:
        parts.append(f"\n{schema_block}")

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
        # F-2：结构化输出优先且给独立配额（此前与摘要共享 500 字上限，字段被截掉）
        if output:
            formatted = json_for_handoff_prompt(output, max_chars=2000)
            entry_lines.append(f"  输出（结构化，以此为准）: {formatted}")
        if summary:
            entry_lines.append(f"  摘要: {summary}")
        artifact_paths = [str(a.get("value") or "").strip() for a in artifacts if isinstance(a, dict) and str(a.get("value") or "").strip()]
        if artifact_paths:
            entry_lines.append("  产出路径:")
            for p in artifact_paths[:12]:
                entry_lines.append(f"    - `{p}`")
        lines.append("\n".join(entry_lines))
    return "\n".join(lines)


def _unwrap_schema_properties(input_schema: dict[str, Any]) -> dict[str, Any]:
    if isinstance(input_schema.get("properties"), dict):
        return input_schema["properties"]
    return input_schema


def _coerce_scalar_to_schema_type(value: Any, expected_type: str) -> Any:
    """Best-effort coerce wire strings (params are always str) into schema types."""
    if expected_type == "integer":
        if isinstance(value, bool):
            return value
        if isinstance(value, int):
            return value
        if isinstance(value, float) and value.is_integer():
            return int(value)
        if isinstance(value, str) and value.strip():
            try:
                return int(value.strip())
            except ValueError:
                return value
    elif expected_type == "number":
        if isinstance(value, bool):
            return value
        if isinstance(value, (int, float)):
            return value
        if isinstance(value, str) and value.strip():
            try:
                num = float(value.strip())
                return int(num) if num.is_integer() else num
            except ValueError:
                return value
    elif expected_type == "boolean":
        if isinstance(value, bool):
            return value
        if isinstance(value, str):
            low = value.strip().lower()
            if low in {"true", "1", "yes", "y"}:
                return True
            if low in {"false", "0", "no", "n"}:
                return False
    return value


def _coerce_resolved_to_input_schema(
    resolved: dict[str, Any],
    input_schema: dict[str, Any],
) -> None:
    """Mutate ``resolved`` so string params match declared input_schema types."""
    props = _unwrap_schema_properties(input_schema)
    _expr_re = __import__("re").compile(r"\{\{(.+?)\}\}")
    for key, value in list(resolved.items()):
        if isinstance(value, str) and _expr_re.search(value):
            continue
        schema_entry = props.get(key)
        if not isinstance(schema_entry, dict):
            continue
        expected_type = str(schema_entry.get("type") or "").strip().lower()
        if expected_type not in {"integer", "number", "boolean"}:
            continue
        resolved[key] = _coerce_scalar_to_schema_type(value, expected_type)


def format_output_schema_for_prompt(output_schema: Any) -> str:
    """Tell the worker exactly which JSON to return for downstream bindings.

    Used by both ``build_core_prompt`` (debug) and production
    ``_build_subtask_enriched_prompt`` — the latter must call this directly
    because it only cherry-picks resolved inputs from ``build_core_prompt``
    and would otherwise drop the contract block.
    """
    if not isinstance(output_schema, dict) or not output_schema:
        return ""
    import json

    props = output_schema.get("properties") if isinstance(output_schema.get("properties"), dict) else {}
    required = output_schema.get("required") if isinstance(output_schema.get("required"), list) else []
    lines = [
        "## 结构化产出契约（output_schema）",
        "本步骤必须产出符合下列 JSON Schema 的结构化结果，供下游 `{{steps.<ref>.output.<field>}}` 绑定使用。",
        "完成时请二选一（优先 1）：",
        "1. 调用 `done` 时传入 `structured_output=<完整 JSON 对象>`（必含全部必填字段）；或",
        "2. 在 `done.summary` 末尾附加一个 JSON 对象（可放在 ```json 代码块中）。",
        "仅写散文、不写 JSON → 本步会被判定未交付结构化产出，下游绑定失败。",
    ]
    try:
        schema_text = json.dumps(output_schema, ensure_ascii=False, indent=2)
    except (TypeError, ValueError):
        schema_text = str(output_schema)
    lines.append("```json")
    lines.append(schema_text)
    lines.append("```")
    if props:
        field_bits = []
        for name, spec in props.items():
            typ = ""
            if isinstance(spec, dict):
                typ = str(spec.get("type") or "").strip()
            req = "必填" if name in {str(x) for x in required} else "可选"
            field_bits.append(f"- `{name}` ({typ or 'any'}, {req})")
        if field_bits:
            lines.append("字段一览：")
            lines.extend(field_bits)
    return "\n".join(lines)


# Back-compat alias for private-name call sites / tests.
_format_output_schema_for_prompt = format_output_schema_for_prompt


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

    input_schema = _unwrap_schema_properties(input_schema)

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
    "format_output_schema_for_prompt",
]
