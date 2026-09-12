"""Continue an existing subtask worker session (Claude Code / ACP) with full context."""

from __future__ import annotations

import json
import logging
from typing import Any

from evoflow.collab.storage import find_main_task, rollup_root_task_progress_from_subtasks
from evoflow.collab.subtask_conversation import append_subtask_conversation_turn
from evoflow.timeutil import utc_now_iso_z
from evoflow.tools.builtins.supervisor.memory import _broadcast_task_event

logger = logging.getLogger(__name__)


def _assigned_is_claude(assigned: str) -> bool:
    n = assigned.strip().lower().replace("_", "-")
    return n in {"claude-code", "claude-session", "claude"}


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
    """Send a follow-up message to the subtask worker and optionally persist the turn."""
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
    is_claude = _assigned_is_claude(assigned)
    is_acp = assigned in _acp_agent_names()
    if not is_claude and not is_acp:
        return {
            "success": False,
            "action": "continue_subtask_session",
            "taskId": task_id,
            "subtaskId": subtask_id,
            "error": "Subtask is not assigned to claude-code / claude-session or ACP provider",
            "assignedTo": target_subtask.get("assigned_to"),
        }

    session_id = str(target_subtask.get("claude_session_id") or "").strip() or str(target_subtask.get("external_session_id") or "").strip()
    acp_supervisor_sid = str(target_subtask.get("acp_supervisor_session_id") or "").strip()

    if is_claude and not session_id:
        return {
            "success": False,
            "action": "continue_subtask_session",
            "taskId": task_id,
            "subtaskId": subtask_id,
            "error": "No bound claude_session_id on subtask. Run start_execution first.",
        }

    if is_acp and not acp_supervisor_sid:
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

    reply_text = ""
    result: dict[str, Any] | None = None
    try:
        if is_acp:
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
                result = {
                    "success": False,
                    "action": "continue_subtask_session",
                    "taskId": task_id,
                    "subtaskId": subtask_id,
                    "supervisorSessionId": acp_supervisor_sid,
                    "error": target_subtask.get("error"),
                    "keepSessionOpen": keep_session_open,
                }
                return result

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

        from evoflow.tools.builtins.claude_session_tool import claude_session_tool

        send_res = await claude_session_tool.ainvoke(
            {
                "action": "send",
                "session_id": session_id,
                "message": msg,
                "stream_to_chat": False,
                "stream_to_subtask_id": subtask_id,
                "stream_to_main_task_id": task_id,
            }
        )
        if not bool(send_res.get("ok")):
            target_subtask["status"] = "failed"
            target_subtask["updated_at"] = utc_now_iso_z()
            target_subtask["error"] = str(send_res.get("error") or "claude_session send failed")
            storage.save_project(project)
            await _broadcast_task_event(
                task_id,
                "task:failed",
                {"task_id": subtask_id, "error": target_subtask.get("error")},
            )
            result = {
                "success": False,
                "action": "continue_subtask_session",
                "taskId": task_id,
                "subtaskId": subtask_id,
                "sessionId": session_id,
                "error": target_subtask.get("error"),
                "keepSessionOpen": keep_session_open,
            }
            return result

        read_res = await claude_session_tool.ainvoke(
            {
                "action": "read",
                "session_id": session_id,
                "lines": max(1, int(read_lines or 200)),
            }
        )
        lines = read_res.get("lines", []) if isinstance(read_res, dict) else []
        pieces = [str(x or "") for x in lines if str(x or "")]
        reply_text = "".join(pieces).strip() or "\n".join(str(x) for x in lines if str(x).strip()).strip()
        reply_lines = [ln for ln in reply_text.splitlines() if ln.strip()] if reply_text else []

        closed = True
        close_error: str | None = None
        if keep_session_open:
            closed = False
        else:
            close_res = await claude_session_tool.ainvoke({"action": "close", "session_id": session_id})
            closed = bool(close_res.get("ok"))
            if not closed:
                close_error = str(close_res.get("error") or "close session failed")
            else:
                target_subtask["session_closed_at"] = utc_now_iso_z()

        target_subtask["updated_at"] = utc_now_iso_z()
        if not closed and not keep_session_open:
            target_subtask["status"] = "failed"
            target_subtask["progress"] = max(0, min(100, int(target_subtask.get("progress") or 0)))
            target_subtask["error"] = close_error or "close session failed"
            await _broadcast_task_event(
                task_id,
                "task:failed",
                {"task_id": subtask_id, "error": target_subtask.get("error") or close_error or "failed"},
            )
        else:
            target_subtask["status"] = "in_progress"
            target_subtask["progress"] = max(0, min(99, int(target_subtask.get("progress") or 0) or 10))
            if not keep_session_open and closed:
                target_subtask["current_step"] = "claude_session 本轮已结束，待 Lead 验收或 subtask_outcome_report"
        storage.save_project(project)
        rollup_root_task_progress_from_subtasks(storage, task_id)

        status_norm = str(target_subtask.get("status") or "").strip().lower()

        result = {
            "success": status_norm != "failed",
            "action": "continue_subtask_session",
            "taskId": task_id,
            "subtaskId": subtask_id,
            "sessionId": session_id,
            "sessionSource": send_res.get("session_source"),
            "streamedLines": int(send_res.get("streamed_lines") or 0),
            "responseLines": reply_lines,
            "responseText": reply_text,
            "status": target_subtask.get("status"),
            "sessionClosed": closed if not keep_session_open else False,
            "sessionCloseError": close_error,
            "keepSessionOpen": keep_session_open,
            "waitForCompletion": wait_for_completion,
            "terminal": status_norm in {"completed", "failed", "cancelled"},
            "shouldStopMonitoring": status_norm in {"completed", "failed", "cancelled"},
            "mustContinueMonitoring": status_norm not in {"completed", "failed", "cancelled"},
            "nextMonitorInSeconds": 0 if status_norm in {"completed", "failed", "cancelled"} else 2,
        }
        return result
    finally:
        if reply_text:
            append_subtask_conversation_turn(
                storage,
                task_id,
                subtask_id,
                user_text="",
                assistant_text=reply_text,
                source=conversation_source,
            )

    return result or {
        "success": False,
        "action": "continue_subtask_session",
        "taskId": task_id,
        "subtaskId": subtask_id,
        "error": "continue_subtask_session did not run",
    }
