"""Application parameter rendering engine.

Converts parameterized App definitions (with `{{param}}` placeholders)
into concrete PlanInput ready for task center integration.
"""

from __future__ import annotations

import re
from typing import Any


PARAM_RE = re.compile(r"\{\{([a-zA-Z_][a-zA-Z0-9_]*)\}\}")

# Content fields that may contain {{param}} (structural fields never rendered)
_STEP_CONTENT_KEYS = (
    "name",
    "goal",
    "inputs",
    "outputs",
    "acceptance",
    "instruction",
    "description",
)


def _render_text(text: str, parameters: dict[str, str]) -> str:
    """Render `{{param}}` placeholders in a string."""
    if not text:
        return text

    def replace_match(match: re.Match[str]) -> str:
        key = match.group(1)
        return str(parameters.get(key, match.group(0)))

    return PARAM_RE.sub(replace_match, text)


def _render_value(value: Any, parameters: dict[str, str]) -> Any:
    """Recursively render placeholders in strings nested in lists/dicts."""
    if isinstance(value, str):
        return _render_text(value, parameters)
    if isinstance(value, list):
        return [_render_value(v, parameters) for v in value]
    if isinstance(value, dict):
        return {k: _render_value(v, parameters) for k, v in value.items()}
    return value


def _render_steps(steps: list[dict[str, Any]], parameters: dict[str, str]) -> list[dict[str, Any]]:
    """Render placeholders in step content fields; keep structural fields as-is."""
    result = []
    for step in steps:
        if not isinstance(step, dict):
            continue
        rendered = dict(step)
        for key in _STEP_CONTENT_KEYS:
            if key in rendered and isinstance(rendered[key], str):
                rendered[key] = _render_text(rendered[key], parameters)
        # Nested checklist items often carry free-text titles
        if isinstance(rendered.get("work_checklist"), list):
            rendered["work_checklist"] = _render_value(rendered["work_checklist"], parameters)
        # P0: Render {{param}} inside input_bindings values, but preserve
        # {{steps.N.output.x}} expressions (they are resolved at dispatch time).
        if isinstance(rendered.get("input_bindings"), dict):
            cleaned: dict[str, str] = {}
            for bk, bv in rendered["input_bindings"].items():
                if isinstance(bv, str):
                    cleaned[str(bk)] = _render_text(bv, parameters)
                else:
                    cleaned[str(bk)] = str(bv)
            rendered["input_bindings"] = cleaned
        # Render {{param}} inside condition expressions (P1)
        if isinstance(rendered.get("condition"), dict):
            cond = dict(rendered["condition"])
            if isinstance(cond.get("expression"), str):
                cond["expression"] = _render_text(cond["expression"], parameters)
            rendered["condition"] = cond
        result.append(rendered)
    return result


def apply_parameter_defaults(
    app_def: dict[str, Any],
    parameters: dict[str, str] | None,
) -> dict[str, str]:
    """Fill missing/blank parameters from AppParameter.default."""
    out: dict[str, str] = {
        str(k): "" if v is None else str(v) for k, v in (parameters or {}).items()
    }
    for p in app_def.get("parameters") or []:
        if not isinstance(p, dict):
            continue
        key = str(p.get("key") or p.get("name") or "").strip()
        if not key:
            continue
        cur = str(out.get(key, "")).strip()
        if cur:
            continue
        default = p.get("default")
        if default is None:
            continue
        default_s = str(default).strip()
        if default_s:
            out[key] = default_s
    return out


def render_plan(app_def: dict[str, Any], parameters: dict[str, str]) -> dict[str, Any]:
    """Render a parameterized App definition into a concrete PlanInput.

    Applies parameter defaults before substitution. Missing placeholders that
    have no supplied value remain as ``{{name}}`` in the output.
    """
    filled = apply_parameter_defaults(app_def, parameters)
    return {
        "goal": _render_text(app_def.get("goal_template", ""), filled),
        "steps": _render_steps(app_def.get("steps", []) or [], filled),
        "flowchart_mermaid": _render_text(app_def.get("flowchart_mermaid", "") or "", filled),
        "validation": [
            _render_text(str(item), filled)
            for item in (app_def.get("validation_template") or [])
            if item is not None
        ],
        "open_questions": "无",  # App runs have no open questions (parameters are filled)
    }


def extract_undefined_params(app_def: dict[str, Any]) -> list[str]:
    """Scan App definition for `{{param}}` placeholders and return unique parameter names."""
    found: set[str] = set()

    def scan_text(text: str) -> None:
        if text:
            found.update(PARAM_RE.findall(text))

    def scan_value(value: Any) -> None:
        if isinstance(value, str):
            scan_text(value)
        elif isinstance(value, list):
            for v in value:
                scan_value(v)
        elif isinstance(value, dict):
            for v in value.values():
                scan_value(v)

    scan_text(app_def.get("goal_template", "") or "")
    scan_text(app_def.get("flowchart_mermaid", "") or "")
    for item in app_def.get("validation_template") or []:
        scan_text(str(item) if item is not None else "")
    for step in app_def.get("steps") or []:
        if not isinstance(step, dict):
            continue
        for key in _STEP_CONTENT_KEYS:
            scan_text(str(step.get(key) or ""))
        scan_value(step.get("work_checklist"))

    return sorted(found)


def validate_parameters(
    app_def: dict[str, Any],
    parameters: dict[str, str],
) -> tuple[bool, list[str], list[str]]:
    """Validate supplied parameters against App definition.

    Returns:
        (is_valid, missing_required, undefined_found)

    - missing_required: required slots still blank after defaults
    - undefined_found: ``{{param}}`` in content with no parameter definition
      (warning list; does not fail validity — definitions may catch up later)
    """
    filled = apply_parameter_defaults(app_def, parameters)

    param_defs: dict[str, dict] = {}
    for p in app_def.get("parameters") or []:
        if not isinstance(p, dict):
            continue
        key = str(p.get("key") or p.get("name") or "").strip()
        if key:
            param_defs[key] = p

    actual_placeholders = extract_undefined_params(app_def)

    missing: list[str] = []
    for key, pd in param_defs.items():
        required = pd.get("required", True)
        if required is False:
            continue
        if not str(filled.get(key, "")).strip():
            missing.append(key)

    undefined = [name for name in actual_placeholders if name not in param_defs]

    # Undefined placeholders block run: literal {{param}} in execution goals
    # would produce broken subtasks. generate flow doesn't call validate_parameters.
    return len(missing) == 0 and len(undefined) == 0, missing, undefined
