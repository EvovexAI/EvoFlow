"""Plan-collaboration prechecks for ``supervisor`` tool actions (tool returns errors, not middleware injection)."""

from __future__ import annotations

from typing import Any

from evoflow.agents.middlewares.plan_guard_middleware import (
    collaboration_has_committed_plan,
    collaboration_has_execution_authorization,
    is_strict_plan_collaboration_for_thread,
)
from evoflow.collab.authorize_execution import (
    is_task_execution_authorized,
)
from evoflow.collab.storage import get_project_storage
from evoflow.collab.thread_collab import load_thread_collab_state
from evoflow.config.paths import get_paths

# Side-effectful orchestration that requires a persisted Plan first.
_PLAN_REQUIRED_ACTIONS = frozenset(
    {
        "create_task",
        "create_task_with_subtasks",
        "create_subtask",
        "create_subtasks",
        "set_task_planned",
    }
)

# Plan 落库后子任务已由 ``plan`` Steps 同步；禁止 Lead 再批量建任务/子任务。
_PLAN_REDUNDANT_SETUP_ACTIONS = frozenset(
    {
        "create_task_with_subtasks",
        "create_subtasks",
    }
)

_PLAN_REDUNDANT_SETUP_MESSAGE = (
    "plan 工具已成功落库时，主任务与子任务行已由 plan Steps 自动同步，"
    "勿再调用 create_task_with_subtasks / create_subtasks。"
    "请使用 supervisor(start_execution, task_id=...) 派发，并用 monitor_execution_step 监控进度。"
)

# Mutates running work or starts workers — requires user「开始执行」authorization.
_EXEC_AUTH_REQUIRED_ACTIONS = frozenset(
    {
        "start_execution",
        "retry_subtask",
        "interrupt_subtask",
        "steer_subtask",
        "continue_subtask_session",
        "peer_send",
        "complete_subtask",
    }
)

_EXEC_AUTH_USER_MESSAGE = "待授权开始执行：须由用户在界面点击「开始执行」或在对话中明确回复「开始执行」后，再调用本操作。勿用 ask_clarification 重复确认（界面已有确认条）。"


def _disk_bound_task_id(thread_id: str) -> str:
    tid = str(thread_id or "").strip()
    if not tid:
        return ""
    try:
        st = load_thread_collab_state(get_paths(), tid)
        return str(getattr(st, "bound_task_id", "") or "").strip()
    except Exception:
        return ""


def resolve_main_task_id_for_thread(
    thread_id: str,
    *,
    explicit_task_id: str | None = None,
) -> str:
    """Resolve main task id for supervisor actions (disk bound_task_id, then latest task on thread)."""
    explicit = str(explicit_task_id or "").strip()
    if explicit:
        return explicit
    tid = str(thread_id or "").strip()
    if not tid:
        return ""
    disk_bound = _disk_bound_task_id(tid)
    if disk_bound:
        return disk_bound
    try:
        from evoflow.agents.middlewares.plan_guard_middleware import _resolve_collab_main_task_id_and_row

        mid, _row = _resolve_collab_main_task_id_and_row(thread_id=tid, disk_bound="")
        return str(mid or "").strip()
    except Exception:
        return ""


def build_supervisor_gate_error(
    *,
    action: str,
    error_code: str,
    message: str,
    hint: str = "",
) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "success": False,
        "action": str(action or "").strip(),
        "error_code": error_code,
        "message": message,
    }
    if hint:
        payload["hint"] = hint
    return payload


def require_execution_authorization(
    *,
    thread_id: str,
    task_id: str | None = None,
    storage: Any | None = None,
) -> dict[str, Any] | None:
    """Unified execution-auth check for supervisor side effects. ``None`` if authorized."""
    tid = str(thread_id or "").strip()
    if not tid:
        return build_supervisor_gate_error(
            action="supervisor",
            error_code="need_execution_authorization",
            message=_EXEC_AUTH_USER_MESSAGE,
        )
    disk_bound = _disk_bound_task_id(tid)
    if collaboration_has_execution_authorization(tid, disk_bound):
        return None
    mid = str(task_id or disk_bound or "").strip()
    if mid:
        store = storage if storage is not None else get_project_storage()
        if is_task_execution_authorized(store, mid):
            return None
    return build_supervisor_gate_error(
        action="supervisor",
        error_code="need_execution_authorization",
        message=_EXEC_AUTH_USER_MESSAGE,
        hint=("用户授权后由系统写入 execution_authorized；再调用 supervisor(action=start_execution, task_id=...)。"),
    )


def check_supervisor_collab_gate(
    action: str,
    thread_id: str,
    *,
    task_id: str | None = None,
    storage: Any | None = None,
) -> dict[str, Any] | None:
    """Return an error payload when plan collaboration preconditions fail; ``None`` if OK."""
    act = str(action or "").strip()
    tid = str(thread_id or "").strip()
    if not act or not tid:
        return None
    if not is_strict_plan_collaboration_for_thread(tid):
        return None

    store = storage if storage is not None else get_project_storage()
    disk_bound = _disk_bound_task_id(tid)
    has_plan = collaboration_has_committed_plan(tid, disk_bound)
    has_auth = collaboration_has_execution_authorization(tid, disk_bound)
    resolved_task = str(task_id or disk_bound or "").strip()
    if resolved_task and not has_auth:
        has_auth = is_task_execution_authorized(store, resolved_task)

    if act in _PLAN_REQUIRED_ACTIONS and not has_plan:
        return build_supervisor_gate_error(
            action=act,
            error_code="need_plan_first",
            message=("当前为 plan 协作：须先通过 **`plan` 工具** 成功保存计划（has_plan），再使用 supervisor 创建任务/子任务。大范围只读调研请用 **`task`**，不要用 supervisor 代替规划。"),
            hint="先调用 plan(goal=..., steps=[...]) 落库计划，必要时用 ask_clarification 做需求澄清。",
        )

    if act in _PLAN_REDUNDANT_SETUP_ACTIONS and has_plan:
        return build_supervisor_gate_error(
            action=act,
            error_code="plan_subtasks_already_synced",
            message=_PLAN_REDUNDANT_SETUP_MESSAGE,
            hint="若执行期需增补单个 Step，可用 create_subtask；批量创建请改 plan 后重新同步。",
        )

    if act in _EXEC_AUTH_REQUIRED_ACTIONS:
        if not has_plan:
            return build_supervisor_gate_error(
                action=act,
                error_code="need_plan_first",
                message="尚未落库 Plan，无法启动执行。请先使用 plan 工具保存计划。",
            )
        if not has_auth:
            return build_supervisor_gate_error(
                action=act,
                error_code="need_execution_authorization",
                message=_EXEC_AUTH_USER_MESSAGE,
                hint=(
                    "用户「开始执行」后由你调用 supervisor(start_execution, task_id=...) 派发；"
                    "用 monitor_execution_step / get_status 跟进。"
                ),
            )

    return None


__all__ = [
    "build_supervisor_gate_error",
    "require_execution_authorization",
    "check_supervisor_collab_gate",
    "resolve_main_task_id_for_thread",
]
