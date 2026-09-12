"""Workflow final rollup: aggregate subtask results onto the main task.

Every multi-step workflow MUST produce a final rollup — it is the default,
not an option. The rollup aggregates each step's outputs onto the main task so
the user always sees a concrete result in the task center.

Behavior (``final_rollup`` field):

- ``auto`` (default for all apps) — append a virtual ``__rollup__`` subtask
  that runs after all leaf steps, synthesizes a final report from every step,
  validates against validation_template, and writes the result to the main task
- ``answer_node_only`` — once all subtasks terminal, copy the answer-node step's
  task_report + merged outputs onto the main task
- ``off`` — legacy value kept for back-compat with stored data; it is NOT a
  "no rollup" escape hatch. Multi-step workflows still roll up (auto behavior).

This module is the single write-path for rollup logic.  It reuses existing
subtask outcome / task_outputs machinery and does not introduce new tables.
"""

from __future__ import annotations

import logging
from typing import Any

from evoflow.collab.task_outputs import merge_task_outputs
from evoflow.timeutil import utc_now_iso_z

logger = logging.getLogger(__name__)

ROLLUP_REF = "__rollup__"
_ROLLUP_SUBTASK_NAME = "结果汇总与验收"
_DEFAULT_ROLLUP_AGENT = "general-purpose"


# ─────────────────────────────── helpers ───────────────────────────────


def _is_app_sourced_task(task: dict[str, Any]) -> bool:
    """True for tasks that originated from an App run (workflow mode)."""
    return bool(str(task.get("source_app_id") or "").strip())


def _app_rollup_mode(task: dict[str, Any]) -> str:
    """Resolve the effective rollup mode for a workflow task.

    Rollup is mandatory for multi-step workflows, so any explicit value other
    than ``answer_node_only`` (including legacy ``off`` or missing) resolves to
    ``auto`` — there is no "disable rollup" mode.
    """
    mode = str(task.get("final_rollup") or "").strip().lower()
    if mode == "answer_node_only":
        return "answer_node_only"
    return "auto"


def _all_subtasks_terminal(subtasks: list[dict[str, Any]]) -> bool:
    """True when every subtask has reached a terminal status."""
    if not subtasks:
        return False
    _TERMINAL = frozenset(
        {"completed", "failed", "blocked", "cancelled", "canceled", "skipped", "timeout", "timed_out"}
    )
    for st in subtasks:
        if not isinstance(st, dict):
            continue
        st_status = str(st.get("status") or "").strip().lower()
        if st_status not in _TERMINAL:
            return False
    return True


def _find_subtask_by_ref(subtasks: list[dict[str, Any]], ref: str) -> dict[str, Any] | None:
    ref_s = str(ref or "").strip()
    for st in subtasks:
        if not isinstance(st, dict):
            continue
        if str(st.get("ref") or "").strip() == ref_s:
            return st
    return None


def _step_task_report(st: dict[str, Any]) -> str:
    """Best-effort task report / result text for one subtask row."""
    if not isinstance(st, dict):
        return ""
    for key in ("task_report", "result_summary", "result_text", "result", "summary", "output_summary"):
        val = str(st.get(key) or "").strip()
        if val:
            return val
    return ""


def _step_outputs(st: dict[str, Any]) -> list[dict[str, str]]:
    """Normalized outputs for one subtask (file / url / text items)."""
    from evoflow.collab.task_outputs import task_outputs_of

    return task_outputs_of(st)


# ─────────────────────── answer_node_only rollup ───────────────────────


def apply_answer_node_rollup(
    task: dict[str, Any],
    *,
    answer_from_ref: str = "",
) -> dict[str, Any] | None:
    """Copy answer-node result (+ its outputs) onto the main task.

    Only runs when:
      - task is app-sourced (workflow run)
      - all subtasks are terminal
      - answer_from_ref is set and points to a completed step

    Returns a patch dict to apply to the main task, or ``None`` when no rollup
    is due / not applicable.

    Prefer the answer step's own deliverables; only fall back to all-step
    outputs when the answer step published none.
    """
    if not isinstance(task, dict):
        return None
    subtasks = [s for s in (task.get("subtasks") or []) if isinstance(s, dict)]
    if not subtasks:
        return None
    if not _all_subtasks_terminal(subtasks):
        return None

    ref = str(answer_from_ref or task.get("answer_from_ref") or "").strip()
    if not ref:
        return None

    answer_step = _find_subtask_by_ref(subtasks, ref)
    if answer_step is None:
        return None
    step_status = str(answer_step.get("status") or "").strip().lower()
    if step_status != "completed":
        # Answer step itself failed — don't promote its output; let the
        # natural failed-status rollup handle messaging.
        return None

    report = _step_task_report(answer_step)
    if not report:
        return None

    answer_outputs = _step_outputs(answer_step)
    if answer_outputs:
        outputs = answer_outputs
    else:
        all_outputs: list[dict[str, str]] = []
        for st in subtasks:
            all_outputs.extend(_step_outputs(st))
        outputs = all_outputs

    patch: dict[str, Any] = {
        "result_summary": report[:8000],
        "result_text": report[:8000],
        "outputs": outputs,
        "rollup_applied_at": utc_now_iso_z(),
        "rollup_mode": "answer_node_only",
        "rollup_source_ref": ref,
    }
    return patch


# ──────────────────────────── auto rollup step ──────────────────────────


def _find_all_step_refs(steps: list[dict[str, Any]]) -> list[str]:
    """Return refs of all user-defined steps (excludes rollup itself)."""
    refs = []
    seen: set[str] = set()
    for s in steps:
        if not isinstance(s, dict):
            continue
        ref = str(s.get("ref") or "").strip()
        if ref and ref not in seen:
            refs.append(ref)
            seen.add(ref)
    return refs


def _find_leaf_step_refs(steps: list[dict[str, Any]]) -> list[str]:
    """Return refs of steps that no other step depends on (DAG leaves)."""
    refs = {str(s.get("ref") or "").strip() for s in steps if isinstance(s, dict)}
    refs.discard("")
    has_downstream: set[str] = set()
    for s in steps:
        if not isinstance(s, dict):
            continue
        for dep in s.get("depends_on") or []:
            dep_s = str(dep or "").strip()
            if dep_s and dep_s in refs:
                has_downstream.add(dep_s)
    return sorted(refs - has_downstream)


def needs_auto_rollup(app: dict[str, Any]) -> bool:
    """Whether an App definition requires rollup.

    Rollup is mandatory for every multi-step workflow (it is the default, not
    an option): any workflow with more than one user-defined step gets a final
    rollup regardless of the stored ``final_rollup`` value (incl. legacy
    ``off``). Only single-step workflows skip it — there is nothing to aggregate.
    """
    if not isinstance(app, dict):
        return False
    steps = app.get("steps") or []
    # Skip trivial single-step workflows (nothing to aggregate)
    if len(steps) <= 1:
        return False
    return True


def build_rollup_subtask_spec(
    app: dict[str, Any],
    *,
    goal: str = "",
    validation: list[str] | None = None,
) -> dict[str, Any]:
    """Build the spec for the virtual rollup subtask.

    The rollup step depends on every leaf step of the DAG so it only starts
    once all user-defined work is done.
    """
    if not isinstance(app, dict):
        app = {}
    steps = app.get("steps") or []
    # Depend on EVERY step (not just leaves) so the dependency-context injection
    # feeds the rollup worker all step task_reports, not just the final leaf ones.
    # DAG-scheduling-wise this is equivalent to depending only on leaves (since
    # leaves already depend on their ancestors), but the rollup step receives
    # richer context for synthesis.
    all_refs = _find_all_step_refs(steps)
    agent = str(app.get("final_rollup_agent") or "").strip() or _DEFAULT_ROLLUP_AGENT
    custom_instr = str(app.get("final_rollup_instruction") or "").strip()

    validation_items = validation if isinstance(validation, list) else []
    validation_text = "\n".join(f"- {item}" for item in validation_items) if validation_items else "（未设置验收标准）"

    goal_text = (
        "你是这个工作流的收尾汇总员。所有步骤都已完成，请整合所有步骤的产出，"
        "生成最终报告并对照验收标准逐项检查。"
    )

    instruction = f"""## 工作流目标
{goal or "（未填写）"}

## 验收标准
{validation_text}

## 你的任务
1. 通读所有上游步骤的任务汇报（已在上下文的 "Upstream dependency output" 部分提供），理解整体产出与各步骤结论
2. 对照上面的验收标准，逐项判断是否达成（通过 / 部分达成 / 未达成）
3. 整合所有步骤的产出，生成一份完整的最终汇总报告
4. 列出所有产出文件（合并各步骤的 outputs）
5. 给出最终结论：通过 / 有保留通过 / 未通过，并说明理由

## 输出要求（最后必须调用 subtask_outcome_report）
- outcome: completed（汇总动作完成，即使部分步骤失败也要输出汇总）
- summary: 最终结论 + 核心要点（300 字以内，给任务中心列表展示用）
- task_report: 完整的汇总报告（含验收核对、各步骤摘要、产出清单、最终结论）
- outputs: 合并所有上游步骤的产出文件列表
"""
    if custom_instr:
        instruction += f"\n## 自定义补充说明\n{custom_instr}\n"

    return {
        "ref": ROLLUP_REF,
        "name": _ROLLUP_SUBTASK_NAME,
        "goal": goal_text,
        "inputs": "所有上游步骤的 task_report 与 outputs",
        "outputs": "最终汇总报告 + 全部产出文件清单",
        "acceptance": "完成所有步骤结果的整合 + 验收标准核对 + 最终结论",
        "assigned_agent": agent,
        "depends_on": all_refs,
        "instruction": instruction,
        "is_rollup_step": True,
    }


def append_rollup_subtask(
    task_id: str,
    app: dict[str, Any],
    *,
    goal: str = "",
    validation: list[str] | None = None,
    storage: Any | None = None,
) -> dict[str, Any] | None:
    """Append the virtual rollup subtask to an existing workflow task.

    Returns info about the added subtask, or ``None`` when not needed
    (single-step workflows, rollup already present, etc.).
    """
    from evoflow.collab.id_format import make_subtask_id
    from evoflow.collab.plan_subtasks_sync import build_worker_profile_from_step
    from evoflow.collab.storage import find_main_task, get_project_storage
    from evoflow.persistence.task_repositories import save_task_bundle
    from evoflow.timeutil import utc_now_iso_z

    if not needs_auto_rollup(app):
        return None

    store = storage if storage is not None else get_project_storage()
    row = find_main_task(store, task_id)
    if not row:
        return None
    project, task = row

    subtasks = task.get("subtasks") or []
    # Guard: don't double-add (ref or worker_profile flag)
    for st in subtasks:
        if is_rollup_subtask(st):
            return None

    spec = build_rollup_subtask_spec(app, goal=goal, validation=validation)
    agent = spec.get("assigned_agent") or _DEFAULT_ROLLUP_AGENT
    all_refs = spec.get("depends_on") or []

    wp = build_worker_profile_from_step(
        spec,
        assigned=agent,
        depends_refs=all_refs,
    )
    # Mark the worker_profile so downstream logic can identify it
    wp["is_rollup_step"] = True
    wp["rollup_mode"] = "auto"

    now = utc_now_iso_z()
    sid = make_subtask_id()
    rollup_row: dict[str, Any] = {
        "id": sid,
        "ref": ROLLUP_REF,
        "name": spec.get("name") or _ROLLUP_SUBTASK_NAME,
        "description": spec.get("goal") or "",
        "status": "planned",
        "dependencies": list(all_refs),
        "assigned_to": agent,
        "assigned_agent_name": "汇总员",
        "result": None,
        "error": None,
        "created_at": now,
        "started_at": None,
        "completed_at": None,
        "progress": 0,
        "worker_profile": wp,
        "is_rollup_step": True,
    }

    # Append and save
    subtasks = list(subtasks) + [rollup_row]
    task["subtasks"] = subtasks
    save_task_bundle(task_id, project)

    return {
        "subtask_id": sid,
        "ref": ROLLUP_REF,
        "name": rollup_row["name"],
        "depends_on": all_refs,
        "assigned_agent": agent,
    }


def is_rollup_subtask(subtask: dict[str, Any]) -> bool:
    """Identify the virtual rollup subtask from any subtask row."""
    if not isinstance(subtask, dict):
        return False
    if str(subtask.get("ref") or "").strip() == ROLLUP_REF:
        return True
    wp = subtask.get("worker_profile")
    if isinstance(wp, dict) and bool(wp.get("is_rollup_step")):
        return True
    return False


def apply_rollup_result_to_main_task(
    task: dict[str, Any],
    rollup_subtask: dict[str, Any],
    *,
    all_subtasks: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """Promote the rollup subtask's outcome onto the main task row.

    Returns a patch dict (not the full task).  Caller is responsible for
    persisting the patch onto project storage.

    When the rollup step has deliverables, those alone become the main-task
    outputs (UI should show the summary node, not every intermediate file).
    Fallback: if the rollup published nothing, union non-rollup step outputs.
    """
    report = _step_task_report(rollup_subtask)
    rollup_outputs = _step_outputs(rollup_subtask)

    if rollup_outputs:
        outputs = rollup_outputs
    else:
        # Rollup published no files — fall back so deliverables are not lost.
        extra_outputs: list[dict[str, str]] = []
        if all_subtasks:
            for st in all_subtasks:
                if is_rollup_subtask(st):
                    continue
                extra_outputs.extend(_step_outputs(st))
        outputs = merge_task_outputs([], extra_outputs)

    patch: dict[str, Any] = {
        "result_summary": report[:8000] if report else "",
        "result_text": report[:8000] if report else "",
        "outputs": outputs,
        "rollup_applied_at": utc_now_iso_z(),
        "rollup_mode": "auto",
        "rollup_source_ref": ROLLUP_REF,
    }
    return patch


# ──────────────────────────── public entry point ────────────────────────


def maybe_rollup_main_task(
    task: dict[str, Any],
    *,
    answer_from_ref: str = "",
) -> dict[str, Any] | None:
    """Top-level helper: decide which rollup (if any) applies and return a patch.

    Returns ``None`` when no rollup action is due.
    """
    if not isinstance(task, dict):
        return None
    if not _is_app_sourced_task(task):
        return None

    mode = _app_rollup_mode(task)
    # Rollup is mandatory; mode is never "off" here (off resolves to auto).

    subtasks = [s for s in (task.get("subtasks") or []) if isinstance(s, dict)]
    if not subtasks:
        return None

    # If a rollup subtask already exists and is completed, promote its result.
    for st in subtasks:
        if is_rollup_subtask(st):
            st_status = str(st.get("status") or "").strip().lower()
            if st_status == "completed":
                # Re-apply when rollup gained file outputs after the first promote
                # (common race: status→completed before outputs are persisted).
                if task.get("rollup_applied_at"):
                    from evoflow.collab.task_outputs import normalize_task_outputs

                    have_values = {
                        str(o.get("value") or "").replace("\\", "/").lower()
                        for o in normalize_task_outputs(task.get("outputs"))
                        if str(o.get("value") or "").strip()
                    }
                    missing = False
                    for o in _step_outputs(st):
                        val = str(o.get("value") or "").replace("\\", "/").lower().strip()
                        if val and val not in have_values:
                            missing = True
                            break
                    if not missing:
                        return None
                return apply_rollup_result_to_main_task(task, st, all_subtasks=subtasks)
            return None  # rollup step exists but not yet done — wait

    # No rollup subtask → answer_node_only mode (auto mode would have added one
    # at run start via app_runner).
    if mode == "answer_node_only":
        # Guard: don't re-apply if already rolled up.
        if task.get("rollup_applied_at"):
            return None
        return apply_answer_node_rollup(task, answer_from_ref=answer_from_ref)

    return None


__all__ = [
    "ROLLUP_REF",
    "apply_answer_node_rollup",
    "apply_rollup_result_to_main_task",
    "build_rollup_subtask_spec",
    "is_rollup_subtask",
    "maybe_rollup_main_task",
    "needs_auto_rollup",
]
