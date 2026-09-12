"""Attach structured plan from the bound main task (not mission_state)."""

from __future__ import annotations

import logging
from typing import Any

logger = logging.getLogger(__name__)


def persist_submitted_plan_markdown(thread_id: str | None, markdown: str) -> bool:
    """Deprecated wrapper — markdown plans are no longer stored."""
    del markdown
    logger.warning("persist_submitted_plan_markdown called but markdown storage is removed")
    return False


def attach_bound_plan_from_mission_state(task_dict: dict[str, Any], thread_id: str | None) -> dict[str, Any]:
    """Copy plan fields from the thread-bound main task onto ``task_dict`` (legacy name)."""
    return attach_bound_plan_from_thread_task(task_dict, thread_id)


def attach_bound_plan_from_thread_task(task_dict: dict[str, Any], thread_id: str | None) -> dict[str, Any]:
    """Copy structured plan fields from the bound main task when the target dict has no plan yet."""
    from evoflow.collab.plan_on_task import load_bound_main_task_plan
    from evoflow.collab.plan_task_storage import task_has_bound_plan, write_plan_fields

    tid = str(thread_id or "").strip()
    out: dict[str, Any] = {"attached": False, "thread_id": tid}
    if not tid:
        return out
    if task_has_bound_plan(task_dict):
        out.update({"attached": True, "source": "task_dict"})
        return out

    plan, ts, src_task = load_bound_main_task_plan(tid)
    if not plan or not src_task:
        return out
    write_plan_fields(
        task_dict,
        goal=str(plan.get("goal") or ""),
        steps=list(plan.get("steps") or []),
        flowchart_mermaid=str(plan.get("flowchart_mermaid") or ""),
        validation=plan.get("validation"),
        open_questions=str(plan.get("open_questions") or "无"),
    )
    out.update(
        {
            "attached": True,
            "source": "bound_main_task",
            "plan_goal_len": len(str(plan.get("goal") or "")),
            "plan_step_count": int(plan.get("step_count") or len(plan.get("steps") or [])),
            "plan_bound_ts_ms": ts,
        }
    )
    logger.info(
        "[PlanBinding] attached structured plan from bound task thread=%s steps=%s",
        tid,
        out.get("plan_step_count"),
    )
    return out
