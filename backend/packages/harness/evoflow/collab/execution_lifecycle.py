"""Collaborative task execution lifecycle: plan → authorize → execute."""

from __future__ import annotations

import json
from typing import Any

from evoflow.collab.models import CollabPhase, TaskStatus

# UI / tool-facing lifecycle stage keys (stable for frontend mapping).
LIFECYCLE_PLANNING = "planning"
LIFECYCLE_PLAN_READY = "plan_ready"
LIFECYCLE_AWAITING_AUTHORIZATION = "awaiting_authorization"
LIFECYCLE_AUTHORIZED = "authorized"
LIFECYCLE_EXECUTING = "executing"
LIFECYCLE_PAUSED = "paused"
LIFECYCLE_DONE = "done"

_LIFECYCLE_LABELS_ZH: dict[str, str] = {
    LIFECYCLE_PLANNING: "规划中",
    LIFECYCLE_PLAN_READY: "计划已定稿",
    LIFECYCLE_AWAITING_AUTHORIZATION: "待授权开始执行",
    LIFECYCLE_AUTHORIZED: "已授权，待启动",
    LIFECYCLE_EXECUTING: "执行中",
    LIFECYCLE_PAUSED: "已暂停",
    LIFECYCLE_DONE: "已结束",
}

_TERMINAL = frozenset({"completed", "failed", "cancelled"})


def _is_execute_confirmation_from_structured_answer(text: str) -> bool:
    raw = str(text or "").strip()
    prefix = "__EVF_CLARIFY_ANS_V1__:"
    if not raw.startswith(prefix):
        return False
    try:
        payload = json.loads(raw[len(prefix) :].strip())
    except Exception:
        return False
    if not isinstance(payload, dict):
        return False
    answers = payload.get("answers")
    if isinstance(answers, list):
        for ans in answers:
            if not isinstance(ans, dict):
                continue
            labels = ans.get("selected_option_labels")
            if isinstance(labels, list):
                for lb in labels:
                    s = str(lb or "").strip()
                    if "开始执行" in s or "按计划开始执行" in s:
                        return True
    free_text = str(payload.get("free_text") or "").strip().lower()
    if free_text and ("开始执行" in free_text or "按计划执行" in free_text or "start execution" in free_text):
        return True
    return False


def user_execution_start_intent(text: str) -> bool:
    """True when the user explicitly agrees to start execution (structured or short NL)."""
    raw = str(text or "").strip()
    if not raw:
        return False
    if raw.startswith("__EVF_CLARIFY_ANS_V1__:"):
        return _is_execute_confirmation_from_structured_answer(raw)
    compact = raw.replace(" ", "").replace("\u3000", "")
    if compact in {
        "开始",
        "开始执行",
        "确认开始",
        "确认开始执行",
        "按计划开始执行",
        "按计划执行",
        "开始吧",
        "执行",
        "start",
        "startexecution",
    }:
        return True
    lower = raw.lower()
    if len(raw) <= 64:
        if "开始执行" in raw or "按计划执行" in raw:
            return True
        if raw.startswith("开始") and "执行" in raw:
            return True
        if "start execution" in lower or lower == "go":
            return True
    return False


def _has_bound_plan(task: dict[str, Any]) -> bool:
    from evoflow.collab.plan_task_storage import task_has_bound_plan

    return task_has_bound_plan(task)


def infer_main_task_lifecycle_stage(
    task: dict[str, Any] | None,
    *,
    collab_phase: str = "",
) -> str:
    """Derive a stable lifecycle stage for progress panels and snapshots."""
    if not task or not isinstance(task, dict):
        p = str(collab_phase or "").strip().lower()
        if p in {CollabPhase.PLANNING.value, CollabPhase.PLAN_READY.value}:
            return LIFECYCLE_PLANNING
        if p == CollabPhase.AWAITING_EXEC.value:
            return LIFECYCLE_AWAITING_AUTHORIZATION
        if p == CollabPhase.EXECUTING.value:
            return LIFECYCLE_EXECUTING
        return LIFECYCLE_PLANNING if p else LIFECYCLE_PLANNING

    status = str(task.get("status") or "").strip().lower()
    auth = bool(task.get("execution_authorized"))
    has_plan = _has_bound_plan(task)
    subs = [x for x in (task.get("subtasks") or []) if isinstance(x, dict)]
    phase = str(collab_phase or "").strip().lower()

    if status in _TERMINAL:
        return LIFECYCLE_DONE
    if phase == CollabPhase.PAUSED.value or status == TaskStatus.PAUSED.value:
        return LIFECYCLE_PAUSED
    if status in {TaskStatus.EXECUTING.value, "running", "in_progress"} or phase == CollabPhase.EXECUTING.value:
        return LIFECYCLE_EXECUTING
    if subs and auth and any(str(x.get("status") or "").lower() not in _TERMINAL for x in subs):
        return LIFECYCLE_EXECUTING
    if auth:
        if phase == CollabPhase.AWAITING_EXEC.value or status in {TaskStatus.PLANNED.value, TaskStatus.PLANNING.value}:
            return LIFECYCLE_AUTHORIZED
        return LIFECYCLE_AUTHORIZED
    if has_plan or status in {TaskStatus.PLANNED.value, TaskStatus.PLANNING.value}:
        return LIFECYCLE_AWAITING_AUTHORIZATION
    if status == TaskStatus.PLANNING.value or phase in {CollabPhase.PLANNING.value, CollabPhase.PLAN_READY.value}:
        return LIFECYCLE_PLANNING
    return LIFECYCLE_PLAN_READY if has_plan else LIFECYCLE_PLANNING


def lifecycle_label_zh(stage: str) -> str:
    return _LIFECYCLE_LABELS_ZH.get(str(stage or "").strip(), str(stage or "").strip() or "未知")


def pack_main_task_lifecycle_fields(
    task: dict[str, Any] | None,
    *,
    collab_phase: str = "",
) -> dict[str, Any]:
    stage = infer_main_task_lifecycle_stage(task, collab_phase=collab_phase)
    return {
        "lifecycleStage": stage,
        "lifecycleLabel": lifecycle_label_zh(stage),
    }


__all__ = [
    "LIFECYCLE_AWAITING_AUTHORIZATION",
    "LIFECYCLE_AUTHORIZED",
    "LIFECYCLE_EXECUTING",
    "LIFECYCLE_PLANNING",
    "infer_main_task_lifecycle_stage",
    "lifecycle_label_zh",
    "pack_main_task_lifecycle_fields",
    "user_execution_start_intent",
]
