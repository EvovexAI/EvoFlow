"""Dispatch workers after user authorizes execution (UI「开始执行」).

Calls ``supervisor_tool`` ``start_execution`` with a gateway-scoped tool runtime so
subtasks actually run without waiting for Lead Agent to remember the tool chain.
"""

from __future__ import annotations

import json
import logging
from typing import Any

from langchain.tools import ToolRuntime
from langgraph.prebuilt.tool_node import ToolRuntime as LangGraphToolRuntime
from langgraph.typing import ContextT

logger = logging.getLogger(__name__)


def gateway_tool_runtime(
    thread_id: str | None,
    *,
    main_task_id: str | None = None,
    subtask_id: str | None = None,
) -> ToolRuntime[ContextT, dict]:
    """Minimal runtime for ``delegate_via_task_tool`` outside an active LangGraph turn."""
    from evoflow.collab.id_format import make_formatted_id
    from evoflow.collab.sse_notify import make_gateway_task_stream_writer

    tid = str(thread_id or "").strip()
    configurable: dict[str, Any] = {"thread_id": tid} if tid else {}
    context: dict[str, Any] = {"thread_id": tid} if tid else {}
    mid = str(main_task_id or "").strip()
    if mid:
        context["collab_task_id"] = mid
        configurable["collab_task_id"] = mid
    sub = str(subtask_id or "").strip()
    if sub:
        context["collab_subtask_id"] = sub
        configurable["collab_subtask_id"] = sub
    stream_writer = make_gateway_task_stream_writer(mid) if mid else (lambda _chunk: None)
    tool_call_id = make_formatted_id("GatewayDispatch")
    if sub:
        tool_call_id = f"{tool_call_id}-{sub[:12]}"
    # Must be a real object: supervisor execution registers weakref.ref(runtime).
    return LangGraphToolRuntime(
        state={"messages": []},
        context=context,
        config={"configurable": configurable},
        store=None,
        stream_writer=stream_writer,
        tool_call_id=tool_call_id,
    )


async def dispatch_authorized_main_task_execution(
    task_id: str,
    *,
    thread_id: str | None = None,
    authorized_by: str = "user",
) -> dict[str, Any]:
    """Run ``supervisor(start_execution)`` when the main task is already authorized.

    Returns parsed JSON from ``supervisor_tool`` (``success`` False on gate errors).
    """
    from evoflow.collab.authorize_execution import is_task_execution_authorized
    from evoflow.collab.storage import find_main_task, get_project_storage
    from evoflow.tools.builtins.collab_bridge import ensure_collab_bridge_ready
    from evoflow.tools.builtins.supervisor_tool import supervisor_tool

    tid = str(task_id or "").strip()
    if not tid:
        return {"success": False, "action": "start_execution", "error": "task_id is required"}

    storage = get_project_storage()
    if not is_task_execution_authorized(storage, tid):
        return {
            "success": False,
            "action": "start_execution",
            "taskId": tid,
            "error": "Task not execution_authorized",
        }

    row = find_main_task(storage, tid)
    if not row:
        return {"success": False, "action": "start_execution", "taskId": tid, "error": "Task not found"}

    _project, task = row
    subtasks = task.get("subtasks") or []
    if not subtasks:
        from evoflow.collab.plan_subtasks_sync import ensure_subtasks_synced_before_start_execution

        pre_sync = ensure_subtasks_synced_before_start_execution(tid, storage=storage)
        row = find_main_task(storage, tid)
        if row:
            _project, task = row
            subtasks = task.get("subtasks") or []
        if not subtasks:
            return {
                "success": False,
                "action": "start_execution",
                "taskId": tid,
                "error": "no_subtasks",
                "message": (
                    "主任务无子任务。请先成功调用 plan（boundPlanReady）同步子任务，"
                    "或检查 plan 的 subtasksSync 是否 created>0。"
                ),
                "subtasksPreSync": pre_sync,
            }

    run_tid = str(thread_id or task.get("thread_id") or "").strip() or None
    runtime = gateway_tool_runtime(run_tid, main_task_id=tid)

    from evoflow.tools.builtins.supervisor.dependency import requeue_failed_subtasks_ready_for_retry

    requeued = requeue_failed_subtasks_ready_for_retry(storage, tid)
    if requeued:
        logger.info(
            "dispatch_authorized_main_task_execution: requeued failed subtasks task_id=%s ids=%s",
            tid,
            requeued,
        )

    task_ok, follow_ok = ensure_collab_bridge_ready()
    if not task_ok:
        return {
            "success": False,
            "action": "start_execution",
            "taskId": tid,
            "error": "task_tool_bridge_not_ready",
            "message": "task_tool delegate not registered; restart gateway or check tool imports",
        }

    logger.info(
        "dispatch_authorized_main_task_execution: task_id=%s thread_id=%s subtasks=%d bridge_task=%s bridge_follow=%s",
        tid,
        run_tid,
        len(subtasks),
        task_ok,
        follow_ok,
    )

    raw = await supervisor_tool.coroutine(
        runtime=runtime,
        action="start_execution",
        task_id=tid,
        tool_call_id="gateway-dispatch-start-execution",
        authorized_by=str(authorized_by or "user").strip() or "user",
    )
    try:
        data = json.loads(raw) if isinstance(raw, str) else {"success": False, "raw": raw}
    except json.JSONDecodeError:
        data = {"success": False, "action": "start_execution", "taskId": tid, "error": "invalid supervisor response", "raw": raw}
    if not isinstance(data, dict):
        data = {"success": False, "action": "start_execution", "taskId": tid, "error": "invalid supervisor response"}
    return data


__all__ = ["gateway_tool_runtime", "dispatch_authorized_main_task_execution"]
