"""Static validation for workflow App definitions before publish.

Runs a set of checks on an App document to catch configuration errors that
would cause runtime failures:

1. **Unresolved binding references** – ``input_bindings`` that reference
   non-existent steps or unparseable expressions.
2. **Circular dependencies** – ``depends_on`` chains that form a cycle.
3. **Step reference integrity** – ``depends_on`` / ``input_bindings`` reference
   steps that don't exist in the definition.
4. **Missing required fields** – steps without a goal or name.
5. **Parameter placeholder integrity** – ``{{param}}`` placeholders that
   don't match any declared parameter.
6. **Schema enforcement policy** – invalid ``schema_enforcement`` values.

The validator does NOT modify the App document. It returns a structured
report that the publish endpoint uses to decide whether to allow publishing.
"""

from __future__ import annotations

import logging
import re
from typing import Any

logger = logging.getLogger(__name__)

# Matches {{...}} expressions in input_bindings / text fields
_EXPR_RE = re.compile(r"\{\{(.+?)\}\}")

# Matches {{param}} style placeholders (single-level, no dots)
_PARAM_PLACEHOLDER_RE = re.compile(r"\{\{([a-zA-Z_][a-zA-Z0-9_]*)\}\}")

_VALID_SCHEMA_POLICIES = frozenset({"strict", "warn", "ignore"})


def _as_str(value: Any, default: str = "") -> str:
    if value is None:
        return default
    return str(value).strip()


def validate_app_definition(app_def: dict[str, Any]) -> dict[str, Any]:
    """Run all static validation checks on an App definition.

    Args:
        app_def: The normalized App document (after ``normalize_app_document``).

    Returns:
        A dict with:
        - ``valid``: bool – True if no errors (warnings are OK).
        - ``errors``: list[str] – Blocking issues (publish should be rejected).
        - ``warnings``: list[str] – Non-blocking issues (publish allowed).
        - ``checks``: dict – Per-check summary for debugging.
    """
    errors: list[str] = []
    warnings: list[str] = []
    checks: dict[str, Any] = {}

    steps = app_def.get("steps") or []
    if not isinstance(steps, list):
        steps = []
    parameters = app_def.get("parameters") or []
    if not isinstance(parameters, list):
        parameters = []

    step_refs = {_as_str(s.get("ref")) for s in steps if isinstance(s, dict)}
    step_refs.discard("")
    param_names = {_as_str(p.get("name")) for p in parameters if isinstance(p, dict)}

    # ── Check 0: Duplicate refs / names ──────────────────────────────
    check0_errors: list[str] = []
    check0_warnings: list[str] = []
    seen_refs: dict[str, int] = {}
    seen_names: dict[str, int] = {}
    for step in steps:
        if not isinstance(step, dict):
            continue
        ref = _as_str(step.get("ref"))
        name = _as_str(step.get("name"))
        if ref:
            seen_refs[ref] = seen_refs.get(ref, 0) + 1
        if name:
            seen_names[name] = seen_names.get(name, 0) + 1
    for ref, count in seen_refs.items():
        if count > 1:
            check0_errors.append(f"Duplicate step ref '{ref}' appears {count} times")
    for name, count in seen_names.items():
        if count > 1:
            check0_warnings.append(f"Duplicate step name '{name}' appears {count} times")
    checks["step_uniqueness"] = {"errors": len(check0_errors), "warnings": len(check0_warnings)}
    errors.extend(check0_errors)
    warnings.extend(check0_warnings)

    # ── Check 1: Step reference integrity ────────────────────────────
    check1_errors: list[str] = []
    for step in steps:
        if not isinstance(step, dict):
            continue
        ref = _as_str(step.get("ref"))
        step_name = _as_str(step.get("name"), ref)
        depends_on = step.get("depends_on") or []
        if not isinstance(depends_on, list):
            depends_on = []
        for dep in depends_on:
            dep_s = _as_str(dep)
            if not dep_s:
                continue
            if dep_s not in step_refs:
                check1_errors.append(
                    f"Step {step_name} (ref={ref}): depends_on references non-existent step '{dep_s}'"
                )
    checks["step_ref_integrity"] = {"errors": len(check1_errors)}
    errors.extend(check1_errors)

    # ── Check 2: Circular dependencies ──────────────────────────────
    check2_errors: list[str] = []
    cycles = _detect_cycles(steps)
    for cycle in cycles:
        cycle_str = " -> ".join(cycle)
        check2_errors.append(f"Circular dependency detected: {cycle_str}")
    checks["circular_deps"] = {"errors": len(check2_errors), "cycles": cycles}
    errors.extend(check2_errors)

    # ── Check 3: Input binding reference integrity ───────────────────
    check3_errors: list[str] = []
    check3_warnings: list[str] = []
    for step in steps:
        if not isinstance(step, dict):
            continue
        ref = _as_str(step.get("ref"))
        step_name = _as_str(step.get("name"), ref)
        bindings = step.get("input_bindings")
        if not isinstance(bindings, dict) or not bindings:
            continue
        for bk, bv in bindings.items():
            bv_s = _as_str(bv)
            if not bv_s:
                continue
            # Extract all {{...}} expressions
            exprs = _EXPR_RE.findall(bv_s)
            for expr in exprs:
                expr = expr.strip()
                ref_step = _extract_step_ref(expr)
                if ref_step is not None:
                    if ref_step not in step_refs:
                        check3_errors.append(
                            f"Step {step_name} (ref={ref}): input_binding '{bk}' references non-existent step '{ref_step}'"
                        )
                # Check for params references
                param_ref = _extract_param_ref(expr)
                if param_ref is not None and param_ref not in param_names:
                    check3_warnings.append(
                        f"Step {step_name} (ref={ref}): input_binding '{bk}' references undeclared parameter '{param_ref}'"
                    )
    checks["binding_refs"] = {"errors": len(check3_errors), "warnings": len(check3_warnings)}
    errors.extend(check3_errors)
    warnings.extend(check3_warnings)

    # ── Check 3b: Output field existence (UNKNOWN_OUTPUT_FIELD) ──────
    # For {{steps.A.output.field}} expressions, verify that `field` is
    # declared in step A's output_schema.properties.
    check3b_errors: list[str] = []
    # Build a map: ref -> output_schema properties dict
    step_output_fields: dict[str, set[str]] = {}
    for step in steps:
        if not isinstance(step, dict):
            continue
        sr = _as_str(step.get("ref"))
        if not sr:
            continue
        os_def = step.get("output_schema")
        if isinstance(os_def, dict):
            props = os_def.get("properties")
            if isinstance(props, dict):
                step_output_fields[sr] = {str(k) for k in props.keys() if k}

    for step in steps:
        if not isinstance(step, dict):
            continue
        ref = _as_str(step.get("ref"))
        step_name = _as_str(step.get("name"), ref)
        bindings = step.get("input_bindings")
        if not isinstance(bindings, dict) or not bindings:
            continue
        for bk, bv in bindings.items():
            bv_s = _as_str(bv)
            if not bv_s:
                continue
            exprs = _EXPR_RE.findall(bv_s)
            for expr in exprs:
                expr = expr.strip()
                parts = _parse_expr_segments(expr)
                if len(parts) >= 4 and parts[0] == "steps" and parts[2] == "output":
                    src_ref = parts[1]
                    field_name = parts[3]
                    declared = step_output_fields.get(src_ref)
                    if declared is not None and field_name not in declared:
                        check3b_errors.append(
                            f"Step {step_name} (ref={ref}): input_binding '{bk}' "
                            f"references output field '{field_name}' which is not "
                            f"declared in step {src_ref}'s output_schema"
                        )
    checks["output_field_refs"] = {"errors": len(check3b_errors)}
    errors.extend(check3b_errors)

    # ── Check 3c: Static type mismatch (STATIC_TYPE_MISMATCH) ────────
    # For {{steps.A.output.field}} where both A's output_schema and the
    # current step's input_schema declare types, verify compatibility.
    check3c_errors: list[str] = []
    # Build: ref -> {field_name -> type_str}
    step_output_types: dict[str, dict[str, str]] = {}
    for step in steps:
        if not isinstance(step, dict):
            continue
        sr = _as_str(step.get("ref"))
        if not sr:
            continue
        os_def = step.get("output_schema")
        if isinstance(os_def, dict):
            props = os_def.get("properties")
            if isinstance(props, dict):
                types: dict[str, str] = {}
                for pk, pv in props.items():
                    if isinstance(pv, dict):
                        types[str(pk)] = str(pv.get("type") or "").strip().lower()
                step_output_types[sr] = types

    for step in steps:
        if not isinstance(step, dict):
            continue
        ref = _as_str(step.get("ref"))
        step_name = _as_str(step.get("name"), ref)
        bindings = step.get("input_bindings")
        input_schema = step.get("input_schema")
        if not isinstance(bindings, dict) or not bindings:
            continue
        if not isinstance(input_schema, dict):
            continue
        # Unwrap JSON Schema {type:object, properties:{...}}
        in_props = input_schema.get("properties")
        if not isinstance(in_props, dict):
            in_props = input_schema  # flat dict form

        for bk, bv in bindings.items():
            bv_s = _as_str(bv)
            if not bv_s:
                continue
            exprs = _EXPR_RE.findall(bv_s)
            for expr in exprs:
                expr = expr.strip()
                parts = _parse_expr_segments(expr)
                if len(parts) >= 4 and parts[0] == "steps" and parts[2] == "output":
                    src_ref = parts[1]
                    field_name = parts[3]
                    src_types = step_output_types.get(src_ref, {})
                    src_type = src_types.get(field_name, "")
                    # Find the input_schema type for this binding key
                    in_entry = in_props.get(bk)
                    if not isinstance(in_entry, dict):
                        continue
                    dst_type = str(in_entry.get("type") or "").strip().lower()
                    if not src_type or not dst_type:
                        continue
                    if not _types_compatible(src_type, dst_type):
                        check3c_errors.append(
                            f"Step {step_name} (ref={ref}): input_binding '{bk}' "
                            f"type mismatch: upstream output '{field_name}' is "
                            f"'{src_type}', but input_schema expects '{dst_type}'"
                        )
    checks["static_type_mismatch"] = {"errors": len(check3c_errors)}
    errors.extend(check3c_errors)

    # ── Check 4: Missing required fields ─────────────────────────────
    check4_warnings: list[str] = []
    for step in steps:
        if not isinstance(step, dict):
            continue
        ref = _as_str(step.get("ref"))
        step_name = _as_str(step.get("name"), ref)
        if not _as_str(step.get("name")):
            check4_warnings.append(f"Step ref={ref}: missing 'name'")
        if not _as_str(step.get("goal")) and not _as_str(step.get("description")):
            check4_warnings.append(f"Step {step_name} (ref={ref}): missing 'goal' or 'description'")
    checks["required_fields"] = {"warnings": len(check4_warnings)}
    warnings.extend(check4_warnings)

    # ── Check 5: Parameter placeholder integrity ─────────────────────
    check5_warnings: list[str] = []
    for step in steps:
        if not isinstance(step, dict):
            continue
        ref = _as_str(step.get("ref"))
        step_name = _as_str(step.get("name"), ref)
        for field_key in ("goal", "inputs", "outputs", "acceptance", "instruction", "description"):
            val = step.get(field_key)
            if not isinstance(val, str) or not val:
                continue
            placeholders = _PARAM_PLACEHOLDER_RE.findall(val)
            for ph in placeholders:
                if ph not in param_names:
                    check5_warnings.append(
                        f"Step {step_name} (ref={ref}): {field_key} references undeclared parameter '{ph}'"
                    )
    # Also check goal_template
    goal_template = _as_str(app_def.get("goal_template"))
    if goal_template:
        for ph in _PARAM_PLACEHOLDER_RE.findall(goal_template):
            if ph not in param_names:
                check5_warnings.append(
                    f"goal_template: references undeclared parameter '{ph}'"
                )
    checks["param_placeholders"] = {"warnings": len(check5_warnings)}
    warnings.extend(check5_warnings)

    # ── Check 6: Schema enforcement policy ───────────────────────────
    check6_warnings: list[str] = []
    app_policy = _as_str(app_def.get("schema_enforcement"))
    if app_policy and app_policy not in _VALID_SCHEMA_POLICIES:
        check6_warnings.append(
            f"App-level schema_enforcement='{app_policy}' is invalid; must be one of: {', '.join(sorted(_VALID_SCHEMA_POLICIES))}"
        )
    for step in steps:
        if not isinstance(step, dict):
            continue
        step_policy = _as_str(step.get("schema_enforcement"))
        if step_policy and step_policy not in _VALID_SCHEMA_POLICIES:
            ref = _as_str(step.get("ref"))
            check6_warnings.append(
                f"Step ref={ref}: schema_enforcement='{step_policy}' is invalid; must be one of: {', '.join(sorted(_VALID_SCHEMA_POLICIES))}"
            )
    checks["schema_policy"] = {"warnings": len(check6_warnings)}
    warnings.extend(check6_warnings)

    # ── Check 7: Empty workflow ──────────────────────────────────────
    if not steps:
        errors.append("App definition has no steps")

    return {
        "valid": len(errors) == 0,
        "errors": errors,
        "warnings": warnings,
        "checks": checks,
    }


def _parse_expr_segments(expr: str) -> list[str]:
    """Parse an expression like ``steps.3.output.title`` into segments.

    Splits on ``.`` and strips whitespace from each segment. Unlike
    ``_extract_step_ref`` / ``_extract_param_ref`` this returns *all*
    segments so callers can inspect deeper paths (e.g. ``output.field``).

    Returns an empty list for empty / whitespace-only input.
    """
    expr = expr.strip()
    if not expr:
        return []
    return [seg.strip() for seg in expr.split(".") if seg.strip()]


# JSON Schema type aliases that are considered compatible for static checks.
# Keys and values are lowercased.  The mapping is intentionally permissive:
# "string" is compatible with itself; "number" covers int/float;  "object"
# and "array" are distinct; "any" / "" (unset) is always compatible.
_TYPE_COMPAT_GROUPS: list[set[str]] = [
    {"number", "integer", "float", "int", "double"},
    {"string", "str"},
    {"boolean", "bool"},
    {"array", "list"},
    {"object", "dict"},
]


def _types_compatible(src_type: str, dst_type: str) -> bool:
    """Check whether *src_type* can be assigned to *dst_type*.

    Rules:
    - If either type is empty or ``"any"``, it's compatible (can't statically
      determine mismatch).
    - If they're equal (case-insensitive), compatible.
    - If both belong to the same compatibility group (e.g. ``integer`` and
      ``number``), compatible.
    - Otherwise incompatible.
    """
    src = src_type.strip().lower()
    dst = dst_type.strip().lower()
    if not src or not dst or src == "any" or dst == "any":
        return True
    if src == dst:
        return True
    for group in _TYPE_COMPAT_GROUPS:
        if src in group and dst in group:
            return True
    return False


def _extract_step_ref(expr: str) -> str | None:
    """Extract the step ref from an expression like ``steps.3.output.x``.

    Returns the ref string (e.g. ``"3"``) or None if the expression doesn't
    reference a step.
    """
    segments = expr.strip().split(".")
    if len(segments) < 2:
        return None
    if segments[0] != "steps":
        return None
    return segments[1].strip() or None


def _extract_param_ref(expr: str) -> str | None:
    """Extract the parameter name from an expression like ``params.topic``.

    Returns the param name or None if the expression doesn't reference a param.
    """
    segments = expr.strip().split(".")
    if len(segments) < 2:
        return None
    if segments[0] != "params":
        return None
    return segments[1].strip() or None


def _canonical_cycle_key(cycle: list[str]) -> tuple[str, ...]:
    """Fingerprint a directed cycle, ignoring start offset but keeping order.

    ``["2", "3", "1", "2"]`` and ``["1", "2", "3", "1"]`` map to the same key.
    Reverse cycles (``1->3->2->1`` vs ``1->2->3->1``) stay distinct.
    """
    body = cycle[:-1] if len(cycle) >= 2 and cycle[0] == cycle[-1] else list(cycle)
    if not body:
        return tuple(cycle)
    k = min(range(len(body)), key=lambda i: body[i])
    return tuple(body[k:] + body[:k])


def _detect_cycles(steps: list[dict[str, Any]]) -> list[list[str]]:
    """Detect circular dependencies in step depends_on chains.

    Returns a list of cycles, each cycle being a list of refs:
    ``["1", "2", "3", "1"]`` means 1->2->3->1.
    """
    # Build adjacency list
    adj: dict[str, list[str]] = {}
    step_refs: set[str] = set()
    for step in steps:
        if not isinstance(step, dict):
            continue
        ref = _as_str(step.get("ref"))
        if not ref:
            continue
        step_refs.add(ref)
        deps = step.get("depends_on") or []
        if not isinstance(deps, list):
            deps = []
        adj[ref] = [_as_str(d) for d in deps if _as_str(d)]

    cycles: list[list[str]] = []
    seen_cycles: set[tuple[str, ...]] = set()
    WHITE, GRAY, BLACK = 0, 1, 2
    color: dict[str, int] = {ref: WHITE for ref in step_refs}

    def dfs(node: str, path: list[str]) -> None:
        color[node] = GRAY
        path.append(node)
        for neighbor in adj.get(node, []):
            if neighbor not in step_refs:
                continue
            state = color.get(neighbor, WHITE)
            if state == GRAY:
                cycle_start = path.index(neighbor)
                cycle = path[cycle_start:] + [neighbor]
                cycle_key = _canonical_cycle_key(cycle)
                if cycle_key not in seen_cycles:
                    seen_cycles.add(cycle_key)
                    cycles.append(cycle)
            elif state == WHITE:
                dfs(neighbor, path)
        path.pop()
        color[node] = BLACK

    for ref in step_refs:
        if color.get(ref, WHITE) == WHITE:
            dfs(ref, [])

    return cycles


__all__ = [
    "validate_app_definition",
]
