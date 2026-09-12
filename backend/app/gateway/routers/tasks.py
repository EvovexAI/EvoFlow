"""Tasks API router for multi-agent collaboration - task-centric model."""

import logging
import os
from datetime import UTC, datetime
from typing import Any

from fastapi import APIRouter, Body, Depends, Query, Request
from pydantic import BaseModel, Field

from app.gateway.deps.license import require_premium
from app.gateway.cancellation import mark_task_cancelled
from app.gateway.events import event_queue
from app.gateway.events.task_events import TaskCancelEvent
from app.gateway.routers.errors import (
    ErrorCode,
    raise_task_error,
)
from app.gateway.routers.events import emit_task_completed, emit_task_progress
from evoflow.authz.http_guard import require_task_visible, resolve_authz_from_request
from evoflow.collab.authorize_execution import authorize_main_task_execution, revoke_main_task_execution_authorization
from evoflow.collab.dispatch_authorized_execution import dispatch_authorized_main_task_execution
from evoflow.collab.id_format import make_subtask_id
from evoflow.collab.models import WorkerProfile
from evoflow.collab.storage import (
    find_main_task,
    get_project_storage,
    new_project_bundle_root_task,
    rollup_root_task_progress_from_subtasks,
)
from evoflow.collab.thread_collab import (
    advance_collab_phase_to_awaiting_exec_for_task,
    advance_collab_phase_to_plan_ready_for_task,
)
from evoflow.config.paths import get_paths
from evoflow.timeutil import utc_now_iso_z

logger = logging.getLogger(__name__)

router = APIRouter(
    prefix="/api/tasks",
    tags=["tasks"],
    dependencies=[Depends(require_premium)],
)

_TASK_API_STRIP_KEYS = ("parent_project_id", "project_name", "parentProjectId", "projectName")

_LIST_DROP_KEYS = (
    "plan_flowchart_mermaid",
    "plan_steps",
    "plan_validation",
    "execution_conversation",
    "task_report",
    "result_json",
    "messages",
    "transcript",
)

_LIST_TRUNCATE_KEYS = (
    "description",
    "summary",
    "plan_goal",
    "plan_open_questions",
    "error",
    "result",
)


def _slim_task_for_list(task: dict[str, Any]) -> dict[str, Any]:
    """Strip heavy fields from catalog rows — list UI only needs cards/filters."""
    out = dict(task)
    steps = out.get("plan_steps")
    if isinstance(steps, list):
        out["plan_steps_count"] = len(steps)
    for k in _LIST_DROP_KEYS:
        out.pop(k, None)
    for k in _LIST_TRUNCATE_KEYS:
        val = out.get(k)
        if isinstance(val, str) and len(val) > 240:
            out[k] = val[:240]
        elif isinstance(val, (dict, list)):
            out.pop(k, None)
    handlers = out.get("handlers")
    if isinstance(handlers, list) and len(handlers) > 8:
        out["handlers"] = handlers[:8]
    outputs = out.get("outputs")
    if isinstance(outputs, list):
        light = []
        for item in outputs[:6]:
            if not isinstance(item, dict):
                continue
            light.append({k: item.get(k) for k in ("type", "key", "label", "value") if k in item})
            if isinstance(light[-1].get("value"), str) and len(light[-1]["value"]) > 120:
                light[-1]["value"] = light[-1]["value"][:120]
        out["outputs"] = light
    return out


def _public_task_dict(task: dict[str, Any]) -> dict[str, Any]:
    """Task-centric API: omit legacy project bundle fields from responses."""
    from evoflow.admin.tasks import task_summary_of
    from evoflow.collab.task_outputs import task_outputs_of
    from evoflow.collab.task_source import normalize_task_source, task_source_zh

    out = task.copy()
    for k in _TASK_API_STRIP_KEYS:
        out.pop(k, None)
    if (
        str(out.get("plan_bound_at") or "").strip()
        and str(out.get("plan_goal") or "").strip()
        and isinstance(out.get("plan_steps"), list)
        and out.get("plan_steps")
        and str(out.get("status") or "").strip().lower() in {"planning", "pending", ""}
    ):
        out["status"] = "planned"
    raw_src = out.get("source")
    # App runs historically stamped source_app_* without source — infer workflow.
    if (raw_src is None or not str(raw_src).strip()) and (
        str(out.get("source_app_id") or "").strip() or str(out.get("source_run_id") or "").strip()
    ):
        raw_src = "app_runner"
        out["source"] = "app_runner"
    if raw_src is not None or "source" in task or str(out.get("source_app_id") or "").strip():
        canon = normalize_task_source(raw_src)
        if canon:
            out["source"] = canon
        out["source_zh"] = task_source_zh(raw_src)
        ch = str(out.get("source_channel") or "").strip()
        if not ch and canon == "workflow" and str(out.get("source_app_id") or "").strip():
            ch = "app_runner"
        if ch:
            out["source_channel"] = ch
    # Canonical handoff fields (summary + structured outputs) for any task row.
    summary = task_summary_of(out)
    if summary:
        out["summary"] = str(out.get("summary") or "").strip() or summary
    outputs = task_outputs_of(out)
    if outputs:
        out["outputs"] = outputs
    elif "outputs" in out and not out.get("outputs"):
        out.pop("outputs", None)
    from evoflow.collab.task_outputs import task_input_refs_of

    input_refs = task_input_refs_of(out)
    if input_refs:
        out["input_refs"] = input_refs
    elif "input_refs" in out and not out.get("input_refs"):
        out.pop("input_refs", None)
    from evoflow.collab.task_handlers import task_handlers_of

    handlers = task_handlers_of(out)
    if handlers:
        out["handlers"] = handlers
    elif "handlers" in out and not out.get("handlers"):
        out.pop("handlers", None)
    return out


def _normalized_task_status(task: dict[str, Any]) -> str:
    return str(_public_task_dict(task).get("status") or "").strip().lower()


def _status_matches_filter(task: dict[str, Any], filter_status: str) -> bool:
    want = str(filter_status or "").strip().lower()
    if not want:
        return True
    raw = str(task.get("status") or "").strip().lower()
    norm = _normalized_task_status(task)
    if want in {raw, norm}:
        return True
    alias_groups: dict[str, frozenset[str]] = {
        "executing": frozenset({"executing", "running", "in_progress", "active", "waiting_dispatch"}),
        "planning": frozenset({"planning", "planned", "awaiting_exec", "plan_ready"}),
        "pending": frozenset({"pending", "idle", "req_confirm"}),
        "completed": frozenset({"completed", "done", "success"}),
        "failed": frozenset({"failed", "error", "timed_out"}),
        "cancelled": frozenset({"cancelled", "canceled"}),
        "reviewed": frozenset({"reviewed"}),
    }
    group = alias_groups.get(want)
    if group:
        return raw in group or norm in group
    return False


def _refresh_main_task_progress_only(storage, task_id: str) -> None:
    """Sync main-task ``progress`` (cap 99%) from subtasks; terminal ``completed`` is lead-only."""
    try:
        rollup_root_task_progress_from_subtasks(storage, task_id)
    except Exception:
        logger.debug("rollup_root_task_progress_from_subtasks failed task_id=%s", task_id, exc_info=True)


class CreateTaskRequest(BaseModel):
    name: str = Field(default="", description="Task name")
    description: str = Field(default="", description="Task description")
    thread_id: str | None = Field(default=None, description="Bind LangGraph thread to this task")
    run_mode: str = Field(
        default="manual",
        description="unattended = zero-touch queue (auto plan/authorize/dispatch); manual = legacy UI flow",
    )
    model_name: str | None = Field(default=None, description="Session model name pinned at creation for subagent delegation")
    lifecycle: str | None = Field(
        default=None,
        description="inbox = 随手待办（不入无人值守队列）；省略则按 run_mode 创建正式任务",
    )
    status: str | None = Field(
        default=None,
        description="可选初始状态；lifecycle=inbox 时强制为 inbox",
    )
    assigned_role: str | None = Field(default=None, description="可选岗位显示名（inbox 可稍后分配）")
    assigned_to: str | None = Field(default=None, description="可选 agent_code / 处理人")
    raised_by: str | None = Field(default=None, description="提起人：user 或 agent_code；默认 user")
    source: str | None = Field(
        default=None,
        description="任务来源 chat|workflow|role；inbox 默认 chat，正式任务默认 workflow",
    )
    priority: str | None = Field(
        default=None,
        description="优先级 P0|P1|P2|P3（重要紧急 / 重要不紧急 / 紧急不重要 / 不重要不紧急）",
    )
    due_at: str | None = Field(
        default=None,
        description="预计完成时间 ISO8601 或 YYYY-MM-DD",
    )
    workspace_root: str | None = Field(
        default=None,
        description="本机项目目录：任务读写/产出落盘根；空则跟随岗位或默认数据目录",
    )


class UpdateTaskRequest(BaseModel):
    name: str | None = Field(default=None, description="Task name")
    description: str | None = Field(default=None, description="Task description")
    status: str | None = Field(default=None, description="Task status")
    progress: int | None = Field(default=None, description="Progress 0-100")
    assigned_role: str | None = Field(default=None, description="岗位显示名；空串清除")
    assigned_to: str | None = Field(default=None, description="agent_code；空串清除")
    run_mode: str | None = Field(
        default=None,
        description="manual|unattended；inbox 升级正式任务时设置",
    )
    promote: bool | None = Field(
        default=None,
        description="True：将 inbox 升级为正式协作任务（status→pending，source→workflow）",
    )
    source: str | None = Field(default=None, description="可选覆盖 source")
    raised_by: str | None = Field(default=None, description="可选覆盖 raised_by")
    priority: str | None = Field(default=None, description="优先级 P0|P1|P2|P3；空串清除")
    due_at: str | None = Field(default=None, description="预计完成时间；空串清除")


class TaskOutputItem(BaseModel):
    """Structured deliverable on any task (main or subtask)."""

    type: str = Field(
        default="file",
        description="Output type: file|url|text|other",
    )
    key: str = Field(description="Stable key, e.g. report / patch / screenshot")
    value: str = Field(description="Path, URL, or short text content")
    label: str | None = Field(default=None, description="Optional display label")


class TaskHandlerItem(BaseModel):
    """Downstream handler proposed at handoff / confirmed by user."""

    agent_code: str = Field(description="处理人 agent_code")
    content: str = Field(default="", description="该处理人要做的事（每人分开写）")
    read_outputs: list[TaskOutputItem] = Field(
        default_factory=list,
        description="该处理人需要阅读的产物引用（勿与任务自身 outputs 混淆）",
    )
    outputs: list[TaskOutputItem] | None = Field(
        default=None,
        description="Legacy alias of read_outputs（兼容旧客户端）",
    )
    role: str | None = Field(default=None, description="可选岗位显示名")


class SetTaskStateRequest(BaseModel):
    status: str = Field(description="Target status (validated against state machine)")
    comment: str | None = Field(default=None, description="Optional note: 打回理由 / 失败说明 / 确认备注")
    summary: str | None = Field(
        default=None,
        description="任务总结 / 交工交付摘要（员工 reviewed 时写入；面板列表与详情展示）",
    )
    outputs: list[TaskOutputItem] | None = Field(
        default=None,
        description=(
            "结构化产出列表 [{type,key,value,label?}]；"
            "type=file|url|text|other。本岗交付物，不是下游 input_refs。"
        ),
    )
    handlers: list[TaskHandlerItem] | None = Field(
        default=None,
        description=(
            "下游处理人列表（每人一条）："
            "[{agent_code, content, read_outputs[], role?}]。"
            "交工 reviewed 时写入（员工仅可指派直属下级）；"
            "确认 completed 时可改（用户可同组织改派），确认后按条建下游 Task，"
            "子任务写入 input_refs 并 wake。"
        ),
    )


class AddSubtaskRequest(BaseModel):
    name: str = Field(default="", description="Subtask name")
    description: str = Field(default="", description="Subtask description")
    dependencies: list[str] = Field(default_factory=list, description="List of subtask IDs this depends on")
    worker_profile: WorkerProfile | None = Field(
        default=None,
        description="Optional worker constraints (§5.2: base_subagent, tools, skills, instruction, depends_on)",
    )


class UpdateSubtaskRequest(BaseModel):
    name: str | None = Field(default=None, description="Subtask name")
    description: str | None = Field(default=None, description="Subtask description")
    status: str | None = Field(default=None, description="Subtask status")
    assigned_to: str | None = Field(default=None, description="Assigned agent ID")
    progress: int | None = Field(default=None, description="Progress 0-100")


class AssignSubtaskRequest(BaseModel):
    agent_id: str = Field(default="", description="Agent ID to assign")


class SubtaskConversationHistoryResponse(BaseModel):
    task_id: str
    subtask_id: str
    count: int
    messages: list[dict[str, Any]] = Field(default_factory=list)
    outcome: dict[str, Any] = Field(
        default_factory=dict,
        description="Canonical handoff from subtask_outcome_report (task_report/summary), not task memory.",
    )


class ContinueSubtaskSessionRequest(BaseModel):
    message: str = Field(..., min_length=1, description="Follow-up message to the subtask worker session")
    keep_session_open: bool = Field(
        default=True,
        description="When true, keep worker session open and subtask in_progress for further rounds",
    )
    wait_for_completion: bool = Field(default=True, description="Wait for worker reply before returning")
    authorized_by: str = Field(default="user", description="Actor label for audit (user | lead | system)")


class SubtaskEnrichedPromptResponse(BaseModel):
    """Exact output of ``evoflow.tools.builtins.supervisor.execution._build_subtask_enriched_prompt``."""

    task_id: str
    subtask_id: str
    enriched_prompt: str = Field(..., description="Prompt text passed to the subtask worker (before optional upstream dependency appendix).")


class AuthorizeExecutionRequest(BaseModel):
    authorized_by: str = Field(default="user", description="user | lead | system")
    thread_id: str | None = Field(
        default=None,
        description="Current LangGraph thread id: collab_state is written here when it differs from the task's bound thread_id",
    )


class BatchOperationRequest(BaseModel):
    action: str = Field(..., description="Action to perform: start|cancel|pause|resume|delete")
    task_ids: list[str] = Field(..., description="List of task IDs to operate on")


class BatchStopRequest(BaseModel):
    task_ids: list[str] | None = Field(default=None, description="Explicit task IDs to pause")
    scope: str | None = Field(
        default=None,
        description="When task_ids omitted: running = in-flight work; active = running + queued/planned",
    )


_PAUSABLE_TASK_STATUSES = frozenset(
    {
        "pending",
        "planning",
        "planned",
        "executing",
        "running",
        "in_progress",
        "active",
        "awaiting_exec",
        "waiting_dispatch",
        "verifying",
        "reflecting",
    }
)
_RUNNING_TASK_STATUSES = frozenset(
    {
        "planning",
        "planned",
        "executing",
        "running",
        "in_progress",
        "active",
        "awaiting_exec",
        "waiting_dispatch",
        "verifying",
        "reflecting",
    }
)


class RetrySubtaskRequest(BaseModel):
    subtask_ids: list[str] = Field(default=[], description="Specific subtask IDs to retry")
    retry_all_failed: bool = Field(default=False, description="Retry all failed subtasks")


def _text_from_message_content(content: Any) -> str:
    if isinstance(content, str):
        return content.strip()
    if isinstance(content, list):
        parts: list[str] = []
        for item in content:
            if isinstance(item, str):
                parts.append(item.strip())
            elif isinstance(item, dict):
                t = item.get("text")
                if isinstance(t, str):
                    parts.append(t.strip())
        return "\n".join([p for p in parts if p]).strip()
    return ""


def _tool_call_hits_subtask(tool_call: dict[str, Any], subtask_id: str) -> bool:
    from evoflow.collab.conversation_scope import tool_call_hits_subtask

    return tool_call_hits_subtask(tool_call, subtask_id)


def _conversation_msg_hits_subtask(
    msg: dict[str, Any],
    subtask_id: str,
    dedicated_subtask_thread_id: str | None = None,
) -> bool:
    from evoflow.collab.conversation_scope import conversation_msg_belongs_to_subtask

    return conversation_msg_belongs_to_subtask(
        msg,
        subtask_id,
        dedicated_subtask_thread_id=dedicated_subtask_thread_id,
    )


def _message_dedupe_key(msg: dict[str, Any]) -> str:
    role = str(msg.get("role") or msg.get("type") or "unknown").strip()
    content = _text_from_message_content(msg.get("content"))
    tool_calls = msg.get("tool_calls")
    try:
        import json

        tool_calls_norm = json.dumps(tool_calls, ensure_ascii=False, sort_keys=True)
    except Exception:
        tool_calls_norm = str(tool_calls)
    msg_id = str(msg.get("id") or "").strip()
    if msg_id:
        return f"id:{msg_id}"
    return f"fp:{role}|{content}|{tool_calls_norm}"


def _publish_task_cancel_event(
    task_id: str,
    project_id: str,
    subtask_ids: list[str],
    reason: str,
    cancelled_by: str = "user",
) -> None:
    """Publish cooperative-cancellation event for running subtasks."""
    if not subtask_ids:
        return
    event = TaskCancelEvent(
        task_id=task_id,
        project_id=project_id,
        subtask_ids=subtask_ids,
        cancelled_by=cancelled_by,
        reason=reason,
        timestamp=datetime.now(UTC),
    )
    event_queue.publish("task_cancelled", event)


def _collect_running_subtask_ids(task: dict[str, Any]) -> list[str]:
    running_subtask_ids: list[str] = []
    for subtask in task.get("subtasks") or []:
        sid = str(subtask.get("id") or "").strip()
        sst = str(subtask.get("status") or "").strip().lower()
        if sid and sst in ("executing", "planning", "pending", "running", "in_progress", "active"):
            running_subtask_ids.append(sid)
    return running_subtask_ids


async def _cancel_plan_worker(thread_id: str | None) -> None:
    """Cancel background stream worker AND LangGraph server-side runs for a thread.

    Previously this only cancelled the local asyncio stream reader, leaving the
    LangGraph server-side run alive. The Lead Agent continued executing and could
    overwrite task status, causing the "cancel doesn't work" bug.
    """
    tid = str(thread_id or "").strip()
    if not tid:
        return
    # 1. Cancel local StreamBackgroundWorker (stops reading the stream).
    try:
        from app.gateway.streaming.background_worker import StreamBackgroundWorker

        worker = StreamBackgroundWorker._workers.get(tid)
        if worker and worker.is_running():
            await worker.cancel()
    except Exception as e:
        logger.warning("Failed to cancel background worker for thread %s: %s", tid, e)
    # 2. Cancel LangGraph server-side runs (stop the actual Lead Agent execution).
    try:
        from langgraph_sdk import get_client

        langgraph_url = os.getenv("EVOFLOW_LANGGRAPH_URL", "http://127.0.0.1:8070/api/langgraph").strip()
        client = get_client(url=langgraph_url)
        runs = await client.runs.list(thread_id=tid, limit=20)
        for run in runs:
            run_id = str(run.get("run_id") or run.get("id") or "").strip()
            status = str(run.get("status") or "").strip().lower()
            if run_id and status in ("pending", "running"):
                try:
                    await client.runs.cancel(thread_id=tid, run_id=run_id)
                    logger.info("Cancelled LangGraph run %s on thread %s", run_id, tid)
                except Exception as e:
                    logger.debug("Failed to cancel run %s on thread %s: %s", run_id, tid, e)
    except Exception as e:
        logger.warning("Failed to cancel LangGraph runs for thread %s: %s", tid, e)


async def _cancel_supervisor_monitor(task_id: str) -> None:
    """Cancel the supervisor background monitor asyncio task for a task.

    The background monitor (_ensure_background_task_monitor) runs a 3-second poll
    loop that triggers _trigger_lead_follow_run -> new LangGraph runs. If not
    cancelled here, the monitor keeps spawning Lead Agent runs even after the user
    cancelled the task, causing the "supervisor keeps calling monitor" death loop.
    """
    tid = str(task_id or "").strip()
    if not tid:
        return
    try:
        from evoflow.tools.builtins.supervisor.monitor import (
            _bg_task_monitors,
            _cleanup_monitor_state_for_task,
        )

        monitor_task = _bg_task_monitors.pop(tid, None)
        if monitor_task and not monitor_task.done():
            monitor_task.cancel()
            try:
                await monitor_task
            except BaseException:
                pass
            logger.info("Cancelled supervisor background monitor for task %s", tid)
        _cleanup_monitor_state_for_task(tid)
    except Exception as e:
        logger.debug("Failed to cancel supervisor monitor for task %s: %s", tid, e)


async def _pause_task_row(project: dict[str, Any], task: dict[str, Any], task_index: int) -> tuple[bool, str | None]:
    """Pause one task: block queue pickup, revert collab phase, cancel workers/subtasks."""
    storage = get_project_storage()
    task_id = str(task.get("id") or "").strip()
    if not task_id:
        return False, "missing_task_id"

    current_status = str(task.get("status") or "").strip().lower()
    if current_status == "paused":
        return True, None
    if current_status not in _PAUSABLE_TASK_STATUSES:
        return False, f"当前状态不可暂停: {current_status or 'unknown'}"

    running_subtask_ids = _collect_running_subtask_ids(task)
    thread_id = task.get("thread_id")

    task["status"] = "paused"
    task["paused_at"] = utc_now_iso_z()
    # Mark only in-flight subtasks paused; leave pending/planned alone so resume
    # + DAG resolve won't treat waiting Step2 as "was running".
    _in_flight = frozenset({"executing", "running", "in_progress", "active", "planning"})
    for st in task.get("subtasks") or []:
        if not isinstance(st, dict):
            continue
        sst = str(st.get("status") or "").strip().lower()
        if sst in _in_flight:
            st["status"] = "paused"
    project["status"] = "paused"
    project["tasks"][task_index] = task

    if not storage.save_project(project):
        return False, "任务停止失败"

    try:
        revoke_main_task_execution_authorization(storage, task_id)
    except Exception as e:
        logger.debug("revoke_main_task_execution_authorization skipped task_id=%s: %s", task_id, e)

    try:
        from evoflow.collab.thread_collab import revert_collab_phase_to_paused

        revert_collab_phase_to_paused(get_paths(), task_id, runtime_thread_id=thread_id)
    except Exception as e:
        logger.warning("Failed to revert collab phase for paused task %s: %s", task_id, e)

    await _cancel_plan_worker(thread_id)
    await _cancel_supervisor_monitor(task_id)

    try:
        for sid in running_subtask_ids:
            mark_task_cancelled(sid, "user", "task_stopped")
        _publish_task_cancel_event(
            task_id=task_id,
            project_id=str(project.get("id") or ""),
            subtask_ids=running_subtask_ids,
            reason="Task stopped from UI",
            cancelled_by="user",
        )
    except Exception as e:
        logger.warning("Failed to propagate stop cancellation for task %s: %s", task_id, e)

    return True, None


def _iter_all_task_rows(storage) -> list[tuple[dict[str, Any], dict[str, Any], int]]:
    rows: list[tuple[dict[str, Any], dict[str, Any], int]] = []
    for project_summary in storage.list_projects():
        project = storage.load_project(project_summary["id"])
        if not project:
            continue
        for idx, task in enumerate(project.get("tasks") or []):
            if isinstance(task, dict) and task.get("id"):
                rows.append((project, task, idx))
    return rows


def _task_ids_for_stop_scope(scope: str | None, storage) -> list[str]:
    scope_key = str(scope or "active").strip().lower()
    allowed = _RUNNING_TASK_STATUSES if scope_key == "running" else _PAUSABLE_TASK_STATUSES
    out: list[str] = []
    for _project, task, _idx in _iter_all_task_rows(storage):
        status = str(task.get("status") or "").strip().lower()
        if status in allowed:
            out.append(str(task.get("id")))
    return out


@router.get("", summary="List All Tasks", description="Get a list of all tasks with optional filtering.")
async def list_tasks(
    request: Request,
    status: str = Query(None, description="Filter by status: pending|executing|paused|completed|failed|cancelled"),
    source: str = Query(
        None,
        description="Filter by 任务来源: chat|workflow|role (aliases OK)",
    ),
    search: str = Query(None, description="Search in task name"),
    project_id: str = Query(None, description="Filter by project ID"),
    thread_id: str | None = Query(None, description="Filter by LangGraph thread_id (returns bound main task row)"),
    session_key: str | None = Query(None, description="Filter by chat session_key (survives thread rotation)"),
    prefer_task_id: str | None = Query(None, description="When thread_id matches multiple rows, prefer this task id"),
    sort: str = Query("updated_at", description="Sort field: created_at|updated_at|status|name"),
    order: str = Query("desc", description="Sort order: asc|desc"),
    page: int = Query(1, ge=1, description="Page number (1-based)"),
    page_size: int = Query(
        0,
        ge=0,
        le=200,
        description="Page size; 0 = return all (backward compatible)",
    ),
    hide_noise: bool = Query(
        True,
        description=(
            "Hide task-center noise by default: duty patrol rounds, upstream receipts, "
            "meeting oral reports, status_check, eval placeholders. Pass hide_noise=false to include."
        ),
    ),
) -> dict:
    """List all tasks (flattened from all projects) with filtering and sorting.

    Query Parameters:
        status: Filter by task status
        source: Filter by task source
        search: Search keyword for task name
        project_id: Filter by specific project
        thread_id: Scope to the main task bound to this LangGraph thread (no full scan intended for UI)
        session_key: Scope to the main task for this chat session (preferred when thread may rotate)
        sort: Sort field (default: updated_at)
        order: Sort order (default: desc)
        page: 1-based page index
        page_size: items per page; 0 returns the full filtered list
    """
    try:
        storage = get_project_storage()
        authz = resolve_authz_from_request(request)

        def _row_ok(row: dict[str, Any] | None) -> bool:
            if not row:
                return False
            if authz.get("is_admin"):
                return True
            tid = str(row.get("id") or row.get("task_id") or "").strip()
            if not tid:
                return False
            from evoflow.persistence import task_repositories as task_repo

            return task_repo.task_visible_to_principal(
                tid,
                is_admin=False,
                personal_scope=authz.get("personal_scope"),
                org_scope=authz.get("org_scope"),
                principal=authz.get("principal"),
            )

        sk_filter = str(session_key or "").strip()
        if sk_filter:
            row = _find_task_row_by_session(
                storage,
                sk_filter,
                prefer_task_id=prefer_task_id,
            )
            if row and not _row_ok(row):
                row = None
            if row:
                main_id = str(row.get("id") or "").strip()
                if main_id:
                    storage.invalidate_project(main_id)
            tasks = [_public_task_dict(row)] if row else []
            return {
                "success": True,
                "data": {
                    "tasks": tasks,
                    "total": len(tasks),
                    "page": 1,
                    "page_size": len(tasks),
                    "page_count": 1 if tasks else 0,
                    "filters": {
                        "session_key": sk_filter,
                        "prefer_task_id": prefer_task_id,
                    },
                },
            }
        tid_filter = str(thread_id or "").strip()
        if tid_filter:
            row = _find_task_row_by_thread(
                storage,
                tid_filter,
                prefer_task_id=prefer_task_id,
            )
            if row and not _row_ok(row):
                row = None
            if row:
                main_id = str(row.get("id") or "").strip()
                if main_id:
                    storage.invalidate_project(main_id)
            tasks = [_public_task_dict(row)] if row else []
            return {
                "success": True,
                "data": {
                    "tasks": tasks,
                    "total": len(tasks),
                    "page": 1,
                    "page_size": len(tasks),
                    "page_count": 1 if tasks else 0,
                    "filters": {
                        "thread_id": tid_filter,
                        "prefer_task_id": prefer_task_id,
                    },
                },
            }

        # Full catalog: one SQL over root rows (task_id = main_task_id), then filter/sort
        # in a worker thread. Avoids N× full-bundle hydrate that blocked the event loop
        # (~1500 projects × load_project) when opening Task Center during chat.
        import asyncio

        payload = await asyncio.to_thread(
            _list_tasks_catalog_sync,
            status=status,
            source=source,
            search=search,
            project_id=project_id,
            sort=sort,
            order=order,
            page=page,
            page_size=page_size,
            hide_noise=hide_noise,
            is_admin=bool(authz.get("is_admin")),
            personal_scope=authz.get("personal_scope"),
            org_scope=authz.get("org_scope"),
            principal=authz.get("principal"),
        )
        return {"success": True, "data": payload}
    except Exception as e:
        logger.exception("list_tasks failed")
        raise_task_error(ErrorCode.INTERNAL_ERROR, f"获取任务列表失败: {str(e)}")


def _list_tasks_catalog_sync(
    *,
    status: str | None,
    source: str | None,
    search: str | None,
    project_id: str | None,
    sort: str,
    order: str,
    page: int,
    page_size: int,
    hide_noise: bool,
    is_admin: bool = False,
    personal_scope: str | None = None,
    org_scope: str | None = None,
    principal: Any = None,
) -> dict[str, Any]:
    """Sync body for ``list_tasks`` catalog path (run via ``asyncio.to_thread``)."""
    from evoflow.authz.resource_visibility import owner_scope_visible_to_principal
    from evoflow.persistence.repositories import list_root_task_summaries

    mid = str(project_id or "").strip() or None
    raw_tasks = list_root_task_summaries(main_task_id=mid)
    all_tasks: list[dict[str, Any]] = []
    for task in raw_tasks:
        if not owner_scope_visible_to_principal(
            task.get("owner_scope_id"),
            principal,
            is_admin=is_admin,
            personal_scope=personal_scope,
            org_scope=org_scope,
        ):
            continue
        if status and not _status_matches_filter(task, status):
            continue
        if source:
            from evoflow.collab.task_source import sources_equal

            if not sources_equal(task.get("source"), source):
                continue
        if search:
            task_name = str(task.get("name") or "").lower()
            task_id = str(task.get("id") or "").lower()
            search_lower = search.lower()
            if search_lower not in task_name and search_lower not in task_id:
                continue
        task_data = _slim_task_for_list(_public_task_dict(task))
        if hide_noise:
            from evoflow.collab.task_noise import is_task_center_noise

            if is_task_center_noise(task_data):
                continue
        all_tasks.append(task_data)

    reverse = str(order or "desc").lower() == "desc"
    sort_key = str(sort or "updated_at").strip().lower()
    if sort_key == "name":
        all_tasks.sort(key=lambda x: str(x.get("name") or "").lower(), reverse=reverse)
    elif sort_key == "status":
        all_tasks.sort(key=lambda x: str(x.get("status") or ""), reverse=reverse)
    elif sort_key == "created_at":
        all_tasks.sort(key=lambda x: str(x.get("created_at") or ""), reverse=reverse)
    else:
        all_tasks.sort(
            key=lambda x: str(x.get("updated_at") or x.get("created_at") or ""),
            reverse=reverse,
        )

    total = len(all_tasks)
    size = int(page_size or 0)
    if size > 0:
        page_count = max(1, (total + size - 1) // size) if total else 0
        page_no = max(1, min(int(page or 1), page_count or 1))
        start = (page_no - 1) * size
        page_tasks = all_tasks[start : start + size]
    else:
        page_no = 1
        page_count = 1 if total else 0
        size = total
        page_tasks = all_tasks

    return {
        "tasks": page_tasks,
        "total": total,
        "page": page_no,
        "page_size": size,
        "page_count": page_count,
        "filters": {
            "status": status,
            "source": source,
            "search": search,
            "hide_noise": hide_noise,
        },
    }


def _task_row_plan_score(row: dict[str, Any], *, prefer_task_id: str = "") -> int:
    """Prefer task rows with plan fields on the main task table."""
    if not row:
        return -1
    s = 0
    goal = str(row.get("plan_goal") or row.get("planGoal") or "").strip()
    if goal:
        s += 20
    steps = row.get("plan_steps") or row.get("planSteps")
    if isinstance(steps, list) and steps:
        s += 10
    if goal and isinstance(steps, list) and steps:
        s += 100
    tid = str(row.get("id") or row.get("taskId") or row.get("task_id") or "").strip()
    if tid and prefer_task_id and tid == prefer_task_id:
        s += 8
    if row.get("plan_bound_at") or row.get("planBoundAt"):
        s += 4
    if row.get("execution_authorized"):
        s += 1
    st = str(row.get("status") or "").strip().lower()
    if st in {"planned", "planning"}:
        s += 2
    return s


def _find_task_row_by_thread(
    storage,
    thread_id: str,
    *,
    prefer_task_id: str | None = None,
) -> dict[str, Any] | None:
    """Resolve the main task for a LangGraph thread from SQLite (not in-process project cache)."""
    from evoflow.persistence import task_repositories as task_repo

    del storage  # legacy arg; thread lookup must bypass stale ProjectStorage cache
    row = task_repo.find_root_task_by_thread_id(
        thread_id,
        prefer_task_id=str(prefer_task_id or ""),
    )
    return _public_task_dict(row) if row else None


def _find_task_row_by_session(
    storage,
    session_key: str,
    *,
    prefer_task_id: str | None = None,
) -> dict[str, Any] | None:
    """Resolve the main task for a chat session (survives LangGraph thread rotation)."""
    from evoflow.persistence import task_repositories as task_repo

    del storage
    row = task_repo.find_root_task_by_session_key(
        session_key,
        prefer_task_id=str(prefer_task_id or ""),
    )
    return _public_task_dict(row) if row else None


@router.get("/queue/status", summary="Unattended task queue status")
async def get_task_queue_status() -> dict:
    import asyncio

    from app.gateway.task_queue_runner import get_task_queue_status

    return await asyncio.to_thread(get_task_queue_status)


@router.post("/queue/tick", summary="Run one unattended queue tick (debug)")
async def run_task_queue_tick_now() -> dict:
    from app.gateway.task_queue_runner import task_queue_tick

    return await task_queue_tick()


@router.post("/batch/stop", summary="Batch Stop Tasks", description="Pause multiple running or queued tasks.")
async def batch_stop_tasks(http_request: Request, request: BatchStopRequest) -> dict:
    """Pause many tasks at once — stops queue pickup and cancels in-flight workers/subtasks."""
    storage = get_project_storage()
    task_ids = [str(tid).strip() for tid in (request.task_ids or []) if str(tid).strip()]
    if not task_ids:
        task_ids = _task_ids_for_stop_scope(request.scope, storage)

    if not task_ids:
        return {
            "success": True,
            "data": {"scope": request.scope or "active", "total": 0, "succeeded": 0, "failed": 0, "results": []},
        }

    for _tid in task_ids:
        require_task_visible(http_request, _tid)

    id_set = set(task_ids)
    results: list[dict[str, Any]] = []
    succeeded = 0
    failed = 0

    for project_summary in storage.list_projects():
        project = storage.load_project(project_summary["id"])
        if not project:
            continue
        for i, task in enumerate(project.get("tasks") or []):
            tid = str(task.get("id") or "").strip()
            if tid not in id_set:
                continue
            ok, err = await _pause_task_row(project, task, i)
            if ok:
                results.append({"task_id": tid, "success": True, "status": "paused"})
                succeeded += 1
            else:
                results.append({"task_id": tid, "success": False, "error": err or "pause_failed"})
                failed += 1
            id_set.discard(tid)

    for missing in sorted(id_set):
        results.append({"task_id": missing, "success": False, "error": "Task not found"})
        failed += 1

    return {
        "success": True,
        "data": {
            "scope": request.scope or ("explicit" if request.task_ids else "active"),
            "total": len(task_ids),
            "succeeded": succeeded,
            "failed": failed,
            "results": results,
        },
    }


@router.get("/{task_id}", summary="Get Task", description="Get a task by ID.")
async def get_task(request: Request, task_id: str) -> dict:
    """Get a task with its subtasks."""
    from evoflow.persistence import task_repositories as task_repo

    require_task_visible(request, task_id)
    storage = get_project_storage()
    bundle = task_repo.load_task_bundle(task_id)
    if bundle:
        for task in bundle.get("tasks", []):
            if task.get("id") == task_id:
                # Heal workflow main-task outputs/summary from completed rollup.
                try:
                    if str(task.get("source_app_id") or "").strip() or str(
                        task.get("final_rollup") or ""
                    ).strip():
                        from evoflow.collab.task_progress import sync_main_task_from_subtasks

                        sync_main_task_from_subtasks(storage, str(task_id))
                        bundle = task_repo.load_task_bundle(task_id) or bundle
                        task = next(
                            (
                                t
                                for t in (bundle.get("tasks") or [])
                                if t.get("id") == task_id
                            ),
                            task,
                        )
                except Exception:
                    pass
                storage.invalidate_project(task_id)
                return _public_task_dict(task)

    projects = storage.list_projects()

    for project_summary in projects:
        project = storage.load_project(project_summary["id"])
        if project:
            for i, task in enumerate(project.get("tasks", [])):
                if task.get("id") == task_id:
                    return _public_task_dict(task)

    raise_task_error(ErrorCode.TASK_NOT_FOUND, f"任务 '{task_id}' 不存在")


@router.post("", summary="Create Task", description="Create a new task.")
async def create_task(http_request: Request, request: CreateTaskRequest) -> dict:
    """Create a new task (same bundle shape as supervisor create_task).

    ``lifecycle=inbox``（或 ``status=inbox``）创建随手待办：不入无人值守队列，
    可稍后分配岗位或升级为正式协作任务。
    """
    storage = get_project_storage()
    project_data, task = new_project_bundle_root_task(
        request.name,
        request.description,
        thread_id=request.thread_id,
        session_model_name=request.model_name,
    )
    from evoflow.collab.task_source import (
        TASK_SOURCE_CHAT,
        TASK_SOURCE_ROLE,
        TASK_SOURCE_WORKFLOW,
        resolve_write_source,
    )

    lifecycle = str(request.lifecycle or "").strip().lower()
    status_req = str(request.status or "").strip().lower()
    is_inbox = lifecycle == "inbox" or status_req == "inbox"

    run_mode = str(request.run_mode or "manual").strip().lower()
    if run_mode not in ("unattended", "manual"):
        run_mode = "manual"
    # inbox 禁止入队；强制 manual
    if is_inbox:
        run_mode = "manual"

    now = utc_now_iso_z()
    task["run_mode"] = run_mode
    task["raised_by"] = str(request.raised_by or "user").strip() or "user"

    role_norm = str(request.assigned_role or "").strip() or None
    assignee_norm = str(request.assigned_to or "").strip() or None
    if role_norm:
        task["assigned_role"] = role_norm
    if assignee_norm:
        task["assigned_to"] = assignee_norm

    pri = str(request.priority or "").strip().upper()
    if pri in {"P0", "P1", "P2", "P3"}:
        task["priority"] = pri
    due_raw = str(request.due_at or "").strip()
    if due_raw:
        task["due_at"] = due_raw
    ws_root = str(request.workspace_root or "").strip()
    if ws_root:
        task["workspace_root"] = ws_root

    if is_inbox:
        # 创建时已指定处理人 → pending（进入值班队列）；否则保持 inbox 等用户分配
        assigned_now = bool(role_norm or assignee_norm)
        task["status"] = "pending" if assigned_now else "inbox"
        default_src = TASK_SOURCE_ROLE if assigned_now else TASK_SOURCE_CHAT
        raw_src = str(request.source or "").strip() or default_src
        src, channel = resolve_write_source(raw_src, default=default_src)
        task["source"] = src
        if channel:
            task["source_channel"] = channel
        task["source_channel"] = task.get("source_channel") or "task_center_inbox"
    else:
        # 任务中心正式创建 → 默认 workflow（可被 request.source 覆盖）
        raw_src = str(request.source or "").strip() or TASK_SOURCE_WORKFLOW
        src, channel = resolve_write_source(raw_src, default=TASK_SOURCE_WORKFLOW)
        task["source"] = src
        if channel:
            task["source_channel"] = channel
        if run_mode == "unattended":
            task["unattended_stage"] = "queued"
            task["unattended_enqueued_at"] = now
            task["unattended_attempts"] = 0

    if storage.save_project(project_data):
        try:
            from evoflow.authz.resource_visibility import stamp_kwargs_from_request
            from evoflow.persistence import task_repositories as task_repo

            stamp = stamp_kwargs_from_request(http_request)
            if stamp.get("owner_scope_id") and task.get("id"):
                task_repo.set_root_task_owner_scope(
                    str(task["id"]),
                    org_id=str(stamp.get("org_id") or "local"),
                    owner_scope_id=stamp["owner_scope_id"],
                    created_by=stamp.get("created_by"),
                )
        except Exception:
            pass
        out = _public_task_dict(task)
        if not is_inbox and run_mode == "unattended":
            out["queue_hint"] = "Task enqueued for unattended execution; Gateway task queue will pick it up."
        return out
    raise_task_error(ErrorCode.SAVE_FAILED, "任务创建失败")


@router.post(
    "/{task_id}/authorize-execution",
    summary="Authorize task execution",
    description=(
        "Gate §5.3: set execution_authorized=true when task is in planned or planning status, "
        "then immediately dispatch the first wave (supervisor start_execution) so workers start "
        "without waiting for Lead to call start_execution again."
    ),
)
async def authorize_task_execution(
    http_request: Request,
    task_id: str,
    request: AuthorizeExecutionRequest | None = Body(default=None),
) -> dict:
    """User「开始执行」: authorize + auto-dispatch first wave."""
    require_task_visible(http_request, task_id)
    from evoflow.collab.dispatch_authorized_execution import dispatch_authorized_main_task_execution
    from evoflow.collab.thread_collab import advance_collab_phase_to_executing_for_task

    storage = get_project_storage()
    body = request if request is not None else AuthorizeExecutionRequest()
    ok, msg = authorize_main_task_execution(storage, task_id, body.authorized_by)
    if not ok:
        if "not found" in msg.lower():
            raise_task_error(ErrorCode.TASK_NOT_FOUND, msg)
        raise_task_error(ErrorCode.EXECUTION_NOT_AUTHORIZED, msg)

    if body.thread_id:
        from evoflow.collab.user_execution_confirm import mark_user_execution_confirmed

        mark_user_execution_confirmed(get_paths(), body.thread_id)

    project_id = ""
    try:
        advance_collab_phase_to_awaiting_exec_for_task(get_paths(), task_id, runtime_thread_id=body.thread_id)
    except Exception:
        logger.exception("authorize-execution: advance_collab_phase_to_awaiting_exec failed task_id=%s", task_id)

    dispatch_result: dict[str, Any] | None = None
    dispatch_ok = False
    try:
        dispatch_result = await dispatch_authorized_main_task_execution(
            task_id,
            thread_id=body.thread_id,
            authorized_by=body.authorized_by or "user",
        )
        _disp_ids = dispatch_result.get("subtaskIds") if dispatch_result else None
        dispatch_ok = bool(
            dispatch_result
            and dispatch_result.get("success")
            and (
                (isinstance(_disp_ids, list) and len(_disp_ids) > 0)
                or any(
                    isinstance(d, dict) and d.get("ok")
                    for d in (dispatch_result.get("delegatedSubtasks") or [])
                )
            )
        )
    except Exception:
        logger.exception("authorize-execution: auto-dispatch failed task_id=%s", task_id)
        dispatch_result = {
            "success": False,
            "action": "start_execution",
            "taskId": task_id,
            "error": "dispatch_failed",
        }

    collab_phase = "awaiting_exec"
    if dispatch_ok:
        try:
            advance_collab_phase_to_executing_for_task(
                get_paths(),
                task_id,
                runtime_thread_id=body.thread_id,
            )
            collab_phase = "executing"
        except Exception:
            logger.exception("authorize-execution: advance_collab_phase_to_executing failed task_id=%s", task_id)
            collab_phase = "executing"  # dispatch already ran; prefer executing for UI

    for project_summary in storage.list_projects():
        project = storage.load_project(project_summary["id"])
        if not project:
            continue
        for task in project.get("tasks", []):
            if task.get("id") == task_id:
                project_id = str(project.get("id") or project_summary.get("id") or "")
                # Optional event for paths without thread-bound Plan UI (Lead/unattended listeners).
                if not body.thread_id:
                    try:
                        from app.gateway.events.event_queue import event_queue
                        from app.gateway.events.task_events import TaskAuthorizedEvent

                        event = TaskAuthorizedEvent.from_request(
                            task_id=task_id,
                            project_id=project_id,
                            authorized_by=body.authorized_by or "user",
                            thread_id=body.thread_id,
                            source="api",
                        )
                        event_queue.publish("task_authorized", event)
                    except Exception:
                        logger.exception("authorize-execution: publish task_authorized failed task_id=%s", task_id)
                out: dict[str, Any] = {
                    "success": True,
                    "task_id": task_id,
                    "message": msg,
                    "execution_authorized": True,
                    "authorized_at": task.get("authorized_at"),
                    "authorized_by": task.get("authorized_by"),
                    "collab_phase": collab_phase,
                    "dispatched": dispatch_ok,
                    "dispatch": dispatch_result,
                }
                return out
    raise_task_error(ErrorCode.TASK_NOT_FOUND, f"任务 '{task_id}' 不存在")


@router.post(
    "/{task_id}/dispatch-execution",
    summary="Dispatch authorized execution",
    description="Run start_execution for an already execution_authorized task (UI retry without Lead chat).",
)
async def dispatch_task_execution(
    http_request: Request,
    task_id: str,
    request: AuthorizeExecutionRequest | None = Body(default=None),
) -> dict:
    """Gateway-only worker dispatch; does not require a LangGraph turn."""
    require_task_visible(http_request, task_id)
    from evoflow.collab.authorize_execution import is_task_execution_authorized
    from evoflow.collab.thread_collab import advance_collab_phase_to_executing_for_task

    storage = get_project_storage()
    body = request if request is not None else AuthorizeExecutionRequest()
    tid = str(task_id or "").strip()
    if not tid:
        raise_task_error(ErrorCode.TASK_NOT_FOUND, "task_id is required")
    if not is_task_execution_authorized(storage, tid):
        raise_task_error(
            ErrorCode.EXECUTION_NOT_AUTHORIZED,
            "Task is not execution_authorized; call authorize-execution first.",
        )

    dispatch_result: dict[str, Any] | None = None
    try:
        dispatch_result = await dispatch_authorized_main_task_execution(
            tid,
            thread_id=body.thread_id,
            authorized_by=body.authorized_by or "user",
        )
    except Exception:
        logger.exception("dispatch-execution failed task_id=%s", tid)
        dispatch_result = {
            "success": False,
            "action": "start_execution",
            "taskId": tid,
            "error": "dispatch_failed",
        }

    _disp_ids = dispatch_result.get("subtaskIds") if dispatch_result else None
    dispatch_ok = bool(
        dispatch_result
        and dispatch_result.get("success")
        and (
            (isinstance(_disp_ids, list) and len(_disp_ids) > 0)
            or any(
                isinstance(d, dict) and d.get("ok")
                for d in (dispatch_result.get("delegatedSubtasks") or [])
            )
        )
    )
    if dispatch_ok:
        try:
            advance_collab_phase_to_executing_for_task(
                get_paths(),
                tid,
                runtime_thread_id=body.thread_id,
            )
        except Exception:
            logger.exception("dispatch-execution: advance_collab_phase_to_executing failed task_id=%s", tid)

    out: dict[str, Any] = {
        "success": dispatch_ok,
        "task_id": tid,
        "execution_authorized": True,
        "collab_phase": "executing" if dispatch_ok else "awaiting_exec",
        "dispatch": dispatch_result,
    }
    return out


@router.post(
    "/{task_id}/revoke-execution-authorization",
    summary="Revoke task execution authorization",
    description="Clear execution_authorized after user revises the plan (must re-authorize before start_execution).",
)
async def revoke_task_execution_authorization(
    http_request: Request,
    task_id: str,
    request: AuthorizeExecutionRequest | None = Body(default=None),
) -> dict:
    """Used when user chooses「修改计划」before execution has started."""
    require_task_visible(http_request, task_id)
    storage = get_project_storage()
    body = request if request is not None else AuthorizeExecutionRequest()
    ok, msg = revoke_main_task_execution_authorization(storage, task_id)
    if not ok and "not found" in msg.lower():
        raise_task_error(ErrorCode.TASK_NOT_FOUND, msg)

    try:
        advance_collab_phase_to_plan_ready_for_task(get_paths(), task_id, runtime_thread_id=body.thread_id)
    except Exception:
        logger.exception("revoke-execution-authorization: advance_collab_phase_to_plan_ready failed task_id=%s", task_id)

    for project_summary in storage.list_projects():
        project = storage.load_project(project_summary["id"])
        if not project:
            continue
        for task in project.get("tasks", []):
            if task.get("id") == task_id:
                return {
                    "success": ok,
                    "task_id": task_id,
                    "message": msg,
                    "execution_authorized": bool(task.get("execution_authorized")),
                    "collab_phase": "plan_ready",
                }
    raise_task_error(ErrorCode.TASK_NOT_FOUND, f"任务 '{task_id}' 不存在")


@router.put("/{task_id}", summary="Update Task", description="Update a task.")
async def update_task(http_request: Request, task_id: str, request: UpdateTaskRequest) -> dict:
    """Update a task (incl. inbox assign / promote / self-complete)."""
    from evoflow.collab.task_source import (
        TASK_SOURCE_ROLE,
        TASK_SOURCE_WORKFLOW,
        resolve_write_source,
    )

    require_task_visible(http_request, task_id)
    storage = get_project_storage()
    projects = storage.list_projects()

    for project_summary in projects:
        project = storage.load_project(project_summary["id"])
        if project:
            for i, task in enumerate(project.get("tasks", [])):
                if task.get("id") == task_id:
                    now = utc_now_iso_z()
                    cur_status = str(task.get("status") or "").strip().lower()
                    if request.name is not None:
                        task["name"] = request.name
                    if request.description is not None:
                        task["description"] = request.description
                    if request.raised_by is not None:
                        rb = str(request.raised_by or "").strip()
                        if rb:
                            task["raised_by"] = rb
                    if request.assigned_role is not None:
                        role = str(request.assigned_role or "").strip()
                        if role:
                            task["assigned_role"] = role
                        else:
                            task.pop("assigned_role", None)
                    if request.assigned_to is not None:
                        assignee = str(request.assigned_to or "").strip()
                        if assignee:
                            task["assigned_to"] = assignee
                        else:
                            task.pop("assigned_to", None)
                    if request.priority is not None:
                        pri = str(request.priority or "").strip().upper()
                        if pri in {"P0", "P1", "P2", "P3"}:
                            task["priority"] = pri
                        else:
                            task.pop("priority", None)
                    if request.due_at is not None:
                        due_raw = str(request.due_at or "").strip()
                        if due_raw:
                            task["due_at"] = due_raw
                        else:
                            task.pop("due_at", None)

                    promote = bool(request.promote)
                    if promote and cur_status == "inbox":
                        task["status"] = "pending"
                        run_mode = str(request.run_mode or task.get("run_mode") or "manual").strip().lower()
                        if run_mode not in ("unattended", "manual"):
                            run_mode = "manual"
                        task["run_mode"] = run_mode
                        raw_src = str(request.source or "").strip() or TASK_SOURCE_WORKFLOW
                        src, channel = resolve_write_source(raw_src, default=TASK_SOURCE_WORKFLOW)
                        task["source"] = src
                        if channel:
                            task["source_channel"] = channel
                        else:
                            task["source_channel"] = "task_center_promote"
                        if run_mode == "unattended":
                            task["unattended_stage"] = "queued"
                            task["unattended_enqueued_at"] = now
                            task["unattended_attempts"] = int(task.get("unattended_attempts") or 0)
                        cur_status = "pending"
                    elif request.run_mode is not None and cur_status != "inbox":
                        run_mode = str(request.run_mode or "manual").strip().lower()
                        if run_mode in ("unattended", "manual"):
                            task["run_mode"] = run_mode
                            if run_mode == "unattended" and not task.get("unattended_stage"):
                                task["unattended_stage"] = "queued"
                                task["unattended_enqueued_at"] = now
                                task["unattended_attempts"] = 0

                    # inbox 分配给岗位：进入 pending，供值班拉取；未分配不得自动开跑
                    assigned_now = bool(
                        str(task.get("assigned_role") or "").strip()
                        or str(task.get("assigned_to") or "").strip()
                    )
                    if cur_status == "inbox" and assigned_now and not promote:
                        task["status"] = "pending"
                        raw_src = str(request.source or task.get("source") or "").strip() or TASK_SOURCE_ROLE
                        src, channel = resolve_write_source(raw_src, default=TASK_SOURCE_ROLE)
                        task["source"] = src
                        if channel:
                            task["source_channel"] = channel
                        task["run_mode"] = "manual"
                        cur_status = "pending"

                    if request.source is not None and not promote:
                        raw_src = str(request.source or "").strip()
                        if raw_src:
                            src, channel = resolve_write_source(raw_src)
                            task["source"] = src
                            if channel:
                                task["source_channel"] = channel

                    if request.status is not None:
                        next_status = str(request.status or "").strip().lower()
                        task["status"] = next_status
                        if next_status == "executing" and not task.get("started_at"):
                            task["started_at"] = now
                        elif next_status in ("completed", "failed") and not task.get("completed_at"):
                            task["completed_at"] = now
                    if request.progress is not None:
                        task["progress"] = request.progress

                    task["updated_at"] = now
                    project["tasks"][i] = task
                    if storage.save_project(project):
                        if request.progress is not None:
                            await emit_task_progress(task_id, task_id, task.get("progress", 0), "")
                        final_status = str(task.get("status") or "").strip().lower()
                        if final_status == "completed":
                            await emit_task_completed(task_id, task_id, task.get("result"))
                        return _public_task_dict(task)
                    raise_task_error(ErrorCode.SAVE_FAILED, "任务更新失败")

    raise_task_error(ErrorCode.TASK_NOT_FOUND, f"任务 '{task_id}' 不存在")


@router.post(
    "/{task_id}/state",
    summary="Set Task State",
    description="Validated state transition (reviewed→completed/executing/failed, etc.).",
)
async def set_task_state_endpoint(http_request: Request, task_id: str, request: SetTaskStateRequest) -> dict:
    require_task_visible(http_request, task_id)
    """Set main-task status via admin state machine (single source of truth)."""
    from evoflow.admin.errors import NotFoundError, ValidationError
    from evoflow.admin.tasks import set_task_state
    from evoflow.collab.storage import patch_collab_main_task_in_project_storage

    tid = str(task_id or "").strip()
    target = str(request.status or "").strip().lower()
    comment = str(request.comment or "").strip()
    summary = str(request.summary or "").strip() or None
    outputs_payload: list[dict[str, Any]] | None = None
    if request.outputs is not None:
        outputs_payload = [item.model_dump(exclude_none=True) for item in request.outputs]
    handlers_payload: list[dict[str, Any]] | None = None
    if request.handlers is not None:
        handlers_payload = []
        for item in request.handlers:
            row = item.model_dump(exclude_none=True)
            read = row.get("read_outputs")
            if read is None:
                read = row.get("outputs") or []
            row["read_outputs"] = [
                o if isinstance(o, dict) else (o.model_dump() if hasattr(o, "model_dump") else o)
                for o in (read or [])
            ]
            row.pop("outputs", None)
            handlers_payload.append(row)
    if not tid:
        raise_task_error(ErrorCode.INVALID_PARAMETERS, "task_id is required")
    if not target:
        raise_task_error(ErrorCode.INVALID_PARAMETERS, "status is required")

    try:
        result = set_task_state(
            tid,
            target,
            summary=summary,
            outputs=outputs_payload,
            handlers=handlers_payload,
        )
    except NotFoundError as e:
        raise_task_error(ErrorCode.TASK_NOT_FOUND, str(e))
    except ValidationError as e:
        raise_task_error(ErrorCode.INVALID_STATE, str(e))
    except Exception as e:
        logger.exception("set_task_state failed for %s", tid)
        raise_task_error(ErrorCode.INTERNAL_ERROR, f"状态更新失败: {e}")

    # Optional supervisor note: 打回/失败写入结果或错误字段，便于详情页展示
    if comment:
        note_updates: dict[str, Any] = {}
        if target == "failed":
            note_updates["error"] = comment
        elif target in {"cancelled", "canceled"}:
            note_updates["error"] = f"【已取消】{comment}"
        elif target == "executing":
            found = find_main_task(get_project_storage(), tid, bypass_cache=True)
            prev = ""
            if found:
                prev = str((found[1] or {}).get("result") or "").strip()
            note = f"【上级打回】{comment}"
            note_updates["result"] = f"{note}\n{prev}".strip() if prev else note
        elif target == "completed":
            found = find_main_task(get_project_storage(), tid, bypass_cache=True)
            prev_summary = ""
            prev_result = ""
            if found:
                row = found[1] or {}
                prev_summary = str(row.get("summary") or "").strip()
                prev_result = str(row.get("result") or "").strip()
            note = f"【上级确认】{comment}"
            # Keep employee 任务总结 intact; append confirm note on result only.
            note_updates["result"] = f"{prev_result}\n{note}".strip() if prev_result else note
            if prev_summary:
                note_updates["summary"] = prev_summary
        if note_updates:
            patch_collab_main_task_in_project_storage(get_project_storage(), tid, note_updates)

    if target == "completed":
        found = find_main_task(get_project_storage(), tid, bypass_cache=True)
        if found:
            row = found[1] or {}
            await emit_task_completed(
                tid,
                tid,
                row.get("summary") or row.get("result"),
            )

    return {"success": True, **result}


@router.delete("/{task_id}", summary="Delete Task", description="Delete a task.")
async def delete_task(request: Request, task_id: str) -> dict:
    """Delete a task and its project."""
    from evoflow.admin.tasks import NotFoundError, ValidationError, delete_task as admin_delete_task

    require_task_visible(request, task_id)
    try:
        result = admin_delete_task(task_id)
        return {"success": True, "message": f"Task '{task_id}' deleted", **result}
    except NotFoundError:
        raise_task_error(ErrorCode.TASK_NOT_FOUND, f"任务 '{task_id}' 不存在")
    except ValidationError as e:
        raise_task_error(ErrorCode.SAVE_FAILED, str(e) or f"删除任务 '{task_id}' 失败")
    except Exception as e:
        raise_task_error(ErrorCode.INTERNAL_ERROR, f"删除任务失败：{e}")


@router.post("/{task_id}/start", summary="Start Task Planning", description="Start task planning and execution.")
async def start_task(http_request: Request, task_id: str) -> dict:
    require_task_visible(http_request, task_id)
    """Start task: unattended → enqueue pipeline tick; manual → planning only."""
    from app.gateway.unattended_task_pipeline import advance_unattended_task, is_unattended_task
    from evoflow.collab.plan_task_storage import task_has_bound_plan

    storage = get_project_storage()
    projects = storage.list_projects()

    for project_summary in projects:
        project = storage.load_project(project_summary["id"])
        if project:
            for i, task in enumerate(project.get("tasks", [])):
                if task.get("id") == task_id:
                    if is_unattended_task(task):
                        if task_has_bound_plan(task):
                            task["status"] = "planned"
                            task["unattended_stage"] = "planned"
                        else:
                            task["status"] = "pending"
                            task["unattended_stage"] = "queued"
                            task["unattended_enqueued_at"] = task.get("unattended_enqueued_at") or utc_now_iso_z()
                        project["status"] = task["status"]
                        project["tasks"][i] = task
                        if not storage.save_project(project):
                            raise_task_error(ErrorCode.SAVE_FAILED, "任务启动失败")
                        tick = await advance_unattended_task(task_id)
                        return {
                            "success": True,
                            "message": "Task enqueued for unattended pipeline",
                            "task_id": task_id,
                            "advance": tick,
                        }

                    task["status"] = "planning"
                    project["status"] = "planning"
                    project["tasks"][i] = task
                    if storage.save_project(project):
                        return {"success": True, "message": "Task started planning", "task_id": task_id}
                    raise_task_error(ErrorCode.SAVE_FAILED, "任务启动失败")

    raise_task_error(ErrorCode.TASK_NOT_FOUND, f"任务 '{task_id}' 不存在")


@router.post("/{task_id}/stop", summary="Stop Task Execution", description="Stop a running task.")
async def stop_task(http_request: Request, task_id: str) -> dict:
    require_task_visible(http_request, task_id)
    """Stop task execution: pause task state and cooperatively cancel running subtasks."""
    storage = get_project_storage()
    projects = storage.list_projects()

    for project_summary in projects:
        project = storage.load_project(project_summary["id"])
        if project:
            for i, task in enumerate(project.get("tasks", [])):
                if task.get("id") == task_id:
                    ok, err = await _pause_task_row(project, task, i)
                    if not ok:
                        raise_task_error(ErrorCode.INVALID_STATE, err or "任务停止失败")
                    logger.info("Task %s paused via stop endpoint", task_id)
                    return {"success": True, "message": "Task paused", "task_id": task_id}

    raise_task_error(ErrorCode.TASK_NOT_FOUND, f"任务 '{task_id}' 不存在")


@router.post("/{task_id}/resume", summary="Resume Task", description="Resume a paused task.")
async def resume_task(http_request: Request, task_id: str) -> dict:
    require_task_visible(http_request, task_id)
    """Resume a paused task and re-enter the unattended pipeline when applicable."""
    from app.gateway.unattended_task_pipeline import advance_unattended_task, is_unattended_task
    from evoflow.collab.plan_task_storage import task_has_bound_plan

    storage = get_project_storage()
    projects = storage.list_projects()

    for project_summary in projects:
        project = storage.load_project(project_summary["id"])
        if project:
            for i, task in enumerate(project.get("tasks", [])):
                if task.get("id") == task_id:
                    if task.get("status") != "paused":
                        raise_task_error(ErrorCode.INVALID_STATE, "只能恢复已暂停的任务")

                    unattended = is_unattended_task(task)
                    if unattended:
                        if task_has_bound_plan(task):
                            task["status"] = "planned"
                            task["unattended_stage"] = "planned"
                        else:
                            task["status"] = "pending"
                            task["unattended_stage"] = "queued"
                    else:
                        task["status"] = "executing"
                    # Reset paused subtasks to pending; DAG / unattended advance
                    # re-dispatches only dependency-satisfied steps.
                    for st in task.get("subtasks") or []:
                        if isinstance(st, dict) and str(st.get("status") or "").strip().lower() == "paused":
                            st["status"] = "pending"
                    task["resumed_at"] = utc_now_iso_z()
                    project["status"] = task["status"]
                    project["tasks"][i] = task
                    if not storage.save_project(project):
                        raise_task_error(ErrorCode.SAVE_FAILED, "任务恢复失败")

                    thread_id = task.get("thread_id")
                    try:
                        from evoflow.collab.thread_collab import advance_collab_phase_from_paused

                        advance_collab_phase_from_paused(get_paths(), task_id, runtime_thread_id=thread_id)
                    except Exception as e:
                        logger.warning("Failed to advance collab phase for resumed task %s: %s", task_id, e)

                    advance_result = None
                    if unattended:
                        advance_result = await advance_unattended_task(task_id)
                    else:
                        try:
                            from app.gateway.events.event_queue import event_queue
                            from app.gateway.events.task_events import TaskResumeEvent

                            event = TaskResumeEvent.from_request(
                                task_id=task_id,
                                project_id=project["id"],
                                thread_id=thread_id,
                            )
                            event_queue.publish("task_resume", event)
                        except Exception as e:
                            logger.warning("Failed to publish resume event for task %s: %s", task_id, e)

                    payload: dict[str, Any] = {
                        "success": True,
                        "message": "Task resumed",
                        "task_id": task_id,
                        "status": task.get("status"),
                    }
                    if advance_result is not None:
                        payload["advance"] = advance_result
                    return payload

    raise_task_error(ErrorCode.TASK_NOT_FOUND, f"任务 '{task_id}' 不存在")


@router.post("/{task_id}/restart", summary="Restart Task", description="Clone task as a new task with fresh execution. The original task is archived.")
async def restart_task(http_request: Request, task_id: str) -> dict:
    require_task_visible(http_request, task_id)
    """Restart a task by cloning it as a completely new task with fresh execution."""
    logger.info("[restart_task] start task_id=%s source=api", task_id)

    storage = get_project_storage()
    projects = storage.list_projects()

    for project_summary in projects:
        project = storage.load_project(project_summary["id"])
        if project:
            for i, task in enumerate(project.get("tasks", [])):
                if task.get("id") == task_id:
                    current_status = task.get("status", "")
                    original_thread_id = task.get("thread_id")

                    # ===== Step 1: Stop and archive original task =====
                    if current_status in ("executing", "planning", "paused"):
                        logger.info(f"Task {task_id} is {current_status}, stopping before archiving...")

                        # Cancel all running subtasks
                        for subtask in task.get("subtasks", []):
                            if subtask.get("status") in ("executing", "planning"):
                                subtask["status"] = "cancelled"
                                subtask["cancelled_at"] = utc_now_iso_z()
                                subtask["error"] = "Task restarted - archived"

                        # Revert collaboration phase
                        try:
                            from evoflow.collab.thread_collab import revert_collab_phase_to_paused

                            revert_collab_phase_to_paused(get_paths(), task_id, runtime_thread_id=original_thread_id)
                        except Exception as e:
                            logger.warning(f"Failed to revert collab phase: {e}")

                        # Publish cancellation event
                        try:
                            from app.gateway.events.task_events import TaskCancelEvent

                            running_subtask_ids = [st["id"] for st in task.get("subtasks", []) if st.get("status") in ("executing", "planning")]
                            if running_subtask_ids:
                                cancel_event = TaskCancelEvent(task_id=task_id, project_id=project["id"], subtask_ids=running_subtask_ids, cancelled_by="user", reason="Task restarted - creating new execution", timestamp=datetime.now(UTC))
                                event_queue.publish("task_cancelled", cancel_event)
                        except Exception as e:
                            logger.warning(f"Failed to publish cancellation event: {e}")

                    # Archive original task
                    task["status"] = "archived"
                    task["archived_at"] = utc_now_iso_z()
                    task["archive_reason"] = "restarted"
                    project["tasks"][i] = task

                    if not storage.save_project(project):
                        raise_task_error(ErrorCode.SAVE_FAILED, "归档原任务失败")

                    logger.info(f"任务 {task_id} 已归档，准备创建新任务")

                    # ===== Step 2: Create LangGraph thread first (synchronously) =====
                    # This ensures we have a valid thread_id to return to frontend
                    import os

                    from langgraph_sdk import get_client

                    langgraph_url = os.getenv("EVOFLOW_LANGGRAPH_URL", "http://127.0.0.1:8070/api/langgraph")
                    client = get_client(url=langgraph_url)

                    try:
                        restart_session_key = f"agent:main:task-restart-{task_id}-{int(datetime.now(UTC).timestamp())}"
                        thread = await client.threads.create(
                            metadata={
                                "task_name": task.get("name", "未命名任务"),
                                "source": "restart_task",
                                "original_task_id": task_id,
                                "restart_sequence": task.get("restart_sequence", 0) + 1,
                                "session_key": restart_session_key,
                            }
                        )
                        new_thread_id = thread["thread_id"]
                        logger.info(f"Created new LangGraph thread {new_thread_id} for restarted task")
                    except Exception as e:
                        logger.error(f"Failed to create LangGraph thread: {e}")
                        restart_session_key = None
                        new_thread_id = None

                    # ===== Step 3: Create new task as a clean restart =====
                    new_project_data, new_task = new_project_bundle_root_task(
                        task_name=task.get("name", "未命名任务"),
                        task_description=task.get("description", ""),
                        thread_id=new_thread_id,  # Use the pre-created thread
                    )

                    # IMPORTANT:
                    # Restart should behave like a fresh task from chat:
                    # copy only main task intent (name/description), let Lead re-plan and create subtasks.
                    new_task["subtasks"] = []
                    new_task["execution_authorized"] = True
                    new_task["authorized_at"] = utc_now_iso_z()
                    new_task["authorized_by"] = "user"
                    new_task["parent_task_id"] = task_id  # Link to original task
                    new_task["restart_sequence"] = task.get("restart_sequence", 0) + 1
                    new_task["run_mode"] = task.get("run_mode") or "unattended"
                    new_task["source"] = task.get("source") or "task_center"
                    if str(new_task.get("run_mode") or "").strip().lower() == "unattended":
                        new_task["unattended_stage"] = "queued"
                        new_task["unattended_enqueued_at"] = utc_now_iso_z()
                        new_task["execution_authorized"] = False
                        new_task["authorized_at"] = None
                        new_task["authorized_by"] = None
                    # Note: new_thread_id is already created and set above

                    # Save new project
                    if not storage.save_project(new_project_data):
                        raise_task_error(ErrorCode.SAVE_FAILED, "创建新任务失败")

                    new_task_id = new_task["id"]

                    logger.info(f"新任务 {new_task_id} 已创建（Thread: {new_thread_id}），子任务将由 Lead 重新规划创建")
                    logger.info(
                        "[restart_task] created new_task_id=%s orig_task_id=%s thread_id=%s session_key=%s subtasks=%s",
                        new_task_id,
                        task_id,
                        new_thread_id,
                        restart_session_key,
                        0,
                    )

                    # ===== Step 4: Start execution =====
                    try:
                        # Trigger planning/execution via LangGraph
                        await _notify_lead_agent_to_restart(
                            thread_id=new_thread_id,
                            task_id=new_task_id,
                            project_id=new_project_data["id"],
                        )
                        logger.info(f"已通知 Lead Agent 开始执行新任务 {new_task_id}")
                        logger.info("[restart_task] notified_lead_agent task_id=%s thread_id=%s", new_task_id, new_thread_id)

                        # Broadcast SSE event
                        try:
                            from app.gateway.routers.events import broadcaster

                            if broadcaster:
                                await broadcaster.broadcast(new_task_id, "task:started", {"task_id": new_task_id, "message": "新任务已开始执行", "started_at": utc_now_iso_z()})
                        except Exception as e:
                            logger.warning(f"发送 SSE 启动事件失败: {e}")

                    except Exception as e:
                        logger.error(f"启动新任务 {new_task_id} 失败: {e}")
                        # Still return success as the new task is created

                    return {
                        "success": True,
                        "message": "Task restarted as new execution",
                        "original_task_id": task_id,
                        "new_task_id": new_task_id,
                        "new_thread_id": new_thread_id,
                        "new_session_key": restart_session_key,
                        "new_project_id": new_project_data["id"],
                        "subtask_count": 0,
                        "execution_triggered": True,
                    }

    raise_task_error(ErrorCode.TASK_NOT_FOUND, f"任务 '{task_id}' 不存在")


@router.post("/{task_id}/cancel", summary="Cancel Task", description="Cancel a running or planned task.")
async def cancel_task(http_request: Request, task_id: str) -> dict:
    require_task_visible(http_request, task_id)
    """Cancel a task: set status to cancelled and cancel workers/subtasks."""
    storage = get_project_storage()
    projects = storage.list_projects()

    for project_summary in projects:
        project = storage.load_project(project_summary["id"])
        if project:
            for i, task in enumerate(project.get("tasks", [])):
                if task.get("id") == task_id:
                    cancellable_subtask_ids: list[str] = []
                    thread_id = task.get("thread_id")
                    now_iso = utc_now_iso_z()
                    task["status"] = "cancelled"
                    task["cancelled_at"] = now_iso
                    task["cancel_reason"] = task.get("cancel_reason") or "用户在任务中心取消"
                    # 保留取消前进度，勿写成 100
                    task["completed_at"] = now_iso
                    for subtask in task.get("subtasks", []):
                        if subtask.get("status") not in ("completed", "failed", "cancelled"):
                            sid = str(subtask.get("id") or "").strip()
                            if sid:
                                cancellable_subtask_ids.append(sid)
                            subtask["status"] = "cancelled"
                            subtask["cancelled_at"] = now_iso
                            subtask["completed_at"] = now_iso
                    project["tasks"][i] = task
                    if storage.save_project(project):
                        try:
                            revoke_main_task_execution_authorization(storage, task_id)
                        except Exception as e:
                            logger.debug("revoke auth on cancel skipped task_id=%s: %s", task_id, e)
                        await _cancel_plan_worker(thread_id)
                        await _cancel_supervisor_monitor(task_id)
                        try:
                            mark_task_cancelled(task_id, "user", "task_cancelled")
                            for sid in cancellable_subtask_ids:
                                mark_task_cancelled(sid, "user", "parent_task_cancelled")
                            _publish_task_cancel_event(
                                task_id=task_id,
                                project_id=str(project.get("id") or ""),
                                subtask_ids=cancellable_subtask_ids,
                                reason="Task cancelled from UI",
                                cancelled_by="user",
                            )
                        except Exception as e:
                            logger.warning(f"Failed to propagate cancellation for task {task_id}: {e}")
                        return {"success": True, "message": "Task cancelled", "task_id": task_id}
                    raise_task_error(ErrorCode.TASK_CANCEL_FAILED, "任务取消失败")

    raise_task_error(ErrorCode.TASK_NOT_FOUND, f"任务 '{task_id}' 不存在")


@router.get("/{task_id}/subtasks", summary="List Subtasks", description="List all subtasks of a task.")
async def list_subtasks(http_request: Request, task_id: str) -> list[dict]:
    """List all subtasks of a task."""
    require_task_visible(http_request, task_id)
    task = await get_task(http_request, task_id)
    return task.get("subtasks", [])


@router.post("/{task_id}/subtasks", summary="Add Subtask", description="Add a subtask to a task.")
async def add_subtask(http_request: Request, task_id: str, request: AddSubtaskRequest) -> dict:
    """Add a subtask to a task."""
    require_task_visible(http_request, task_id)
    storage = get_project_storage()
    projects = storage.list_projects()

    for project_summary in projects:
        project = storage.load_project(project_summary["id"])
        if project:
            for i, task in enumerate(project.get("tasks", [])):
                if task.get("id") == task_id:
                    now = utc_now_iso_z()
                    subtask = {
                        "id": make_subtask_id(),
                        "name": request.name,
                        "description": request.description,
                        "status": "pending",
                        "dependencies": request.dependencies,
                        "assigned_to": None,
                        "result": None,
                        "error": None,
                        "created_at": now,
                        "started_at": None,
                        "completed_at": None,
                        "progress": 0,
                    }
                    if request.worker_profile is not None:
                        wp = request.worker_profile.to_storage_dict()
                        if wp:
                            subtask["worker_profile"] = wp

                    task.setdefault("subtasks", []).append(subtask)
                    project["tasks"][i] = task
                    if storage.save_project(project):
                        return subtask
                    raise_task_error(ErrorCode.SAVE_FAILED, "添加子任务失败")

    raise_task_error(ErrorCode.TASK_NOT_FOUND, f"任务 '{task_id}' 不存在")


@router.get("/{task_id}/subtasks/{subtask_id}", summary="Get Subtask", description="Get a subtask by ID.")
async def get_subtask(http_request: Request, task_id: str, subtask_id: str) -> dict:
    require_task_visible(http_request, task_id)
    """Get a subtask by ID."""
    task = await get_task(http_request, task_id)
    for subtask in task.get("subtasks", []):
        if subtask.get("id") == subtask_id:
            return subtask
    raise_task_error(ErrorCode.SUBTASK_NOT_FOUND, f"子任务 '{subtask_id}' 在任务 '{task_id}' 中不存在")


@router.get(
    "/{task_id}/subtasks/{subtask_id}/enriched-prompt",
    response_model=SubtaskEnrichedPromptResponse,
    summary="Get subtask enriched prompt",
    description=(
        "Returns the exact enriched prompt string produced by `_build_subtask_enriched_prompt` "
        "(retry context, worker_profile, plan excerpt from bound_plan_markdown, default self-check). "
        "Note: at actual delegate time the supervisor may append an upstream-dependency summary after this text."
    ),
)
async def get_subtask_enriched_prompt(http_request: Request, task_id: str, subtask_id: str) -> SubtaskEnrichedPromptResponse:
    require_task_visible(http_request, task_id)
    """Mirror runtime `_build_subtask_enriched_prompt` for UI inspection."""
    storage = get_project_storage()
    row = find_main_task(storage, task_id)
    if row is None:
        raise_task_error(ErrorCode.TASK_NOT_FOUND, f"任务 '{task_id}' 不存在")
    _project, task = row
    target_id = str(subtask_id or "").strip()
    subtask_row = next(
        (st for st in (task.get("subtasks") or []) if str(st.get("id") or "").strip() == target_id),
        None,
    )
    if subtask_row is None:
        raise_task_error(
            ErrorCode.SUBTASK_NOT_FOUND,
            f"子任务 '{subtask_id}' 在任务 '{task_id}' 中不存在",
        )
    from evoflow.tools.builtins.supervisor.execution import _build_subtask_enriched_prompt

    text = _build_subtask_enriched_prompt(
        subtask_row=subtask_row,
        main_task_id=task_id,
        subtask_id=subtask_id,
        storage=storage,
    )
    return SubtaskEnrichedPromptResponse(task_id=task_id, subtask_id=subtask_id, enriched_prompt=text)


@router.get(
    "/{task_id}/subtasks/{subtask_id}/conversation-history",
    response_model=SubtaskConversationHistoryResponse,
    summary="Get Subtask Conversation History",
    description="Get persisted conversation-structure history for a subtask.",
)
async def get_subtask_conversation_history(http_request: Request, task_id: str, subtask_id: str, limit: int = Query(500, ge=1, le=5000)) -> SubtaskConversationHistoryResponse:
    require_task_visible(http_request, task_id)
    """Return subtask history from ``evoflow_chat_messages`` (executor thread scope)."""
    task = await get_task(http_request, task_id)
    target_subtask = next((st for st in (task.get("subtasks") or []) if str(st.get("id") or "").strip() == str(subtask_id or "").strip()), None)
    if target_subtask is None:
        raise_task_error(
            ErrorCode.SUBTASK_NOT_FOUND,
            f"子任务 '{subtask_id}' 在任务 '{task_id}' 中不存在",
        )

    from evoflow.collab.conversation_persist import list_subtask_conversation_ui_messages

    cap = max(1, min(int(limit or 500), 5000))
    rows = list_subtask_conversation_ui_messages(
        task,
        str(subtask_id or "").strip(),
        subtask_row=target_subtask if isinstance(target_subtask, dict) else None,
        limit=cap,
    )
    from evoflow.collab.subtask_outcome import build_subtask_outcome_snapshot

    outcome = build_subtask_outcome_snapshot(target_subtask if isinstance(target_subtask, dict) else {})
    return SubtaskConversationHistoryResponse(
        task_id=task_id,
        subtask_id=subtask_id,
        count=len(rows),
        messages=rows,
        outcome=outcome,
    )


@router.post(
    "/{task_id}/subtasks/{subtask_id}/continue-session",
    summary="Continue Subtask Session",
    description="Send a follow-up message to an existing subtask worker session (Claude Code / ACP) with conversation history preserved.",
)
async def continue_subtask_session_api(
    http_request: Request,
    task_id: str,
    subtask_id: str,
    request: ContinueSubtaskSessionRequest = Body(...),
) -> dict[str, Any]:
    """User/UI entrypoint mirroring supervisor continue_subtask_session."""
    require_task_visible(http_request, task_id)
    msg = str(request.message or "").strip()
    if not msg:
        raise_task_error(ErrorCode.INVALID_PARAMETERS, "message is required")

    storage = get_project_storage()
    row = find_main_task(storage, task_id)
    if not row:
        raise_task_error(ErrorCode.TASK_NOT_FOUND, f"任务 '{task_id}' 不存在")
    _project, task = row
    target_subtask = next(
        (st for st in (task.get("subtasks") or []) if str(st.get("id") or "").strip() == str(subtask_id or "").strip()),
        None,
    )
    if target_subtask is None:
        raise_task_error(ErrorCode.SUBTASK_NOT_FOUND, f"子任务 '{subtask_id}' 在任务 '{task_id}' 中不存在")

    has_session = bool(str(target_subtask.get("claude_session_id") or target_subtask.get("external_session_id") or "").strip() or str(target_subtask.get("acp_supervisor_session_id") or "").strip())
    if not task.get("execution_authorized") and not has_session:
        raise_task_error(
            ErrorCode.EXECUTION_NOT_AUTHORIZED,
            "任务尚未授权执行，且子任务尚无 worker 会话；请先授权并开始执行",
        )

    from evoflow.collab.continue_subtask_session import continue_subtask_session

    result = await continue_subtask_session(
        storage=storage,
        task_id=task_id,
        subtask_id=subtask_id,
        agent_message=msg,
        keep_session_open=bool(request.keep_session_open),
        wait_for_completion=bool(request.wait_for_completion),
        runtime=None,
        conversation_source="user_continue_subtask_session",
    )
    if not bool(result.get("success")):
        raise_task_error(
            ErrorCode.EXECUTION_FAILED,
            str(result.get("error") or "continue_subtask_session failed"),
        )
    return {"success": True, "data": result}


@router.put("/{task_id}/subtasks/{subtask_id}", summary="Update Subtask", description="Update a subtask.")
async def update_subtask(http_request: Request, task_id: str, subtask_id: str, request: UpdateSubtaskRequest) -> dict:
    require_task_visible(http_request, task_id)
    """Update a subtask."""
    storage = get_project_storage()
    projects = storage.list_projects()

    for project_summary in projects:
        project = storage.load_project(project_summary["id"])
        if project:
            for i, task in enumerate(project.get("tasks", [])):
                if task.get("id") == task_id:
                    for j, subtask in enumerate(task.get("subtasks", [])):
                        if subtask.get("id") == subtask_id:
                            if request.name is not None:
                                subtask["name"] = request.name
                            if request.description is not None:
                                subtask["description"] = request.description
                            if request.status is not None:
                                subtask["status"] = request.status
                                if request.status == "executing" and not subtask.get("started_at"):
                                    subtask["started_at"] = utc_now_iso_z()
                                elif request.status in ("completed", "failed") and not subtask.get("completed_at"):
                                    subtask["completed_at"] = utc_now_iso_z()
                            if request.assigned_to is not None:
                                subtask["assigned_to"] = request.assigned_to
                            if request.progress is not None:
                                subtask["progress"] = request.progress

                            task["subtasks"][j] = subtask
                            project["tasks"][i] = task
                            if not storage.save_project(project):
                                raise_task_error(ErrorCode.SAVE_FAILED, "更新子任务失败")
                            _refresh_main_task_progress_only(storage, task_id)
                            row = find_main_task(storage, task_id)
                            if not row:
                                raise_task_error(ErrorCode.SAVE_FAILED, "更新子任务后无法重新加载主任务")
                            _proj_fresh, task_fresh = row
                            out_sub = subtask
                            for st in task_fresh.get("subtasks") or []:
                                if isinstance(st, dict) and st.get("id") == subtask_id:
                                    out_sub = st
                                    break
                            if request.progress is not None:
                                await emit_task_progress(
                                    task_id,
                                    subtask_id,
                                    out_sub.get("progress", 0),
                                    "",
                                )
                            if request.status == "completed":
                                await emit_task_completed(task_id, subtask_id, out_sub.get("result"))
                            if task_fresh.get("status") == "completed":
                                await emit_task_completed(task_id, task_id, task_fresh.get("result"))
                            return out_sub

    raise_task_error(ErrorCode.SUBTASK_NOT_FOUND, f"子任务 '{subtask_id}' 不存在")


@router.delete("/{task_id}/subtasks/{subtask_id}", summary="Delete Subtask", description="Delete a subtask.")
async def delete_subtask(http_request: Request, task_id: str, subtask_id: str) -> dict:
    require_task_visible(http_request, task_id)
    """Delete a subtask."""
    storage = get_project_storage()
    projects = storage.list_projects()

    for project_summary in projects:
        project = storage.load_project(project_summary["id"])
        if project:
            for i, task in enumerate(project.get("tasks", [])):
                if task.get("id") == task_id:
                    subtasks = task.get("subtasks", [])
                    for j, subtask in enumerate(subtasks):
                        if subtask.get("id") == subtask_id:
                            task["subtasks"].pop(j)
                            project["tasks"][i] = task
                            if storage.save_project(project):
                                return {"success": True, "message": f"Subtask '{subtask_id}' deleted"}
                            raise_task_error(ErrorCode.SAVE_FAILED, "删除子任务失败")

    raise_task_error(ErrorCode.SUBTASK_NOT_FOUND, f"子任务 '{subtask_id}' 不存在")


@router.post("/{task_id}/subtasks/{subtask_id}/assign", summary="Assign Subtask", description="Assign a subtask to an agent.")
async def assign_subtask(http_request: Request, task_id: str, subtask_id: str, request: AssignSubtaskRequest) -> dict:
    require_task_visible(http_request, task_id)
    """Assign a subtask to an agent."""
    storage = get_project_storage()
    projects = storage.list_projects()

    for project_summary in projects:
        project = storage.load_project(project_summary["id"])
        if project:
            for i, task in enumerate(project.get("tasks", [])):
                if task.get("id") == task_id:
                    for j, subtask in enumerate(task.get("subtasks", [])):
                        if subtask.get("id") == subtask_id:
                            subtask["assigned_to"] = request.agent_id
                            if subtask["status"] == "pending":
                                subtask["status"] = "pending"

                            task["subtasks"][j] = subtask
                            project["tasks"][i] = task
                            if storage.save_project(project):
                                return {"success": True, "message": f"Subtask assigned to {request.agent_id}"}
                            raise_task_error(ErrorCode.SAVE_FAILED, "分配子任务失败")

    raise_task_error(ErrorCode.SUBTASK_NOT_FOUND, f"子任务 '{subtask_id}' 不存在")


@router.post("/batch", summary="Batch Operations", description="Perform batch operations on multiple tasks.")
async def batch_tasks(http_request: Request, request: BatchOperationRequest) -> dict:
    """Perform batch operations (start/cancel/pause/resume/delete) on multiple tasks.

    This endpoint executes the specified action on each task in the task_ids list.
    Each task is processed independently - failure of one does not affect others.
    """
    for _tid in (request.task_ids or []):
        tid = str(_tid or "").strip()
        if tid:
            require_task_visible(http_request, tid)
    action = request.action
    task_ids = request.task_ids

    if not task_ids:
        raise_task_error(ErrorCode.MISSING_REQUIRED_FIELD, "task_ids 不能为空")

    if action not in ("start", "cancel", "pause", "resume", "delete"):
        raise_task_error(ErrorCode.INVALID_ACTION, f"无效的操作 '{action}'，允许的操作: start, cancel, pause, resume, delete")

    storage = get_project_storage()
    results = []
    succeeded = 0
    failed = 0

    # Get all projects to find tasks
    projects = storage.list_projects()
    all_tasks = {}
    task_to_project = {}

    for project_summary in projects:
        project = storage.load_project(project_summary["id"])
        if not project:
            continue
        for task in project.get("tasks", []):
            tid = task.get("id")
            if tid:
                all_tasks[tid] = task
                task_to_project[tid] = (project, project["id"])

    # Process each task
    for task_id in task_ids:
        if task_id not in all_tasks:
            results.append({"task_id": task_id, "success": False, "error": "Task not found"})
            failed += 1
            continue

        task = all_tasks[task_id]
        project, project_id = task_to_project[task_id]
        current_status = task.get("status", "unknown")

        try:
            if action == "start":
                if str(current_status).strip().lower() not in ("pending", "paused"):
                    raise ValueError(f"Task status '{current_status}' does not allow start")
                from app.gateway.unattended_task_pipeline import advance_unattended_task, is_unattended_task
                from evoflow.collab.plan_task_storage import task_has_bound_plan

                row = find_main_task(storage, task_id)
                if not row:
                    raise ValueError("Task not found")
                proj, tsk = row
                idx = next(i for i, x in enumerate(proj.get("tasks") or []) if x.get("id") == task_id)
                if is_unattended_task(tsk):
                    if task_has_bound_plan(tsk):
                        tsk["status"] = "planned"
                        tsk["unattended_stage"] = "planned"
                    else:
                        tsk["status"] = "pending"
                        tsk["unattended_stage"] = "queued"
                        tsk["unattended_enqueued_at"] = tsk.get("unattended_enqueued_at") or utc_now_iso_z()
                else:
                    tsk["status"] = "planning"
                proj["status"] = tsk["status"]
                proj["tasks"][idx] = tsk
                if not storage.save_project(proj):
                    raise RuntimeError("Failed to save project")
                tick = await advance_unattended_task(task_id) if is_unattended_task(tsk) else None
                results.append({"task_id": task_id, "success": True, "status": tsk.get("status"), "advance": tick})
                succeeded += 1
                continue

            elif action == "cancel":
                if current_status in ("completed", "failed", "cancelled"):
                    raise ValueError(f"Task already in terminal state: {current_status}")
                await cancel_task(task_id)
                results.append({"task_id": task_id, "success": True, "status": "cancelled"})
                succeeded += 1
                continue

            elif action == "pause":
                row = find_main_task(storage, task_id)
                if not row:
                    raise ValueError("Task not found")
                proj, tsk = row
                idx = next(i for i, x in enumerate(proj.get("tasks") or []) if x.get("id") == task_id)
                ok, err = await _pause_task_row(proj, tsk, idx)
                if not ok:
                    raise ValueError(err or "pause_failed")
                results.append({"task_id": task_id, "success": True, "status": "paused"})
                succeeded += 1
                continue

            elif action == "resume":
                if str(current_status).strip().lower() != "paused":
                    raise ValueError(f"Task must be 'paused' to resume, current: {current_status}")
                payload = await resume_task(task_id)
                results.append({"task_id": task_id, "success": True, "status": payload.get("status", "executing")})
                succeeded += 1
                continue

            elif action == "delete":
                task["status"] = "deleted"
                task["deleted_at"] = utc_now_iso_z()

            # Save project
            project_tasks = project.get("tasks", [])
            for idx, t in enumerate(project_tasks):
                if t.get("id") == task_id:
                    project_tasks[idx] = task
                    break

            if storage.save_project(project):
                results.append({"task_id": task_id, "success": True, "status": task.get("status")})
                succeeded += 1
            else:
                raise RuntimeError("Failed to save project")

        except Exception as e:
            logger.exception(f"Batch {action} failed for task {task_id}")
            results.append({"task_id": task_id, "success": False, "status": current_status, "error": str(e)})
            failed += 1

    return {"success": True, "data": {"action": action, "total": len(task_ids), "succeeded": succeeded, "failed": failed, "results": results}}


@router.post("/{task_id}/retry", summary="Retry Failed Subtasks", description="Retry failed subtasks of a task.")
async def retry_task(http_request: Request, task_id: str, request: RetrySubtaskRequest) -> dict:
    require_task_visible(http_request, task_id)
    """Retry failed subtasks of a task.

    This endpoint allows retrying specific failed subtasks or all failed subtasks.
    Retried subtasks are reset to 'pending' status and can be re-executed.
    """
    storage = get_project_storage()
    projects = storage.list_projects()

    for project_summary in projects:
        project = storage.load_project(project_summary["id"])
        if not project:
            continue

        for i, task in enumerate(project.get("tasks", [])):
            if task.get("id") == task_id:
                subtasks = task.get("subtasks", [])
                retried = []
                failed_to_retry = []

                # Determine which subtasks to retry
                subtasks_to_retry = []
                if request.retry_all_failed:
                    subtasks_to_retry = [s for s in subtasks if s.get("status") == "failed"]
                elif request.subtask_ids:
                    subtasks_to_retry = [s for s in subtasks if s.get("id") in request.subtask_ids]

                if not subtasks_to_retry:
                    raise_task_error(ErrorCode.SUBTASK_NOT_RETRYABLE, "没有可重试的子任务")

                # Retry each subtask
                for subtask in subtasks_to_retry:
                    subtask_id = subtask.get("id")
                    current_status = subtask.get("status")

                    if current_status != "failed":
                        failed_to_retry.append({"subtask_id": subtask_id, "error": f"Status is '{current_status}', not 'failed'"})
                        continue

                    # Reset subtask to pending
                    subtask["status"] = "pending"
                    subtask["previous_attempts"] = subtask.get("previous_attempts", 0) + 1
                    subtask["retried_at"] = utc_now_iso_z()
                    # Clear failure info
                    subtask.pop("error", None)
                    subtask.pop("failed_at", None)
                    subtask.pop("result", None)

                    retried.append(subtask_id)

                # Update task status if it was failed
                if task.get("status") == "failed" and retried:
                    task["status"] = "executing"
                    task["retry_attempts"] = task.get("retry_attempts", 0) + 1
                    task["retried_at"] = utc_now_iso_z()

                # Save project
                project["tasks"][i] = task
                if storage.save_project(project):
                    return {"success": True, "data": {"task_id": task_id, "retried_subtasks": retried, "failed_to_retry": failed_to_retry, "total_retried": len(retried), "task_status": task.get("status")}}
                raise_task_error(ErrorCode.SAVE_FAILED, "保存任务失败")

    raise_task_error(ErrorCode.TASK_NOT_FOUND, f"任务 '{task_id}' 不存在")


async def _log_task_restart(
    task_id: str,
    thread_id: str | None,
    phase: str,
    details: dict[str, Any] | None = None,
) -> None:
    """记录任务重启关键环节（不落盘，仅标准 logger）。"""
    if details:
        logger.info("[task_restart] task=%s thread=%s phase=%s details=%s", task_id, thread_id, phase, details)
    else:
        logger.info("[task_restart] task=%s thread=%s phase=%s", task_id, thread_id, phase)


async def _notify_lead_agent_to_restart(
    thread_id: str,
    task_id: str,
    project_id: str,
) -> None:
    """通知 Lead Agent 任务已重启，请重新执行"""
    logger.info("[notify_restart] start task_id=%s thread_id=%s", task_id, thread_id)

    try:
        # 通过事件系统触发执行
        from app.gateway.events.event_queue import event_queue
        from app.gateway.events.task_events import TaskAuthorizedEvent

        event = TaskAuthorizedEvent.from_request(
            task_id=task_id,
            project_id=project_id,
            authorized_by="user",
            thread_id=thread_id,
        )
        event_queue.publish("task_authorized", event)

        logger.info("[notify_restart] published task_authorized task_id=%s thread_id=%s", task_id, thread_id)
    except Exception as e:
        logger.error(f"发布任务授权事件失败: {e}")
        await _log_task_restart(task_id=task_id, thread_id=thread_id, phase="发布任务授权事件失败", details={"错误": str(e), "错误类型": type(e).__name__})
        raise


async def _archive_current_execution(
    task: dict[str, Any],
    thread_id: str,
) -> dict[str, Any] | None:
    """归档当前执行记录到 execution_history"""
    try:
        # 创建执行记录（不再归档 ui_messages，直接从 LangGraph 查询）
        from evoflow.collab.id_format import make_formatted_id

        execution_id = make_formatted_id("Exec")

        record = {
            "execution_id": execution_id,
            "thread_id": thread_id,
            "started_at": task.get("started_at"),
            "completed_at": utc_now_iso_z(),
            "status": task.get("status", "unknown"),
            "summary": None,
        }

        await _log_task_restart(task_id=task.get("id", "未知"), thread_id=thread_id, phase="创建执行记录完成", details={"执行记录ID": execution_id})

        return record

    except Exception as e:
        logger.warning(f"归档任务 {task.get('id')} 执行记录失败: {e}")
        await _log_task_restart(task_id=task.get("id", "未知"), thread_id=thread_id, phase="归档执行记录失败", details={"错误": str(e)})
        return None


@router.get("/{task_id}/execution-history", summary="Get Execution History", description="Get task execution history list.")
async def get_execution_history(http_request: Request, task_id: str) -> dict:
    require_task_visible(http_request, task_id)
    """获取任务的执行历史列表"""
    storage = get_project_storage()
    projects = storage.list_projects()

    for project_summary in projects:
        project = storage.load_project(project_summary["id"])
        if not project:
            continue

        for task in project.get("tasks", []):
            if task.get("id") == task_id:
                execution_history = task.get("execution_history", [])
                current_thread_id = task.get("thread_id")

                # 尝试从 LangGraph 获取 thread 的 session_key
                session_key = None
                if current_thread_id:
                    try:
                        from langgraph_sdk import get_client

                        from evoflow.config.paths import get_paths

                        paths = get_paths()
                        langgraph_url = getattr(paths, "langgraph_url", None) or "http://127.0.0.1:8070/api/langgraph"
                        client = get_client(url=langgraph_url)
                        thread = await client.threads.get(current_thread_id)
                        metadata = thread.get("metadata", {}) if thread else {}
                        session_key = metadata.get("session_key")
                    except Exception as e:
                        logger.debug(f"Failed to get thread metadata for {current_thread_id}: {e}")

                return {
                    "task_id": task_id,
                    "current_thread_id": current_thread_id,
                    "session_key": session_key,
                    "execution_history": execution_history,
                    "total_executions": len(execution_history),
                }

    raise_task_error(ErrorCode.TASK_NOT_FOUND, f"任务 '{task_id}' 不存在")


@router.get("/{task_id}/observability", summary="Get Task Observability", description="Model/tool token and invocation metrics from observability SQLite.")
async def get_task_observability(
    http_request: Request,
    task_id: str,
    since_hours: float | None = Query(None, ge=0, le=24 * 90, description="Limit metrics to recent hours; omit for all time"),
) -> dict:
    """Per-task metrics aggregated from ``evoflow_observability.db`` by thread_id."""
    require_task_visible(http_request, task_id)
    from evoflow.collab.task_observability import summarize_task_observability
    from evoflow.observability.queries import ObservabilityDiskFullError, disk_full_user_message

    storage = get_project_storage()
    row = find_main_task(storage, task_id)
    if not row:
        raise_task_error(ErrorCode.TASK_NOT_FOUND, f"任务 '{task_id}' 不存在")
    _project, task = row
    try:
        return summarize_task_observability(task_id, task, since_hours=since_hours)
    except ObservabilityDiskFullError as exc:
        raise_task_error(ErrorCode.INTERNAL_ERROR, str(exc) or disk_full_user_message())
    except Exception as exc:
        logger.warning("task observability failed task_id=%s: %s", task_id, exc, exc_info=True)
        raise_task_error(ErrorCode.INTERNAL_ERROR, f"观测数据读取失败: {exc}")


@router.get("/{task_id}/runtime", summary="Get Task Runtime", description="Get task runtime state including agent assignments.")
async def get_task_runtime(http_request: Request, task_id: str) -> dict:
    require_task_visible(http_request, task_id)
    """Get task runtime state.

    Returns runtime information including:
    - Agent assignments
    - Current executing subtasks
    - Runtime metadata
    """
    storage = get_project_storage()
    projects = storage.list_projects()

    for project_summary in projects:
        project = storage.load_project(project_summary["id"])
        if not project:
            continue

        for task in project.get("tasks", []):
            if task.get("id") == task_id:
                # Build agents list from subtask assignments
                agents = []
                assigned_agents = set()

                for subtask in task.get("subtasks", []):
                    assigned_to = subtask.get("assigned_to")
                    if assigned_to and assigned_to not in assigned_agents:
                        assigned_agents.add(assigned_to)
                        agents.append(
                            {
                                "agent_id": assigned_to,
                                "agent_name": assigned_to,
                                "status": "busy" if subtask.get("status") == "executing" else "idle",
                                "current_subtask_id": subtask.get("id") if subtask.get("status") == "executing" else None,
                                "progress": subtask.get("progress", 0),
                            }
                        )

                return {
                    "success": True,
                    "data": {
                        "task_id": task_id,
                        "status": task.get("status"),
                        "agents": agents,
                        "updated_at": utc_now_iso_z(),
                    },
                }

    raise_task_error(ErrorCode.TASK_NOT_FOUND, f"任务 '{task_id}' 不存在")


@router.get("/subagent/{task_id}/transcript", summary="Subagent Task Transcript")
async def get_subagent_task_transcript(http_request: Request, task_id: str) -> dict:
    require_task_visible(http_request, task_id)
    """Return subagent execution transcript (AI messages) by background task ID.

    Reads from the in-memory ``_background_tasks`` store maintained by
    ``SubagentExecutor``; no database persistence layer needed.

    Collab UIs may pass ``collab_subtask_id``; when the direct lookup misses,
    resolve ``background_task_id`` from the subtask row and retry.
    """
    from evoflow.subagents.executor import get_background_task_result_or_snapshot

    lookup_id = str(task_id or "").strip()
    result = get_background_task_result_or_snapshot(lookup_id) if lookup_id else None
    if result is None and lookup_id:
        try:
            from evoflow.collab.storage import find_subtask_row_by_id, get_project_storage

            found = find_subtask_row_by_id(get_project_storage(), lookup_id)
            if found is not None:
                _project, _task, st = found
                bg_id = str(st.get("background_task_id") or "").strip()
                if bg_id and bg_id != lookup_id:
                    result = get_background_task_result_or_snapshot(bg_id)
                    if result is not None:
                        lookup_id = bg_id
        except Exception:
            pass

    if result is None:
        return {
            "task_id": task_id,
            "status": "unknown",
            "messages": [],
            "empty": True,
        }

    messages = list(result.stream_messages or [])
    # Claude Code 等工作常把正文写在 result 字段，stream_messages 仅有薄包装 tool 行；
    # 弹窗若只吃 messages 会空白，这里用 result/error 合成一条可展示 AI 消息。
    if not messages:
        body = str(result.result or "").strip()
        err = str(result.error or "").strip()
        if body or err:
            messages = [
                {
                    "type": "ai",
                    "role": "assistant",
                    "content": body or err,
                }
            ]

    return {
        "task_id": lookup_id,
        "status": result.status.value if hasattr(result.status, "value") else str(result.status),
        "result": result.result,
        "error": result.error,
        "started_at": result.started_at.isoformat() if result.started_at else None,
        "completed_at": result.completed_at.isoformat() if result.completed_at else None,
        "messages": messages,
        "ai_messages": result.ai_messages or [],
        "empty": not bool(messages),
    }


class SaveAsAppRequest(BaseModel):
    name: str | None = None
    description: str | None = None
    execution_mode: str = "workflow"
    auto_extract: bool = True
    max_params: int = 5


@router.post(
    "/{task_id}/save-as-app",
    summary="Save Task as Reusable App",
    description="Convert an existing task (with plan) into a reusable App definition. "
    "Auto-extracts parameter placeholders from plan content (product names, domains, "
    "years, tech terms, etc.) if auto_extract=True.",
)
def save_task_as_app_endpoint(
    http_request: Request,
    task_id: str,
    request: SaveAsAppRequest,
) -> dict[str, Any]:
    require_task_visible(http_request, task_id)
    """Save an existing task as a reusable App definition."""
    storage = get_project_storage()
    project_data, task = find_main_task(storage, task_id)
    if not task:
        raise_task_error(ErrorCode.TASK_NOT_FOUND, f"Task not found: {task_id}")

    plan_goal = task.get("plan_goal") or ""
    plan_steps = task.get("plan_steps") or []
    plan_validation = task.get("plan_validation") or []
    flowchart_mermaid = task.get("plan_flowchart_mermaid") or ""

    if not plan_goal or not plan_steps:
        raise_task_error(
            ErrorCode.INVALID_STATUS,
            "Task has no plan. Only tasks with a bound plan can be saved as an App.",
        )

    from evoflow.collab.app_extractor import create_app_from_task
    from evoflow.persistence import app_repositories

    app_doc = create_app_from_task(
        task_id=task_id,
        task_name=task.get("name", ""),
        task_description=task.get("description", ""),
        plan_goal=plan_goal,
        plan_steps=plan_steps,
        plan_validation=plan_validation,
        flowchart_mermaid=flowchart_mermaid,
        app_name=request.name,
        app_description=request.description,
        execution_mode=request.execution_mode,
        auto_extract=request.auto_extract,
    )

    # Cap parameters at max_params (create_app_from_task may have extracted more)
    if len(app_doc["parameters"]) > request.max_params:
        app_doc["parameters"] = app_doc["parameters"][: request.max_params]

    app_repositories.save_app(app_doc["id"], app_doc)

    created = app_repositories.load_app(app_doc["id"])
    if created is None:
        raise HTTPException(status_code=500, detail="Failed to save application")

    return created
