"""Continue an existing ACP subtask worker session with full context."""

from __future__ import annotations

import json
import logging
from typing import Any

from evoflow.collab.storage import find_main_task, rollup_root_task_progress_from_subtasks
from evoflow.collab.subtask_conversation import append_subtask_conversation_turn
from evoflow.timeutil import utc_now_iso_z
from evoflow.tools.builtins.supervisor.memory import _broadcast_task_event

logger = logging.getLogger(__name__)


def _acp_agent_names() -> set[str]:
    try:
        from evoflow.config.acp_config import get_acp_agents

        return {str(k).strip().lower().replace("_", "-") for k in get_acp_agents().keys()}
    except Exception:
        return set()


async def continue_subtask_session(
    *,
    storage: Any,
    task_id: str,
    subtask_id: str,
    agent_message: str,
    read_lines: int = 200,
    keep_session_open: bool = True,
    wait_for_completion: bool = True,
    runtime: Any | None = None,
    conversation_source: str = "continue_subtask_session",
) -> dict[str, Any]:
    """Send a follow-up message to the ACP subtask worker and optionally persist the turn."""
    msg = str(agent_message or "").strip()
    if not msg:
        return {
            "success": False,
            "action": "continue_subtask_session",
            "taskId": task_id,
            "subtaskId": subtask_id,
            "error": "agent_message is required",
        }

    row = find_main_task(storage, task_id)
    if not row:
        return {
            "success": False,
            "action": "continue_subtask_session",
            "taskId": task_id,
            "subtaskId": subtask_id,
            "error": f"Task '{task_id}' not found",
        }

    project, task = row
    target_subtask: dict[str, Any] | None = None
    for st in task.get("subtasks") or []:
        if str(st.get("id") or "").strip() == subtask_id:
            target_subtask = st
            break
    if target_subtask is None:
        return {
            "success": False,
            "action": "continue_subtask_session",
            "taskId": task_id,
            "subtaskId": subtask_id,
            "error": f"Subtask '{subtask_id}' not found in task '{task_id}'",
        }

    assigned = str(target_subtask.get("assigned_to") or "").strip().lower().replace("_", "-")
    is_acp = assigned in _acp_agent_names()
    if not is_acp:
        return {
            "success": False,
            "action": "continue_subtask_session",
            "taskId": task_id,
            "subtaskId": subtask_id,
            "error": "Subtask is not assigned to an ACP provider",
            "assignedTo": target_subtask.get("assigned_to"),
        }

    acp_supervisor_sid = str(target_subtask.get("acp_supervisor_session_id") or "").strip()

    if not acp_supervisor_sid:
        from evoflow.tools.builtins.invoke_acp_agent_tool import build_invoke_acp_agent_tool
        from evoflow.tools.builtins.supervisor.acp_session_registry import find_reusable_for_task

        reusable = find_reusable_for_task(
            provider=assigned,
            thread_id=str(task.get("thread_id") or "").strip() or None,
            task_id=task_id,
        )
        if reusable is not None:
            acp_supervisor_sid = str(reusable.supervisor_session_id or "").strip()
            if acp_supervisor_sid:
                target_subtask["acp_supervisor_session_id"] = acp_supervisor_sid
                storage.save_project(project)
        if not acp_supervisor_sid:
            try:
                from evoflow.config.acp_config import get_acp_agents

                invoke_tool = build_invoke_acp_agent_tool(get_acp_agents())
                local_root = ""
                if runtime is not None:
                    try:
                        cfg = getattr(runtime, "config", None) or {}
                        local_root = str((cfg.get("configurable") or {}).get("local_workspace_root") or "").strip()
                    except Exception:
                        local_root = ""
                project_path = str(target_subtask.get("project_path") or "").strip() or local_root or "./"
                start_raw = await invoke_tool.ainvoke(
                    {
                        "agent": assigned,
                        "action": "start",
                        "task_id": task_id,
                        "subtask_id": subtask_id,
                        "project_path": project_path,
                    },
                    config={"configurable": {"thread_id": task.get("thread_id")}} if task.get("thread_id") else None,
                )
                start_obj = json.loads(start_raw) if isinstance(start_raw, str) else {}
                if bool(start_obj.get("ok")):
                    acp_supervisor_sid = str(start_obj.get("supervisor_session_id") or "").strip()
                    if acp_supervisor_sid:
                        target_subtask["acp_supervisor_session_id"] = acp_supervisor_sid
                        target_subtask["project_path"] = project_path
                        storage.save_project(project)
                else:
                    return {
                        "success": False,
                        "action": "continue_subtask_session",
                        "taskId": task_id,
                        "subtaskId": subtask_id,
                        "error": str(start_obj.get("error") or start_raw or "acp start failed"),
                        "assignedTo": target_subtask.get("assigned_to"),
                    }
            except Exception as e:
                return {
                    "success": False,
                    "action": "continue_subtask_session",
                    "taskId": task_id,
                    "subtaskId": subtask_id,
                    "error": f"Failed to initialize ACP session: {e}",
                    "assignedTo": target_subtask.get("assigned_to"),
                }

    append_subtask_conversation_turn(
        storage,
        task_id,
        subtask_id,
        user_text=msg,
        assistant_text=None,
        source=conversation_source,
    )

    now = utc_now_iso_z()
    target_subtask["status"] = "in_progress"
    target_subtask["updated_at"] = now
    target_subtask.pop("session_closed_at", None)
    storage.save_project(project)

    from evoflow.config.acp_config import get_acp_agents
    from evoflow.tools.builtins.invoke_acp_agent_tool import build_invoke_acp_agent_tool

    invoke_tool = build_invoke_acp_agent_tool(get_acp_agents())
    send_raw = await invoke_tool.ainvoke(
        {
            "agent": assigned,
            "action": "send",
            "prompt": msg,
            "supervisor_session_id": acp_supervisor_sid,
            "task_id": task_id,
            "subtask_id": subtask_id,
        },
        config={"configurable": {"thread_id": task.get("thread_id")}} if task.get("thread_id") else None,
    )
    send_obj = json.loads(send_raw) if isinstance(send_raw, str) else {}
    if not bool(send_obj.get("ok")):
        target_subtask["status"] = "failed"
        target_subtask["updated_at"] = utc_now_iso_z()
        target_subtask["error"] = str(send_obj.get("error") or "acp send failed")
        storage.save_project(project)
        await _broadcast_task_event(
            task_id,
            "task:failed",
            {"task_id": subtask_id, "error": target_subtask.get("error")},
        )
        return {
            "success": False,
            "action": "continue_subtask_session",
            "taskId": task_id,
            "subtaskId": subtask_id,
            "supervisorSessionId": acp_supervisor_sid,
            "error": target_subtask.get("error"),
            "keepSessionOpen": keep_session_open,
        }

    reply_text = str(send_obj.get("result") or "").strip()
    target_subtask["updated_at"] = utc_now_iso_z()
    target_subtask["status"] = "in_progress"
    target_subtask["progress"] = max(0, min(99, int(target_subtask.get("progress") or 0) or 10))
    if not keep_session_open:
        target_subtask["current_step"] = "ACP 本轮已结束（会话可关），待 Lead 验收或 subtask_outcome_report"
    storage.save_project(project)
    rollup_root_task_progress_from_subtasks(storage, task_id)

    result = {
        "success": True,
        "action": "continue_subtask_session",
        "taskId": task_id,
        "subtaskId": subtask_id,
        "supervisorSessionId": acp_supervisor_sid,
        "responseText": reply_text,
        "status": target_subtask.get("status"),
        "keepSessionOpen": keep_session_open,
        "waitForCompletion": wait_for_completion,
        "terminal": False,
        "shouldStopMonitoring": False,
        "mustContinueMonitoring": True,
        "nextMonitorInSeconds": 2,
    }
    return result
