"""Collaboration subtask terminal outcome — worker must call ``subtask_outcome_report``."""

from __future__ import annotations

import logging
from typing import Any, Literal

from evoflow.collab.storage import (
    find_subtask_by_ids,
    get_project_storage,
    get_task_detail_storage,
    persist_subtask_runtime_snapshot,
    rollup_root_task_progress_from_subtasks,
)
from evoflow.collab.task_outputs import (
    evidence_paths_from_outputs,
    merge_task_outputs,
    outputs_from_evidence_paths,
    task_outputs_of,
)
from evoflow.timeutil import utc_now_iso_z

logger = logging.getLogger(__name__)

TerminalOutcome = Literal["completed", "failed", "blocked", "cancelled", "timed_out"]

_TERMINAL = frozenset({"completed", "failed", "blocked", "cancelled", "timed_out"})
_SUCCESS = frozenset({"completed"})
_FAIL = frozenset({"failed", "blocked", "cancelled", "timed_out"})


def is_subtask_outcome_reported(row: dict[str, Any] | None) -> bool:
    if not row or not isinstance(row, dict):
        return False
    return bool(str(row.get("outcome_reported_at") or "").strip())


def is_upstream_subtask_dependency_met(row: dict[str, Any] | None) -> bool:
    """True when an upstream subtask is done for DAG purposes (``subtask_outcome_report`` + completed)."""
    if not row or not isinstance(row, dict):
        return False
    if not is_subtask_outcome_reported(row):
        return False
    return str(row.get("status") or "").strip().lower() == "completed"


def get_subtask_task_report(row: dict[str, Any] | None) -> str:
    """Official subtask completion report for collab UI / downstream (``subtask_outcome_report`` only)."""
    if not row or not isinstance(row, dict):
        return ""
    if not is_subtask_outcome_reported(row):
        return ""
    tr = str(row.get("task_report") or "").strip()
    if tr:
        return tr
    return str(row.get("result") or "").strip()


def build_subtask_outcome_snapshot(row: dict[str, Any] | None) -> dict[str, Any]:
    """Canonical handoff payload from ``subtask_outcome_report`` (not task memory / conversation)."""
    if not row or not isinstance(row, dict):
        return {
            "reported": False,
            "status": "",
            "task_report": "",
            "summary": "",
            "outcome_reported_at": None,
            "evidence_paths": [],
            "outputs": [],
        }
    reported = is_subtask_outcome_reported(row)
    report = get_subtask_task_report(row) if reported else ""
    outputs = task_outputs_of(row)
    paths = evidence_paths_from_outputs(outputs)
    if not paths:
        wp = row.get("worker_profile") if isinstance(row.get("worker_profile"), dict) else {}
        paths_raw = wp.get("evidence_paths") if isinstance(wp.get("evidence_paths"), list) else []
        paths = [str(p).strip() for p in paths_raw if str(p).strip()]
        if paths and not outputs:
            outputs = outputs_from_evidence_paths(paths)
    at = str(row.get("outcome_reported_at") or "").strip() or None
    return {
        "reported": reported,
        "status": str(row.get("status") or "").strip(),
        "task_report": report,
        "summary": report,
        "outcome_reported_at": at,
        "evidence_paths": paths,
        "outputs": outputs,
    }


def get_subtask_execution_preview(
    row: dict[str, Any] | None,
    *,
    main_task: dict[str, Any] | None = None,
) -> str:
    """Running text from chat transcript; legacy short row hints only."""
    if main_task and row:
        from evoflow.collab.conversation_persist import latest_subtask_conversation_text

        sid = str(row.get("id") or "").strip()
        text = latest_subtask_conversation_text(main_task, sid, subtask_row=row)
        if text:
            return text
    if not row or not isinstance(row, dict):
        return ""
    hint = str(row.get("execution_preview") or "").strip()
    return hint if len(hint) <= 160 else ""


def format_subtask_outcome_mandate_block() -> str:
    """Inject into collab subtask worker system prompt."""
    return """## 子任务终态上报（强制，最后一环）

你的 LangGraph 回合**结束不等于子任务完成**。必须在收尾前调用工具 **`subtask_outcome_report`** 一次，写入协作侧栏的真实状态与任务汇报。

**何时调用（结束前必做）**
- 目标达成、验收通过 → `outcome="completed"`，`summary` 写清产出路径、验收证据、结论
- 无法完成、验收失败、缺权限/缺信息 → `outcome="failed"`，`summary` + `error` 说明原因与已尝试步骤
- 被阻塞需 Lead 决策 → `outcome="blocked"`
- 主动放弃/范围取消 → `outcome="cancelled"`

**禁止**
- 只在对话里写「已完成 / 失败」而不调工具
- 未调用本工具就结束回合（系统会把子任务标为失败：`未调用 subtask_outcome_report`）

**参数**
- `summary`（必填）：**子任务完成汇报**（给 Lead / 协作侧栏），写清做了什么与验收结论
- `error`（`failed`/`blocked` 时建议填写）
- `outputs`（推荐）：结构化产出 `[{type,key,value,label?}]`，type=`file|url|text|other`
- `evidence_paths`（兼容旧参）：文件路径列表，等价于 `type=file` 的 outputs

**与智能体记忆区分**
- 本工具的 `summary` / `outputs` 写入协作子任务交工字段，是侧栏与验收的唯一依据
- 执行过程中的 `task_memory.output_summary` 仅为**智能体工作记忆**，不能代替本工具

**与 DAG / 下游子任务**
- 本工具返回成功后，协作状态即视为**已完成**，下游依赖子任务可以立即并行启动
- 你在此之后输出的简短收尾文字仅用于会话展示，**不会**阻塞下游；请勿在调用本工具后再做新的实质性工作

可先使用 `subtask_work_checklist` 记录步骤，并用 `subtask_progress_report` 在阶段边界上报 0–100 进度；**终态以 `subtask_outcome_report` 为准**。"""


def _normalize_outcome(raw: str) -> TerminalOutcome | None:
    s = str(raw or "").strip().lower()
    if s in {"complete", "done", "success", "succeeded"}:
        return "completed"
    if s in {"fail", "error"}:
        return "failed"
    if s in {"block", "blocked"}:
        return "blocked"
    if s in {"cancel", "cancelled", "canceled"}:
        return "cancelled"
    if s == "timed_out" or s == "timeout":
        return "timed_out"
    if s in _SUCCESS | _FAIL:
        return s  # type: ignore[return-value]
    return None


def _run_id_from_tool_runtime(runtime: Any | None) -> str | None:
    if runtime is None:
        return None
    for bag in (
        getattr(runtime, "context", None) or {},
        (getattr(runtime, "config", None) or {}).get("configurable") or {},
        (getattr(runtime, "config", None) or {}).get("metadata") or {},
    ):
        if not isinstance(bag, dict):
            continue
        rid = str(bag.get("run_id") or bag.get("runId") or "").strip()
        if rid:
            return rid
    return None


async def apply_subtask_outcome_report(
    *,
    main_task_id: str,
    subtask_id: str,
    outcome: str,
    summary: str,
    error: str | None = None,
    evidence_paths: list[str] | None = None,
    outputs: Any = None,
    reported_by: str = "worker",
    storage: Any | None = None,
    followup_runtime: Any | None = None,
    run_id: str | None = None,
    tool_call_id: str | None = None,
    structured_output: Any = None,
    output_schema: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Persist terminal subtask status from worker tool (source of truth)."""
    mid = str(main_task_id or "").strip()
    sid = str(subtask_id or "").strip()
    out = _normalize_outcome(outcome)
    summ = str(summary or "").strip()
    if not mid or not sid:
        return {"ok": False, "error": "main_task_id and subtask_id are required"}
    if not out:
        return {"ok": False, "error": "outcome must be completed|failed|blocked|cancelled"}
    if not summ:
        return {"ok": False, "error": "summary is required (task report for lead agent)"}

    from evoflow.collab.workflow_handoff_sanitize import (
        sanitize_output_item,
        sanitize_string_for_handoff,
        sanitize_value_for_handoff,
    )

    summ = sanitize_string_for_handoff(summ, 8000)

    store = storage if storage is not None else get_project_storage()
    st = find_subtask_by_ids(store, mid, sid)
    if not st:
        return {"ok": False, "error": "subtask not found"}

    prev = str(st.get("status") or "").strip().lower()
    if prev in _TERMINAL and is_subtask_outcome_reported(st) and prev != out:
        return {
            "ok": False,
            "error": f"subtask already reported as {prev}; cannot change to {out}",
            "previousStatus": prev,
        }

    now = utc_now_iso_z()
    err_text = str(error or "").strip()[:4000] if error else ""
    paths = [str(p).strip() for p in (evidence_paths or []) if str(p).strip()]
    output_items = merge_task_outputs(outputs, outputs_from_evidence_paths(paths))
    if output_items:
        output_items = [sanitize_output_item(item) for item in output_items if isinstance(item, dict)]
    if not paths:
        paths = evidence_paths_from_outputs(output_items)
    # Keep task_report self-contained for Lead readers; UI also gets structured outputs.
    if paths and "产出路径" not in summ:
        summ = summ + "\n\n产出路径：\n" + "\n".join(f"- `{p}`" for p in paths)

    progress = 100 if out in _SUCCESS else max(0, min(int(st.get("progress") or 0), 99))
    report_text = summ[:8000]
    patch: dict[str, Any] = {
        "status": out,
        "progress": progress,
        "outcome_reported_at": now,
        "outcome_reported_by": reported_by,
        "updated_at": now,
        "task_report": report_text,
        "summary": report_text,
        "result": report_text if out in _SUCCESS else (st.get("result") or report_text),
    }
    if output_items:
        patch["outputs"] = output_items
        patch["evidence_paths"] = paths
    if out in _SUCCESS:
        patch["completed_at"] = st.get("completed_at") or now
        patch.pop("error", None)
    else:
        patch["error"] = err_text or summ[:2000]
        patch["failed_at"] = st.get("failed_at") or now
        if out == "cancelled":
            patch["status"] = "cancelled"

    # P0: Structured output extraction + schema validation
    from evoflow.collab.structured_output import process_step_output

    schema_to_use = output_schema
    if not schema_to_use:
        # Try to find schema from the subtask row itself
        row_schema = st.get("output_schema")
        if isinstance(row_schema, dict) and row_schema:
            schema_to_use = row_schema
        else:
            # Try plan_steps on the main task
            try:
                from evoflow.collab.plan_task_storage import load_plan_steps
                from evoflow.collab.storage import find_main_task
                from evoflow.collab.structured_output import get_step_output_schema

                row_pair = find_main_task(store, mid)
                if row_pair:
                    _proj, main_task_row = row_pair
                    plan_steps = load_plan_steps(main_task_row)
                    schema_to_use = get_step_output_schema(st, plan_steps=plan_steps)
            except Exception:
                logger.debug("structured_output: could not look up output_schema", exc_info=True)

    structured_result = process_step_output(
        report_text,
        schema_to_use,
        explicit_structured_output=structured_output,
    )
    if structured_result["structured_output"] is not None:
        patch["structured_output"] = sanitize_value_for_handoff(
            structured_result["structured_output"],
            max_str_len=1500,
        )
        patch["schema_valid"] = structured_result["schema_valid"]
        if structured_result["schema_errors"]:
            patch["schema_errors"] = structured_result["schema_errors"]

    # P0.5-1: Schema Enforcement Policy — when policy is "strict" and schema
    # validation failed, rewrite the outcome to "failed" so downstream DAG
    # dispatch is naturally blocked. Old behavior (warn) is the default.
    from evoflow.collab.schema_enforcement import enforce_schema_on_outcome, resolve_schema_policy

    # Look up the matching plan step for per-step policy override
    _enforcement_step: dict[str, Any] | None = None
    try:
        from evoflow.collab.plan_task_storage import load_plan_steps
        from evoflow.collab.storage import find_main_task

        row_pair = find_main_task(store, mid)
        if row_pair:
            _enforcement_proj, main_task_row = row_pair
            plan_steps = load_plan_steps(main_task_row)
            ref = str(st.get("ref") or "").strip()
            if ref and plan_steps:
                for ps in plan_steps:
                    if isinstance(ps, dict) and str(ps.get("ref") or "").strip() == ref:
                        _enforcement_step = ps
                        break
    except Exception:
        logger.debug("schema_enforcement: could not look up plan step", exc_info=True)

    enforcement_policy = resolve_schema_policy(step=_enforcement_step, task_row=st)
    enforcement_result = enforce_schema_on_outcome(
        outcome=out,
        structured_result=structured_result,
        policy=enforcement_policy,
        has_output_schema=bool(schema_to_use),
    )

    if enforcement_result["enforcement_action"] == "block":
        # Rewrite outcome to failed
        out = enforcement_result["outcome"]  # "failed"
        patch["status"] = out
        patch["progress"] = 0
        patch["error"] = enforcement_result["error"]
        patch["failed_at"] = st.get("failed_at") or now
        # Remove completed_at if it was set
        patch.pop("completed_at", None)
        patch["schema_enforcement_action"] = "block"
        patch["schema_enforcement_reason"] = enforcement_result["enforcement_reason"]
    elif enforcement_result["enforcement_action"] == "warn":
        patch["schema_enforcement_action"] = "warn"
        patch["schema_enforcement_reason"] = enforcement_result["enforcement_reason"]

    mem = get_task_detail_storage()
    ok = persist_subtask_runtime_snapshot(
        store,
        mem,
        mid,
        sid,
        status=patch["status"],
        progress=patch["progress"],
        task_report=report_text,
        result=str(patch.get("result") or "") or None,
        error=str(patch.get("error") or "") or None,
        current_step=f"Worker reported: {out}",
    )
    if not ok:
        return {"ok": False, "error": "persist subtask snapshot failed"}

    # outcome metadata on project row
    from evoflow.collab.storage import patch_collab_subtask_in_project_storage

    outcome_meta: dict[str, Any] = {
        "outcome_reported_at": now,
        "outcome_reported_by": reported_by,
        "task_report": report_text,
        "summary": report_text,
        "status": out,  # P0.5-1: sync possibly-rewritten outcome (e.g. failed by strict enforcement)
        "progress": patch["progress"],
    }
    # P0.5-1: When schema enforcement blocked the outcome, propagate error + enforcement metadata
    if enforcement_result["enforcement_action"] == "block":
        outcome_meta["error"] = enforcement_result["error"]
        outcome_meta["failed_at"] = patch.get("failed_at") or now
        outcome_meta["schema_enforcement_action"] = "block"
        outcome_meta["schema_enforcement_reason"] = enforcement_result["enforcement_reason"]
    elif enforcement_result["enforcement_action"] == "warn":
        outcome_meta["schema_enforcement_action"] = "warn"
        outcome_meta["schema_enforcement_reason"] = enforcement_result["enforcement_reason"]
    if structured_result["structured_output"] is not None:
        outcome_meta["structured_output"] = structured_result["structured_output"]
        outcome_meta["schema_valid"] = structured_result["schema_valid"]
        if structured_result["schema_errors"]:
            outcome_meta["schema_errors"] = structured_result["schema_errors"]
    if output_items:
        outcome_meta["outputs"] = output_items
        outcome_meta["evidence_paths"] = paths
        wp_row = st.get("worker_profile")
        if isinstance(wp_row, dict):
            wp_row = {**wp_row, "evidence_paths": paths}
            outcome_meta["worker_profile"] = wp_row
    elif paths:
        outcome_meta["evidence_paths"] = paths
        wp_row = st.get("worker_profile")
        if isinstance(wp_row, dict):
            wp_row = {**wp_row, "evidence_paths": paths}
            outcome_meta["worker_profile"] = wp_row
    patch_collab_subtask_in_project_storage(store, mid, sid, outcome_meta)

    try:
        from evoflow.collab.conversation_persist import append_subtask_outcome_record

        append_subtask_outcome_record(
            store,
            mid,
            sid,
            status=out,
            task_report=report_text,
            outcome_reported_at=now,
            run_id=run_id or _run_id_from_tool_runtime(followup_runtime),
            tool_call_id=tool_call_id,
        )
    except Exception:
        logger.debug("append subtask outcome record failed", exc_info=True)

    try:
        from evoflow.collab.sse_notify import broadcast_collab_task_event

        if out in _SUCCESS:
            await broadcast_collab_task_event(mid, "task:completed", {"task_id": sid, "result": summ[:4000]})
        elif out in _FAIL:
            await broadcast_collab_task_event(
                mid,
                "task:failed",
                {"task_id": sid, "error": patch.get("error") or summ[:4000]},
            )
    except Exception:
        logger.debug("broadcast after outcome report failed", exc_info=True)

    rollup_root_task_progress_from_subtasks(store, mid)

    if out in _SUCCESS:
        from evoflow.collab.dag_trace import dag_info

        dag_info(
            "outcome_followup_schedule main=%s completed_sub=%s outcome=%s runtime=%s",
            mid,
            sid,
            out,
            followup_runtime is not None,
        )

        try:
            from evoflow.tools.builtins.collab_bridge import schedule_followup_wave_needed

            # Resolve lead runtime inside follow-up handler; do not pass worker runtime
            # (subtask_outcome_report runs off-graph and lacks session model metadata).
            schedule_followup_wave_needed(None, mid)
        except Exception:
            logger.debug("schedule follow-up wave failed main=%s", mid, exc_info=True)

    return {
        "ok": True,
        "mainTaskId": mid,
        "subtaskId": sid,
        "status": out,
        "progress": patch["progress"],
        "outcomeReportedAt": now,
        "outputs": output_items,
        "schemaEnforcementAction": enforcement_result["enforcement_action"],
        "message": "子任务终态已写入；请勿在未改结果的情况下重复调用。",
    }


async def apply_subtask_system_outcome(
    *,
    main_task_id: str,
    subtask_id: str,
    outcome: str,
    summary: str,
    error: str | None = None,
    storage: Any | None = None,
) -> bool:
    """Backend-only terminal status (timeout/crash/no report). Skips if worker already reported."""
    store = storage if storage is not None else get_project_storage()
    st = find_subtask_by_ids(store, main_task_id, subtask_id)
    if st and is_subtask_outcome_reported(st):
        return False
    res = await apply_subtask_outcome_report(
        main_task_id=main_task_id,
        subtask_id=subtask_id,
        outcome=outcome,
        summary=summary,
        error=error,
        reported_by="system",
        storage=store,
    )
    return bool(res.get("ok"))


__all__ = [
    "TerminalOutcome",
    "is_subtask_outcome_reported",
    "is_upstream_subtask_dependency_met",
    "get_subtask_task_report",
    "build_subtask_outcome_snapshot",
    "get_subtask_execution_preview",
    "format_subtask_outcome_mandate_block",
    "apply_subtask_outcome_report",
    "apply_subtask_system_outcome",
]
