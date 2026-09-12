"""Authorize collaborative main-task execution (gate before workers run).

Kept in a dedicated module so LangGraph / uvicorn workers reliably load fresh logic
(avoid stale bytecode confusion with a large storage.py).
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

from evoflow.timeutil import utc_now_iso_z

if TYPE_CHECKING:
    from evoflow.collab.storage import ProjectStorage

_USER_AUTHORIZATION_ACTORS = frozenset({"user", "system", "api", "page", "ui", "automation"})
_TERMINAL_TASK_STATUSES = frozenset({"completed", "failed", "cancelled"})


def is_task_execution_authorized(storage: ProjectStorage, task_id: str) -> bool:
    """Whether the main task row has execution_authorized set (persisted user consent)."""
    from evoflow.collab.storage import find_main_task

    tid = str(task_id or "").strip()
    if not tid:
        return False
    row = find_main_task(storage, tid)
    if not row:
        return False
    return bool(row[1].get("execution_authorized"))


def authorize_main_task_execution(storage: ProjectStorage, task_id: str, authorized_by: str) -> tuple[bool, str]:
    """Set execution_authorized when status is planned, planning, or pending.

    Pending tasks are promoted to ``planned`` before the gate check so
    ``start_execution`` works right after ``create_task`` without a separate
    ``set_task_planned`` call.
    """
    actor = str(authorized_by or "").strip().lower()
    if actor not in _USER_AUTHORIZATION_ACTORS:
        return (
            False,
            "执行授权仅接受用户确认（界面「开始执行」或对话「开始执行」）；Lead/模型不可自行授权。",
        )

    allowed_status = ("planned", "planning", "pending")
    _reauth_status = frozenset({"executing", "waiting_dispatch", "running", "in_progress"})
    for summary in storage.list_projects():
        project = storage.load_project(summary["id"])
        if not project:
            continue
        for i, task in enumerate(project.get("tasks", [])):
            if task.get("id") != task_id:
                continue
            if task.get("execution_authorized"):
                return True, "Already authorized"
            status = task.get("status")
            if status == "pending":
                task["status"] = "planned"
                project["tasks"][i] = task
                if not storage.save_project(project):
                    return False, "Failed to save project while promoting task from pending to planned"
                status = "planned"
            if status not in allowed_status:
                if status in _reauth_status:
                    # UI「开始执行」重试派发时主任务可能已是 executing 但授权位未写入。
                    pass
                else:
                    return False, (
                        f"Task status must be one of {allowed_status!r} to authorize execution; got {status!r}"
                    )
            now = utc_now_iso_z()
            was_authorized = bool(task.get("execution_authorized"))
            task["execution_authorized"] = True
            task["authorized_at"] = task.get("authorized_at") or now
            task["authorized_by"] = task.get("authorized_by") or authorized_by
            project["tasks"][i] = task
            if storage.save_project(project):
                if was_authorized:
                    return True, "Already authorized (no-op)"
                if status in _reauth_status:
                    return True, "Execution authorized (reauth from in-progress state)"
                return True, "Execution authorized"
            return False, "Failed to save project"
    return False, f"Task '{task_id}' not found"


def _human_message_text(content: Any) -> str:
    if isinstance(content, str):
        return content.strip()
    if isinstance(content, list):
        parts: list[str] = []
        for block in content:
            if isinstance(block, dict) and block.get("type") == "text":
                parts.append(str(block.get("text") or ""))
        return " ".join(parts).strip()
    return str(content or "").strip()


def resolve_thread_id_for_task(
    storage: ProjectStorage,
    task_id: str,
    *,
    thread_id_hint: str = "",
) -> str:
    """Best-effort thread_id for authorization (runtime hint → task row → LangGraph config)."""
    hint = str(thread_id_hint or "").strip()
    if hint:
        return hint
    from evoflow.collab.storage import find_main_task

    tid = str(task_id or "").strip()
    if tid:
        row = find_main_task(storage, tid)
        if row:
            on_task = str(row[1].get("thread_id") or "").strip()
            if on_task:
                return on_task
    try:
        from langgraph.config import get_config

        conf = get_config().get("configurable") or {}
        if isinstance(conf, dict):
            cfg_tid = str(conf.get("thread_id") or "").strip()
            if cfg_tid:
                return cfg_tid
    except Exception:
        pass
    return ""


def collab_thread_allows_execution_start(
    storage: ProjectStorage,
    task_id: str,
    *,
    thread_id: str = "",
) -> bool:
    """True when thread collab state shows user already moved past plan_ready (UI / 开始执行)."""
    run_tid = resolve_thread_id_for_task(storage, task_id, thread_id_hint=thread_id)
    if not run_tid:
        return False
    from evoflow.collab.thread_collab import load_thread_collab_state
    from evoflow.config.paths import get_paths

    try:
        st = load_thread_collab_state(get_paths(), run_tid)
    except Exception:
        return False
    bound = str(getattr(st, "bound_task_id", "") or "").strip()
    task = str(task_id or "").strip()
    if bound and task and bound != task:
        return False
    phase = str(getattr(st, "collab_phase", "") or "").strip().lower()
    if phase in ("awaiting_exec", "executing"):
        return True
    return bool(str(getattr(st, "user_execution_confirmed_at", "") or "").strip())


def user_has_confirmed_execution_start(
    thread_id: str,
    *,
    messages: list[Any] | None = None,
) -> bool:
    """Whether the user already clicked or said「开始执行」on this thread (or in recent messages)."""
    tid = str(thread_id or "").strip()
    if tid:
        from evoflow.collab.thread_collab import load_thread_collab_state
        from evoflow.collab.user_execution_confirm import thread_has_recent_user_execution_confirm
        from evoflow.config.paths import get_paths

        paths = get_paths()
        if thread_has_recent_user_execution_confirm(paths, tid):
            return True
        try:
            st = load_thread_collab_state(paths, tid)
            if str(getattr(st, "user_execution_confirmed_at", "") or "").strip():
                return True
        except Exception:
            pass

    if messages:
        from evoflow.collab.execution_lifecycle import user_execution_start_intent

        human_seen = 0
        for m in reversed(messages):
            if getattr(m, "type", None) != "human":
                continue
            human_seen += 1
            if user_execution_start_intent(_human_message_text(getattr(m, "content", ""))):
                return True
            if human_seen >= 12:
                break
    return False


def authorize_main_task_after_user_confirm(storage: ProjectStorage, task_id: str) -> tuple[bool, str]:
    """Persist execution_authorized after user confirm when strict status gate blocked."""
    tid = str(task_id or "").strip()
    if not tid:
        return False, "task_id is required"
    for summary in storage.list_projects():
        project = storage.load_project(summary["id"])
        if not project:
            continue
        for i, task in enumerate(project.get("tasks", [])):
            if task.get("id") != tid:
                continue
            if task.get("execution_authorized"):
                return True, "Already authorized"
            status = str(task.get("status") or "").strip().lower()
            if status in _TERMINAL_TASK_STATUSES:
                return False, f"Cannot authorize terminal task status={status!r}"
            if status == "pending":
                task["status"] = "planned"
            now = utc_now_iso_z()
            task["execution_authorized"] = True
            task["authorized_at"] = now
            task["authorized_by"] = "user"
            project["tasks"][i] = task
            if storage.save_project(project):
                return True, "Execution authorized after user confirm"
            return False, "Failed to save project"
    return False, f"Task '{tid}' not found"


def ensure_task_execution_authorized_for_user(
    storage: ProjectStorage,
    task_id: str,
    *,
    thread_id: str = "",
    messages: list[Any] | None = None,
) -> tuple[bool, str]:
    """Lazy authorize at start_execution: user confirm → write execution_authorized if missing."""
    tid = str(task_id or "").strip()
    if not tid:
        return False, "task_id is required"
    if is_task_execution_authorized(storage, tid):
        return True, "Already authorized"

    run_tid = resolve_thread_id_for_task(storage, tid, thread_id_hint=thread_id)
    confirmed = user_has_confirmed_execution_start(run_tid, messages=messages)
    if not confirmed:
        confirmed = collab_thread_allows_execution_start(storage, tid, thread_id=run_tid)
    if not confirmed:
        return (
            False,
            "待授权开始执行：须由用户在界面点击「开始执行」或在对话中明确回复「开始执行」后，再调用 start_execution。",
        )

    ok, msg = authorize_main_task_execution(storage, tid, "user")
    if ok or "already" in msg.lower():
        return True, msg

    ok2, msg2 = authorize_main_task_after_user_confirm(storage, tid)
    if ok2:
        return True, msg2
    return False, msg2 or msg


def revoke_main_task_execution_authorization(storage: ProjectStorage, task_id: str) -> tuple[bool, str]:
    """Clear execution_authorized after plan revision (user must re-authorize to start)."""
    for summary in storage.list_projects():
        project = storage.load_project(summary["id"])
        if not project:
            continue
        for i, task in enumerate(project.get("tasks", [])):
            if task.get("id") != task_id:
                continue
            if not task.get("execution_authorized"):
                return True, "Not authorized"
            task["execution_authorized"] = False
            task.pop("authorized_at", None)
            task.pop("authorized_by", None)
            status = str(task.get("status") or "").strip().lower()
            if status == "executing":
                task["status"] = "planned"
            project["tasks"][i] = task
            if storage.save_project(project):
                return True, "Execution authorization revoked"
            return False, "Failed to save project"
    return False, f"Task '{task_id}' not found"
