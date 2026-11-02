"""Tasks API router for multi-agent collaboration - task-centric model."""

import logging
import os
from datetime import UTC, datetime
from typing import Any

from fastapi import APIRouter, Body, Depends, HTTPException, Query, Request
from pydantic import BaseModel, Field

from app.gateway.cancellation import mark_task_cancelled
from app.gateway.deps.license import require_premium
from app.gateway.events import event_queue
from app.gateway.events.task_events import TaskCancelEvent
from app.gateway.routers.errors import (
    ErrorCode,
    raise_task_error,
)
from app.gateway.routers.events import emit_task_completed, emit_task_progress
from evoflow.authz.http_guard import require_task_visible, require_thread_visible, resolve_authz_from_request
from evoflow.collab.authorize_execution import authorize_main_task_execution, revoke_main_task_execution_authorization
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
    # 列表 UI 不消费的大字段：app_definition_snapshot 占整个列表响应 ~20%
    # （App 运行详情走 GET /tasks/{id}），evidence_paths 亦无列表读点。
    "app_definition_snapshot",
    "evidence_paths",
    # 列表卡/筛选不需要结构化交付物；详情走 GET /tasks/{id}
    "outputs",
    "handlers",
    "input_refs",
    "result_text",
    "result_summary",
    "run_parameters",
    "dependencies",
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
        if isinstance(val, str) and len(val) > 160:
            out[k] = val[:160]
        elif isinstance(val, (dict, list)):
            out.pop(k, None)
    # Root catalog rows always ship empty subtasks[]; omit to shrink wire size.
    subs = out.get("subtasks")
    if not isinstance(subs, list) or not subs:
        out.pop("subtasks", None)
    return out


# Default / hard caps for GET /api/tasks catalog. page_size=0 historically meant
# "return every root" and forced a full-table hydrate even after SQL gained LIMIT —
# that is what kept wedging Gateway under chat load. Never unbounded again.
_TASKS_LIST_DEFAULT_PAGE = 40
_TASKS_LIST_ALL_CAP = 200
_TASKS_LIST_MAX_SCAN = 2500


def _resolve_list_page_size(*, page_size: int, limit: int | None) -> int:
    """``page_size`` wins; ``limit`` is a FE/compat alias when page_size is 0 (all).

    Returns 0 only when the caller explicitly asked for unbounded (legacy); the
    catalog path clamps that to ``_TASKS_LIST_ALL_CAP`` so SQL always pages.
    """
    size = int(page_size or 0)
    if size > 0:
        return size
    if limit is None:
        return 0
    try:
        n = int(limit)
    except (TypeError, ValueError):
        return 0
    return max(0, n)


def _attach_runtime_health(task: dict[str, Any]) -> dict[str, Any]:
    """Stamp ``runtime_health`` from SQLite session runs (authoritative for 已中断/在跑)."""
    try:
        from evoflow.collab.task_runtime_health import enrich_tasks_runtime_health

        enrich_tasks_runtime_health([task])
    except Exception:
        logger.debug("attach runtime_health failed", exc_info=True)
    return task


def _public_task_dict(task: dict[str, Any], *, for_list: bool = False) -> dict[str, Any]:
    """Task-centric API: omit legacy project bundle fields from responses.

    ``for_list=True`` (Task Center catalog): skip ``task_outputs_of`` /
    ``task_input_refs_of`` / ``task_handlers_of``. Those walk the filesystem to
    absolutize paths (~2s cold for a 40-row page) and the list path drops the
    fields in ``_slim_task_for_list`` anyway.
    """
    from evoflow.admin.tasks import task_summary_of
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
    if (raw_src is None or not str(raw_src).strip()) and (str(out.get("source_app_id") or "").strip() or str(out.get("source_run_id") or "").strip()):
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
    if for_list:
        # Catalog cards only need summary/status/source — drop heavy handoff blobs
        # before any filesystem absolutize. Detail views keep full enrichment.
        for k in ("outputs", "input_refs", "handlers", "evidence_paths"):
            out.pop(k, None)
        return out

    from evoflow.collab.task_outputs import task_input_refs_of, task_outputs_of

    outputs = task_outputs_of(out)
    if outputs:
        out["outputs"] = outputs
    elif "outputs" in out and not out.get("outputs"):
        out.pop("outputs", None)

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
        description=("结构化产出列表 [{type,key,value,label?}]；type=file|url|text|other。本岗交付物，不是下游 input_refs。"),
    )
    handlers: list[TaskHandlerItem] | None = Field(
        default=None,
        description=(
            "下游处理人列表（每人一条）：[{agent_code, content, read_outputs[], role?}]。交工 reviewed 时写入（员工仅可指派直属下级）；确认 completed 时可改（用户可同组织改派），确认后按条建下游 Task，子任务写入 input_refs 并 wake。"
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
    messages: list[dict[str, Any]] = Field(
        default_factory=list,
        description="Rows from evoflow_chat_messages only (same store as main chat). Never includes outcome summary.",
    )
    thread_id: str | None = Field(
        default=None,
        description="Resolved executor thread_id — prefer GET /api/chat/sessions/by-thread/{thread_id}/messages.",
    )
    outcome: dict[str, Any] = Field(
        default_factory=dict,
        description="Canonical handoff from done (task_report/summary); not a chat message.",
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


# Cancel helpers moved to the shared module (E-2) so App-run cancel reaches the
# same depth as Task Center cancel. Names are re-exported for local callers.
from app.gateway.task_cancel_support import (  # noqa: E402
    _cancel_plan_worker,
    _cancel_supervisor_monitor,
    _collect_running_subtask_ids,
    _publish_task_cancel_event,
    cancel_app_run_deep,
)


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
        _TASKS_LIST_DEFAULT_PAGE,
        ge=0,
        le=500,
        description=(
            f"Page size (default {_TASKS_LIST_DEFAULT_PAGE}). "
            f"0 = capped catalog window ({_TASKS_LIST_ALL_CAP}), never unbounded."
        ),
    ),
    limit: int | None = Query(
        None,
        ge=0,
        le=500,
        description="Alias for page_size when page_size=0 (evopanel listAllTasks historically sent limit).",
    ),
    hide_noise: bool = Query(
        True,
        description=("Hide task-center noise by default: duty patrol rounds, upstream receipts, meeting oral reports, status_check, eval placeholders. Pass hide_noise=false to include."),
    ),
    has_role: bool = Query(
        False,
        description="Only return tasks stamped with assigned_role (岗位). Role work-boards drop unassigned tasks client-side, so they can filter server-side instead of pulling the full catalog.",
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

        effective_page_size = _resolve_list_page_size(page_size=page_size, limit=limit)
        shed_applied = False
        # Under Gateway overload (chat stream + sessions pile-up), unbounded or
        # large catalogs wedge the thread pool and delay workflow open /messages.
        # Cap hard instead of serving page_size=0 / 100+ while lag/slow REST is high.
        try:
            from app.gateway.hang_diagnostics import should_shed_best_effort

            clamp_hint = False
            try:
                clamp_hint = bool(getattr(request.state, "traffic_lane_clamp", False))
            except Exception:
                clamp_hint = False
            if clamp_hint or should_shed_best_effort(min_slow=2, min_wait_s=4.0):
                shed_cap = int(os.environ.get("EVOFLOW_TASKS_LIST_SHED_PAGE_SIZE", "20") or 20)
                shed_cap = max(5, min(shed_cap, 40))
                if effective_page_size <= 0 or effective_page_size > shed_cap:
                    logger.warning(
                        "list_tasks shed: clamping page_size %s → %s (gateway overloaded clamp=%s)",
                        effective_page_size or "all",
                        shed_cap,
                        clamp_hint,
                    )
                    effective_page_size = shed_cap
                    shed_applied = True
        except Exception:
            logger.debug("list_tasks shed check failed", exc_info=True)

        import time as _time

        from app.gateway.hang_diagnostics import append_gateway_slow_log
        from app.gateway.traffic_lanes import tasks_catalog_slot

        catalog_timeout_s = float(os.environ.get("EVOFLOW_TASKS_LIST_TIMEOUT_S", "10") or 10)
        catalog_timeout_s = max(3.0, min(catalog_timeout_s, 30.0))
        acquire_s = min(3.0, catalog_timeout_s)
        slot = tasks_catalog_slot()
        t_acq0 = _time.perf_counter()
        try:
            await asyncio.wait_for(slot.acquire(), timeout=acquire_s)
        except TimeoutError:
            logger.warning("list_tasks catalog slot busy (acquire>%.1fs)", acquire_s)
            append_gateway_slow_log(
                kind="tasks_catalog_slot_busy",
                method="GET",
                path="/api/tasks",
                duration_s=_time.perf_counter() - t_acq0,
                status_code=503,
                extra=f"page_size={effective_page_size}",
            )
            raise HTTPException(status_code=503, detail="tasks list busy, retry shortly") from None
        acquire_ms = (_time.perf_counter() - t_acq0) * 1000
        try:
            t_work0 = _time.perf_counter()
            try:
                payload = await asyncio.wait_for(
                    asyncio.to_thread(
                        _list_tasks_catalog_sync,
                        status=status,
                        source=source,
                        search=search,
                        project_id=project_id,
                        sort=sort,
                        order=order,
                        page=page,
                        page_size=effective_page_size,
                        hide_noise=hide_noise,
                        has_role=has_role,
                        is_admin=bool(authz.get("is_admin")),
                        personal_scope=authz.get("personal_scope"),
                        org_scope=authz.get("org_scope"),
                        principal=authz.get("principal"),
                    ),
                    timeout=catalog_timeout_s,
                )
            except TimeoutError:
                logger.warning(
                    "list_tasks catalog timed out after %.1fs page_size=%s acquire_ms=%.0f",
                    catalog_timeout_s,
                    effective_page_size,
                    acquire_ms,
                )
                append_gateway_slow_log(
                    kind="tasks_catalog_timeout",
                    method="GET",
                    path="/api/tasks",
                    duration_s=catalog_timeout_s,
                    status_code=503,
                    extra=f"page_size={effective_page_size} acquire_ms={acquire_ms:.0f}",
                )
                raise HTTPException(
                    status_code=503, detail="tasks list timed out, retry shortly"
                ) from None
            work_ms = (_time.perf_counter() - t_work0) * 1000
            n_tasks = len((payload or {}).get("tasks") or []) if isinstance(payload, dict) else 0
            total = (payload or {}).get("total") if isinstance(payload, dict) else None
            if work_ms >= 200 or acquire_ms >= 100:
                logger.info(
                    "list_tasks catalog done work_ms=%.0f acquire_ms=%.0f page_size=%s n=%s total=%s shed=%s",
                    work_ms,
                    acquire_ms,
                    effective_page_size,
                    n_tasks,
                    total,
                    shed_applied,
                )
            if work_ms >= 1000:
                append_gateway_slow_log(
                    kind="tasks_catalog",
                    method="GET",
                    path="/api/tasks",
                    duration_s=work_ms / 1000.0,
                    extra=(
                        f"acquire_ms={acquire_ms:.0f} page_size={effective_page_size} "
                        f"n={n_tasks} total={total} shed={shed_applied}"
                    ),
                )
        finally:
            slot.release()
        if shed_applied and isinstance(payload, dict):
            payload = {**payload, "shed": True, "shed_page_size": effective_page_size}
        return {"success": True, "data": payload}
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("list_tasks failed")
        raise_task_error(ErrorCode.INTERNAL_ERROR, f"获取任务列表失败: {str(e)}")


def _catalog_row_matches(
    task: dict[str, Any],
    *,
    status: str | None,
    source: str | None,
    search: str | None,
    has_role: bool,
    hide_noise: bool,
    is_admin: bool,
    personal_scope: str | None,
    org_scope: str | None,
    principal: Any,
) -> dict[str, Any] | None:
    """Apply Python-side catalog filters; return slimmed row or None."""
    from evoflow.authz.resource_visibility import owner_scope_visible_to_principal

    if has_role and not str(task.get("assigned_role") or "").strip():
        return None
    if not owner_scope_visible_to_principal(
        task.get("owner_scope_id"),
        principal,
        is_admin=is_admin,
        personal_scope=personal_scope,
        org_scope=org_scope,
    ):
        return None
    if status and not _status_matches_filter(task, status):
        return None
    if source:
        from evoflow.collab.task_source import sources_equal

        if not sources_equal(task.get("source"), source):
            return None
    if search:
        task_name = str(task.get("name") or "").lower()
        task_id = str(task.get("id") or "").lower()
        search_lower = search.lower()
        if search_lower not in task_name and search_lower not in task_id:
            return None
    task_data = _slim_task_for_list(_public_task_dict(task, for_list=True))
    if hide_noise:
        from evoflow.collab.task_noise import is_task_center_noise

        if is_task_center_noise(task_data):
            return None
    return task_data


_CATALOG_SQL_PREFILTERS: bool | None = None


def _catalog_list_roots(
    *,
    limit: int | None = None,
    offset: int = 0,
    main_task_id: str | None = None,
    has_role: bool = False,
    exclude_noise: bool = False,
    owner_scope_ids: list[str] | None = None,
    search: str | None = None,
) -> tuple[list[dict[str, Any]], bool]:
    """Call ``list_root_task_summaries`` with SQL prefilters when the harness supports them.

    Packaged ``evoflow-gateway.exe`` may ship an older harness without
    ``has_role`` / ``exclude_noise`` kwargs while ``app/gateway`` hot-reloads from
    source — never 500 on TypeError; fall back to limit/offset only and let
    Python filters finish the job. Returns ``(rows, sql_prefilters_applied)``.
    """
    global _CATALOG_SQL_PREFILTERS
    from evoflow.persistence.repositories import list_root_task_summaries

    base = {"main_task_id": main_task_id, "limit": limit, "offset": offset}
    if _CATALOG_SQL_PREFILTERS is False:
        return list_root_task_summaries(**base), False

    rich = {
        **base,
        "has_role": bool(has_role),
        "exclude_noise": bool(exclude_noise),
        "owner_scope_ids": owner_scope_ids,
        "search": str(search or "").strip() or None,
    }
    try:
        rows = list_root_task_summaries(**rich)
        _CATALOG_SQL_PREFILTERS = True
        return rows, True
    except TypeError as exc:
        if "unexpected keyword" not in str(exc):
            raise
        _CATALOG_SQL_PREFILTERS = False
        logger.warning(
            "list_root_task_summaries missing SQL prefilter kwargs (%s); "
            "using limit/offset only — rebuild gateway binary to pick up harness pushdown",
            exc,
        )
        return list_root_task_summaries(**base), False


def _catalog_count_roots(
    *,
    main_task_id: str | None = None,
    has_role: bool = False,
    exclude_noise: bool = False,
    owner_scope_ids: list[str] | None = None,
    search: str | None = None,
) -> int | None:
    """COUNT with prefilters when supported; None if harness is too old."""
    from evoflow.persistence.repositories import count_root_task_summaries

    if _CATALOG_SQL_PREFILTERS is False:
        try:
            return int(count_root_task_summaries(main_task_id=main_task_id))
        except TypeError:
            return None

    rich = {
        "main_task_id": main_task_id,
        "has_role": bool(has_role),
        "exclude_noise": bool(exclude_noise),
        "owner_scope_ids": owner_scope_ids,
        "search": str(search or "").strip() or None,
    }
    try:
        return int(count_root_task_summaries(**rich))
    except TypeError as exc:
        if "unexpected keyword" not in str(exc):
            raise
        try:
            return int(count_root_task_summaries(main_task_id=main_task_id))
        except TypeError:
            return None


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
    has_role: bool = False,
    is_admin: bool = False,
    personal_scope: str | None = None,
    org_scope: str | None = None,
    principal: Any = None,
) -> dict[str, Any]:
    """Sync body for ``list_tasks`` catalog path (run via ``asyncio.to_thread``).

    Critical: SQL ``LIMIT``/``OFFSET`` must be used. The old path called
    ``list_root_task_summaries()`` with no limit, filtered in Python, then sliced —
    so ``page_size=40`` still scanned every root and wedged Gateway during chat.
    """
    import time as _time

    t_sync0 = _time.perf_counter()
    mid = str(project_id or "").strip() or None
    requested = int(page_size or 0)
    if requested <= 0:
        size = int(os.environ.get("EVOFLOW_TASKS_LIST_ALL_CAP", str(_TASKS_LIST_ALL_CAP)) or _TASKS_LIST_ALL_CAP)
        size = max(1, min(size, 500))
        page_no = 1
        unbounded_clamped = True
    else:
        size = requested
        page_no = max(1, int(page or 1))
        unbounded_clamped = False

    owner_scopes: list[str] | None = None
    if not is_admin:
        owner_scopes = [s for s in (personal_scope, org_scope) if str(s or "").strip()]

    # Coarse SQL prefilter (noise / role / scope / search). Status+source stay Python
    # (alias groups). Sort other than updated_at also stays Python on the page window.
    sort_key = str(sort or "updated_at").strip().lower()
    reverse = str(order or "desc").lower() == "desc"
    sql_order_ok = sort_key in {"", "updated_at"} and reverse

    list_kwargs: dict[str, Any] = {
        "main_task_id": mid,
        "has_role": bool(has_role),
        "exclude_noise": bool(hide_noise),
        "owner_scope_ids": owner_scopes,
        "search": str(search or "").strip() or None,
    }

    need = page_no * size
    window = max(size * 3, 60)
    max_scan = int(os.environ.get("EVOFLOW_TASKS_LIST_MAX_SCAN", str(_TASKS_LIST_MAX_SCAN)) or _TASKS_LIST_MAX_SCAN)
    max_scan = max(size * 2, min(max_scan, 10_000))

    matched: list[dict[str, Any]] = []
    scanned = 0
    exhausted = False
    sql_prefilters = True

    def _match(task: dict[str, Any], *, prefiltered: bool) -> dict[str, Any] | None:
        # When harness SQL prefilters applied, skip duplicate has_role/search work.
        return _catalog_row_matches(
            task,
            status=status,
            source=source,
            search=None if prefiltered else str(search or "").strip() or None,
            has_role=False if prefiltered else bool(has_role),
            hide_noise=hide_noise,
            is_admin=is_admin,
            personal_scope=personal_scope,
            org_scope=org_scope,
            principal=principal,
        )

    # Fast path: default newest-first with no status/source filter → one SQL page
    # with overfetch, then Python refine. Avoids multi-window when drop-rate is low.
    use_single_window = sql_order_ok and not status and not source
    t_sql0 = _time.perf_counter()
    if use_single_window:
        overfetch = max(size * 4, size + 20)
        # Pull enough SQL rows to cover prior pages + this page after filter drop.
        sql_limit = min(max_scan, need + overfetch)
        raw, sql_prefilters = _catalog_list_roots(limit=sql_limit, offset=0, **list_kwargs)
        scanned = len(raw)
        exhausted = scanned < sql_limit
        t_sql_ms = (_time.perf_counter() - t_sql0) * 1000
        t_match0 = _time.perf_counter()
        for task in raw:
            row = _match(task, prefiltered=sql_prefilters)
            if row is not None:
                matched.append(row)
                if len(matched) >= need:
                    break
        t_match_ms = (_time.perf_counter() - t_match0) * 1000
    else:
        t_match0 = _time.perf_counter()
        while len(matched) < need and scanned < max_scan:
            batch, sql_prefilters = _catalog_list_roots(limit=window, offset=scanned, **list_kwargs)
            if not batch:
                exhausted = True
                break
            scanned += len(batch)
            for task in batch:
                row = _match(task, prefiltered=sql_prefilters)
                if row is not None:
                    matched.append(row)
            if len(batch) < window:
                exhausted = True
                break
        t_match_ms = (_time.perf_counter() - t_match0) * 1000
        t_sql_ms = t_match_ms  # multi-window interleaves SQL+match

    if not sql_order_ok:
        if sort_key == "name":
            matched.sort(key=lambda x: str(x.get("name") or "").lower(), reverse=reverse)
        elif sort_key == "status":
            matched.sort(key=lambda x: str(x.get("status") or ""), reverse=reverse)
        elif sort_key == "created_at":
            matched.sort(key=lambda x: str(x.get("created_at") or ""), reverse=reverse)
        else:
            matched.sort(
                key=lambda x: str(x.get("updated_at") or x.get("created_at") or ""),
                reverse=reverse,
            )

    start = (page_no - 1) * size
    page_tasks = matched[start : start + size]

    # Totals without a second full-table hydrate:
    # - No status/source: SQL COUNT with the same coarse prefilters (may be slightly
    #   higher than Python noise/authz — Task Center pager still works).
    # - With status/source: count remaining matches in windows up to max_scan.
    total_is_approximate = False
    if not status and not source:
        counted = _catalog_count_roots(**list_kwargs)
        if counted is None:
            total = len(matched) if exhausted else max(len(matched), need)
            total_is_approximate = True
        else:
            total = counted
            if exhausted and len(matched) < need:
                total = len(matched)
            elif total < len(matched):
                total = len(matched)
            total_is_approximate = True
    else:
        extra = 0
        off = scanned
        while off < max_scan:
            batch, sql_prefilters = _catalog_list_roots(limit=window, offset=off, **list_kwargs)
            if not batch:
                exhausted = True
                break
            off += len(batch)
            for task in batch:
                row = _match(task, prefiltered=sql_prefilters)
                if row is not None:
                    extra += 1
            if len(batch) < window:
                exhausted = True
                break
        total = len(matched) + extra
        if not exhausted and off >= max_scan:
            total_is_approximate = True

    page_count = max(1, (total + size - 1) // size) if total else 0
    if page_no > (page_count or 1) and page_count:
        page_no = page_count
        start = (page_no - 1) * size
        page_tasks = matched[start : start + size]

    # Join SQLite session run_status — UI must not invent「已中断」via client probe.
    t_enrich0 = _time.perf_counter()
    try:
        from evoflow.collab.task_runtime_health import enrich_tasks_runtime_health

        enrich_tasks_runtime_health(page_tasks)
    except Exception:
        logger.debug("list_tasks: runtime_health enrich failed", exc_info=True)
    t_enrich_ms = (_time.perf_counter() - t_enrich0) * 1000
    t_total_ms = (_time.perf_counter() - t_sync0) * 1000
    if t_total_ms >= 200:
        logger.info(
            "list_tasks catalog_sync total_ms=%.0f sql_ms=%.0f match_ms=%.0f enrich_ms=%.0f "
            "scanned=%s matched=%s page_n=%s page_size=%s",
            t_total_ms,
            t_sql_ms,
            t_match_ms,
            t_enrich_ms,
            scanned,
            len(matched),
            len(page_tasks),
            size,
        )

    out: dict[str, Any] = {
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
    if unbounded_clamped:
        out["unbounded_clamped"] = True
    if total_is_approximate:
        out["total_is_approximate"] = True
    return out


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
                    if str(task.get("source_app_id") or "").strip() or str(task.get("final_rollup") or "").strip():
                        from evoflow.collab.task_progress import sync_main_task_from_subtasks

                        sync_main_task_from_subtasks(storage, str(task_id))
                        bundle = task_repo.load_task_bundle(task_id) or bundle
                        task = next(
                            (t for t in (bundle.get("tasks") or []) if t.get("id") == task_id),
                            task,
                        )
                except Exception:
                    pass
                storage.invalidate_project(task_id)
                return _attach_runtime_health(_public_task_dict(task))

    projects = storage.list_projects()

    for project_summary in projects:
        project = storage.load_project(project_summary["id"])
        if project:
            for i, task in enumerate(project.get("tasks", [])):
                if task.get("id") == task_id:
                    return _attach_runtime_health(_public_task_dict(task))

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
        "Gate §5.3: set execution_authorized=true when task is in planned or planning status, then immediately dispatch the first wave (supervisor start_execution) so workers start without waiting for Lead to call start_execution again."
    ),
)
async def authorize_task_execution(
    http_request: Request,
    task_id: str,
    request: AuthorizeExecutionRequest | None = Body(default=None),
) -> dict:
    """User「开始执行」: authorize + auto-dispatch first wave."""
    require_task_visible(http_request, task_id)
    from evoflow.collab.thread_collab import advance_collab_phase_to_executing_for_task
    from evoflow.collab.workflow_runtime import dispatch_for_task

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
        dispatch_result = await dispatch_for_task(
            task_id,
            thread_id=body.thread_id,
            authorized_by=body.authorized_by or "user",
        )
        _disp_ids = dispatch_result.get("subtaskIds") if dispatch_result else None
        dispatch_ok = bool(dispatch_result and dispatch_result.get("success") and ((isinstance(_disp_ids, list) and len(_disp_ids) > 0) or any(isinstance(d, dict) and d.get("ok") for d in (dispatch_result.get("delegatedSubtasks") or []))))
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
        from evoflow.collab.workflow_runtime import dispatch_for_task

        dispatch_result = await dispatch_for_task(
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
    dispatch_ok = bool(dispatch_result and dispatch_result.get("success") and ((isinstance(_disp_ids, list) and len(_disp_ids) > 0) or any(isinstance(d, dict) and d.get("ok") for d in (dispatch_result.get("delegatedSubtasks") or []))))
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
                    assigned_now = bool(str(task.get("assigned_role") or "").strip() or str(task.get("assigned_to") or "").strip())
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
            row["read_outputs"] = [o if isinstance(o, dict) else (o.model_dump() if hasattr(o, "model_dump") else o) for o in (read or [])]
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
    from evoflow.admin.tasks import NotFoundError, ValidationError
    from evoflow.admin.tasks import delete_task as admin_delete_task

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

    from evoflow.collab.conversation_persist import (
        list_subtask_conversation_ui_messages,
        resolve_subtask_transcript_thread,
    )

    sid = str(subtask_id or "").strip()
    sub_row = target_subtask if isinstance(target_subtask, dict) else None
    cap = max(1, min(int(limit or 500), 5000))
    rows = list_subtask_conversation_ui_messages(
        task,
        sid,
        subtask_row=sub_row,
        limit=cap,
    )
    thread_id = resolve_subtask_transcript_thread(task, sid, subtask_row=sub_row)
    from evoflow.collab.subtask_outcome import build_subtask_outcome_snapshot

    outcome = build_subtask_outcome_snapshot(sub_row or {})
    return SubtaskConversationHistoryResponse(
        task_id=task_id,
        subtask_id=sid,
        count=len(rows),
        messages=rows,
        thread_id=thread_id,
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
    for _tid in request.task_ids or []:
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


_RETRYABLE_FAILED_STATUSES = frozenset({"failed", "error", "timed_out"})


def _is_retryable_failed_status(status: Any) -> bool:
    return str(status or "").strip().lower() in _RETRYABLE_FAILED_STATUSES


def _kick_work_item_retry(task_id: str, task: dict[str, Any]) -> None:
    """Background re-dispatch for leaf / employee work items (no Plan subtasks)."""
    import asyncio

    tid = str(task_id or "").strip()
    if not tid:
        return
    role_code = str(task.get("assigned_to") or task.get("agent_code") or "").strip() or "unknown"
    try:
        from evoflow.proactive.router import (
            _log_create_task_result,
            _safe_execute_approved_work_item,
        )
    except Exception:
        logger.exception("retry: cannot import work-item executor for task=%s", tid)
        return

    try:
        fut = asyncio.get_running_loop().create_task(
            _safe_execute_approved_work_item(tid, role_code)
        )
        fut.add_done_callback(_log_create_task_result)
        logger.info("retry: scheduled work-item re-dispatch task=%s role=%s", tid, role_code)
    except Exception:
        logger.exception("retry: failed to schedule work-item re-dispatch task=%s", tid)


@router.post(
    "/{task_id}/recover",
    summary="Recover Workflow From Breakpoint",
    description=(
        "Heal zombie executing / requeue failed steps from DB, then advance the App DAG "
        "(workflow_runtime). Prefer this after gateway restart; distinct from pause resume."
    ),
)
async def recover_workflow_task(http_request: Request, task_id: str, reason: str = "api") -> dict:
    require_task_visible(http_request, task_id)
    from evoflow.admin import apps as apps_admin
    from evoflow.admin.errors import ValidationError

    try:
        return await apps_admin.recover_task_async(task_id, reason=reason or "api")
    except ValidationError as e:
        raise_task_error(ErrorCode.INVALID_PARAMETERS, str(e))


@router.post(
    "/{task_id}/retry",
    summary="Retry Failed Subtasks",
    description="Retry failed subtasks, or re-dispatch a leaf/work-item task that failed as a whole.",
)
async def retry_task(http_request: Request, task_id: str, request: RetrySubtaskRequest) -> dict:
    require_task_visible(http_request, task_id)
    """Retry failed subtasks, or the main task when it is a leaf/work-item failure.

    Plan tasks: reset ``failed``/``error``/``timed_out`` subtasks to ``pending``.
    Employee work items (often no subtasks): reset the main task and re-dispatch.
    """
    storage = get_project_storage()
    found = find_main_task(storage, str(task_id or "").strip(), bypass_cache=True)
    if not found:
        raise_task_error(ErrorCode.TASK_NOT_FOUND, f"任务 '{task_id}' 不存在")

    project, task = found
    subtasks = [s for s in (task.get("subtasks") or []) if isinstance(s, dict)]
    retried: list[str] = []
    failed_to_retry: list[dict[str, str]] = []
    now = utc_now_iso_z()

    # ── Path A: Plan-style failed subtasks ──────────────────────────
    subtasks_to_retry: list[dict[str, Any]] = []
    if request.retry_all_failed:
        subtasks_to_retry = [s for s in subtasks if _is_retryable_failed_status(s.get("status"))]
    elif request.subtask_ids:
        wanted = {str(x) for x in request.subtask_ids}
        subtasks_to_retry = [s for s in subtasks if str(s.get("id") or "") in wanted]

    if subtasks_to_retry:
        for subtask in subtasks_to_retry:
            subtask_id = str(subtask.get("id") or "").strip()
            current_status = str(subtask.get("status") or "").strip().lower()
            if not _is_retryable_failed_status(current_status):
                failed_to_retry.append(
                    {
                        "subtask_id": subtask_id,
                        "error": f"Status is '{current_status}', not failed",
                    }
                )
                continue
            subtask["status"] = "pending"
            subtask["previous_attempts"] = int(subtask.get("previous_attempts") or 0) + 1
            subtask["retried_at"] = now
            subtask.pop("error", None)
            subtask.pop("failed_at", None)
            subtask.pop("result", None)
            if subtask_id:
                retried.append(subtask_id)

        if _is_retryable_failed_status(task.get("status")) and retried:
            task["status"] = "executing"
            task["retry_attempts"] = int(task.get("retry_attempts") or 0) + 1
            task["retried_at"] = now
            task.pop("error", None)
            task.pop("failed_at", None)

        task["subtasks"] = subtasks
        task["updated_at"] = now
        project["updated_at"] = now
        # Persist via in-place mutation of the loaded project bundle.
        mid = str(task.get("id") or task_id).strip()
        tasks_list = list(project.get("tasks") or [])
        for i, t in enumerate(tasks_list):
            if isinstance(t, dict) and t.get("id") == mid:
                tasks_list[i] = task
                break
        project["tasks"] = tasks_list
        if not storage.save_project(project):
            raise_task_error(ErrorCode.SAVE_FAILED, "保存任务失败")
        if str(task.get("source_app_id") or "").strip():
            try:
                from evoflow.collab.app_run_events import emit_app_run_from_main_task

                emit_app_run_from_main_task(task, reason="retry_task_subtasks")
            except Exception:
                logger.debug("retry_task: emit_app_run failed task_id=%s", mid, exc_info=True)
            if retried:
                try:
                    from evoflow.collab.workflow_runtime import retry_wave
                    from evoflow.subagents.detached_poll_scheduler import schedule_detached_poll

                    schedule_detached_poll(
                        retry_wave(mid, authorized_by="api"),
                        name=f"retry-task-{mid[:12]}",
                    )
                except Exception:
                    logger.debug("retry_task: schedule retry_wave failed task_id=%s", mid, exc_info=True)
        return {
            "success": True,
            "data": {
                "task_id": mid,
                "retried_subtasks": retried,
                "failed_to_retry": failed_to_retry,
                "total_retried": len(retried),
                "task_status": task.get("status"),
                "mode": "subtasks",
            },
        }

    # ── Path B: Leaf / employee work item (no failed subtasks) ──────
    # Formal-package employee tasks often fail as the main row with empty
    # ``subtasks``; the old handler returned 400「没有可重试的子任务」.
    if request.retry_all_failed and _is_retryable_failed_status(task.get("status")):
        mid = str(task.get("id") or task_id).strip()
        updates: dict[str, Any] = {
            "status": "pending",
            "progress": 0,
            "retry_attempts": int(task.get("retry_attempts") or 0) + 1,
            "retried_at": now,
            "previous_attempts": int(task.get("previous_attempts") or 0) + 1,
            "error": None,
            "failed_at": None,
            "result": None,
        }
        from evoflow.collab.storage import patch_collab_main_task_in_project_storage

        if not patch_collab_main_task_in_project_storage(storage, mid, updates):
            raise_task_error(ErrorCode.SAVE_FAILED, "保存任务失败")
        # Refresh for kick payload
        task = {**task, **{k: v for k, v in updates.items() if v is not None}}
        task["status"] = "pending"
        if str(task.get("source_app_id") or "").strip():
            try:
                from evoflow.collab.app_run_events import emit_app_run_from_main_task

                emit_app_run_from_main_task(task, reason="retry_task_main")
            except Exception:
                logger.debug("retry_task: emit_app_run main failed task_id=%s", mid, exc_info=True)
        _kick_work_item_retry(mid, task)
        return {
            "success": True,
            "data": {
                "task_id": mid,
                "retried_subtasks": [],
                "failed_to_retry": [],
                "total_retried": 1,
                "task_status": "pending",
                "mode": "main_task",
            },
        }

    raise_task_error(ErrorCode.SUBTASK_NOT_RETRYABLE, "没有可重试的子任务")


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


def _load_subagent_transcript_sync(task_id: str) -> dict[str, Any]:
    """DB + memory snapshot for subagent transcript (run off the event loop).

    Slow log 2026-10-31: FE polled this every 2s at 1–2s each while Task Center
    opened — sync collab storage on the loop starved /api/tasks + /sessions.
    """
    from evoflow.subagents.executor import get_background_task_result_or_snapshot

    lookup_id = str(task_id or "").strip()
    result = get_background_task_result_or_snapshot(lookup_id) if lookup_id else None
    parent_thread: str | None = None

    def _parent_from_result(r: Any) -> str | None:
        # Prefer explicit parent_thread_id (chat subagents now use a dedicated
        # {lead}__sub__{tool_call_id} executor thread — thread_id is the child).
        p = str(getattr(r, "parent_thread_id", None) or "").strip() or None
        if p:
            return p
        return str(getattr(r, "thread_id", None) or "").strip() or None

    if result is not None:
        parent_thread = _parent_from_result(result)
    else:
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
                        parent_thread = _parent_from_result(result)
        except Exception:
            pass

    chat_messages: list = []
    thread_id: str | None = None
    try:
        from evoflow.collab.conversation_persist import (
            list_subtask_conversation_ui_messages,
            resolve_subtask_transcript_thread,
        )
        from evoflow.collab.storage import find_subtask_row_by_id, get_project_storage

        found = find_subtask_row_by_id(get_project_storage(), str(task_id or "").strip())
        if found is not None:
            _project, task, st = found
            sid = str(st.get("id") or "").strip()
            if sid:
                thread_id = resolve_subtask_transcript_thread(task, sid, subtask_row=st)
                # Cap for poll path — UI does not need 2000 rows every few seconds.
                chat_messages = list_subtask_conversation_ui_messages(
                    task, sid, subtask_row=st, limit=200
                )
    except Exception:
        pass

    if result is None:
        return {
            "lookup_id": lookup_id,
            "parent_thread": parent_thread,
            "need_task_visible": True,
            "payload": {
                "task_id": task_id,
                "status": "unknown",
                "messages": chat_messages,
                "thread_id": thread_id,
                "empty": not bool(chat_messages),
            },
        }

    messages = list(result.stream_messages or [])
    result_thread = str(getattr(result, "thread_id", None) or "").strip() or None
    if not thread_id and result_thread:
        thread_id = result_thread
    if not messages:
        if chat_messages:
            messages = chat_messages
        else:
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
        "lookup_id": lookup_id,
        "parent_thread": parent_thread or result_thread,
        "need_task_visible": False,
        "payload": {
            "task_id": lookup_id,
            "status": result.status.value if hasattr(result.status, "value") else str(result.status),
            "result": result.result,
            "error": result.error,
            "started_at": result.started_at.isoformat() if result.started_at else None,
            "completed_at": result.completed_at.isoformat() if result.completed_at else None,
            "messages": messages,
            "ai_messages": result.ai_messages or [],
            "thread_id": thread_id,
            "parent_thread_id": parent_thread or None,
            "empty": not bool(messages),
        },
    }


@router.get("/subagent/{task_id}/transcript", summary="Subagent Task Transcript")
async def get_subagent_task_transcript(http_request: Request, task_id: str) -> dict:
    """Return subagent execution transcript (AI messages) by background task ID.

    Best-effort lane: worker thread + concurrency slot + timeout so 2–5s polls
    cannot starve Task Center catalog + session list on the Gateway event loop.
    """
    import asyncio
    import time as _time

    from app.gateway.hang_diagnostics import append_gateway_slow_log
    from app.gateway.traffic_lanes import transcript_slot

    timeout_s = float(os.environ.get("EVOFLOW_TRANSCRIPT_TIMEOUT_S", "6") or 6)
    timeout_s = max(2.0, min(timeout_s, 20.0))
    acquire_s = min(2.0, timeout_s)
    slot = transcript_slot()
    t0 = _time.perf_counter()
    try:
        await asyncio.wait_for(slot.acquire(), timeout=acquire_s)
    except TimeoutError:
        append_gateway_slow_log(
            kind="transcript_slot_busy",
            method="GET",
            path=f"/api/tasks/subagent/{task_id}/transcript",
            duration_s=_time.perf_counter() - t0,
            status_code=503,
        )
        raise HTTPException(status_code=503, detail="transcript busy, retry shortly") from None
    try:
        try:
            packed = await asyncio.wait_for(
                asyncio.to_thread(_load_subagent_transcript_sync, str(task_id or "").strip()),
                timeout=timeout_s,
            )
        except TimeoutError:
            append_gateway_slow_log(
                kind="transcript_timeout",
                method="GET",
                path=f"/api/tasks/subagent/{task_id}/transcript",
                duration_s=timeout_s,
                status_code=503,
            )
            raise HTTPException(
                status_code=503, detail="transcript timed out, retry shortly"
            ) from None
        work_ms = (_time.perf_counter() - t0) * 1000
        if work_ms >= 1500:
            append_gateway_slow_log(
                kind="transcript",
                method="GET",
                path=f"/api/tasks/subagent/{task_id}/transcript",
                duration_s=work_ms / 1000.0,
            )
    finally:
        slot.release()
    parent_thread = str(packed.get("parent_thread") or "").strip()
    if parent_thread:
        require_thread_visible(http_request, parent_thread)
    elif packed.get("need_task_visible"):
        require_task_visible(http_request, task_id)
    return packed["payload"]


class SaveAsAppRequest(BaseModel):
    name: str | None = None
    description: str | None = None
    execution_mode: str = "workflow"
    auto_extract: bool = True
    max_params: int = 5


@router.post(
    "/{task_id}/save-as-app",
    summary="Save Task as Reusable App",
    description="Convert an existing task (with plan) into a reusable App definition. Auto-extracts parameter placeholders from plan content (product names, domains, years, tech terms, etc.) if auto_extract=True.",
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
