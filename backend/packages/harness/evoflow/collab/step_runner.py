"""Shared Step Runner — claim + delegate entry for Workflow and Lead collab.

Architecture
------------
- **Claim / revert** live here (storage + ``SubtaskStateMachine`` only).
- **Delegate** (task_tool / lifecycle SSE) stays in ``supervisor.execution`` for now;
  callers should enter via :func:`run_steps` so Workflow does not import supervisor
  for the claim surface.

WorkflowRuntime / WorkflowScheduler and Lead ``start_execution`` share this module.
"""

from __future__ import annotations

import logging
from typing import Any

from evoflow.timeutil import utc_now_iso_z

logger = logging.getLogger(__name__)

CLAIMABLE_SUBTASK_STATUSES = frozenset({"pending", "planned", "waiting_dispatch"})


def claim_subtasks_for_delegation(
    storage: Any,
    main_task_id: str,
    subtask_ids: list[str],
) -> list[str]:
    """Atomically mark pending subtasks as executing before parallel delegate (TOCTOU)."""
    from evoflow.collab.dag_trace import dag_info
    from evoflow.collab.storage import find_main_task, main_task_mutation_lock
    from evoflow.tools.builtins.supervisor.dependency import _IN_FLIGHT_SUBTASK, _TERMINAL_SUBTASK

    mid = str(main_task_id or "").strip()
    if not mid:
        return []
    claimed: list[str] = []
    skipped: list[dict[str, str]] = []
    want: set[str] = set()
    with main_task_mutation_lock(mid):
        row = find_main_task(storage, mid, bypass_cache=True)
        if not row:
            dag_info("claim_skip main=%s reason=task_not_found want=%s", main_task_id, subtask_ids)
            return []
        project, task = row
        want = {str(s).strip() for s in subtask_ids if str(s).strip()}
        if not want:
            return []

        now = utc_now_iso_z()
        for st in task.get("subtasks") or []:
            if not isinstance(st, dict):
                continue
            sid = str(st.get("id") or "").strip()
            if sid not in want:
                continue
            status = str(st.get("status") or "pending").strip().lower()
            if status in _TERMINAL_SUBTASK:
                skipped.append({"subtaskId": sid, "status": status, "reason": "terminal"})
                continue
            if status in _IN_FLIGHT_SUBTASK:
                skipped.append({"subtaskId": sid, "status": status, "reason": "in_flight"})
                continue
            from evoflow.subagents.runtime_guard import is_subtask_background_executor_active

            if is_subtask_background_executor_active(st):
                skipped.append({"subtaskId": sid, "status": status, "reason": "background_active"})
                dag_info(
                    "claim_skip main=%s sub=%s reason=background_active bg=%s",
                    main_task_id,
                    sid,
                    st.get("background_task_id"),
                )
                continue
            if status not in CLAIMABLE_SUBTASK_STATUSES:
                skipped.append({"subtaskId": sid, "status": status, "reason": "not_claimable"})
                continue
            from evoflow.collab.subtask_state_machine import advance_subtask_row_status

            ok_adv, adv_reason = advance_subtask_row_status(st, "executing")
            if not ok_adv:
                skipped.append({"subtaskId": sid, "status": status, "reason": adv_reason})
                continue
            st["started_at"] = st.get("started_at") or now
            st["updated_at"] = now
            claimed.append(sid)

        if claimed:
            task["updated_at"] = now
            storage.save_project(project)
    dag_info(
        "claim main=%s requested=%s claimed=%s skipped=%s",
        main_task_id,
        sorted(want),
        claimed,
        skipped[:12],
    )
    return claimed


def revert_claimed_subtasks_to_pending(
    storage: Any,
    main_task_id: str,
    subtask_ids: list[str],
    *,
    reason: str,
) -> None:
    """Undo executing claim when delegation cannot start (prevents infinite spinner)."""
    from evoflow.collab.dag_trace import dag_warning
    from evoflow.collab.storage import find_main_task, main_task_mutation_lock

    want = {str(s).strip() for s in subtask_ids if str(s).strip()}
    if not want:
        return
    mid = str(main_task_id or "").strip()
    if not mid:
        return
    reverted: list[str] = []
    with main_task_mutation_lock(mid):
        row = find_main_task(storage, mid, bypass_cache=True)
        if not row:
            return
        project, task = row
        now = utc_now_iso_z()
        for st in task.get("subtasks") or []:
            if not isinstance(st, dict):
                continue
            sid = str(st.get("id") or "").strip()
            if sid not in want:
                continue
            status = str(st.get("status") or "").strip().lower()
            if status not in {"executing", "running", "in_progress"}:
                continue
            st["status"] = "pending"
            st["error"] = str(reason or "delegation not started")[:500]
            st["updated_at"] = now
            reverted.append(sid)
        if reverted:
            task["updated_at"] = now
            storage.save_project(project)
    if reverted:
        dag_warning(
            "revert_claimed main=%s subs=%s reason=%s",
            main_task_id,
            reverted,
            reason[:300],
        )


async def run_steps(
    runtime: Any | None,
    storage: Any,
    main_task_id: str,
    subtask_ids: list[str],
    *,
    wait_for_completion: bool = False,
) -> list[dict[str, Any]]:
    """Canonical Step Runner entry: claim (here) + delegate (execution helper)."""
    from evoflow.tools.builtins.supervisor.execution import delegate_collab_subtasks_for_start_execution

    return await delegate_collab_subtasks_for_start_execution(
        runtime,
        storage,
        main_task_id,
        subtask_ids,
        wait_for_completion=wait_for_completion,
    )


async def advance_runnable_wave(
    runtime: Any | None,
    storage: Any,
    main_task_id: str,
    *,
    wait_for_completion: bool = False,
) -> list[dict[str, Any]]:
    """Resolve currently runnable subtasks and ``run_steps`` them.

    Shared by WorkflowScheduler followup/retry and Lead ``auto_delegate`` body.
    """
    from evoflow.tools.builtins.supervisor.dependency import _resolve_subtasks_for_start_execution

    tid = str(main_task_id or "").strip()
    if not tid:
        return []
    to_run, _blocked = _resolve_subtasks_for_start_execution(storage, tid, None)
    if not to_run:
        return []
    return await run_steps(
        runtime,
        storage,
        tid,
        to_run,
        wait_for_completion=wait_for_completion,
    )


__all__ = [
    "CLAIMABLE_SUBTASK_STATUSES",
    "advance_runnable_wave",
    "claim_subtasks_for_delegation",
    "revert_claimed_subtasks_to_pending",
    "run_steps",
]
