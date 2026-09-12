"""Collaboration task progress helpers (worker reports + lead orchestration hints)."""

from __future__ import annotations

import logging
from typing import Any

from evoflow.collab.storage import (
    find_main_task,
    find_subtask_by_ids,
    get_project_storage,
    get_task_detail_storage,
    persist_subtask_runtime_snapshot,
)
from evoflow.timeutil import utc_now_iso_z

logger = logging.getLogger(__name__)

_TERMINAL_SUCCESS = frozenset({"completed", "done", "success"})
_TERMINAL_FAIL = frozenset({"failed", "error", "cancelled", "canceled", "timed_out"})
_IN_FLIGHT = frozenset({"in_progress", "executing", "running", "active", "waiting_dispatch"})
_MAIN_TERMINAL = frozenset({"completed", "failed", "cancelled", "done"})
_SUB_FAIL = frozenset({"failed", "error", "timed_out", "blocked"})
_SUB_CANCEL = frozenset({"cancelled", "canceled"})
_SUB_TERMINAL = _TERMINAL_SUCCESS | _SUB_FAIL | _SUB_CANCEL
# Auto-sync cap applies to **main task** rollup only; subtasks may reach 100% + completed via worker tools.
_AUTO_SYNC_MAIN_PROGRESS_CAP = 99


def clamp_task_progress(raw: Any, *, default: int = 0) -> int:
    try:
        v = int(raw)
    except (TypeError, ValueError):
        v = default
    return max(0, min(100, v))


def subtask_row_progress_percent(row: dict[str, Any]) -> int:
    """Best-effort 0–100 for one subtask row."""
    if not isinstance(row, dict):
        return 0
    st = str(row.get("status") or "").strip().lower()
    stored = clamp_task_progress(row.get("progress"))
    if st in _TERMINAL_SUCCESS:
        return 100
    if st in _TERMINAL_FAIL:
        return stored if stored > 0 else 0
    if stored > 0:
        return stored
    if st in _IN_FLIGHT:
        return 10
    return 0


def aggregate_subtasks_progress_percent(subtasks: list[dict[str, Any]]) -> int:
    """Average subtask progress (0–100) for lead UI hints."""
    rows = [x for x in subtasks if isinstance(x, dict)]
    if not rows:
        return 0
    total = sum(subtask_row_progress_percent(x) for x in rows)
    return max(0, min(100, int(round(total / len(rows)))))


def normalize_main_task_status(status: str) -> str:
    s = str(status or "").strip().lower()
    if s == "done":
        return "completed"
    if s in {"in_progress", "running", "active", "waiting_dispatch"}:
        return "executing"
    if s == "error":
        return "failed"
    if s == "canceled":
        return "cancelled"
    return s


def cap_auto_sync_main_progress(progress: int, *, main_status: str) -> int:
    """Clamp auto-synced main progress; 100% only when lead already marked completed/awaiting_close."""
    pct = clamp_task_progress(progress)
    norm = normalize_main_task_status(main_status)
    if norm in {"completed", "awaiting_close"}:
        return pct
    return min(pct, _AUTO_SYNC_MAIN_PROGRESS_CAP)


def infer_main_status_from_subtasks(subtasks: list[dict[str, Any]]) -> str | None:
    """Derive non-terminal main-task status from subtask rows (never ``completed``)."""
    rows = [x for x in subtasks if isinstance(x, dict)]
    if not rows:
        return None
    statuses = [str(x.get("status") or "").strip().lower() for x in rows]
    if all(s in _TERMINAL_SUCCESS for s in statuses):
        return None
    if all(s in _SUB_CANCEL for s in statuses):
        return "cancelled"
    if all(s in _SUB_TERMINAL for s in statuses):
        if any(s in _SUB_FAIL for s in statuses):
            return "failed"
        return None
    if any(s in _IN_FLIGHT for s in statuses):
        return "executing"
    if any(s in _TERMINAL_SUCCESS for s in statuses):
        return "executing"
    if any(subtask_row_progress_percent(x) > 0 for x in rows):
        return "executing"
    return None


def _schedule_main_task_broadcast(main_task_id: str, event_type: str, data: dict[str, Any]) -> None:
    """Best-effort broadcast of main-task progress/status changes.

    Works from both async and sync contexts:
    - If a running event loop exists, schedule on it (fire-and-forget).
    - If not (sync thread / background worker), spawn a short-lived daemon
      thread with its own loop so the broadcast isn't silently dropped.
    """
    try:
        import asyncio
        import threading

        from evoflow.tools.builtins.supervisor.memory import _broadcast_task_event

        try:
            asyncio.get_running_loop()
        except RuntimeError:
            # No running loop — spawn a daemon thread with its own loop.
            # This keeps broadcasts working from sync callers (e.g. task_queue_runner).
            def _fire() -> None:
                try:
                    _loop = asyncio.new_event_loop()
                    asyncio.set_event_loop(_loop)
                    try:
                        _loop.run_until_complete(
                            _broadcast_task_event(main_task_id, event_type, dict(data))
                        )
                    finally:
                        _loop.close()
                except Exception:
                    logger.debug("background broadcast thread failed", exc_info=True)

            t = threading.Thread(target=_fire, daemon=True, name="task_broadcast")
            t.start()
            return

        # Has running loop — schedule on it.
        # Use ensure_future so the Task holds a reference (avoids GC).
        asyncio.ensure_future(_broadcast_task_event(main_task_id, event_type, dict(data)))
    except Exception:
        logger.debug("schedule main task broadcast failed", exc_info=True)


def sync_main_task_from_subtasks(storage: Any, main_task_id: str) -> dict[str, Any]:
    """Persist main-task progress (and non-terminal status) from subtask rows.

    Intermediate progress is auto-synced (capped at 99% until lead sets ``completed``).
    **App / workflow sourced tasks** (`source_app_id`) have no lead finalize step — once
    every subtask succeeds they auto-close at 100% / ``completed``.

    Uses per-main-task lock to prevent lost updates when multiple subtasks
    finish concurrently and both trigger a rollup.
    """
    from evoflow.collab.storage import main_task_mutation_lock

    mid = str(main_task_id or "").strip()
    if not mid:
        return {"ok": False, "changed": False}

    # Serialize read-modify-write per main task to avoid lost updates
    with main_task_mutation_lock(mid):
        return _sync_main_task_from_subtasks_locked(storage, mid)


def _sync_main_task_from_subtasks_locked(storage: Any, main_task_id: str) -> dict[str, Any]:
    """Inner implementation of sync_main_task_from_subtasks (caller must hold lock)."""
    found = find_main_task(storage, main_task_id)
    if not found:
        return {"ok": False, "changed": False}

    project, task = found
    subs = [x for x in (task.get("subtasks") or []) if isinstance(x, dict)]
    if not subs:
        return {
            "ok": True,
            "changed": False,
            "status": task.get("status"),
            "progress": clamp_task_progress(task.get("progress")),
        }

    cur_status = normalize_main_task_status(str(task.get("status") or ""))
    cur_progress = clamp_task_progress(task.get("progress"))
    raw_progress = aggregate_subtasks_progress_percent(subs)
    app_sourced = bool(str(task.get("source_app_id") or "").strip())
    statuses = [str(x.get("status") or "").strip().lower() for x in subs]

    forced_status: str | None = None
    if app_sourced and cur_status not in _MAIN_TERMINAL and statuses:
        if all(s in _TERMINAL_SUCCESS for s in statuses):
            forced_status = "completed"
            new_progress = 100
        elif all(s in _SUB_TERMINAL for s in statuses) and any(s in _SUB_FAIL for s in statuses):
            forced_status = "failed"
            new_progress = clamp_task_progress(raw_progress)
        elif all(s in _SUB_CANCEL for s in statuses):
            forced_status = "cancelled"
            new_progress = clamp_task_progress(raw_progress)
        else:
            new_progress = cap_auto_sync_main_progress(raw_progress, main_status=cur_status)
    elif cur_status == "completed":
        new_progress = 100
    else:
        new_progress = cap_auto_sync_main_progress(raw_progress, main_status=cur_status)

    inferred = infer_main_status_from_subtasks(subs)

    new_status: str | None = None
    if forced_status:
        new_status = forced_status
    elif cur_status not in _MAIN_TERMINAL:
        new_status = inferred

    changed = False
    if new_progress != cur_progress:
        task["progress"] = new_progress
        changed = True
    if new_status and new_status != cur_status:
        task["status"] = new_status
        changed = True
        now = utc_now_iso_z()
        if new_status == "completed":
            task["progress"] = 100
            new_progress = 100
            if task.get("completed_at") is None:
                task["completed_at"] = now
            try:
                from evoflow.memory.episodes import record_task_episode

                record_task_episode(task, outcome="completed")
            except Exception:
                logger.debug("sync complete → memory episode skipped", exc_info=True)
        elif new_status == "failed":
            if task.get("failed_at") is None:
                task["failed_at"] = now
        elif new_status == "executing" and not task.get("started_at"):
            task["started_at"] = now

    # App-sourced tasks: promote rollup even when status/progress already terminal
    # (covers the race where status completed before outputs were written).
    if app_sourced:
        try:
            from evoflow.collab.app_rollup import maybe_rollup_main_task

            rollup_patch = maybe_rollup_main_task(
                task, answer_from_ref=str(task.get("answer_from_ref") or "")
            )
            if rollup_patch:
                for k, v in rollup_patch.items():
                    task[k] = v
                changed = True
        except Exception:
            logger.debug("rollup_main_task failed task_id=%s", main_task_id, exc_info=True)

    if not changed:
        return {
            "ok": True,
            "changed": False,
            "status": task.get("status"),
            "progress": clamp_task_progress(task.get("progress")),
        }

    task["updated_at"] = utc_now_iso_z()
    project["updated_at"] = task["updated_at"]
    storage.save_project(project)

    try:
        from evoflow.tools.builtins.supervisor.memory import _persist_main_task_memory_snapshot

        _persist_main_task_memory_snapshot(project, task)
    except Exception:
        logger.debug("sync main task memory failed", exc_info=True)

    mid = str(main_task_id).strip()
    effective_status = normalize_main_task_status(str(task.get("status") or ""))
    effective_progress = clamp_task_progress(task.get("progress"))
    if effective_status == "completed":
        effective_progress = 100
        if int(task.get("progress") or 0) != 100:
            task["progress"] = 100
    _schedule_main_task_broadcast(
        mid,
        "task:progress",
        {
            "task_id": mid,
            "progress": effective_progress,
            "status": effective_status,
            "current_step": "",
        },
    )

    return {"ok": True, "changed": True, "status": effective_status, "progress": effective_progress}


def infer_subtask_status_for_progress(
    *,
    current_status: str,
    progress: int,
    explicit_status: str | None = None,
) -> str | None:
    if explicit_status:
        s = str(explicit_status).strip().lower()
        if s in {"done"}:
            return "completed"
        if s in {"error"}:
            return "failed"
        if s in {"canceled"}:
            return "cancelled"
        if s in {"executing", "running", "active"}:
            return "in_progress"
        return s or None
    cur = str(current_status or "").strip().lower()
    if cur in _TERMINAL_SUCCESS | _TERMINAL_FAIL:
        return None
    if progress >= 100:
        return None
    if progress > 0 and cur in {"", "pending", "planned", "waiting_dispatch"}:
        return "in_progress"
    return None


async def broadcast_subtask_progress_event(
    main_task_id: str,
    subtask_id: str,
    *,
    progress: int,
    status: str | None = None,
    current_step: str | None = None,
) -> None:
    try:
        from evoflow.tools.builtins.supervisor.memory import _broadcast_task_event

        payload: dict[str, Any] = {
            "task_id": subtask_id,
            "collab_subtask_id": subtask_id,
            "progress": clamp_task_progress(progress),
        }
        if current_step:
            payload["current_step"] = str(current_step)[:500]
        if status:
            payload["status"] = str(status).strip().lower()
        await _broadcast_task_event(main_task_id, "task:progress", payload)
    except Exception:
        logger.debug("broadcast_subtask_progress_event failed", exc_info=True)


async def apply_subtask_progress_report(
    *,
    main_task_id: str,
    subtask_id: str,
    progress: int,
    current_step: str | None = None,
    status: str | None = None,
    reported_by: str = "worker",
    storage: Any | None = None,
) -> dict[str, Any]:
    """Persist worker/lead subtask progress (0–100) to project storage + task memory."""
    mid = str(main_task_id or "").strip()
    sid = str(subtask_id or "").strip()
    if not mid or not sid:
        return {"ok": False, "error": "main_task_id and subtask_id are required"}

    pct = clamp_task_progress(progress)
    step = str(current_step or "").strip()[:500] or None

    store = storage if storage is not None else get_project_storage()
    st = find_subtask_by_ids(store, mid, sid)
    if not st:
        return {"ok": False, "error": "subtask not found"}

    prev_status = str(st.get("status") or "").strip().lower()
    if prev_status in _TERMINAL_SUCCESS | _TERMINAL_FAIL:
        return {
            "ok": False,
            "error": f"subtask already terminal ({prev_status}); use subtask_outcome_report to change outcome",
            "status": prev_status,
            "progress": clamp_task_progress(st.get("progress")),
        }

    next_status = infer_subtask_status_for_progress(
        current_status=prev_status,
        progress=pct,
        explicit_status=status,
    )
    if pct >= 100 and not next_status:
        # progress 已满但状态未变：保持当前状态，不强制推进
        pass

    mem = get_task_detail_storage()
    ok = persist_subtask_runtime_snapshot(
        store,
        mem,
        mid,
        sid,
        status=next_status,
        progress=pct,
        current_step=step or f"Progress {pct}% ({reported_by})",
        sync_agent_memory=True,
    )
    if not ok:
        return {"ok": False, "error": "persist subtask progress failed"}

    await broadcast_subtask_progress_event(
        mid,
        sid,
        progress=pct,
        status=next_status or prev_status,
        current_step=step,
    )

    return {
        "ok": True,
        "mainTaskId": mid,
        "subtaskId": sid,
        "progress": pct,
        "status": next_status or prev_status or "pending",
        "currentStep": step,
        "reportedBy": reported_by,
        "updatedAt": utc_now_iso_z(),
        "message": f"子任务进度已更新为 {pct}%",
    }


def format_subtask_progress_mandate_block() -> str:
    """Inject into collab subtask worker system prompt."""
    return """## 子任务进度上报（强制，执行过程中）

协作侧栏与工作流 DAG 的**进度条与状态灯**只认存储里的 `progress`（0–100）与 `status`。聊天文字**不会**更新 UI。

**你必须主动上报（按完成度估算百分比）**
- 开始实质性工作前：`subtask_progress_report(progress=5~15, current_step="…")`，并确保 checklist 已 `set`
- 每完成一个关键里程碑（或 checklist 一项 `completed` 后）：再次调用，进度单调递增（建议 20→50→80…）
- 若在用 `subtask_work_checklist`：每次 `update` 完成项后 checklist 会自动折算进度；**仍建议在阶段边界再调一次** `subtask_progress_report` 写清 `current_step`
- 收尾前：`subtask_outcome_report` 会把终态设为 100%（completed）或保留末次进度（failed/blocked）

**参数**
- `progress`（必填）：0–100 整数，反映**本子任务**整体完成度（不是主任务）
- `current_step`（强烈建议）：正在做什么（一句话，供 Lead / UI）
- `status`（可选）：`in_progress`；终态请用 `subtask_outcome_report`

**禁止**
- 全程 0% 或只在最后一步才上报
- 用主会话 prose 代替工具调用

**与主任务区分**
- **本子任务**：你可上报到 100%，并用 `subtask_outcome_report` 设为 `completed`（或 failed/blocked）。
- **主任务（整体）**：执行期进度由后端从子任务汇总（主任务自动上限 99%）；主任务 `completed` + 100% **仅 Lead** 在 Plan 验收后写入。"""


def format_lead_main_progress_mandate_block() -> str:
    """Short block for lead executing phase (may be merged into collab middleware)."""
    return """**主任务（整体）进度**
- 执行期：每次 monitor 后后端按子任务平均更新**主任务** `progress`（自动上限 99%，不会把主任务标为 `completed`）。
- **子任务**仍由各 worker 自行上报至 100% 并用 `subtask_outcome_report` 完成；这与主任务关单无关。
- 终态：全部子任务 completed 且 Plan 验收通过后，Lead 必须 `update_progress(..., progress=100, status=completed)` 或 `set_task_state(status=completed)` 关闭**主任务**。"""


__all__ = [
    "aggregate_subtasks_progress_percent",
    "apply_subtask_progress_report",
    "broadcast_subtask_progress_event",
    "cap_auto_sync_main_progress",
    "clamp_task_progress",
    "format_lead_main_progress_mandate_block",
    "format_subtask_progress_mandate_block",
    "infer_main_status_from_subtasks",
    "infer_subtask_status_for_progress",
    "normalize_main_task_status",
    "subtask_row_progress_percent",
    "sync_main_task_from_subtasks",
]
