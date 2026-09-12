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

    Returns:
        Complete App document dict ready for ``app_repositories.save_app()``.
    """
    # ── Step 1: Parameter extraction ──
    if auto_extract and goal and steps:
        rendered_plan, parameters = extract_parameters_from_plan(
            goal, steps, max_params=max_params
        )
        goal_template = rendered_plan["goal_template"]
        param_steps = rendered_plan["steps"]
        param_count = rendered_plan["param_count"]
    else:
        goal_template = goal or ""
        param_steps = steps or []
        parameters = []
        param_count = 0

    # ── Step 2: Assemble App document ──
    ts = utc_now_iso_z().replace(":", "").replace("-", "").replace("T", "").split(".")[0]
    app_id = f"App_{ts}_{uuid.uuid4().hex[:6]}"

    final_tags = list(tags or [])
    final_tags.append("generated")
    if param_count > 0:
        final_tags.append("auto-parameterized")

    final_description = description or (
        f"Generated application: {name}. "
        f"{param_count} parameter(s) extracted for reuse."
    )

    now = utc_now_iso_z()

    return {
        "id": app_id,
        "name": name,
        "description": final_description,
        "icon": icon,
        "category": category,
        "parameters": parameters,
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
