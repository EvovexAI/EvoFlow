"""Application generator: create reusable App definitions from model-generated plans.

When a lead agent (or any model) produces a plan (goal + steps), this module
converts it into a parameterized App definition by:
  1. Running the parameter extraction engine (``app_extractor``) to identify
     variable content and replace it with ``{{param}}`` placeholders.
  2. Assembling a complete App document with ``source="generated"``.

This is the "model generates -> save as App" path described in design doc §7.1,
complementing ``app_extractor.create_app_from_task()`` which handles the
"from existing task" path (§7.2).
"""

from __future__ import annotations

import uuid
from typing import Any

from evoflow.collab.app_extractor import extract_parameters_from_plan
from evoflow.timeutil import utc_now_iso_z


def _merge_declared_parameters(
    extracted: list[dict[str, Any]],
    declared: list[dict[str, Any]] | None,
) -> list[dict[str, Any]]:
    """Caller-declared parameter definitions win over heuristic extraction.

    ``extract_parameters_from_plan`` only sees the placeholder *names* present in
    the plan, so it stamps every one of them ``required=True`` with an empty
    ``default`` and a title-cased label. When the author already declared the real
    label / type / default / required (platform ``workflow.generate``, App editor),
    throwing those away leaves a run form that demands values the author had
    already supplied — and an empty ``default`` also means the placeholder is never
    filled at render time, so ``{{name}}`` leaks into the prompt verbatim.

    Declared entries whose name is absent from the plan are appended anyway so the
    form still shows them. Blank fields in a declared entry do not clobber the
    extracted value.
    """
    if not declared:
        return extracted
    by_name: dict[str, dict[str, Any]] = {}
    for p in extracted or []:
        if isinstance(p, dict):
            key = str(p.get("name") or p.get("key") or "").strip()
            if key:
                by_name[key] = dict(p)
    for d in declared:
        if not isinstance(d, dict):
            continue
        key = str(d.get("name") or d.get("key") or "").strip()
        if not key:
            continue
        target = by_name.setdefault(key, {"name": key, "type": "text"})
        for field in ("label", "type", "default", "description", "options"):
            val = d.get(field)
            if val is None or (isinstance(val, str) and not val.strip()):
                continue
            target[field] = val
        if "required" in d:
            target["required"] = bool(d.get("required"))
    return list(by_name.values())


def generate_app_from_plan(
    goal: str,
    steps: list[dict[str, Any]],
    name: str,
    description: str = "",
    icon: str = "📋",
    category: str = "general",
    execution_mode: str = "workflow",
    auto_run: bool = False,
    auto_extract: bool = True,
    max_params: int = 5,
    tags: list[str] | None = None,
    parameters: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """Generate a reusable App definition from a model-generated plan.

    This is the primary entry point for the "lead agent generates plan ->
    save as App" workflow.  It parameterizes the plan content so the
    resulting App can be re-run with different inputs.

    Args:
        goal: The plan goal text (may contain concrete values to be parameterized).
        steps: The plan steps list (each step is a dict with name, goal,
            assigned_agent, depends_on, etc.).
        name: Application name (human-readable).
        description: Optional description; auto-generated if empty.
        icon: Emoji or icon string.
        category: Category label for filtering (e.g. "research", "dev", "ops").
        execution_mode: "workflow" (default) or "lead_supervised".
        auto_run: Whether the app auto-executes after parameter fill.
        auto_extract: If True, run parameter extraction to identify variable
            content. If False, the raw plan is stored with zero parameters.
        max_params: Maximum number of parameters to extract (default 5).
        tags: Optional list of tags.
        parameters: Author-declared AppParameter definitions (label / type /
            default / required). These win over the heuristic extraction for the
            same parameter name; see ``_merge_declared_parameters``.

    Returns:
        Complete App document dict ready for ``app_repositories.save_app()``.
    """
    # ── Step 1: Parameter extraction ──
    # Extract when goal is present even if steps is empty (placeholders in goal alone).
    # NOTE: do not rebind the ``parameters`` argument here — the caller's declared
    # definitions must survive and win over the heuristic (see _merge_declared_parameters).
    if auto_extract and goal:
        rendered_plan, extracted_params = extract_parameters_from_plan(goal, steps or [], max_params=max_params)
        goal_template = rendered_plan["goal_template"]
        param_steps = rendered_plan["steps"]
    else:
        goal_template = goal or ""
        param_steps = steps or []
        extracted_params = []

    final_parameters = _merge_declared_parameters(extracted_params, parameters)
    # ``auto-parameterized`` describes the heuristic path only — counting the
    # author's declared parameters here would mislabel a hand-written plan.
    extracted_count = len(extracted_params or [])

    # ── Step 2: Assemble App document ──
    ts = utc_now_iso_z().replace(":", "").replace("-", "").replace("T", "").split(".")[0]
    app_id = f"App_{ts}_{uuid.uuid4().hex[:6]}"

    final_tags = list(tags or [])
    final_tags.append("generated")
    if extracted_count > 0:
        final_tags.append("auto-parameterized")

    final_description = description or (
        f"Generated application: {name}. {len(final_parameters)} parameter(s) for reuse."
    )

    now = utc_now_iso_z()

    return {
        "id": app_id,
        "name": name,
        "description": final_description,
        "icon": icon,
        "category": category,
        "parameters": final_parameters,
        "steps": param_steps,
        "goal_template": goal_template,
        "validation_template": [],
        "flowchart_mermaid": "",
        "execution_mode": execution_mode,
        "auto_run": auto_run,
        "source": "generated",
        "source_task_id": None,
        "version": 1,
        "status": "draft",
        "tags": final_tags,
        "created_at": now,
        "updated_at": now,
        "usage_count": 0,
        "last_used_at": None,
    }
