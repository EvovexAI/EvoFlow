"""Structured plan fields on the bound main task row only (``evoflow_collab_tasks`` / bundle)."""

from __future__ import annotations

import logging
from typing import Any

from evoflow.collab.storage import find_main_task, get_project_storage
from evoflow.collab.thread_collab import load_thread_collab_state
from evoflow.config.paths import get_paths

logger = logging.getLogger(__name__)


def load_bound_main_task_plan(thread_id: str, *, disk_bound: str = "") -> tuple[dict[str, Any] | None, int, dict[str, Any] | None]:
    """Return ``(plan_dict, ts_ms, task_dict)`` from the thread-bound main task."""
    from evoflow.collab.plan_task_storage import plan_snapshot_for_api, task_has_bound_plan

    tid = str(thread_id or "").strip()
    if not tid:
        return None, 0, None
    bound = str(disk_bound or "").strip()
    if not bound:
        try:
            collab = load_thread_collab_state(get_paths(), tid)
            bound = str(collab.bound_task_id or "").strip()
        except Exception:
            bound = ""

    storage = get_project_storage()
    row = find_main_task(storage, bound) if bound else None
    if not row:
        from evoflow.collab.task_progress_snapshot import find_root_tasks_bound_to_thread

        cands = find_root_tasks_bound_to_thread(storage, tid)
        if cands:
            row = cands[0]

    if not row:
        return None, 0, None

    _project, task = row
    if not task_has_bound_plan(task):
        return None, 0, task

    bound_at = str(task.get("plan_bound_at") or "")
    ts = 0
    if bound_at:
        try:
            from evoflow.timeutil import iso_z_to_ms

            ts = int(iso_z_to_ms(bound_at) or 0)
        except Exception:
            ts = 0
    return plan_snapshot_for_api(task), ts, task


def thread_has_committed_plan_on_task(thread_id: str, *, disk_bound: str = "") -> bool:
    """True when the bound main task has structured plan columns populated."""
    plan, _ts, _task = load_bound_main_task_plan(thread_id, disk_bound=disk_bound)
    return plan is not None
