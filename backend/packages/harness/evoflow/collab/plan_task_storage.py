"""Structured plan fields on the main collaboration task row (no plan markdown)."""

from __future__ import annotations

import json
from typing import Any

from evoflow.timeutil import utc_now_iso_z


def _json_dumps(obj: Any) -> str:
    return json.dumps(obj, ensure_ascii=False, separators=(",", ":"))


def _json_loads(raw: str | None) -> Any:
    if not raw:
        return None
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        return None


def coerce_plan_validation(raw: list[str] | str | None) -> list[str]:
    if raw is None or raw == "":
        return []
    if isinstance(raw, list):
        return [str(x).strip() for x in raw if str(x).strip()]
    text = str(raw).strip()
    if text.startswith("["):
        loaded = _json_loads(text)
        if isinstance(loaded, list):
            return [str(x).strip() for x in loaded if str(x).strip()]
    out: list[str] = []
    for line in text.splitlines():
        t = line.strip()
        if not t:
            continue
        out.append(t.lstrip("- ").strip())
    return out


def load_plan_steps(task: dict[str, Any]) -> list[dict[str, Any]]:
    """Steps list from in-memory task (backed by ``plan_steps_json`` column)."""
    raw = task.get("plan_steps")
    if isinstance(raw, list):
        return [x for x in raw if isinstance(x, dict)]
    loaded = _json_loads(str(task.get("plan_steps_json") or ""))
    if isinstance(loaded, list):
        return [x for x in loaded if isinstance(x, dict)]
    return []


def persist_plan_steps(task: dict[str, Any], steps: list[dict[str, Any]]) -> None:
    from evoflow.collab.plan_subtasks_sync import normalize_plan_step_dict

    normalized = [normalize_plan_step_dict(s, idx=i) for i, s in enumerate(steps, start=1) if isinstance(s, dict)]
    task["plan_steps"] = normalized
    task["plan_steps_json"] = _json_dumps(normalized)


def task_has_bound_plan(task: dict[str, Any] | None) -> bool:
    if not task:
        return False
    goal = str(task.get("plan_goal") or "").strip()
    return bool(goal) and len(load_plan_steps(task)) > 0


def sync_main_task_identity_from_plan_goal(
    task: dict[str, Any],
    project: dict[str, Any] | None,
    goal: str,
) -> None:
    """Replace placeholder main-task title; description mirrors plan goal.

    App / workflow runs keep a short ``name`` (app title) and already store the
    full goal in ``plan_goal`` — do not overwrite the display name with the
    entire goal text (Task Center would become unreadable).
    """
    goal_text = str(goal or task.get("plan_goal") or "").strip()
    if not goal_text:
        return
    is_app_run = bool(str(task.get("source_app_id") or "").strip())
    if not is_app_run:
        task["name"] = goal_text[:240]
    task["description"] = goal_text[:4000]
    if project is not None:
        if is_app_run:
            app_name = str(task.get("source_app_name") or task.get("name") or "").strip()
            if app_name:
                project["name"] = app_name[:120]
        else:
            project["name"] = goal_text[:120]


def write_plan_fields(
    task: dict[str, Any],
    *,
    goal: str,
    steps: list[dict[str, Any]],
    flowchart_mermaid: str | None = None,
    validation: list[str] | str | None = None,
    open_questions: str = "无",
) -> None:
    from evoflow.collab.plan_subtasks_sync import normalize_mermaid_body

    task["plan_goal"] = str(goal or "").strip()
    task["plan_flowchart_mermaid"] = normalize_mermaid_body(flowchart_mermaid)
    val_list = coerce_plan_validation(validation)
    task["plan_validation"] = val_list
    task["plan_validation_json"] = _json_dumps(val_list)
    task["plan_open_questions"] = str(open_questions or "无").strip() or "无"
    persist_plan_steps(task, steps)
    task["plan_bound_at"] = utc_now_iso_z()
    for legacy in ("bound_plan_markdown", "bound_plan_steps", "bound_plan_ts_ms", "bound_plan_preview"):
        task.pop(legacy, None)


def clear_plan_fields(task: dict[str, Any]) -> None:
    for key in (
        "plan_goal",
        "plan_flowchart_mermaid",
        "plan_validation",
        "plan_validation_json",
        "plan_open_questions",
        "plan_steps",
        "plan_steps_json",
        "plan_bound_at",
        "bound_plan_markdown",
        "bound_plan_steps",
        "bound_plan_ts_ms",
    ):
        task.pop(key, None)


def format_plan_for_prompt(task: dict[str, Any]) -> str:
    """Render bound plan columns as canonical ``# Plan`` markdown for prompt injection."""
    from evoflow.collab.plan_subtasks_sync import build_plan_markdown

    goal = str(task.get("plan_goal") or "").strip()
    steps = load_plan_steps(task)
    if not goal or not steps:
        return ""
    validation = task.get("plan_validation") if isinstance(task.get("plan_validation"), list) else coerce_plan_validation(task.get("plan_validation_json"))
    return build_plan_markdown(
        goal=goal,
        steps=steps,
        flowchart_mermaid=str(task.get("plan_flowchart_mermaid") or "").strip() or None,
        validation=validation,
        open_questions=str(task.get("plan_open_questions") or "无"),
    )


def plan_snapshot_for_api(task: dict[str, Any]) -> dict[str, Any]:
    """Subset for tool output / UI."""
    steps = load_plan_steps(task)
    return {
        "goal": str(task.get("plan_goal") or "").strip(),
        "flowchart_mermaid": str(task.get("plan_flowchart_mermaid") or "").strip(),
        "validation": task.get("plan_validation") if isinstance(task.get("plan_validation"), list) else coerce_plan_validation(task.get("plan_validation_json")),
        "open_questions": str(task.get("plan_open_questions") or "无").strip() or "无",
        "steps": steps,
        "step_count": len(steps),
        "bound_at": str(task.get("plan_bound_at") or "").strip(),
    }


__all__ = [
    "coerce_plan_validation",
    "load_plan_steps",
    "persist_plan_steps",
    "sync_main_task_identity_from_plan_goal",
    "task_has_bound_plan",
    "write_plan_fields",
    "clear_plan_fields",
    "format_plan_for_prompt",
    "plan_snapshot_for_api",
]
