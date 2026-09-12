"""Structured orchestration hints for the lead agent."""

from __future__ import annotations

from typing import Any

from evoflow.collab.task_progress import aggregate_subtasks_progress_percent

# Main task storage terminal — must match supervisor / monitor semantics.
MAIN_TASK_TERMINAL = frozenset({"completed", "failed", "cancelled"})
_SUB_TERMINAL = frozenset({"completed", "failed", "cancelled", "timed_out"})
_SUB_IN_FLIGHT = frozenset({"executing", "running", "in_progress", "waiting_dispatch"})


def _norm_sub_statuses(task: dict[str, Any]) -> list[str]:
    subs = [x for x in (task.get("subtasks") or []) if isinstance(x, dict)]
    return [str(s.get("status") or "").strip().lower() for s in subs]


def compute_orchestration_phase(task: dict[str, Any]) -> str:
    """High-level phase for orchestration UX (stable string keys for clients/models)."""
    ms = str(task.get("status") or "").strip().lower()
    if ms in MAIN_TASK_TERMINAL:
        return "main_terminal"
    authorized = bool(task.get("execution_authorized"))
    statuses = _norm_sub_statuses(task)
    if not statuses:
        return "no_subtasks"
    if all(s in _SUB_TERMINAL for s in statuses):
        if all(s == "completed" for s in statuses):
            return "all_subtasks_completed_main_open"
        return "all_subtasks_terminal_mixed_main_open"
    if any(s in _SUB_IN_FLIGHT for s in statuses):
        return "running_subtasks"
    if authorized and any(s in {"planned", "pending", "waiting_dispatch"} for s in statuses):
        return "authorized_ready_to_dispatch"
    if authorized:
        return "authorized_pending_start_or_dispatch"
    return "pending_start_or_dispatch"


def compute_suggested_next(phase: str, *, task: dict[str, Any] | None = None) -> list[str]:
    """Human-readable next steps (English for stable API; lead prompt may restate in user language)."""
    if phase == "main_terminal":
        return [
            "Summarize outcomes for the user in natural language (avoid internal ids/tool names).",
            "Optional: read-only supervisor checks if you need a last consistency pass.",
        ]
    if phase == "no_subtasks":
        return [
            "Add work with supervisor create_subtask/create_subtasks, or confirm the main task should finish without subtasks.",
            "When ready, start_execution(task_id=...) for delegated workers.",
        ]
    if phase == "all_subtasks_completed_main_open":
        return [
            "Run Plan-level validation (read_file / terminal or process per Plan) before declaring overall success.",
            "Main task progress is auto-synced up to 99% (subtasks may still be 100% completed); Lead must close the main task: update_progress(progress=100, status=completed) or set_task_state(status=completed).",
            "Use suggestedMainProgressPercent from monitor/get_status as a baseline; set 100% only after Plan validation passes.",
        ]
    if phase == "all_subtasks_terminal_mixed_main_open":
        return [
            "Inspect failed/timed_out/cancelled subtasks; use get_subtask_conversation on the hot subtask ids.",
            "Stuck task_tool subtasks: steer_subtask(same subtask_id, agent_message=...) — keeps DAG id; downstream waits for subtask_outcome_report.",
            "Prefer steer_subtask over retry_subtask when correcting in-flight work; retry_subtask resets progress.",
        ]
    if phase == "running_subtasks":
        return [
            "Poll with monitor_execution_step or get_status until subtasks settle or failures appear.",
            "Main task progress is auto-synced (main cap 99%; subtasks may reach 100% completed); override main progress with update_progress(task_id=..., progress=...) without subtask_id if Plan weights differ.",
            "Use `suggestedMainProgressPercent` from monitor/get_status as the baseline average of subtask progress.",
            "Ensure workers report subtask progress via subtask_progress_report / subtask_work_checklist — if a subtask stays at 0%, nudge or continue_subtask_session.",
            "Tune work with continue_subtask_session (multi-turn, keep_session_open=true) or start_execution(subtask_ids=[...]); set keep_session_open=false on the final round.",
        ]
    if phase in {"authorized_ready_to_dispatch", "authorized_pending_start_or_dispatch"}:
        return [
            "User already authorized execution (`executionAuthorized=true`). Do NOT ask them to click「开始执行」again.",
            "Call supervisor(start_execution, task_id=...) to open the next runnable wave (omit subtask_ids).",
            "Main task `status` may still be `planned` until you update it — that does not mean unauthorized.",
            "Entries in `blockedSubtasks` with `waiting_on_dependencies` are waiting on upstream steps (DAG), not missing authorization.",
        ]
    return [
        "Ensure execution is authorized, then start_execution(task_id=...) (omit subtask_ids to let the server open the next runnable wave).",
        "Use list_subtasks to see blocked dependencies and worker assignments.",
    ]


def build_orchestration_hints(task: dict[str, Any]) -> dict[str, Any]:
    phase = compute_orchestration_phase(task)
    subs = [x for x in (task.get("subtasks") or []) if isinstance(x, dict)]
    suggested_main = aggregate_subtasks_progress_percent(subs) if subs else None
    main_stored = task.get("progress")
    try:
        main_progress = int(main_stored) if main_stored is not None else None
    except (TypeError, ValueError):
        main_progress = None
    return {
        "orchestrationPhase": phase,
        "suggestedNext": compute_suggested_next(phase, task=task),
        "executionAuthorized": bool(task.get("execution_authorized")),
        "suggestedMainProgressPercent": suggested_main,
        "mainTaskProgressPercent": main_progress,
    }


def merge_orchestration_hints(payload: dict[str, Any], task: dict[str, Any]) -> dict[str, Any]:
    """Return a shallow copy of payload with orchestration fields merged in."""
    out = dict(payload)
    out.update(build_orchestration_hints(task))
    return out
