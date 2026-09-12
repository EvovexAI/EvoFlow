"""Expression resolver for workflow node input bindings.

Parses and resolves reference expressions like::

    {{params.topic}}
    {{steps.1.output.companies}}
    {{steps.2.summary}}
    {{steps.1.artifacts[0].path}}
    {{steps.1.artifacts.report.path}}

Supported sources:
    - ``params``   – run-time parameters filled by the user / API
    - ``steps``    – upstream step results: ``.output`` (structured), ``.summary`` (text), ``.artifacts``
    - ``trigger``  – trigger metadata (reserved for future use)
    - ``env``      – environment variables (reserved for future use)

Design rules:
    - If the entire string is a single ``{{expr}}``, the raw resolved value is
      returned (dict / list / number / bool), enabling structured data binding.
    - If the string mixes literal text with one or more expressions, string
      interpolation is performed (all values coerced to ``str``).
    - Unresolvable expressions are left as-is (``{{steps.5.output.x}}``) so the
      downstream Agent can see the missing reference – this is intentional for
      debugging.
    - Array indexing: ``[0]``, ``[1]`` etc. on arrays; ``artifacts.KEY`` for
      keyed access when artifacts are stored as a dict.
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass
from typing import Any, Literal

logger = logging.getLogger(__name__)

# ── Expression parsing ──────────────────────────────────────────────────

# Matches {{ ... }} – content is the expression path
_EXPR_RE = re.compile(r"\{\{(.+?)\}\}")

# Matches array index [N] within a path segment
_INDEX_RE = re.compile(r"^(.+?)\[(\d+)\]$")

# Top-level sources we recognise
_KNOWN_SOURCES = frozenset({"params", "steps", "trigger", "env"})


def _split_path(expr: str) -> list[str]:
    """Split 'steps.1.output.companies[0].name' into ['steps', '1', 'output', 'companies', '[0]', 'name'].

    Array indices like ``[0]`` are kept as standalone segments so they can be
    applied during traversal.
    """
    segments: list[str] = []
    for part in expr.strip().split("."):
        if not part:
            continue
        # Check for array index suffix:  companies[0] -> ['companies', '[0]']
        m = _INDEX_RE.match(part)
        if m:
            segments.append(m.group(1))
            segments.append(f"[{m.group(2)}]")
        elif part.startswith("[") and part.endswith("]"):
            # Already a standalone index segment
            segments.append(part)
        else:
            segments.append(part)
    return segments


def _traverse(root: Any, segments: list[str]) -> tuple[bool, Any]:
    """Walk ``root`` following ``segments``.  Returns ``(found, value)``."""
    if root is None and segments:
        return False, None
    current = root
    for seg in segments:
        if seg.startswith("[") and seg.endswith("]"):
            # Array index
            try:
                idx = int(seg[1:-1])
            except ValueError:
                return False, None
            if isinstance(current, list) and 0 <= idx < len(current):
                current = current[idx]
            else:
                return False, None
        elif isinstance(current, dict):
            if seg in current:
                current = current[seg]
            else:
                return False, None
        elif isinstance(current, list):
            # Allow numeric string key on lists: "1" -> index 1
            try:
                idx = int(seg)
            except ValueError:
                return False, None
            if 0 <= idx < len(current):
                current = current[idx]
            else:
                return False, None
        else:
            return False, None
    return True, current


def _resolve_single(
    expr: str,
    *,
    params: dict[str, str],
    steps_output: dict[str, dict[str, Any]],
    env: dict[str, str] | None = None,
    trigger: dict[str, Any] | None = None,
) -> tuple[bool, Any]:
    """Resolve one expression path. Returns ``(found, value)``."""
    segments = _split_path(expr)
    if not segments:
        return False, None

    source = segments[0]
    rest = segments[1:]

    if source == "params":
        return _traverse(params, rest)
    elif source == "steps":
        # steps.{ref}.{field...}  field is output / summary / artifacts
        if not rest:
            return False, None
        ref = rest[0]
        step_data = steps_output.get(ref)
        if step_data is None:
            return False, None
        if len(rest) == 1:
            # Just the step root – return everything
            return True, step_data
        return _traverse(step_data, rest[1:])
    elif source == "env" and env is not None:
        return _traverse(env, rest)
    elif source == "trigger" and trigger is not None:
        return _traverse(trigger, rest)
    else:
        # Unknown source – try params as fallback for bare {{name}}
        # (backward compat with simple {{topic}} style)
        if source in params:
            return True, params[source]
        return False, None


def resolve_expression(
    expr_string: str,
    *,
    params: dict[str, str] | None = None,
    steps_output: dict[str, dict[str, Any]] | None = None,
    env: dict[str, str] | None = None,
    trigger: dict[str, Any] | None = None,
) -> Any:
    """Resolve expressions in ``expr_string``.

    - If the entire string is a single ``{{expr}}``, returns the raw resolved
      value (dict / list / number / etc.).
    - If the string contains literal text mixed with expressions, returns a
      string with all expressions substituted.
    - Unresolvable expressions are left as ``{{expr}}`` in the output.
    """
    params = params or {}
    steps_output = steps_output or {}

    if expr_string is None:
        return ""
    if not isinstance(expr_string, str):
        expr_string = str(expr_string)
    if not expr_string.strip():
        return expr_string

    matches = list(_EXPR_RE.finditer(expr_string))
    if not matches:
        return expr_string

    # Single expression covering the entire string -> return raw value
    if len(matches) == 1 and matches[0].group(0) == expr_string.strip():
        inner = matches[0].group(1).strip()
        found, value = _resolve_single(
            inner,
            params=params,
            steps_output=steps_output,
            env=env,
            trigger=trigger,
        )
        if found:
            from evoflow.collab.workflow_handoff_sanitize import sanitize_value_for_handoff

            return sanitize_value_for_handoff(value)
        # Unresolvable – return original
        return expr_string

    # Multiple expressions or mixed text -> string interpolation
    def _replace(match: re.Match[str]) -> str:
        inner = match.group(1).strip()
        found, value = _resolve_single(
            inner,
            params=params,
            steps_output=steps_output,
            env=env,
            trigger=trigger,
        )
        if not found:
            return match.group(0)  # Leave as-is
        if value is None:
            return ""
        if isinstance(value, (dict, list)):
            import json

            try:
                return json.dumps(value, ensure_ascii=False)
            except (TypeError, ValueError):
                return str(value)
        return str(value)

    return _EXPR_RE.sub(_replace, expr_string)


def resolve_bindings(
    bindings: dict[str, str] | None,
    *,
    params: dict[str, str] | None = None,
    steps_output: dict[str, dict[str, Any]] | None = None,
    env: dict[str, str] | None = None,
    trigger: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Resolve all ``input_bindings`` into a ``{var_name: resolved_value}`` dict.

    If ``bindings`` is None or empty, returns an empty dict (caller should
    then fall back to legacy behavior of injecting all upstream summaries).
    """
    if not bindings:
        return {}
    resolved: dict[str, Any] = {}
    from evoflow.collab.workflow_handoff_sanitize import sanitize_resolved_bindings

    for key, expr in bindings.items():
        if expr is None or (isinstance(expr, str) and not expr.strip()):
            resolved[key] = "" if expr is None else expr
            continue
        resolved[key] = resolve_expression(
            expr,
            params=params,
            steps_output=steps_output,
            env=env,
            trigger=trigger,
        )
    return sanitize_resolved_bindings(resolved)


# ── Helpers: build steps_output from subtask rows ──────────────────────


def build_steps_output_from_subtasks(
    subtasks: list[dict[str, Any]],
) -> dict[str, dict[str, Any]]:
    """Convert a list of subtask row dicts into the ``steps_output`` format.

    Each entry becomes::

        {
            "ref": {
                "output": <structured_output dict or {}>,
                "summary": "<result_summary text>",
                "artifacts": [{type, key, value, label?}, ...]  # or {} if keyed
            }
        }
    """
    from evoflow.collab.task_outputs import normalize_task_outputs

    out: dict[str, dict[str, Any]] = {}
    for st in subtasks:
        if not isinstance(st, dict):
            continue
        ref = str(st.get("ref") or "").strip()
        if not ref:
            continue
        status = str(st.get("status") or "").strip().lower()
        # Only include completed steps (their output is usable)
        if status not in ("completed", "done", "success", "skipped"):
            continue

        # Structured output (new field, may be absent on legacy subtasks)
        structured = st.get("structured_output")
        if isinstance(structured, str):
            import json

            try:
                structured = json.loads(structured)
            except (json.JSONDecodeError, TypeError):
                structured = {}
        elif not isinstance(structured, dict):
            structured = {}

        # Summary text
        summary = ""
        for key in ("task_report", "result_summary", "result_text", "result", "summary"):
            val = str(st.get(key) or "").strip()
            if val:
                summary = val
                break

        # Artifacts – use the existing task_outputs normalizer
        artifacts_raw = st.get("outputs")
        artifacts_list = normalize_task_outputs(artifacts_raw)

        # Also build a keyed dict for {{steps.N.artifacts.KEY.path}} access
        artifacts_keyed: dict[str, dict[str, str]] = {}
        for item in artifacts_list:
            item_key = str(item.get("key") or "").strip()
            if item_key:
                artifacts_keyed[item_key] = item

        from evoflow.collab.workflow_handoff_sanitize import sanitize_steps_output_entry

        out[ref] = sanitize_steps_output_entry(
            {
                "output": structured,
                "summary": summary,
                "artifacts": artifacts_list,
                "artifacts_keyed": artifacts_keyed,
            }
        )
    return out


def resolve_step_inputs(
    step: dict[str, Any],
    *,
    params: dict[str, str],
    subtasks: list[dict[str, Any]],
    env: dict[str, str] | None = None,
) -> dict[str, Any]:
    """High-level helper: resolve a step's input_bindings against upstream subtask results.

    Returns a dict with:
        - ``resolved``: {var_name: value} from input_bindings (empty if none)
        - ``has_bindings``: bool – whether this step has explicit input_bindings
        - ``steps_output``: the built steps_output dict (for debugging / trace)
    """
    bindings = step.get("input_bindings")
    if not isinstance(bindings, dict) or not bindings:
        return {"resolved": {}, "has_bindings": False, "steps_output": {}}

    steps_output = build_steps_output_from_subtasks(subtasks)
    resolved = resolve_bindings(
        bindings,
        params=params,
        steps_output=steps_output,
        env=env,
    )
    return {
        "resolved": resolved,
        "has_bindings": True,
        "steps_output": steps_output,
    }


# ── Helpers: format resolved inputs for Agent prompt injection ──────────


def format_resolved_inputs_for_prompt(resolved: dict[str, Any]) -> str:
    """Format resolved input_bindings as a readable block for Agent prompt.

    Example output::

        ## 输入数据（显式绑定）
        - companies: [{"name": "OpenAI", "domain": "openai.com"}]
        - max_count: 5
    """
    if not resolved:
        return ""
    from evoflow.collab.workflow_handoff_sanitize import (
        json_for_handoff_prompt,
        sanitize_resolved_bindings,
        sanitize_string_for_handoff,
    )

    safe = sanitize_resolved_bindings(resolved)
    lines = ["## 输入数据（显式绑定）"]
    lines.append("（大文件/图片仅传路径引用；请 read 工作区文件，勿假定 base64 已在上下文中。）")
    for key, value in safe.items():
        if isinstance(value, (dict, list)):
            formatted = json_for_handoff_prompt(value)
            lines.append(f"- **{key}**:\n```json\n{formatted}\n```")
        elif value is None:
            lines.append(f"- **{key}**: (未解析)")
        else:
            lines.append(f"- **{key}**: {sanitize_string_for_handoff(str(value), 1500)}")
    return "\n".join(lines)


def detect_unresolved_bindings(resolved: dict[str, Any]) -> list[str]:
    """Detect unresolved ``{{...}}`` expressions in a resolved bindings dict.

    After :func:`resolve_bindings`, values that couldn't be resolved retain
    their original ``{{expr}}`` syntax. This function scans the resolved dict
    and returns a list of human-readable warnings for each unresolved binding.

    Args:
        resolved: The output of :func:`resolve_bindings` or
            ``resolve_step_inputs["resolved"]``.

    Returns:
        A list of warning strings, e.g.
        ``["companies: unresolved {{steps.5.output.companies}}"]``.
        Empty list if all bindings resolved successfully.
    """
    warnings: list[str] = []
    for key, value in resolved.items():
        if isinstance(value, str) and _EXPR_RE.search(value):
            # Find all unresolved expressions in this value
            matches = _EXPR_RE.findall(value)
            for match in matches:
                expr = match.strip()
                warnings.append(f"{key}: unresolved {{{{{expr}}}}}")
    return warnings


# ── Structured resolution errors (P0.5 Final Closure) ──────────────────

# Machine-readable error codes for binding resolution failures.
# These enable trace data and production dispatch gates to distinguish
# *why* a binding failed, not just that it did.
BindingErrorCode = Literal[
    "UNKNOWN_PARAM",           # {{params.foo}} but foo is not a declared parameter
    "UNKNOWN_STEP",            # {{steps.5.output.x}} but step ref "5" doesn't exist
    "UNKNOWN_OUTPUT_FIELD",    # {{steps.1.output.companies}} but "companies" not in output
    "UPSTREAM_NOT_COMPLETED",  # {{steps.2.output.x}} but step 2 hasn't completed yet
    "UPSTREAM_SCHEMA_INVALID", # upstream completed but schema_valid=False
    "UNRESOLVED_BINDING",      # Generic: expression left as {{...}} for unknown reason
    "INVALID_EXPRESSION",      # Malformed expression (e.g. empty, unparseable)
    "TYPE_MISMATCH",           # Resolved value type doesn't match input_schema declaration
]


@dataclass
class BindingError:
    """Structured binding resolution error for trace / dispatch gating."""

    code: str  # BindingErrorCode
    binding_key: str  # The input_bindings key that failed
    expression: str  # The original {{expr}} that couldn't resolve
    message: str  # Human-readable detail
    detail: dict[str, Any] | None = None  # Extra context (step ref, param name, etc.)

    def to_dict(self) -> dict[str, Any]:
        return {
            "code": self.code,
            "binding_key": self.binding_key,
            "expression": self.expression,
            "message": self.message,
            "detail": self.detail or {},
        }

    def __str__(self) -> str:
        return f"{self.binding_key}: [{self.code}] {self.message}"


def _classify_resolution_failure(
    expr: str,
    *,
    binding_key: str,
    params: dict[str, str],
    steps_output: dict[str, dict[str, Any]],
    subtasks: list[dict[str, Any]] | None = None,
) -> BindingError:
    """Classify why a single {{expr}} couldn't resolve into a structured error.

    Examines the expression path and available data to determine the most
    specific error code.
    """
    # Strip {{ }} wrapper if present (caller may pass wrapped or unwrapped)
    expr_inner = expr.strip()
    if expr_inner.startswith("{{") and expr_inner.endswith("}}"):
        expr_inner = expr_inner[2:-2].strip()
    segments = _split_path(expr_inner)
    if not segments:
        return BindingError(
            code="INVALID_EXPRESSION",
            binding_key=binding_key,
            expression=expr,
            message=f"Empty or unparseable expression: {expr}",
        )

    source = segments[0]

    if source == "params":
        if len(segments) < 2:
            return BindingError(
                code="INVALID_EXPRESSION",
                binding_key=binding_key,
                expression=expr,
                message=f"Parameter reference missing name: {expr}",
            )
        param_name = segments[1]
        if param_name not in params:
            return BindingError(
                code="UNKNOWN_PARAM",
                binding_key=binding_key,
                expression=expr,
                message=f"Parameter '{param_name}' is not declared or not provided",
                detail={"param_name": param_name},
            )
        # Param exists but deeper path failed
        return BindingError(
            code="UNRESOLVED_BINDING",
            binding_key=binding_key,
            expression=expr,
            message=f"Parameter '{param_name}' exists but path '{'.'.join(segments[1:])}' not found",
            detail={"param_name": param_name, "path": segments[1:]},
        )

    if source == "steps":
        if len(segments) < 2:
            return BindingError(
                code="INVALID_EXPRESSION",
                binding_key=binding_key,
                expression=expr,
                message=f"Step reference missing ref number: {expr}",
            )
        step_ref = segments[1]
        if step_ref not in steps_output:
            # Check if the step exists but hasn't completed
            if subtasks:
                matching = [s for s in subtasks if str(s.get("ref") or "").strip() == step_ref]
                if matching:
                    st = matching[0]
                    status = str(st.get("status") or "").strip().lower()
                    if status not in ("completed", "done", "success"):
                        return BindingError(
                            code="UPSTREAM_NOT_COMPLETED",
                            binding_key=binding_key,
                            expression=expr,
                            message=f"Upstream step {step_ref} has not completed (status: {status})",
                            detail={"step_ref": step_ref, "upstream_status": status},
                        )
                    # Completed but not in steps_output = schema invalid or no structured output
                    schema_valid = st.get("schema_valid")
                    if schema_valid is False:
                        return BindingError(
                            code="UPSTREAM_SCHEMA_INVALID",
                            binding_key=binding_key,
                            expression=expr,
                            message=f"Upstream step {step_ref} completed but output schema validation failed",
                            detail={"step_ref": step_ref, "schema_valid": False},
                        )
            return BindingError(
                code="UNKNOWN_STEP",
                binding_key=binding_key,
                expression=expr,
                message=f"Step ref '{step_ref}' does not exist in the workflow",
                detail={"step_ref": step_ref},
            )
        # Step exists in steps_output but deeper path failed
        if len(segments) >= 3 and segments[2] == "output":
            field_name = segments[3] if len(segments) > 3 else ""
            return BindingError(
                code="UNKNOWN_OUTPUT_FIELD",
                binding_key=binding_key,
                expression=expr,
                message=f"Step {step_ref} output does not contain field '{field_name}'",
                detail={"step_ref": step_ref, "field": field_name},
            )
        return BindingError(
            code="UNRESOLVED_BINDING",
            binding_key=binding_key,
            expression=expr,
            message=f"Step {step_ref} exists but path '{'.'.join(segments[2:])}' not found",
            detail={"step_ref": step_ref, "path": segments[2:]},
        )

    # Unknown source (not params/steps/env/trigger)
    # Check if it's a bare param name (backward compat)
    if source in params:
        return BindingError(
            code="UNRESOLVED_BINDING",
            binding_key=binding_key,
            expression=expr,
            message=f"Parameter '{source}' exists but expression path is incomplete",
            detail={"source": source},
        )

    return BindingError(
        code="INVALID_EXPRESSION",
        binding_key=binding_key,
        expression=expr,
        message=f"Unknown expression source '{source}' in: {expr}",
        detail={"source": source},
    )


def detect_binding_errors(
    resolved: dict[str, Any],
    *,
    bindings: dict[str, str] | None = None,
    params: dict[str, str] | None = None,
    steps_output: dict[str, dict[str, Any]] | None = None,
    subtasks: list[dict[str, Any]] | None = None,
) -> list[BindingError]:
    """Detect and classify all binding resolution failures with structured error codes.

    This is the structured-error counterpart to :func:`detect_unresolved_bindings`.
    It returns :class:`BindingError` objects with machine-readable codes.

    Args:
        resolved: The output of :func:`resolve_bindings`.
        bindings: The original input_bindings dict (for re-classification context).
        params: Run-time parameters (for UNKNOWN_PARAM classification).
        steps_output: Built steps_output dict (for UNKNOWN_STEP classification).
        subtasks: Raw subtask rows (for UPSTREAM_NOT_COMPLETED classification).

    Returns:
        List of BindingError objects. Empty list if all bindings resolved.
    """
    errors: list[BindingError] = []
    params = params or {}
    steps_output = steps_output or {}
    for key, value in resolved.items():
        if isinstance(value, str) and _EXPR_RE.search(value):
            matches = _EXPR_RE.findall(value)
            for match in matches:
                expr_raw = match.strip()
                error = _classify_resolution_failure(
                    f"{{{{{expr_raw}}}}}",
                    binding_key=key,
                    params=params,
                    steps_output=steps_output,
                    subtasks=subtasks,
                )
                errors.append(error)
    return errors


def detect_unresolved_in_step(
    step: dict[str, Any],
    *,
    params: dict[str, str],
    subtasks: list[dict[str, Any]],
    env: dict[str, str] | None = None,
) -> dict[str, Any]:
    """High-level helper: resolve a step's input_bindings and report unresolved ones.

    Returns a dict with:
        - ``resolved``: {var_name: value} from input_bindings (empty if none)
        - ``has_bindings``: bool – whether this step has explicit input_bindings
        - ``unresolved``: list[str] – human-readable warnings for unresolved bindings
        - ``unresolved_count``: int – number of unresolved bindings
    """
    resolve_result = resolve_step_inputs(step, params=params, subtasks=subtasks, env=env)
    unresolved = detect_unresolved_bindings(resolve_result["resolved"])
    return {
        "resolved": resolve_result["resolved"],
        "has_bindings": resolve_result["has_bindings"],
        "unresolved": unresolved,
        "unresolved_count": len(unresolved),
    }


__all__ = [
    "resolve_expression",
    "resolve_bindings",
    "resolve_step_inputs",
    "build_steps_output_from_subtasks",
    "format_resolved_inputs_for_prompt",
    "detect_unresolved_bindings",
    "detect_unresolved_in_step",
    "BindingError",
    "BindingErrorCode",
    "detect_binding_errors",
]
