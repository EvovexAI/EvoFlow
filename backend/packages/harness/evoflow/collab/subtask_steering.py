"""Lead steering for ephemeral (task_tool) collab subtasks — interrupt + redelegate."""

from __future__ import annotations

import logging
from typing import Any

from evoflow.timeutil import utc_now_iso_z

logger = logging.getLogger(__name__)


def is_ephemeral_task_tool_subtask(subtask_row: dict[str, Any] | None) -> bool:
    """True when subtask worker runs via in-process ``task_tool`` (not Claude/ACP session)."""
    if not isinstance(subtask_row, dict):
        return False
    from evoflow.tools.builtins.supervisor.execution import (
        _is_acp_worker,
        _is_claude_session_worker,
        _resolved_subagent_type_for_subtask,
    )

    worker = _resolved_subagent_type_for_subtask(subtask_row)
    return not _is_claude_session_worker(worker) and not _is_acp_worker(worker)


def interrupt_subtask_background_run(
    storage: Any,
    main_task_id: str,
    subtask_id: str,
    *,
    reason: str = "",
    cancelled_by: str = "lead",
) -> dict[str, Any]:
    """Cooperatively stop the detached ``task_tool`` background run for a subtask."""
    from evoflow.cancellation import mark_task_cancelled
    from evoflow.collab.storage import find_subtask_by_ids, patch_collab_subtask_in_project_storage
    from evoflow.subagents.executor import (
        _background_tasks,
        _background_tasks_lock,
        get_background_task_result,
    )

    mid = str(main_task_id or "").strip()
    sid = str(subtask_id or "").strip()
    st = find_subtask_by_ids(storage, mid, sid)
    if st is None:
        return {"ok": False, "error": f"Subtask '{sid}' not found in task '{mid}'"}

    bg_id = str(st.get("background_task_id") or "").strip()
    if not bg_id:
        active = False
        try:
            from evoflow.subagents.runtime_guard import is_subtask_background_executor_active

            active = is_subtask_background_executor_active(st)
        except Exception:
            active = False
        if not active:
            return {
                "ok": True,
                "interrupted": False,
                "taskId": mid,
                "subtaskId": sid,
                "message": "No active background run",
            }
        bg_id = bg_id or str(st.get("background_task_id") or "").strip()

    if not bg_id:
        return {
            "ok": True,
            "interrupted": False,
            "taskId": mid,
            "subtaskId": sid,
            "message": "No background_task_id on subtask",
        }

    why = str(reason or "").strip() or "interrupted by lead"
    mark_task_cancelled(bg_id, cancelled_by, why)

    try:
        from evoflow.core.scheduler.executor import cancel_subprocess

        cancel_subprocess(bg_id)
    except Exception:
        logger.debug("cancel_subprocess failed bg=%s", bg_id, exc_info=True)

    result = get_background_task_result(bg_id)
    active_statuses = {"pending", "running"}
    status_key = ""
    if result is not None:
        raw = result.status
        status_key = str(getattr(raw, "name", None) or getattr(raw, "value", raw) or "").lower()
    if result is not None and status_key in active_statuses:
        from datetime import datetime

        from evoflow.subagents.executor import SubagentStatus

        cancelled = SubagentStatus.CANCELLED
        with _background_tasks_lock:
            ent = _background_tasks.get(bg_id)
            if ent is not None:
                ent.status = cancelled
                ent.error = why
                ent.completed_at = datetime.now()

    now = utc_now_iso_z()
    patch_collab_subtask_in_project_storage(
        storage,
        mid,
        sid,
        {
            "status": "in_progress",
            "last_interrupt_at": now,
            "last_interrupt_reason": why[:2000],
            "background_task_id": "",
            "superseded_background_task_id": bg_id,
        },
    )
    return {
        "ok": True,
        "interrupted": True,
        "taskId": mid,
        "subtaskId": sid,
        "backgroundTaskId": bg_id,
        "reason": why,
    }


def build_steer_prompt_block(
    storage: Any,
    *,
    main_task_id: str,
    subtask_id: str,
    subtask_row: dict[str, Any],
    steer_message: str,
    steer_count: int,
    steer_context_mode: str = "truncated",
) -> str:
    """Conversation context + lead steer instruction for a new task_tool round.

    Args:
        steer_context_mode: Controls how much prior conversation is included.
            "full" — include up to 120 messages (legacy behavior, may cause repeat loops).
            "truncated" — include only the last 10 messages (default, prevents repeat loops).
            "clean" — no conversation history, only the original instruction + steer message.
    """
    from evoflow.collab.conversation_persist import list_subtask_conversation_ui_messages
    from evoflow.collab.storage import find_main_task
    from evoflow.tools.builtins.supervisor.conversation import build_subtask_conversation_payload

    msg = str(steer_message or "").strip()
    # Steer message FIRST — worker sees the correction before any history
    lines = [
        f"## Lead 纠偏指令（第 {steer_count} 轮）",
        msg,
        "",
        "请在本轮继续完成本子任务目标；**未完成前不要**调用 `subtask_outcome_report`。",
        "若需汇报进度，使用 `subtask_progress_report` / `subtask_work_checklist`。",
    ]

    mode = str(steer_context_mode or "truncated").strip().lower()
    if mode == "clean":
        return "\n".join(lines)

    # Truncated: only last 10 messages (vs legacy 120) to avoid repeating failed patterns
    history_limit = 10 if mode == "truncated" else 120

    row = find_main_task(storage, main_task_id)
    task = row[1] if row else None
    if isinstance(task, dict):
        payload = build_subtask_conversation_payload(
            storage,
            task_id=main_task_id,
            subtask_id=subtask_id,
            limit=history_limit,
        )
        transcript = str(payload.get("transcript") or "").strip()
        if transcript:
            lines.extend(["", "## 最近执行对话摘要（仅最近几条，避免重复之前的错误模式）", transcript])
        else:
            ui_msgs = list_subtask_conversation_ui_messages(task, subtask_id, subtask_row=subtask_row, limit=history_limit)
            if ui_msgs:
                lines.append("")
                lines.append(f"## 已有对话（{len(ui_msgs)} 条）")

    return "\n".join(lines)


async def steer_ephemeral_subtask(
    runtime: Any,
    storage: Any,
    *,
    main_task_id: str,
    subtask_id: str,
    steer_message: str,
    interrupt_first: bool = True,
    wait_for_completion: bool = False,
) -> dict[str, Any]:
    """Interrupt an active background run (optional) and start a new detached task_tool round."""
    from evoflow.collab.id_format import make_formatted_id
    from evoflow.collab.storage import find_subtask_by_ids, patch_collab_subtask_in_project_storage
    from evoflow.tools.builtins.collab_bridge import delegate_via_task_tool, is_bridge_ready
    from evoflow.tools.builtins.supervisor.execution import (
        _build_subtask_enriched_prompt,
        _register_collab_lead_runtime,
        _resolved_subagent_type_for_subtask,
        _worker_delegation_error,
    )

    mid = str(main_task_id or "").strip()
    sid = str(subtask_id or "").strip()
    msg = str(steer_message or "").strip()
    if not msg:
        return {"ok": False, "error": "agent_message is required for steer_subtask"}

    st = find_subtask_by_ids(storage, mid, sid)
    if st is None:
        return {"ok": False, "error": f"Subtask '{sid}' not found"}

    if not is_ephemeral_task_tool_subtask(st):
        return {
            "ok": False,
            "error": "steer_subtask currently supports task_tool workers only (not claude-code / ACP)",
            "assignedTo": st.get("assigned_to"),
        }

    status = str(st.get("status") or "").strip().lower()
    if status in {"completed", "failed", "cancelled", "timed_out"}:
        return {"ok": False, "error": f"Subtask is terminal ({status}); use retry_subtask to restart"}

    interrupt_info: dict[str, Any] | None = None
    if interrupt_first:
        interrupt_info = interrupt_subtask_background_run(storage, mid, sid, reason=msg[:500])

    steer_count = int(st.get("steer_count") or 0) + 1
    now = utc_now_iso_z()
    patch_collab_subtask_in_project_storage(
        storage,
        mid,
        sid,
        {
            "status": "in_progress",
            "steer_count": steer_count,
            "last_steer_at": now,
            "last_steer_message": msg[:4000],
        },
    )

    st = find_subtask_by_ids(storage, mid, sid) or st
    base_prompt = _build_subtask_enriched_prompt(
        subtask_row=st,
        main_task_id=mid,
        subtask_id=sid,
        storage=storage,
    )
    steer_block = build_steer_prompt_block(
        storage,
        main_task_id=mid,
        subtask_id=sid,
        subtask_row=st,
        steer_message=msg,
        steer_count=steer_count,
    )
    prompt = f"{base_prompt}\n\n{steer_block}"

    subagent_type = _resolved_subagent_type_for_subtask(st)
    worker_err = _worker_delegation_error(subagent_type)
    if worker_err:
        return {"ok": False, "error": worker_err}

    if runtime is None:
        return {"ok": False, "error": "No runtime: cannot delegate steer round"}

    task_ok, _follow_ok = is_bridge_ready()
    if not task_ok:
        return {"ok": False, "error": "task_tool unavailable (bridge not ready)"}

    _register_collab_lead_runtime(mid, runtime)

    name = str(st.get("name") or "subtask").strip() or "subtask"
    tcid = make_formatted_id("SupervisorSteer")
    try:
        out = await delegate_via_task_tool(
            runtime,
            description=f"steer:{name[:80]}",
            prompt=prompt,
            subagent_type=subagent_type,
            tool_call_id=tcid,
            max_turns=None,
            collab_task_id=mid,
            collab_subtask_id=sid,
            detach=not wait_for_completion,
        )
    except Exception as e:
        logger.exception("steer_ephemeral_subtask delegate failed main=%s sub=%s", mid, sid)
        return {"ok": False, "error": str(e)}

    text = out if isinstance(out, str) else str(out)
    detached = text.startswith("Task Detached.")
    return {
        "ok": True,
        "taskId": mid,
        "subtaskId": sid,
        "steerCount": steer_count,
        "interrupt": interrupt_info,
        "detached": detached,
        "waitForCompletion": wait_for_completion,
        "backgroundTaskId": tcid if detached else None,
        "resultPreview": text[:500],
        "terminal": False,
        "mustContinueMonitoring": True,
        "nextMonitorInSeconds": 2,
        "downstreamBlockedUntil": "subtask_outcome_report",
    }


__all__ = [
    "build_steer_prompt_block",
    "interrupt_subtask_background_run",
    "is_ephemeral_task_tool_subtask",
    "steer_ephemeral_subtask",
]
