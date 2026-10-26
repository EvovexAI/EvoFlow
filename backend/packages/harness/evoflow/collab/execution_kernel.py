"""Collab execution kernel — shared wave/lock/runtime primitives (E-3).

Single home for the state and helpers that both the Workflow scheduler
(``workflow_scheduler`` / ``step_runner``) and Lead supervisor
(``tools.builtins.supervisor.execution``) need. Before this module the
workflow side imported supervisor's private underscore helpers directly, so
the "Workflow does not depend on Lead" boundary existed only in docstrings.

What lives here:
- per-main-task follow-up wave locks (all wave-2+ paths must share ONE dict)
- lead ToolRuntime registry (strong + weak refs, resolved on follow-up)
- upstream artifact verification before a follow-up wave starts dependents
- lazy delegation proxies (claim → delegate still executes in supervisor's
  ``delegate_collab_subtasks_for_start_execution``; importing it eagerly here
  would recreate the cycle, so it is imported at call time)

Supervisor keeps its historical underscore names as thin aliases of this
module — its internals are unchanged; external consumers now import from here.
"""

from __future__ import annotations

import asyncio
import logging
import weakref
from collections.abc import Callable
from typing import Any

from evoflow.timeutil import utc_now_iso_z

logger = logging.getLogger(__name__)

# Per main-task lock: concurrent subtask completions must not double-start
# follow-up waves. ONE dict process-wide, shared by workflow + lead paths.
_followup_wave_locks: dict[str, asyncio.Lock] = {}

# Lead ToolRuntime from start_execution — used when follow-up fires from a
# worker subthread that has no lead runtime of its own.
_collab_lead_runtime_by_task: dict[str, Any] = {}
# Strong refs: weakref alone is often collected before wave-2 follow-up runs.
_collab_lead_runtime_strong: dict[str, Any] = {}


def followup_lock_for_task(main_task_id: str) -> asyncio.Lock:
    """Process-wide per-main-task asyncio lock for wave-2+ follow-up."""
    tid = str(main_task_id or "").strip()
    lock = _followup_wave_locks.get(tid)
    if lock is None:
        lock = asyncio.Lock()
        _followup_wave_locks[tid] = lock
    return lock


def store_lead_runtime(main_task_id: str, runtime: Any) -> None:
    """Record the lead runtime (strong + weak) for later follow-up resolution."""
    tid = str(main_task_id or "").strip()
    if not tid or runtime is None:
        return
    _collab_lead_runtime_strong[tid] = runtime
    try:
        _collab_lead_runtime_by_task[tid] = weakref.ref(
            runtime,
            lambda _r, task_id=tid: _collab_lead_runtime_strong.pop(task_id, None),
        )
    except TypeError:
        # Gateway/minimal runtimes must not abort delegation (follow-up may lack lead runtime).
        logger.debug("collab lead runtime not weakref-able for task %s type=%s", tid, type(runtime).__name__)


def drop_lead_runtime(main_task_id: str) -> None:
    """Drop strong/weak refs to lead runtime when a task reaches terminal."""
    tid = str(main_task_id or "").strip()
    if not tid:
        return
    _collab_lead_runtime_strong.pop(tid, None)
    _collab_lead_runtime_by_task.pop(tid, None)


def peek_lead_runtime(main_task_id: str) -> Any | None:
    """Best-effort lookup without a caller runtime: strong ref first, then weak."""
    tid = str(main_task_id or "").strip()
    strong = _collab_lead_runtime_strong.get(tid)
    if strong is not None:
        return strong
    ref = _collab_lead_runtime_by_task.get(tid)
    if ref is not None:
        return ref()
    return None


def default_is_subtask_worker(runtime: Any) -> bool:
    """Default worker predicate: thread id belongs to a collab executor thread."""
    from evoflow.collab.thread_ids import is_collab_executor_thread
    from evoflow.tools.builtins.supervisor.utils import _runtime_thread_id

    return is_collab_executor_thread(_runtime_thread_id(runtime))


def resolve_followup_runtime(
    caller_runtime: Any | None,
    main_task_id: str,
    *,
    is_subtask_worker: Callable[[Any], bool] | None = None,
) -> Any | None:
    """Resolution order for the runtime that should drive a follow-up wave.

    1. registered strong lead runtime for this task
    2. the caller's runtime, when it is NOT a subtask worker (i.e. it IS the lead)
    3. registered weakref lead runtime (if still alive)
    4. the caller's worker runtime (better than nothing)
    5. None — no runtime available; the wave is skipped by the caller
    """
    from evoflow.collab.dag_trace import dag_info

    predicate = is_subtask_worker or default_is_subtask_worker
    tid = str(main_task_id or "").strip()
    strong = _collab_lead_runtime_strong.get(tid)
    if strong is not None:
        dag_info("followup_runtime main=%s source=strong_ref type=%s", tid, type(strong).__name__)
        return strong
    if caller_runtime is not None and not predicate(caller_runtime):
        dag_info("followup_runtime main=%s source=caller_lead_runtime type=%s", tid, type(caller_runtime).__name__)
        return caller_runtime
    ref = _collab_lead_runtime_by_task.get(tid)
    if ref is not None:
        resolved = ref()
        if resolved is not None:
            dag_info("followup_runtime main=%s source=weakref_alive type=%s", tid, type(resolved).__name__)
            return resolved
        dag_info("followup_runtime main=%s source=weakref_dead", tid)
    if caller_runtime is not None:
        dag_info("followup_runtime main=%s source=caller_worker_runtime type=%s", tid, type(caller_runtime).__name__)
        return caller_runtime
    dag_info("followup_runtime main=%s source=none (no caller runtime, no stored lead runtime)", tid)
    return None


def verify_upstream_artifacts_before_followup(storage: Any, main_task_id: str) -> None:
    """Verify that completed subtasks have produced their expected outputs on disk.

    If a completed subtask's expected_outputs files are missing, mark it as ``failed``
    so dependents won't start with broken upstream artifacts.
    """
    import os as _os

    from evoflow.collab.storage import find_main_task

    row = find_main_task(storage, main_task_id)
    if not row:
        return
    project, task = row
    subtasks = [st for st in (task.get("subtasks") or []) if isinstance(st, dict)]
    if not subtasks:
        return

    project_path = str(task.get("project_path") or "").strip()
    if not project_path:
        project_path = str(project.get("project_path") or "").strip()
    if not project_path:
        # Only warn when a subtask actually declared expected outputs. A task
        # that produces no artifacts has nothing to verify, so a missing
        # project_path is harmless there — warning on it spams every wave.
        declares_outputs = any(
            isinstance(st.get("worker_profile"), dict) and st["worker_profile"].get("expected_outputs")
            for st in subtasks
        )
        if declares_outputs:
            logger.warning(
                "artifact verification skipped for task %s: project_path is empty",
                main_task_id,
            )
        return

    now = utc_now_iso_z()
    changed = False

    for st in subtasks:
        sid = str(st.get("id") or "").strip()
        if not sid:
            continue
        status = str(st.get("status") or "").strip().lower()
        if status != "completed":
            continue

        wp = st.get("worker_profile")
        if not isinstance(wp, dict):
            continue
        expected = wp.get("expected_outputs")
        if not isinstance(expected, list) or not expected:
            continue

        def _path_exists(rel_or_abs: str) -> bool:
            p_str = str(rel_or_abs or "").strip()
            if not p_str:
                return False
            candidates: list[str] = []
            if _os.path.isabs(p_str):
                candidates.append(p_str)
            else:
                candidates.append(_os.path.join(project_path, p_str))
                for sub in ("outputs", "workspace", "workspace/outputs", "mnt/user-data/outputs"):
                    candidates.append(_os.path.join(project_path, sub, p_str))
            for full in candidates:
                if full and _os.path.exists(full):
                    return True
            return False

        missing: list[str] = []
        for p in expected:
            p_str = str(p or "").strip()
            if not p_str:
                continue
            if not _path_exists(p_str):
                missing.append(p_str)

        if missing:
            evidence_raw = st.get("evidence_paths")
            if not isinstance(evidence_raw, list):
                evidence_raw = wp.get("evidence_paths") if isinstance(wp.get("evidence_paths"), list) else []
            evidence = [str(x).strip() for x in evidence_raw if str(x).strip()]
            if evidence and any(_path_exists(p) for p in evidence):
                logger.info(
                    "artifact verification: subtask %s missing %s but evidence_paths exist on disk; allow",
                    sid,
                    missing,
                )
                continue

            logger.warning(
                "artifact verification: subtask %s completed but missing outputs: %s",
                sid,
                missing,
            )
            st["status"] = "failed"
            st["error"] = f"Artifact verification failed: missing expected outputs: {missing}"
            st["failed_at"] = now
            st.pop("completed_at", None)
            changed = True

    if changed:
        storage.save_project(project)
        try:
            from evoflow.collab.storage import rollup_root_task_progress_from_subtasks

            rollup_root_task_progress_from_subtasks(storage, main_task_id)
        except Exception:
            logger.debug("artifact verification: rollup failed", exc_info=True)


async def delegate_claimed_subtasks(
    runtime: Any | None,
    storage: Any,
    main_task_id: str,
    subtask_ids: list[str],
    *,
    wait_for_completion: bool = False,
) -> list[dict[str, Any]]:
    """Delegate claimed subtasks (task_tool / lifecycle SSE) via the supervisor executor.

    Lazy import: supervisor.execution imports collab.step_runner at module
    level, so importing it eagerly here would create an import cycle.
    """
    from evoflow.tools.builtins.supervisor.execution import delegate_collab_subtasks_for_start_execution

    return await delegate_collab_subtasks_for_start_execution(
        runtime,
        storage,
        main_task_id,
        subtask_ids,
        wait_for_completion=wait_for_completion,
    )


def resolve_runnable_subtasks(storage: Any, main_task_id: str, runtime: Any | None = None) -> tuple[list[str], list[str]]:
    """Resolve currently runnable subtask ids (runnable, blocked) for a main task.

    Lazy proxy over supervisor dependency resolution — kept here so collab-side
    modules never import supervisor private names.
    """
    from evoflow.tools.builtins.supervisor.dependency import _resolve_subtasks_for_start_execution

    return _resolve_subtasks_for_start_execution(storage, main_task_id, runtime)


__all__ = [
    "delegate_claimed_subtasks",
    "default_is_subtask_worker",
    "drop_lead_runtime",
    "followup_lock_for_task",
    "peek_lead_runtime",
    "resolve_followup_runtime",
    "resolve_runnable_subtasks",
    "store_lead_runtime",
    "verify_upstream_artifacts_before_followup",
]
