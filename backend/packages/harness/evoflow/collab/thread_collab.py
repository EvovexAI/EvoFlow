"""Load/save per-thread collaboration state (SQLite ``evoflow_thread_collab``)."""

import logging
import time as _collab_time
from pathlib import Path
from typing import Any

from evoflow.collab.models import CollabPhase, ThreadCollabState, _utc_iso_z
from evoflow.config.paths import Paths
from evoflow.persistence import repositories as repo

TASK_STATE_FILENAME = "task_state.json"  # legacy name; data lives in SQLite

# Short-TTL cache for load_thread_collab_state — 8+ middlewares (27+ call sites)
# call this during a single model turn. A 3-second TTL eliminates redundant
# SQLite reads while staying fresh for collab phase transitions.
_collab_cache: dict[str, tuple[ThreadCollabState, float]] = {}
_COLLAB_CACHE_TTL = 3.0


def invalidate_collab_cache(thread_id: str | None = None) -> None:
    """Clear the collab state cache (call after save_thread_collab_state)."""
    if thread_id:
        _collab_cache.pop(str(thread_id).strip(), None)
    else:
        _collab_cache.clear()


def collab_state_path(paths: Paths, thread_id: str) -> Path:
    """Legacy path helper (thread sandbox dirs only; collab state is in SQLite)."""
    return paths.thread_dir(thread_id) / TASK_STATE_FILENAME


def default_thread_collab_state() -> ThreadCollabState:
    return ThreadCollabState()


def load_merged_collab_phase(paths: Paths, thread_id: str, ctx_collab_phase: str | None = None) -> str:
    """Merge runtime ``collab_phase`` with persisted thread collab state.

    When collaboration has left ``idle`` on disk, the persisted value wins over
    ``runtime.context["collab_phase"]``, which can remain stale for an entire
    LangGraph stream (e.g. after ``supervisor(start_execution)`` writes
    ``executing`` to ``collab_state.json``).
    """
    tid = str(thread_id or "").strip()
    ctx = str(ctx_collab_phase or "").strip().lower()
    if not tid:
        return ctx or CollabPhase.IDLE.value
    try:
        disk = load_thread_collab_state(paths, tid)
        p = disk.collab_phase.value if isinstance(disk.collab_phase, CollabPhase) else str(disk.collab_phase or "")
        disk_p = str(p).strip().lower()
    except Exception:
        disk_p = ""
    if disk_p and disk_p != CollabPhase.IDLE.value:
        return disk_p
    if ctx and ctx != CollabPhase.IDLE.value:
        return ctx
    return disk_p or ctx or CollabPhase.IDLE.value


def load_thread_collab_state(paths: Paths, thread_id: str) -> ThreadCollabState:
    """Read state from SQLite, or return defaults if missing / invalid.

    Uses a 3-second TTL cache to avoid redundant reads across the middleware chain
    (8+ middlewares call this per model turn). Call ``invalidate_collab_cache``
    after ``save_thread_collab_state`` to ensure freshness.
    """
    del paths
    tid = str(thread_id or "").strip()
    if tid:
        now = _collab_time.monotonic()
        cached = _collab_cache.get(tid)
        if cached is not None and now - cached[1] < _COLLAB_CACHE_TTL:
            return cached[0]
    raw = repo.load_thread_collab(thread_id)
    if not isinstance(raw, dict):
        result = default_thread_collab_state()
    else:
        try:
            result = ThreadCollabState.model_validate(raw)
        except Exception:
            result = default_thread_collab_state()
    if tid:
        _collab_cache[tid] = (result, _collab_time.monotonic())
    return result


def append_sidebar_supervisor_step(paths: Paths, thread_id: str, step: dict[str, Any], *, max_steps: int = 80) -> None:
    """Append one supervisor timeline step and persist (trim to last ``max_steps``)."""
    tid = (thread_id or "").strip()
    if not tid:
        raise ValueError("thread_id is required")
    paths.thread_dir(tid)
    current = load_thread_collab_state(paths, tid)
    steps = list(current.sidebar_supervisor_steps)
    steps.append(step)
    if len(steps) > max_steps:
        steps = steps[-max_steps:]
    save_thread_collab_state(paths, tid, current.model_copy(update={"sidebar_supervisor_steps": steps}))


def save_thread_collab_state(paths: Paths, thread_id: str, state: ThreadCollabState) -> ThreadCollabState:
    """Write state to SQLite; ensures thread sandbox dirs exist for uploads/workspace."""
    paths.thread_dir(thread_id).mkdir(parents=True, exist_ok=True)
    out = state.model_copy(update={"updated_at": _utc_iso_z()})
    repo.save_thread_collab(thread_id, out.model_dump(mode="json"))
    invalidate_collab_cache(thread_id)
    try:
        from evoflow.collab.ws_notify import schedule_collab_state_changed

        schedule_collab_state_changed(thread_id)
    except Exception:
        logger.debug("collab state ws notify failed thread=%s", thread_id, exc_info=True)
    return out


def merge_thread_collab_state(current: ThreadCollabState, patch: dict[str, Any]) -> ThreadCollabState:
    """Apply partial update (only keys present in ``patch``)."""
    data = current.model_dump(mode="json")
    for key, value in patch.items():
        if key == "updated_at" or key not in ThreadCollabState.model_fields:
            continue
        data[key] = value
    return ThreadCollabState.model_validate(data)


logger = logging.getLogger(__name__)

# Allowed collab phase transitions (from -> to). Same-phase is always allowed.
_COLLAB_PHASE_TRANSITIONS: dict[str, frozenset[str]] = {
    CollabPhase.IDLE.value: frozenset({CollabPhase.PLANNING.value, CollabPhase.REQ_CONFIRM.value}),
    CollabPhase.REQ_CONFIRM.value: frozenset({CollabPhase.PLANNING.value, CollabPhase.IDLE.value}),
    CollabPhase.PLANNING.value: frozenset({CollabPhase.PLAN_READY.value, CollabPhase.IDLE.value, CollabPhase.AWAITING_EXEC.value}),
    CollabPhase.PLAN_READY.value: frozenset({CollabPhase.AWAITING_EXEC.value, CollabPhase.PLANNING.value, CollabPhase.EXECUTING.value}),
    CollabPhase.AWAITING_EXEC.value: frozenset({CollabPhase.EXECUTING.value, CollabPhase.PLAN_READY.value, CollabPhase.PLANNING.value}),
    CollabPhase.EXECUTING.value: frozenset({CollabPhase.VERIFYING.value, CollabPhase.PAUSED.value, CollabPhase.DONE.value, CollabPhase.REFLECTING.value}),
    CollabPhase.VERIFYING.value: frozenset({CollabPhase.REFLECTING.value, CollabPhase.DONE.value, CollabPhase.EXECUTING.value}),
    CollabPhase.REFLECTING.value: frozenset({CollabPhase.DONE.value}),
    CollabPhase.PAUSED.value: frozenset({CollabPhase.EXECUTING.value}),
    CollabPhase.DONE.value: frozenset(),
}


def _norm_collab_phase_value(phase: Any) -> str:
    if isinstance(phase, CollabPhase):
        return phase.value
    return str(phase or CollabPhase.IDLE.value).strip().lower() or CollabPhase.IDLE.value


def can_transition_collab_phase(from_phase: str | CollabPhase | None, to_phase: str | CollabPhase | None) -> bool:
    src = _norm_collab_phase_value(from_phase)
    dst = _norm_collab_phase_value(to_phase)
    if src == dst:
        return True
    allowed = _COLLAB_PHASE_TRANSITIONS.get(src)
    if allowed is None:
        return False
    return dst in allowed


def _resolve_collab_thread_targets(
    task: dict[str, Any],
    *,
    runtime_thread_id: str | None = None,
) -> list[str]:
    task_tid = str(task.get("thread_id") or "").strip()
    run_tid = str(runtime_thread_id or "").strip()
    nt, nr = _norm_thread_id_for_dedup(task_tid), _norm_thread_id_for_dedup(run_tid)
    targets: list[str] = []
    if task_tid:
        targets.append(task_tid)
    if run_tid and nr != nt:
        targets.append(run_tid)
    return targets


def _apply_collab_phase_patch_to_threads(
    paths: Paths,
    thread_ids: list[str],
    patch: dict[str, Any],
    *,
    task_id: str = "",
    log_label: str = "collab_phase",
) -> bool:
    """Load each thread independently, validate transition, then persist."""
    target_phase = patch.get("collab_phase")
    if target_phase is None:
        return False
    changed = False
    for tid in thread_ids:
        tid_s = str(tid or "").strip()
        if not tid_s:
            continue
        current = load_thread_collab_state(paths, tid_s)
        src = _norm_collab_phase_value(current.collab_phase)
        dst = _norm_collab_phase_value(target_phase)
        if not can_transition_collab_phase(src, dst):
            logger.warning(
                "%s: rejected transition %s -> %s thread=%s task=%s",
                log_label,
                src,
                dst,
                tid_s,
                task_id or "?",
            )
            continue
        merged = merge_thread_collab_state(current, patch)
        save_thread_collab_state(paths, tid_s, merged)
        changed = True
    return changed


def finalize_collab_phase_on_main_terminal(
    paths: Paths,
    task_id: str,
    *,
    runtime_thread_id: str | None = None,
) -> str:
    """When main task is terminal, advance collab phase toward ``done``.

    Returns ``reflecting`` when deferred to reflecting step, ``done`` when reached terminal
    collab phase, or ``skipped`` when no update applied.
    """
    from evoflow.collab.storage import find_main_task, get_project_storage

    storage = get_project_storage()
    found = find_main_task(storage, task_id)
    if not found:
        return "skipped"
    _project, task = found
    targets = _resolve_collab_thread_targets(task, runtime_thread_id=runtime_thread_id)
    if not targets:
        return "skipped"

    primary = targets[0]
    current = load_thread_collab_state(paths, primary)
    phase_val = _norm_collab_phase_value(current.collab_phase)

    if phase_val == CollabPhase.VERIFYING.value:
        if advance_collab_phase_to_reflecting_for_task(paths, task_id, runtime_thread_id=runtime_thread_id):
            return "reflecting"
        return "skipped"

    if phase_val == CollabPhase.REFLECTING.value:
        if _apply_collab_phase_patch_to_threads(
            paths,
            targets,
            {"collab_phase": CollabPhase.DONE.value, "bound_task_id": task_id},
            task_id=task_id,
            log_label="finalize_collab_done",
        ):
            return "done"
        return "skipped"

    if phase_val == CollabPhase.DONE.value:
        return "skipped"

    if _apply_collab_phase_patch_to_threads(
        paths,
        targets,
        {"collab_phase": CollabPhase.DONE.value, "bound_task_id": task_id},
        task_id=task_id,
        log_label="finalize_collab_done",
    ):
        return "done"
    return "skipped"


def _norm_thread_id_for_dedup(value: str | None) -> str:
    """Match thread ids across clients (UUID casing, braces)."""
    if value is None:
        return ""
    return str(value).strip().lower().replace("{", "").replace("}", "")


def revert_collab_phase_to_paused(paths: Paths, task_id: str, runtime_thread_id: str | None = None) -> bool:
    """回退协作阶段到 paused。

    当任务被暂停时调用，将协作阶段从 EXECUTING 回退到 PAUSED。
    这会阻止新的子任务派发，但允许运行中的子任务继续完成。
    """
    from evoflow.collab.storage import find_main_task, get_project_storage

    storage = get_project_storage()
    found = find_main_task(storage, task_id)
    if not found:
        logger.warning("revert_collab_phase_to_paused: main task %r not found", task_id)
        return False
    _project, task = found
    targets = _resolve_collab_thread_targets(task, runtime_thread_id=runtime_thread_id)
    if not targets:
        logger.warning(
            "revert_collab_phase_to_paused: task %r has no thread_id and no runtime_thread_id; skip collab_state update",
            task_id,
        )
        return False

    _PAUSABLE_COLLAB = frozenset(
        {
            CollabPhase.PLANNING,
            CollabPhase.PLAN_READY,
            CollabPhase.AWAITING_EXEC,
            CollabPhase.EXECUTING,
            CollabPhase.VERIFYING,
            CollabPhase.REFLECTING,
        }
    )
    primary = targets[0]
    current = load_thread_collab_state(paths, primary)
    phase = current.collab_phase
    phase_val = phase.value if isinstance(phase, CollabPhase) else str(phase)
    if phase not in _PAUSABLE_COLLAB and phase_val not in {p.value for p in _PAUSABLE_COLLAB}:
        logger.info(
            "revert_collab_phase_to_paused: task %r current phase is %s, not pausable, skip",
            task_id,
            phase_val,
        )
        return False

    ok = _apply_collab_phase_patch_to_threads(
        paths,
        targets,
        {"collab_phase": CollabPhase.PAUSED.value, "bound_task_id": task_id},
        task_id=task_id,
        log_label="revert_collab_phase_to_paused",
    )
    if ok:
        logger.info(
            "revert_collab_phase_to_paused: thread_ids=%s task_id=%s from_phase=%s",
            targets,
            task_id,
            phase_val,
        )
    return ok


def advance_collab_phase_from_paused(paths: Paths, task_id: str, runtime_thread_id: str | None = None) -> bool:
    """从 paused 推进协作阶段到 executing。"""
    from evoflow.collab.storage import find_main_task, get_project_storage

    storage = get_project_storage()
    found = find_main_task(storage, task_id)
    if not found:
        logger.warning("advance_collab_phase_from_paused: main task %r not found", task_id)
        return False
    _project, task = found
    targets = _resolve_collab_thread_targets(task, runtime_thread_id=runtime_thread_id)
    if not targets:
        logger.warning(
            "advance_collab_phase_from_paused: task %r has no thread_id and no runtime_thread_id; skip collab_state update",
            task_id,
        )
        return False

    primary = targets[0]
    current = load_thread_collab_state(paths, primary)
    if current.collab_phase != CollabPhase.PAUSED:
        logger.info(
            "advance_collab_phase_from_paused: task %r current phase is %s, not PAUSED, skip",
            task_id,
            current.collab_phase.value if isinstance(current.collab_phase, CollabPhase) else str(current.collab_phase),
        )
        return False

    ok = _apply_collab_phase_patch_to_threads(
        paths,
        targets,
        {"collab_phase": CollabPhase.EXECUTING.value, "bound_task_id": task_id},
        task_id=task_id,
        log_label="advance_collab_phase_from_paused",
    )
    if ok:
        logger.info("advance_collab_phase_from_paused: thread_ids=%s task_id=%s", targets, task_id)
    return ok


def advance_collab_phase_to_plan_ready_for_task(
    paths: Paths,
    task_id: str,
    *,
    runtime_thread_id: str | None = None,
) -> bool:
    """After plan revision revokes authorization, return collab phase to ``plan_ready``."""
    from evoflow.collab.storage import find_main_task, get_project_storage

    storage = get_project_storage()
    found = find_main_task(storage, task_id)
    if not found:
        logger.warning("advance_collab_phase_to_plan_ready: main task %r not found", task_id)
        return False
    _project, task = found
    targets = _resolve_collab_thread_targets(task, runtime_thread_id=runtime_thread_id)
    if not targets:
        return False
    ok = _apply_collab_phase_patch_to_threads(
        paths,
        targets,
        {"collab_phase": CollabPhase.PLAN_READY.value, "bound_task_id": task_id},
        task_id=task_id,
        log_label="advance_collab_phase_to_plan_ready",
    )
    if ok:
        logger.info("advance_collab_phase_to_plan_ready: thread_ids=%s task_id=%s", targets, task_id)
    return ok


def advance_collab_phase_to_awaiting_exec_for_task(
    paths: Paths,
    task_id: str,
    *,
    runtime_thread_id: str | None = None,
) -> bool:
    """After user authorizes execution (page/API/chat), move thread collab phase to ``awaiting_exec``.

    Real ``executing`` is set only when ``supervisor(start_execution)`` runs.
    """
    from evoflow.collab.storage import find_main_task, get_project_storage

    storage = get_project_storage()
    found = find_main_task(storage, task_id)
    if not found:
        logger.warning("advance_collab_phase_to_awaiting_exec: main task %r not found", task_id)
        return False
    _project, task = found
    targets = _resolve_collab_thread_targets(task, runtime_thread_id=runtime_thread_id)
    if not targets:
        logger.warning(
            "advance_collab_phase_to_awaiting_exec: task %r has no thread_id and no runtime_thread_id; skip",
            task_id,
        )
        return False
    ok = _apply_collab_phase_patch_to_threads(
        paths,
        targets,
        {"collab_phase": CollabPhase.AWAITING_EXEC.value, "bound_task_id": task_id},
        task_id=task_id,
        log_label="advance_collab_phase_to_awaiting_exec",
    )
    if ok:
        logger.info(
            "advance_collab_phase_to_awaiting_exec: thread_ids=%s task_id=%s",
            targets,
            task_id,
        )
    return ok


def advance_collab_phase_to_executing_for_task(paths: Paths, task_id: str, *, runtime_thread_id: str | None = None) -> bool:
    """After ``supervisor(start_execution)`` / authorize, move thread collab phase to ``executing``.

    Writes ``collab_state.json`` under the task's ``thread_id`` **and** (when different) under
    ``runtime_thread_id``. Middleware and ``task_tool`` read state by **current LangGraph thread**;
    if those differ from the task record, only updating the task folder leaves the chat stuck in
    ``awaiting_exec``.
    """
    from evoflow.collab.storage import find_main_task, get_project_storage

    storage = get_project_storage()
    found = find_main_task(storage, task_id)
    if not found:
        logger.warning("advance_collab_phase_to_executing: main task %r not found", task_id)
        return False
    _project, task = found
    targets = _resolve_collab_thread_targets(task, runtime_thread_id=runtime_thread_id)
    if not targets:
        logger.warning(
            "advance_collab_phase_to_executing: task %r has no thread_id and no runtime_thread_id; skip collab_state update",
            task_id,
        )
        return False
    ok = _apply_collab_phase_patch_to_threads(
        paths,
        targets,
        {"collab_phase": CollabPhase.EXECUTING.value, "bound_task_id": task_id},
        task_id=task_id,
        log_label="advance_collab_phase_to_executing",
    )
    if ok:
        logger.info(
            "advance_collab_phase_to_executing: thread_ids=%s task_id=%s",
            targets,
            task_id,
        )
    return ok


def advance_collab_phase_to_verifying_for_task(
    paths: Paths,
    task_id: str,
    *,
    runtime_thread_id: str | None = None,
) -> bool:
    """When all subtasks finished, move thread to ``verifying`` (tests/read-only tools)."""
    from evoflow.collab.storage import find_main_task, get_project_storage

    storage = get_project_storage()
    found = find_main_task(storage, task_id)
    if not found:
        logger.warning("advance_collab_phase_to_verifying: main task %r not found", task_id)
        return False
    _project, task = found
    targets = _resolve_collab_thread_targets(task, runtime_thread_id=runtime_thread_id)
    if not targets:
        return False
    ok = _apply_collab_phase_patch_to_threads(
        paths,
        targets,
        {"collab_phase": CollabPhase.VERIFYING.value, "bound_task_id": task_id},
        task_id=task_id,
        log_label="advance_collab_phase_to_verifying",
    )
    if ok:
        logger.info("advance_collab_phase_to_verifying: thread_ids=%s task_id=%s", targets, task_id)
    return ok


def advance_collab_phase_to_reflecting_for_task(
    paths: Paths,
    task_id: str,
    *,
    runtime_thread_id: str | None = None,
) -> bool:
    """After verification, move thread to ``reflecting`` for outcome summary before ``done``."""
    from evoflow.collab.storage import find_main_task, get_project_storage

    storage = get_project_storage()
    found = find_main_task(storage, task_id)
    if not found:
        logger.warning("advance_collab_phase_to_reflecting: main task %r not found", task_id)
        return False
    _project, task = found
    targets = _resolve_collab_thread_targets(task, runtime_thread_id=runtime_thread_id)
    if not targets:
        return False
    primary = targets[0]
    current = load_thread_collab_state(paths, primary)
    phase = _norm_collab_phase_value(current.collab_phase)
    if phase in {CollabPhase.DONE.value, CollabPhase.IDLE.value, CollabPhase.REFLECTING.value}:
        return False
    ok = _apply_collab_phase_patch_to_threads(
        paths,
        targets,
        {"collab_phase": CollabPhase.REFLECTING.value, "bound_task_id": task_id},
        task_id=task_id,
        log_label="advance_collab_phase_to_reflecting",
    )
    if ok:
        logger.info("advance_collab_phase_to_reflecting: thread_ids=%s task_id=%s", targets, task_id)
    return ok
