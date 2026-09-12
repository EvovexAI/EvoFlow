"""Task event handlers.

Processes task-related events and triggers appropriate actions.
The main handler is `handle_task_authorized` which triggers a Lead Agent conversation
to let the AI decide when to call supervisor_tool for task execution.
"""

import asyncio
import json
import logging
from datetime import UTC, datetime
from typing import Any

from evoflow.timeutil import utc_now_iso_z

from .event_queue import EventQueue, event_queue
from .task_events import (
    TaskAuthorizedEvent,
    TaskCancelEvent,
    TaskExecutionFailedEvent,
    TaskExecutionStartedEvent,
    TaskResumeEvent,
)

logger = logging.getLogger(__name__)

# Retry configuration
MAX_RETRY_ATTEMPTS = 3
RETRY_DELAY_SECONDS = [1, 5, 15]  # Exponential backoff

# LangGraph configuration
DEFAULT_LANGGRAPH_URL = "http://127.0.0.1:8070/api/langgraph"
DEFAULT_ASSISTANT_ID = "lead_agent"


_TASK_LINK_LOCK = asyncio.Lock()


async def _log_task_link(
    task_id: str,
    stage: str,
    status: str,
    details: dict | None = None,
) -> None:
    """统一任务链路日志 - 记录任务完整生命周期（不落盘，仅标准 logger）。"""
    try:
        import json

        # 避免并发下日志内容交错，保持单条日志为一个原子片段
        async with _TASK_LINK_LOCK:
            if details:
                details_str = json.dumps(details, ensure_ascii=False, default=str)
                if len(details_str) > 2000:
                    details_str = details_str[:1997] + "..."
                logger.info("[task_link] task=%s stage=%s status=%s details=%s", task_id, stage, status, details_str)
            else:
                logger.info("[task_link] task=%s stage=%s status=%s", task_id, stage, status)
    except Exception as e:
        logger.debug("Failed to emit task_link log: %s", e)


# 为了保持兼容，保留旧函数但使用新日志
async def _log_lead_agent_execution(
    task_id: str,
    thread_id: str | None,
    phase: str,
    details: dict | None = None,
) -> None:
    """【已迁移】使用统一日志记录 Lead Agent 执行"""
    await _log_task_link(task_id=task_id, stage="lead_agent", status="info", details={"phase": phase, "thread_id": thread_id, **(details or {})})


async def handle_task_authorized(event: TaskAuthorizedEvent) -> None:
    """Handle task authorized event: trigger Lead Agent conversation.

    This is the core handler that bridges the gap between API authorization
    and actual task execution. Instead of directly calling supervisor_tool,
    it triggers a Lead Agent conversation via LangGraph, allowing the AI to
    autonomously decide when to call supervisor_tool(action="start_execution").

    This approach:
    1. Validates task state
    2. Sends a message to Lead Agent via LangGraph runs.create/stream
    3. Lead Agent sees the task authorization and calls supervisor_tool
    4. supervisor_tool handles actual subtask delegation with proper ToolRuntime

    Args:
        event: TaskAuthorizedEvent with task_id, project_id, etc.
    """
    task_id = event.task_id
    thread_id = event.thread_id

    # 🔥 记录事件处理入口
    await _log_task_link(task_id=task_id, stage="authorize", status="start", details={"thread_id": thread_id, "authorized_by": event.authorized_by})

    await _log_lead_agent_execution(task_id=task_id, thread_id=thread_id, phase="收到任务授权事件", details={"授权人": event.authorized_by, "来源": event.source, "策略": "触发 Lead Agent 对话 (而非直接调用工具)"})

    # Import broadcaster lazily to avoid circular dependencies
    try:
        from app.gateway.routers.events import broadcaster
    except ImportError:
        broadcaster = None
        logger.warning("Could not import broadcaster, SSE events will not be sent")

    try:
        # Import here to avoid circular dependencies at module load time
        from evoflow.collab.storage import find_main_task, get_project_storage

        # 1. Find and validate task
        storage = get_project_storage()
        row = find_main_task(storage, task_id)

        await _log_task_link(task_id=task_id, stage="authorize", status="storage_ok", details={"found": row is not None})

        if not row:
            logger.error(f"任务 {task_id} 未找到")
            await _log_task_link(task_id=task_id, stage="authorize", status="fail", details={"error": "Task not found"})
            await _emit_execution_failed(event, "Task not found", retryable=False)
            return

        project, task = row

        await _log_task_link(task_id=task_id, stage="authorize", status="success", details={"project": project.get("name", "unknown"), "task_name": task.get("name", "unknown")})

        # 2. Check task status
        status = task.get("status", "")
        if status not in ["planning", "planned", "awaiting_exec", "pending"]:
            logger.warning(f"任务 {task_id} 状态 '{status}' 不适合执行")
            await _emit_execution_failed(event, f"Task status '{status}' not suitable for execution", retryable=False)
            return

        # 3. Check authorization flag
        if not task.get("execution_authorized"):
            logger.warning(f"任务 {task_id} 未授权")
            await _emit_execution_failed(event, "Task not authorized", retryable=False)
            return

        # 4. Subtasks exist: Lead must call supervisor(start_execution) in-graph (stream + monitor).
        subtasks = task.get("subtasks", [])

        # 5. Prepare and send message to Lead Agent via LangGraph
        # Build task summary for the AI
        task_name = task.get("name", "Unnamed Task")
        task_desc = task.get("description", "")
        # Preserve the user's original intent from conversation, not only condensed task_description.
        # This avoids losing key constraints such as ordering / parallelism / data handoff rules.
        latest_user_requirement = ""
        lead_thread = str(thread_id or task.get("thread_id") or "").strip()
        if lead_thread:
            try:
                from evoflow.persistence import chat_message_repositories as msg_repo

                for msg in reversed(msg_repo.conversation_archive_from_thread_id(lead_thread, limit=200)):
                    if not isinstance(msg, dict):
                        continue
                    role = str(msg.get("role") or msg.get("type") or "").strip().lower()
                    if role not in {"user", "human"}:
                        continue
                    content = msg.get("content")
                    if isinstance(content, str) and content.strip():
                        latest_user_requirement = content.strip()
                        break
            except Exception:
                logger.debug("latest user requirement from chat failed", exc_info=True)
        subtask_summary = []
        for st in subtasks:
            st_name = st.get("name", "Unnamed")
            st_status = st.get("status", "pending")
            subtask_summary.append(f"- {st_name} ({st_status})")

        # Compose the message to Lead Agent
        if subtasks:
            planning_instruction = (
                f'任务已获用户授权。请按顺序调用 supervisor：'
                f'① action="set_task_state", task_id="{task_id}", status="planned"（若已是 planned 可跳过）；'
                f'② action="start_execution", task_id="{task_id}"。'
                f'子任务已由 plan 同步，勿 create_task_with_subtasks。不要再次询问用户是否开始执行。'
            )
            subtasks_overview = f"当前已有 {len(subtasks)} 个子任务：\n{chr(10).join(subtask_summary)}"
        else:
            planning_instruction = (
                f'任务已获用户授权。请先视需要调用 supervisor 创建子任务（create_subtasks / create_task_with_subtasks），再依次：set_task_state(status=planned) → start_execution（task_id="{task_id}"）。不要再次询问用户是否开始执行。'
            )
            subtasks_overview = "当前尚无子任务。"

        user_requirement_block = f"\n用户原始需求（原文）：\n{latest_user_requirement}\n" if latest_user_requirement else ""

        prompt_text = f"""【系统】主任务「{task_name}」（ID: {task_id}）已由 {event.authorized_by or "user"} 授权开始执行。

任务说明：{task_desc or "（无）"}
{user_requirement_block}

{subtasks_overview}

{planning_instruction}

会话 thread_id：{thread_id or "N/A"}
"""

        logger.info(f"准备通过 LangGraph 触发 Lead Agent 对话，任务: {task_id}")
        await _log_lead_agent_execution(task_id=task_id, thread_id=thread_id, phase="准备 LangGraph 调用", details={"操作": "发送消息给 Lead Agent", "消息长度": len(prompt_text), "子任务数": len(subtasks)})

        # 6. Invoke Lead Agent via LangGraph SDK
        # Directly await the invocation (runs in event_queue's background thread)
        # Do NOT use asyncio.create_task here as it may not work well in nested event loops
        logger.info(f"[TaskEvent] 开始直接调用 Lead Agent，任务: {task_id}")

        try:
            await _invoke_lead_agent_for_task_execution(
                task_id=task_id,
                thread_id=thread_id,
                prompt_text=prompt_text,
                event=event,
                broadcaster=broadcaster,
            )
            logger.info(f"[TaskEvent] Lead Agent 调用完成，任务: {task_id}")
        except Exception as e:
            logger.exception(f"[TaskEvent] Lead Agent 调用失败，任务: {task_id}: {e}")

        await _log_lead_agent_execution(task_id=task_id, thread_id=thread_id, phase="Lead Agent 调用完成", details={"状态": "已完成", "说明": "同步调用结束"})

        # Broadcast that we're triggering Lead Agent
        if broadcaster:
            await broadcaster.broadcast(
                task_id,
                "task:agent_triggered",
                {
                    "task_id": task_id,
                    "message": "Lead Agent is being invoked to start execution",
                    "triggered_at": utc_now_iso_z(),
                },
            )

    except Exception as e:
        logger.exception(f"Failed to handle task authorized event for {task_id}: {e}")
        await _log_task_link(task_id=task_id, stage="authorize", status="except", details={"error": str(e), "error_type": type(e).__name__})
        if broadcaster:
            try:
                await broadcaster.broadcast(
                    task_id,
                    "task:failed",
                    {
                        "task_id": task_id,
                        "error": str(e),
                        "failed_at": utc_now_iso_z(),
                    },
                )
            except Exception:
                pass
        await _emit_execution_failed(event, str(e), retryable=True)


async def _invoke_lead_agent_for_task_execution(
    task_id: str,
    thread_id: str | None,
    prompt_text: str,
    event: TaskAuthorizedEvent,
    broadcaster: Any,
) -> None:
    """Invoke Lead Agent via LangGraph SDK to handle task execution.

    This runs as a background task and communicates with the LangGraph Server
    to trigger a Lead Agent conversation. The Lead Agent will see the prompt
    and autonomously call supervisor_tool(action="start_execution").

    Args:
        task_id: The task ID
        thread_id: Optional thread ID for context
        prompt_text: The message to send to Lead Agent
        event: Original event for error reporting
        broadcaster: SSE broadcaster for status updates
    """

    # ===== 函数开始日志 =====
    logger.info(f"[_invoke_lead_agent] >>>>> 函数开始执行，task_id={task_id}")

    try:
        ok = await _execute_lead_agent_invocation(task_id, thread_id, prompt_text, event, broadcaster)
        if ok:
            logger.info(f"[_invoke_lead_agent] <<<<< 函数执行成功完成，task_id={task_id}")
        else:
            logger.warning(f"[_invoke_lead_agent] <<<<< 函数执行结束（失败已处理），task_id={task_id}")
    except Exception as e:
        logger.exception(f"[_invoke_lead_agent] XXXXX 函数执行失败，task_id={task_id}: {e}")
        # 不写入临时文件，避免 IO 噪音；异常堆栈已通过 logger.exception 输出


async def _execute_lead_agent_invocation(
    task_id: str,
    thread_id: str | None,
    prompt_text: str,
    event: TaskAuthorizedEvent,
    broadcaster: Any,
) -> bool:
    """实际的 Lead Agent 调用逻辑（被外层包装函数调用）"""
    import os

    langgraph_url = os.getenv("EVOFLOW_LANGGRAPH_URL", DEFAULT_LANGGRAPH_URL)
    assistant_id = DEFAULT_ASSISTANT_ID

    logger.info(f"[_invoke_lead_agent] 准备 LangGraph 调用，URL={langgraph_url}, assistant={assistant_id}")

    await _log_lead_agent_execution(task_id=task_id, thread_id=thread_id, phase="开始 LangGraph 调用", details={"url": langgraph_url, "assistant": assistant_id, "thread_id": thread_id or "(will create new)"})

    try:
        from langgraph_sdk import get_client

        client = get_client(url=langgraph_url)

        # Use provided thread_id or create a new thread
        if thread_id:
            # Verify thread exists
            try:
                await client.threads.get(thread_id)
                logger.info(f"Using existing thread {thread_id} for task {task_id}")
                await _log_lead_agent_execution(task_id=task_id, thread_id=thread_id, phase="使用已有 Thread", details={"thread_id": thread_id})
            except Exception as e:
                logger.warning(f"Thread {thread_id} not found, will create new thread: {e}")
                await _log_lead_agent_execution(task_id=task_id, thread_id=thread_id, phase="已有 Thread 无效", details={"错误": str(e), "原因": "将创建新 Thread"})
                thread_id = None

        if not thread_id:
            # Create new thread for this task execution
            logger.info(f"[TaskEvent] 正在创建新的 LangGraph Thread for task {task_id}")
            await _log_lead_agent_execution(task_id=task_id, thread_id=None, phase="创建新 LangGraph Thread", details={"原因": "task 没有有效的 thread_id"})
            thread = await client.threads.create(
                metadata={
                    "task_id": task_id,
                    "project_id": event.project_id,
                    "source": "task_event_handler",
                    "triggered_by": event.authorized_by or "user",
                }
            )
            thread_id = thread["thread_id"]
            logger.info(f"Created new thread {thread_id} for task {task_id}")
            await _log_lead_agent_execution(task_id=task_id, thread_id=thread_id, phase="新 Thread 创建成功", details={"thread_id": thread_id})

            # Save the new thread_id to task so frontend can read output from it
            try:
                from evoflow.collab.storage import find_main_task, get_project_storage

                storage = get_project_storage()
                row = find_main_task(storage, task_id)
                if row:
                    project, task = row
                    task["current_execution_thread_id"] = thread_id
                    storage.save_project(project)
                    logger.info(f"Saved current_execution_thread_id {thread_id} to task {task_id}")
            except Exception as e:
                logger.warning(f"Failed to save current_execution_thread_id for task {task_id}: {e}")

        from evoflow.runtime.long_run_limits import LONG_RUN_RECURSION_LIMIT

        run_config = {
            "recursion_limit": LONG_RUN_RECURSION_LIMIT,
            # LangGraph API 0.7.x 对 runs.create/stream 的 `context` 字段期望为 None；
            # 需要透传的任务信息放到 configurable（不会触发 pydantic context 序列化告警）。
            "configurable": {
                "task_id": task_id,
                "is_task_execution": True,
                "triggered_by": event.authorized_by or "user",
            },
        }

        await _log_task_link(task_id=task_id, stage="stream", status="start", details={"thread_id": thread_id})

        # 使用统一的 LangGraph 代理流管理器（与 /api/langgraph proxy 同链路），
        # 避免 task_execution 特殊分支在刷新后表现与实时对话不一致。
        from app.gateway.streaming.background_worker import StreamBackgroundWorker

        run_body = json.dumps(
            {
                "assistant_id": assistant_id,
                "input": {"messages": [{"role": "human", "content": prompt_text}]},
                "config": run_config,
                "stream_mode": "messages-tuple",
                "multitask_strategy": "enqueue",
            },
            ensure_ascii=False,
        ).encode("utf-8")

        # 获取或创建后台任务（由 worker 直接连 LangGraph /threads/{id}/runs/stream）
        worker, is_new = await StreamBackgroundWorker.get_or_create_with_langgraph(
            thread_id=thread_id,
            langgraph_path=f"threads/{thread_id}/runs/stream",
            request_method="POST",
            request_body=run_body,
            request_headers={"content-type": "application/json"},
        )

        if is_new:
            await worker.start()
            await _log_task_link(task_id=task_id, stage="stream", status="worker_started", details={"thread_id": thread_id})
            logger.info(f"[Task {task_id}] Background worker started for thread {thread_id}, will handle persistent writing and broadcasting")
        else:
            await _log_task_link(task_id=task_id, stage="stream", status="worker_reused", details={"thread_id": thread_id})
            logger.info(f"[Task {task_id}] Reusing existing background worker for thread {thread_id}")

        _event_subtasks = getattr(event, "subtasks", None)
        _subtask_count = len(_event_subtasks) if isinstance(_event_subtasks, list) else 0
        _publish_task_execution_started(
            task_id=task_id,
            project_id=event.project_id,
            subtask_count=_subtask_count,
            triggered_by=str(event.authorized_by or "user"),
        )

        await _log_task_link(
            task_id=task_id,
            stage="stream",
            status="dispatched",
            details={"thread_id": thread_id, "note": "Lead Agent stream running in background worker"},
        )

        if is_new and worker._task is not None:
            asyncio.create_task(
                _finalize_task_execution_after_worker(
                    task_id=task_id,
                    thread_id=thread_id,
                    worker=worker,
                    broadcaster=broadcaster,
                ),
                name=f"task-exec-finalize-{task_id[:24]}",
            )
        return True

    except Exception as e:
        logger.exception(f"LangGraph invocation failed for task {task_id}: {e}")
        await _log_task_link(task_id=task_id, stage="langgraph", status="fail", details={"error": str(e), "error_type": type(e).__name__})

        # Broadcast failure
        if broadcaster:
            await broadcaster.broadcast(
                task_id,
                "task:agent_failed",
                {
                    "task_id": task_id,
                    "error": str(e),
                    "failed_at": utc_now_iso_z(),
                },
            )

        await _emit_execution_failed(event, f"Lead Agent invocation failed: {e}", retryable=True)
        return False


def _publish_task_execution_started(
    *,
    task_id: str,
    project_id: str,
    subtask_count: int,
    triggered_by: str,
) -> None:
    started_event = TaskExecutionStartedEvent(
        task_id=task_id,
        project_id=project_id,
        started_at=datetime.now(UTC),
        subtask_count=subtask_count,
        triggered_by=triggered_by,
    )
    if event_queue.publish("task_execution_started", started_event):
        logger.info("Published TaskExecutionStartedEvent for %s", task_id)
    else:
        logger.warning("Failed to publish TaskExecutionStartedEvent for %s", task_id)


async def _finalize_task_execution_after_worker(
    *,
    task_id: str,
    thread_id: str | None,
    worker: Any,
    broadcaster: Any,
) -> None:
    """Wait for background stream worker, then reconcile lead chat and notify UI."""
    run_task = getattr(worker, "_task", None)
    if run_task is not None:
        try:
            await run_task
        except Exception:
            logger.warning("Lead Agent background worker failed for task %s", task_id, exc_info=True)

    tid = str(thread_id or "").strip()
    await _log_task_link(
        task_id=task_id,
        stage="stream",
        status="worker_finished",
        details={"thread_id": tid or None},
    )
    if tid:
        await _save_lead_agent_conversation(task_id, tid)

    if broadcaster:
        try:
            await broadcaster.broadcast(
                task_id,
                "task:agent_completed",
                {
                    "task_id": task_id,
                    "thread_id": tid,
                    "completed_at": utc_now_iso_z(),
                },
            )
        except Exception:
            logger.warning("Failed to broadcast task:agent_completed for task %s", task_id, exc_info=True)


async def _save_lead_agent_conversation(task_id: str, thread_id: str) -> None:
    """Bind lead thread to task; transcript lives in ``evoflow_chat_messages``."""
    try:
        from evoflow.collab.conversation_persist import reconcile_lead_conversation_from_chat
        from evoflow.collab.storage import get_project_storage

        storage = get_project_storage()
        reconcile_lead_conversation_from_chat(storage, task_id, thread_id)
    except Exception as e:
        logger.warning(f"Failed to reconcile Lead Agent conversation for task {task_id}: {e}")


def _get_message_role(msg: dict) -> str:
    """Extract role from message dict.

    Maps message types to standard roles for UI display.
    """
    msg_type = msg.get("type", "").lower()

    if msg_type == "humanmessage":
        return "user"
    elif msg_type == "aimessage":
        return "assistant"
    elif msg_type == "toolmessage":
        return "tool"
    else:
        return "unknown"


async def _emit_execution_failed(original_event: TaskAuthorizedEvent, error: str, retryable: bool) -> None:
    """Emit task execution failed event.

    Args:
        original_event: The original authorization event
        error: Error message
        retryable: Whether the error is retryable
    """
    failed_event = TaskExecutionFailedEvent(
        task_id=original_event.task_id,
        project_id=original_event.project_id,
        error=error,
        failed_at=datetime.now(UTC),
        retryable=retryable,
    )

    if not event_queue.publish("task_execution_failed", failed_event):
        logger.error("Failed to publish TaskExecutionFailedEvent for %s", original_event.task_id)
    logger.error(f"Task execution failed: {failed_event}")


async def handle_task_execution_started(event: TaskExecutionStartedEvent) -> None:
    """Handle task execution started event.

    This handler can be used to:
    - Update UI via WebSocket
    - Log metrics
    - Trigger notifications
    """
    logger.info(f"Task {event.task_id} execution started with {event.subtask_count} subtasks")
    # TODO: Emit WebSocket event to frontend


async def handle_task_execution_failed(event: TaskExecutionFailedEvent) -> None:
    """Handle task execution failed event.

    This handler can be used to:
    - Update UI via WebSocket with error
    - Implement retry logic
    - Log failures
    """
    logger.error(f"Task {event.task_id} execution failed: {event.error}")
    # TODO: Emit WebSocket event to frontend with error details


async def handle_task_cancelled(event: TaskCancelEvent) -> None:
    """Handle task cancel event: propagate cancellation to background tasks.

    This handler:
    1. Marks all subtasks as cancelled
    2. Signals background tasks to stop (cooperative cancellation)
    3. Broadcasts cancellation status via SSE

    Args:
        event: TaskCancelEvent with task_id, subtask_ids, etc.
    """
    from app.gateway.cancellation import mark_task_cancelled
    from evoflow.subagents.executor import SubagentStatus, get_background_task_result

    task_id = event.task_id
    logger.info(f"Handling task cancel event for task {task_id}, cancelling {len(event.subtask_ids)} subtasks")

    try:
        # 1. Mark main task as cancelled
        mark_task_cancelled(task_id, event.cancelled_by, event.reason)

        # 2. Process each subtask
        cancelled_count = 0
        from evoflow.collab.storage import find_subtask_by_ids, get_project_storage

        storage = get_project_storage()
        for subtask_id in event.subtask_ids:
            try:
                mark_task_cancelled(subtask_id, event.cancelled_by, "parent_cancelled")

                bg_task_id = str(subtask_id or "").strip()
                st_row = find_subtask_by_ids(storage, task_id, subtask_id)
                if isinstance(st_row, dict):
                    stored_bg = str(st_row.get("background_task_id") or "").strip()
                    if stored_bg:
                        bg_task_id = stored_bg

                mark_task_cancelled(bg_task_id, event.cancelled_by, "parent_cancelled")

                result = get_background_task_result(bg_task_id)
                if result:
                    if result.status == SubagentStatus.RUNNING:
                        logger.info(f"Marked running background task {bg_task_id} as cancelled (subtask {subtask_id})")
                        cancelled_count += 1
                    elif result.status == SubagentStatus.PENDING:
                        logger.info(f"Marked pending background task {bg_task_id} as cancelled (subtask {subtask_id})")
                        cancelled_count += 1
                else:
                    logger.debug(f"No background task for subtask {subtask_id} (bg_id={bg_task_id})")

            except Exception as e:
                logger.warning(f"Failed to cancel subtask {subtask_id}: {e}")
                # Continue with other subtasks

        logger.info(f"Task {task_id} cancellation processed, marked {cancelled_count}/{len(event.subtask_ids)} subtasks")

        # 3. Broadcast cancellation status via SSE
        try:
            from app.gateway.routers.events import broadcaster

            await broadcaster.broadcast(
                task_id,
                "task:cancelled",
                {
                    "task_id": task_id,
                    "cancelled_at": utc_now_iso_z(),
                    "cancelled_by": event.cancelled_by,
                    "subtask_count": len(event.subtask_ids),
                    "cancelled_subtask_count": cancelled_count,
                },
            )
        except Exception as e:
            logger.warning(f"Failed to broadcast cancellation event: {e}")

    except Exception as e:
        logger.exception(f"Failed to handle task cancel event for {task_id}: {e}")


async def handle_task_resume(event: TaskResumeEvent) -> None:
    """Handle task resume event: notify scheduler to continue execution.

    This handler:
    1. Validates task state (should be paused)
    2. Broadcasts resume event to frontend via SSE
    3. Signals scheduler to continue paused execution

    Args:
        event: TaskResumeEvent with task_id, project_id, etc.
    """
    task_id = event.task_id

    logger.info(f"Handling task resume event for task {task_id}")

    # Import broadcaster lazily to avoid circular dependencies
    try:
        from app.gateway.routers.events import broadcaster
    except ImportError:
        broadcaster = None
        logger.warning("Could not import broadcaster, SSE events will not be sent")

    try:
        # 1. Find and validate task
        from evoflow.collab.storage import find_main_task, get_project_storage

        storage = get_project_storage()
        row = find_main_task(storage, task_id)

        if not row:
            logger.error(f"Task {task_id} not found for resume")
            return

        project, task = row

        # 2. Check task status
        status = task.get("status", "")
        if status != "paused":
            logger.warning(f"Task {task_id} status '{status}' not suitable for resume")
            return

        # 3. Update task status back to executing
        task["status"] = "executing"
        storage.save_project(project)

        # 4. Broadcast resume event to frontend
        if broadcaster:
            await broadcaster.broadcast(
                task_id,
                "task:resumed",
                {
                    "task_id": task_id,
                    "resumed_at": utc_now_iso_z(),
                    "resumed_by": event.resumed_by,
                },
            )

        # 5. Signal scheduler to continue execution
        # The scheduler should detect the phase change and continue from where it left off
        logger.info(f"Task {task_id} resumed, scheduler will continue execution")

        # Note: The actual continuation is handled by:
        # - The collaboration phase advancement (done in resume_task API)
        # - The scheduler detecting state changes and continuing execution
        # - Background tasks will resume via checkpoint/snapshot restoration

    except Exception as e:
        logger.exception(f"Failed to handle task resume event for {task_id}: {e}")


def register_event_handlers(event_queue: EventQueue) -> None:
    """Register all task event handlers with the event queue.

    Call this at application startup to wire up event handlers.

    Args:
        event_queue: The EventQueue instance to register handlers with
    """
    logger.info("[事件处理器] 开始注册任务事件处理器")
    event_queue.subscribe("task_authorized", handle_task_authorized)
    logger.info("[事件处理器] 已注册: task_authorized -> handle_task_authorized")
    event_queue.subscribe("task_execution_started", handle_task_execution_started)
    logger.info("[事件处理器] 已注册: task_execution_started -> handle_task_execution_started")
    event_queue.subscribe("task_execution_failed", handle_task_execution_failed)
    logger.info("[事件处理器] 已注册: task_execution_failed -> handle_task_execution_failed")
    event_queue.subscribe("task_cancelled", handle_task_cancelled)
    logger.info("[事件处理器] 已注册: task_cancelled -> handle_task_cancelled")
    event_queue.subscribe("task_resume", handle_task_resume)
    logger.info("[事件处理器] 已注册: task_resume -> handle_task_resume")

    logger.info("[事件处理器] 所有任务事件处理器注册完成")


# Import for type hints
