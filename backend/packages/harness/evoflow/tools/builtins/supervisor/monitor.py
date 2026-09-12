"""Background monitor, recommendation engine, and auto-follow loop for supervisor.

Provides:
- _ensure_background_task_monitor — server-side asyncio monitor for detached runs
- _compute_monitor_recommendation — stalled / fail / finalize_main / continue_wait signals
- _monitor_main_task_until_terminal — backend poll loop used by start_execution auto-follow
- _broadcast_task_event — SSE event broadcast helper
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
from typing import Any

from evoflow.collab.id_format import make_formatted_id
from evoflow.timeutil import utc_now_iso_z

# Main-task storage terminal statuses (do not infer from subtasks alone).
MAIN_TASK_TERMINAL_STATUSES = frozenset({"completed", "failed", "cancelled"})

logger = logging.getLogger(__name__)

_bg_task_monitors: dict[str, asyncio.Task[Any]] = {}
_task_watch_state: dict[str, dict[str, Any]] = {}
_MONITOR_RESTART_COOLDOWN_UNTIL: dict[str, float] = {}
_MONITOR_RESTART_BACKOFF_SECONDS = 15.0
_MONITOR_MAX_RUNTIME_SECONDS = float(os.getenv("EVOFLOW_BG_MONITOR_MAX_SECONDS", "86400") or 86400)
_TASK_WATCH_NO_CHANGE_CAP = 10_000


def _cleanup_monitor_state_for_task(task_id: str, thread_id: str | None = None) -> None:
    key = str(task_id or "").strip()
    if key:
        _task_watch_state.pop(key, None)
        _DECISION_EMIT_GUARD.pop(key, None)
        _MONITOR_RESTART_COOLDOWN_UNTIL.pop(key, None)
    tid = str(thread_id or "").strip()
    if tid:
        _LEAD_FOLLOW_GUARD.pop(tid, None)


def _all_sub_rows_strictly_completed(sub_rows: list[dict[str, Any]]) -> bool:
    if not sub_rows:
        return False
    for r in sub_rows:
        st = str(r.get("status") or "").strip().lower()
        if st != "completed":
            return False
    return True


_RUNNING_SUBTASK_STATUSES = {"executing", "running", "in_progress"}
_DECISION_EMIT_GUARD: dict[str, dict[str, Any]] = {}
_LEAD_FOLLOW_GUARD: dict[str, dict[str, Any]] = {}

# LangGraph base URL (direct). Monitor runs inside the harness process.
_LANGGRAPH_BASE_URL = (os.getenv("EVOFLOW_LANGGRAPH_URL", "http://127.0.0.1:8070/api/langgraph") or "").rstrip("/")

# Align with EvoPanel "Hosted Agent" prompt style (frontend: useHostedAgent.ts).
# Keep it short and action-focused: it should drive the lead agent to keep orchestrating.
_HOSTED_FOLLOW_SYSTEM_PROMPT = (
    "你处于【目标调度】模式：你的职责是让协作任务持续推进直到终态或必须等待用户。\n"
    "规则：\n"
    "1) 每一轮必须做出明确调度动作：优先调用 supervisor（监控/重试/重分配/补子任务/修正状态）。\n"
    "2) 不要重复同一句话；若无可执行动作，必须解释阻塞点并选择：继续等待/降低并发/改派/拆分。\n"
    "3) 若任务已完成/无法继续/需要用户输入，明确输出结论并停止自动推进。\n"
)

_HOSTED_AUTOFOLLOW_MESSAGE_NAME = "hosted_autofollow"
_HOSTED_HEARTBEAT_SECONDS = float(os.getenv("EVOFLOW_HOSTED_HEARTBEAT_SECONDS", "30") or 30)

_ACTIVE_SUBTASK_STATUSES = frozenset(
    {"pending", "planned", "waiting_dispatch", "executing", "running", "in_progress"}
)


def _has_dispatchable_subtasks(sub_rows: list[dict[str, Any]]) -> bool:
    for row in sub_rows:
        st = str(row.get("status") or "").strip().lower()
        if st in _ACTIVE_SUBTASK_STATUSES:
            return True
    return False


def _collect_timed_out_subtasks_to_requeue(
    row: tuple[Any, dict[str, Any]],
    *,
    max_retries_per_subtask: int,
    retry_reason: str,
) -> tuple[Any, dict[str, Any], list[str]]:
    return _collect_auto_retriable_subtasks_to_requeue(
        row,
        max_retries_per_subtask=max_retries_per_subtask,
        retry_reason=retry_reason,
    )


def _collect_auto_retriable_subtasks_to_requeue(
    row: tuple[Any, dict[str, Any]],
    *,
    max_retries_per_subtask: int,
    retry_reason: str,
) -> tuple[Any, dict[str, Any], list[str]]:
    from evoflow.subagents.runtime_guard import is_subtask_background_executor_active

    project, task = row
    subs = [x for x in (task.get("subtasks") or []) if isinstance(x, dict)]
    now = utc_now_iso_z()
    retried: list[str] = []

    for st in subs:
        sid = str(st.get("id") or "").strip()
        if not sid:
            continue
        prior_status = str(st.get("status") or "").strip().lower()
        if prior_status not in {"timed_out", "failed", "error"}:
            continue
        if is_subtask_background_executor_active(st):
            continue
        retry_count = int(st.get("auto_retry_count") or 0)
        if retry_count >= max(0, int(max_retries_per_subtask)):
            continue
        st["status"] = "pending"
        st["progress"] = 0
        st["updated_at"] = now
        st["auto_retry_count"] = retry_count + 1
        st["last_auto_retry_at"] = now
        st["last_auto_retry_reason"] = retry_reason
        st["last_auto_retry_from_status"] = prior_status
        for key in ("completed_at", "failed_at", "error", "error_text", "result"):
            st.pop(key, None)
        retried.append(sid)
    return project, task, retried


def _trace_subtask_requeue_after_timeout(
    task: dict[str, Any],
    main_task_id: str,
    retried: list[str],
    *,
    source: str,
) -> None:
    try:
        from evoflow.debug.task_lifecycle_trace import write_task_lifecycle_trace

        _tid = str(task.get("thread_id") or "").strip() or None
        for _sid in retried:
            write_task_lifecycle_trace(
                thread_id=_tid,
                event="subtask_requeued_after_timeout",
                main_task_id=main_task_id,
                subtask_id=_sid,
                status="pending",
                detail={"source": source, "prior_status": "timed_out"},
            )
    except Exception:
        pass


def _rollup_after_requeue(storage: Any, main_task_id: str) -> None:
    try:
        from evoflow.collab.storage import rollup_root_task_progress_from_subtasks

        rollup_root_task_progress_from_subtasks(storage, main_task_id)
    except Exception:
        logger.debug("requeue timed_out: rollup failed task_id=%s", main_task_id, exc_info=True)


async def _requeue_and_redispatch_timed_out_subtasks_once(
    storage: Any,
    main_task_id: str,
    *,
    runtime: Any | None = None,
    max_retries_per_subtask: int | None = None,
    retry_reason: str = "monitor_detected_timeout",
    trace_source: str = "monitor",
) -> dict[str, Any]:
    """Requeue timed_out/failed subtasks and immediately delegate the next runnable wave."""
    from evoflow.collab.storage import find_main_task
    from evoflow.tools.builtins.supervisor.dependency import (
        normalize_subtask_depends_on_refs,
        skip_subtasks_blocked_by_exhausted_upstream_failure,
        subtask_auto_retry_max,
    )
    from evoflow.tools.builtins.supervisor.dependency import _resolve_subtasks_for_start_execution
    from evoflow.tools.builtins.supervisor.execution import (
        _resolve_collab_followup_runtime,
        delegate_collab_subtasks_for_start_execution,
    )

    key = str(main_task_id or "").strip()
    if not key:
        return {"retriedSubtaskIds": [], "delegatedSubtaskIds": []}
    retry_limit = subtask_auto_retry_max() if max_retries_per_subtask is None else max(0, int(max_retries_per_subtask))
    normalize_subtask_depends_on_refs(storage, key)
    skip_subtasks_blocked_by_exhausted_upstream_failure(storage, key, max_auto_retries=retry_limit)
    row = find_main_task(storage, key)
    if not row:
        return {"retriedSubtaskIds": [], "delegatedSubtaskIds": []}
    project, task, retried = _collect_auto_retriable_subtasks_to_requeue(
        row,
        max_retries_per_subtask=retry_limit,
        retry_reason=retry_reason,
    )
    if not retried:
        return {"retriedSubtaskIds": [], "delegatedSubtaskIds": []}
    task["updated_at"] = utc_now_iso_z()
    storage.save_project(project)
    _trace_subtask_requeue_after_timeout(task, key, retried, source=trace_source)
    _rollup_after_requeue(storage, key)

    delegated_ids: list[str] = []
    try:
        resolved_runtime = _resolve_collab_followup_runtime(runtime, key)
        to_run, _blocked = _resolve_subtasks_for_start_execution(storage, key, None)
        if to_run:
            delegated = await delegate_collab_subtasks_for_start_execution(
                resolved_runtime,
                storage,
                key,
                to_run,
                wait_for_completion=False,
            )
            delegated_ids = [
                str(d.get("subtaskId") or "")
                for d in delegated
                if bool(d.get("ok")) and str(d.get("subtaskId") or "").strip()
            ]
    except Exception:
        logger.debug(
            "requeue_and_redispatch timed_out: delegation failed task_id=%s",
            key,
            exc_info=True,
        )

    return {"retriedSubtaskIds": retried, "delegatedSubtaskIds": delegated_ids}


async def _has_active_langgraph_run(thread_id: str) -> bool:
    """Best-effort: check if the given thread currently has a pending/running run."""
    tid = str(thread_id or "").strip()
    if not tid or not _LANGGRAPH_BASE_URL:
        return False
    try:
        import httpx

        url = f"{_LANGGRAPH_BASE_URL}/threads/{tid}/runs?limit=10"
        timeout = httpx.Timeout(connect=2.5, read=3.0, write=3.0, pool=3.0)
        async with httpx.AsyncClient(timeout=timeout) as client:
            resp = await client.get(url)
            if resp.status_code != 200:
                return False
            data: Any = resp.json()
            items: Any = data
            if isinstance(data, dict):
                items = data.get("items") if isinstance(data.get("items"), list) else data.get("runs")
            if not isinstance(items, list):
                return False
            for r in items:
                if not isinstance(r, dict):
                    continue
                st = str(r.get("status") or "").strip().lower()
                if st in {"pending", "running"}:
                    return True
        return False
    except Exception:
        return False


async def _trigger_lead_follow_run(
    *,
    thread_id: str,
    main_task_id: str,
    recommendation: dict[str, Any],
    throttle_seconds: float = 8.0,
) -> bool:
    """Trigger a follow-up lead-agent run for the same thread (event-driven orchestration).

    This matches the product philosophy: during a task lifecycle, the lead agent keeps deciding
    without requiring user input, except when waiting_user/terminal/exception.
    """
    tid = str(thread_id or "").strip()
    mtid = str(main_task_id or "").strip()
    if not tid or not mtid or not _LANGGRAPH_BASE_URL:
        return False
    # Defensive guard: do not trigger new Lead Agent runs for cancelled tasks.
    try:
        from evoflow.cancellation import is_task_cancelled

        if is_task_cancelled(mtid):
            logger.info("lead follow run skipped: task cancelled task_id=%s", mtid)
            return False
    except Exception:
        pass
    from evoflow.collab.thread_ids import is_langgraph_lead_thread_id

    if not is_langgraph_lead_thread_id(tid):
        logger.warning("lead follow run rejected invalid thread_id=%r task=%s", tid, mtid)
        return False
    action = str(recommendation.get("action") or "").strip()
    if action not in {"retry_or_reassign", "check_stalled", "heartbeat"}:
        return False

    now = float(__import__("time").time())
    sig = json.dumps(
        {
            "task": mtid,
            "a": action,
            "failed": recommendation.get("failedSubtaskIds") or [],
            "stalled": bool(recommendation.get("stalled")),
        },
        ensure_ascii=False,
    )
    gs = _LEAD_FOLLOW_GUARD.get(tid) or {}
    last_sig = str(gs.get("sig") or "")
    last_ts = float(gs.get("ts") or 0.0)
    if sig == last_sig and (now - last_ts) < float(throttle_seconds or 0.0):
        return False

    # Avoid spawning multiple concurrent lead runs for the same thread.
    if await _has_active_langgraph_run(tid):
        return False

    # Send a synthetic "user" message that asks the lead agent to take orchestration actions.
    # CollabPhaseMiddleware will refresh executing snapshot from disk (thread_id in context).
    msg = (
        "【系统自动调度】检测到任务需要主智能体决策。\n"
        f"- 主任务: {mtid}\n"
        f"- 建议动作: {action}\n"
        f"- 原因: {str(recommendation.get('reason') or '').strip()}\n"
        f"- 失败/超时子任务: {', '.join([str(x) for x in (recommendation.get('failedSubtaskIds') or [])])}\n"
        "请你基于最新状态，使用 supervisor 做出下一步调度（重试/重分配/补充子任务/修正状态），"
        "并在必要时继续监控直到进入终态或等待用户输入。"
    )
    payload = {
        "input": {
            "messages": [
                {"role": "system", "content": _HOSTED_FOLLOW_SYSTEM_PROMPT},
                {"role": "user", "content": msg, "name": _HOSTED_AUTOFOLLOW_MESSAGE_NAME},
            ]
        },
        "config": {"configurable": {"thread_id": tid, "prompt_source": "hosted_autofollow"}},
        "stream_mode": "messages-tuple",
        "multitask_strategy": "enqueue",
    }
    try:
        import httpx

        url = f"{_LANGGRAPH_BASE_URL}/threads/{tid}/runs"
        timeout = httpx.Timeout(connect=4.0, read=20.0, write=10.0, pool=10.0)
        headers: dict[str, str] = {}
        api_key = (os.getenv("EVOFLOW_LANGGRAPH_API_KEY") or os.getenv("LANGGRAPH_API_KEY") or "").strip()
        if api_key:
            headers["Authorization"] = f"Bearer {api_key}"
        max_attempts = 3
        for attempt in range(max_attempts):
            async with httpx.AsyncClient(timeout=timeout) as client:
                resp = await client.post(url, json=payload, headers=headers or None)
            ok = resp.status_code in {200, 201, 202}
            if ok:
                _LEAD_FOLLOW_GUARD[tid] = {"sig": sig, "ts": now}
                return True
            if resp.status_code in {409, 423} and attempt + 1 < max_attempts:
                await asyncio.sleep(min(8.0, 2.0 * (attempt + 1)))
                continue
            logger.warning(
                "lead follow run HTTP failed thread=%s task=%s status=%s attempt=%s",
                tid,
                mtid,
                resp.status_code,
                attempt + 1,
            )
            return False
    except Exception:
        logger.warning("lead follow run trigger failed thread=%s task=%s", tid, mtid, exc_info=True)
        return False


async def _maybe_emit_decision_required(
    storage: Any,
    main_task_id: str,
    *,
    recommendation: dict[str, Any],
    memory_payload: dict[str, Any] | None,
    throttle_seconds: float = 12.0,
) -> bool:
    """When backend detects a condition requiring lead-agent decision, persist + broadcast an event.

    This is the bridge that answers: "主模型都在干嘛？" — it gets invoked only when we have a concrete
    orchestration reason (failed/timed_out/stalled), not on every poll tick.
    """
    try:
        action = str(recommendation.get("action") or "").strip()
        if action not in {"retry_or_reassign", "check_stalled"}:
            return False
        tid = str(main_task_id or "").strip()
        if not tid:
            return False
        now = float(__import__("time").time())
        sig = json.dumps(
            {
                "a": action,
                "failed": recommendation.get("failedSubtaskIds") or [],
                "stalled": bool(recommendation.get("stalled")),
            },
            ensure_ascii=False,
        )
        gs = _DECISION_EMIT_GUARD.get(tid) or {}
        last_sig = str(gs.get("sig") or "")
        last_ts = float(gs.get("ts") or 0.0)
        if sig == last_sig and (now - last_ts) < float(throttle_seconds or 0.0):
            return False
        _DECISION_EMIT_GUARD[tid] = {"sig": sig, "ts": now}

        # Persist to main-task memory (best-effort).
        try:
            from evoflow.collab.storage import get_task_detail_storage, load_task_detail_for_task_id

            mem_store = get_task_detail_storage()
            mrow = load_task_detail_for_task_id(storage, mem_store, tid)
            if mrow is not None:
                mem, _pid, _aid, _parent = mrow
                mem["decision_required"] = True
                mem["decision"] = {
                    "action": action,
                    "reason": recommendation.get("reason") or "",
                    "failedSubtaskIds": recommendation.get("failedSubtaskIds") or [],
                    "stalled": bool(recommendation.get("stalled")),
                    "stagnantSeconds": int(recommendation.get("stagnantSeconds") or 0),
                    "noChangeCount": int(recommendation.get("noChangeCount") or 0),
                }
                if isinstance(memory_payload, dict) and memory_payload.get("current_step"):
                    mem["decision"]["currentStep"] = str(memory_payload.get("current_step") or "")[:400]
                mem_store.save_task_memory(mem)
        except Exception:
            logger.debug("decision_required: persist task memory failed", exc_info=True)

        # Broadcast event so UI (and optionally a lead-runner) can react.
        try:
            from evoflow.tools.builtins.supervisor.memory import _broadcast_task_event

            payload = {
                "task_id": tid,
                "recommendation": recommendation,
            }
            await _broadcast_task_event(tid, "task:decision_required", payload)
        except Exception:
            logger.warning("decision_required: broadcast failed task_id=%s", tid, exc_info=True)

        return True
    except Exception:
        logger.debug("decision_required: compute guard failed", exc_info=True)
        return False


def _expire_stale_running_subtasks(
    storage: Any,
    main_task_id: str,
    *,
    now_ts: float | None = None,
    lease_grace_seconds: float = 0.0,
) -> list[str]:
    """Expire running subtasks whose heartbeat lease is past due.

    This is a backend-only watchdog. It does NOT rely on the lead agent calling monitor tools.

    Contract:
    - Subtask rows may carry:
      - ``lease_until_ts``: unix seconds. If now > lease_until_ts (+ optional grace), the subtask is considered stale.
      - ``last_heartbeat_ts``: unix seconds, informational only.
    - If a subtask is in a running status and lease is expired, mark it ``timed_out`` and attach an ``error`` string.
    - Returns list of expired subtask ids (best-effort).
    """
    from evoflow.collab.storage import (
        find_main_task,
        patch_collab_subtask_in_project_storage,
        rollup_root_task_progress_from_subtasks,
    )

    key = str(main_task_id or "").strip()
    if not key:
        return []
    now = float(now_ts if now_ts is not None else __import__("time").time())
    try:
        row = find_main_task(storage, key)
        if not row:
            return []
        _proj, task = row
        subtasks = [st for st in (task.get("subtasks") or []) if isinstance(st, dict)]
        expired: list[str] = []
        for st in subtasks:
            sid = str(st.get("id") or "").strip()
            if not sid:
                continue
            status = str(st.get("status") or "").strip().lower()
            if status not in _RUNNING_SUBTASK_STATUSES:
                continue
            try:
                lease_until = float(st.get("lease_until_ts") or 0.0)
            except (TypeError, ValueError):
                lease_until = 0.0
            if lease_until <= 0:
                continue
            if now <= (lease_until + float(lease_grace_seconds or 0.0)):
                continue
            from evoflow.subagents.runtime_guard import is_subtask_background_executor_active

            if is_subtask_background_executor_active(st):
                logger.debug(
                    "background monitor: skip lease expiry sub=%s bg=%s (executor still active)",
                    sid,
                    st.get("background_task_id"),
                )
                continue
            # Mark timed out (idempotent-ish): if already terminal, patch helper will merge anyway.
            ok = patch_collab_subtask_in_project_storage(
                storage,
                key,
                sid,
                {
                    "status": "timed_out",
                    "progress": 0,
                    "error": "Subtask heartbeat lease expired (watchdog).",
                },
            )
            if ok:
                expired.append(sid)
            else:
                logger.warning(
                    "background monitor: failed to mark subtask timed_out main=%s sub=%s (storage patch returned false)",
                    key,
                    sid,
                )
        if expired:
            rollup_root_task_progress_from_subtasks(storage, key)
        return expired
    except Exception:
        logger.debug("background monitor: expire stale subtasks failed main=%s", key, exc_info=True)
        return []


async def _save_conversation_and_update_task(storage: Any, task_id: str, thread_id: str) -> bool:
    """Bind lead thread to task and verify chat transcript is reachable."""
    if not thread_id:
        logger.debug("[_save_conversation_and_update_task] No thread_id provided, skipping")
        return False

    logger.info(f"[_save_conversation_and_update_task] Reconciling thread {thread_id} -> task {task_id}")
    try:
        from evoflow.collab.conversation_persist import reconcile_lead_conversation_from_chat

        added = reconcile_lead_conversation_from_chat(storage, task_id, thread_id)
        if added <= 0:
            logger.info(f"[_save_conversation_and_update_task] No new messages for thread {thread_id}")
            return False
        logger.info(f"[_save_conversation_and_update_task] Reconciled {added} messages to task {task_id}")
        return True
    except Exception as e:
        logger.warning(f"[_save_conversation_and_update_task] Error saving conversation: {e}")
        return False


def _ensure_background_task_monitor(
    storage: Any,
    main_task_id: str,
    runtime_thread_id: str | None,
    *,
    poll_seconds: float = 3.0,
) -> None:
    """Server-side monitor for detached runs: keep writing progress/memory/collab convergence.

    This guarantees long tasks are tracked by backend even if lead-agent run already ended.
    """
    from evoflow.collab.storage import find_main_task, get_task_detail_storage, load_task_detail_for_task_id
    from evoflow.collab.thread_collab import append_sidebar_supervisor_step
    from evoflow.config.paths import get_paths
    from evoflow.tools.builtins.supervisor.dependency import _auto_finalize_unrunnable_pending_subtasks
    from evoflow.tools.builtins.supervisor.memory import _broadcast_task_event

    key = str(main_task_id or "").strip()
    if not key:
        return
    now_mono = float(__import__("time").time())
    if now_mono < float(_MONITOR_RESTART_COOLDOWN_UNTIL.get(key) or 0.0):
        logger.debug("background monitor: restart cooldown active task_id=%s", key)
        return
    prev = _bg_task_monitors.get(key)
    if prev is not None and not prev.done():
        return

    async def _runner() -> None:
        from evoflow.observability.poll_loop_log import log_poll_loop_end, log_poll_loop_start, log_poll_tick

        paths = get_paths()
        last_sig = ""
        loop_started = float(__import__("time").time())
        log_poll_loop_start(
            "supervisor_bg_monitor",
            task_id=key,
            thread_id=(runtime_thread_id or "").strip() or None,
            poll_s=poll_seconds,
        )
        try:
            while True:
                # Check if task has been cancelled - stop monitor loop immediately.
                # This is the critical guard against the supervisor death loop: without it,
                # the monitor keeps polling and triggering _trigger_lead_follow_run even
                # after the user cancelled the task.
                try:
                    from evoflow.cancellation import is_task_cancelled

                    if is_task_cancelled(key):
                        logger.info("background monitor: task cancelled, stopping monitor task_id=%s", key)
                        _cleanup_monitor_state_for_task(key, (runtime_thread_id or "").strip() or None)
                        return
                except Exception:
                    pass
                if _MONITOR_MAX_RUNTIME_SECONDS > 0 and (float(__import__("time").time()) - loop_started) > _MONITOR_MAX_RUNTIME_SECONDS:
                    logger.warning("background monitor: max runtime exceeded task_id=%s", key)
                    return
                log_poll_tick("supervisor_bg_monitor", key=key, interval_s=30.0)
                try:
                    _auto_finalize_unrunnable_pending_subtasks(storage, key)
                except Exception:
                    logger.warning("background monitor: auto finalize pending failed task_id=%s", key, exc_info=True)
                # Watchdog: expire running subtasks with stale heartbeat lease.
                try:
                    expired_ids = _expire_stale_running_subtasks(storage, key, lease_grace_seconds=3.0)
                    if expired_ids:
                        try:
                            from evoflow.collab.sse_notify import broadcast_collab_task_event

                            for sid in expired_ids[:20]:
                                await broadcast_collab_task_event(
                                    key,
                                    "task:timed_out",
                                    {"task_id": sid, "error": "Subtask heartbeat lease expired (watchdog)."},
                                )
                        except Exception:
                            logger.debug("background monitor: broadcast timed_out failed", exc_info=True)
                except Exception:
                    logger.warning("background monitor: expire stale subtasks failed task_id=%s", key, exc_info=True)
                row = find_main_task(storage, key)
                if not row:
                    return
                project, task = row
                main_status = str(task.get("status") or "pending").strip().lower()
                main_progress = int(task.get("progress") or 0)
                subtasks = [st for st in (task.get("subtasks") or []) if isinstance(st, dict)]
                # Requeue timed_out/failed subtasks (auto-retry) and redispatch runnable wave.
                try:
                    retry_payload = await _requeue_and_redispatch_timed_out_subtasks_once(
                        storage,
                        key,
                        retry_reason="background_monitor_auto_retry",
                        trace_source="background_monitor",
                    )
                    retried_ids = retry_payload.get("retriedSubtaskIds") or []
                    if retried_ids:
                        logger.info(
                            "background monitor: requeued timed_out subtasks task_id=%s ids=%s delegated=%s",
                            key,
                            retried_ids[:20],
                            (retry_payload.get("delegatedSubtaskIds") or [])[:20],
                        )
                except Exception:
                    logger.warning("background monitor: requeue timed_out failed task_id=%s", key, exc_info=True)
                terminal_main = main_status in MAIN_TASK_TERMINAL_STATUSES

                mem_step = ""
                mem_summary = ""
                memory_payload: dict[str, Any] | None = None
                try:
                    mem_store = get_task_detail_storage()
                    mem_row = load_task_detail_for_task_id(storage, mem_store, key)
                    if mem_row is not None:
                        mem, _pid, _aid, _parent = mem_row
                        mem_step = str(mem.get("current_step") or "").strip()
                        mem_summary = str(mem.get("output_summary") or "").strip()
                        facts = mem.get("facts") or []
                        if not isinstance(facts, list):
                            facts = []
                        memory_payload = {
                            "status": mem.get("status", ""),
                            "progress": mem.get("progress", 0),
                            "current_step": mem_step,
                            "output_summary": mem_summary,
                            "factsCount": len(facts),
                        }
                except Exception:
                    logger.debug("background monitor: read task memory failed", exc_info=True)

                sig = json.dumps(
                    {
                        "s": main_status,
                        "p": main_progress,
                        "st": [(str(st.get("id") or ""), str(st.get("status") or "")) for st in subtasks],
                        "m": mem_step,
                    },
                    ensure_ascii=False,
                )
                if sig != last_sig:
                    last_sig = sig
                    tid = (runtime_thread_id or task.get("thread_id") or "").strip()
                    if tid:
                        try:
                            detail = f"Monitor: {main_status} · {main_progress}%"
                            if mem_step:
                                detail += f" · {mem_step[:120]}"
                            append_sidebar_supervisor_step(
                                paths,
                                tid,
                                {"id": make_formatted_id("Monitor"), "action": "monitor", "label": detail, "done": bool(terminal_main)},
                                max_steps=120,
                            )
                        except Exception:
                            logger.debug("background monitor: append supervisor step failed", exc_info=True)

                    try:
                        await _broadcast_task_event(
                            key,
                            "task:progress",
                            {
                                "task_id": key,
                                "status": main_status,
                                "progress": main_progress,
                                "current_step": mem_step,
                                "output_summary": mem_summary[:500],
                            },
                        )
                    except Exception:
                        logger.debug("background monitor: broadcast progress failed", exc_info=True)

                if terminal_main:
                    tid = (runtime_thread_id or task.get("thread_id") or "").strip()
                    outcome = "skipped"
                    if tid:
                        try:
                            from evoflow.collab.thread_collab import finalize_collab_phase_on_main_terminal
                            from evoflow.tools.builtins.supervisor.execution import unregister_collab_lead_runtime

                            outcome = finalize_collab_phase_on_main_terminal(paths, key, runtime_thread_id=tid)
                            unregister_collab_lead_runtime(key)
                        except Exception:
                            logger.warning("background monitor: finalize collab phase failed task_id=%s", key, exc_info=True)
                    _cleanup_monitor_state_for_task(key, tid)

                    if outcome == "reflecting":
                        logger.info(
                            "[monitor] Task %s terminal in verifying — advanced to reflecting; defer conversation save",
                            key,
                        )
                        return

                    # Save Lead Agent conversation when task reaches terminal state (completed/failed/cancelled)
                    try:
                        logger.info(f"[monitor] Task {key} reached terminal state '{main_status}', saving conversation")
                        await _save_conversation_and_update_task(storage, key, tid)
                    except Exception as conv_e:
                        logger.warning(f"[monitor] Failed to save conversation for task {key}: {conv_e}")

                    return

                # Decision-required signal (event-driven): tell UI/lead when failures/stalls need orchestration.
                try:
                    sub_rows = [
                        {
                            "subtaskId": str(st.get("id") or ""),
                            "status": str(st.get("status") or ""),
                            "error": str(st.get("error") or ""),
                        }
                        for st in subtasks
                        if isinstance(st, dict)
                    ]
                    rec = _compute_monitor_recommendation(
                        task_id=key,
                        status=main_status,
                        progress=int(main_progress or 0),
                        sub_rows=sub_rows,
                        memory_payload=memory_payload,
                    )
                    await _maybe_emit_decision_required(
                        storage,
                        key,
                        recommendation=rec,
                        memory_payload=memory_payload,
                    )
                    # Philosophy: lead agent keeps deciding during task lifecycle (no user input needed).
                    tid = (runtime_thread_id or task.get("thread_id") or "").strip()
                    if tid:
                        follow_ok = await _trigger_lead_follow_run(thread_id=tid, main_task_id=key, recommendation=rec)
                        if not follow_ok and rec.get("action") in {"retry_or_reassign", "check_stalled"}:
                            logger.warning(
                                "background monitor: lead follow run failed task_id=%s thread_id=%s action=%s",
                                key,
                                tid,
                                rec.get("action"),
                            )
                        # 2) Heartbeat follow only while subtasks still need orchestration.
                        if (
                            _HOSTED_HEARTBEAT_SECONDS
                            and _HOSTED_HEARTBEAT_SECONDS > 0
                            and _has_dispatchable_subtasks(sub_rows)
                        ):
                            hb_rec = {"action": "heartbeat", "reason": "hosted_heartbeat", "failedSubtaskIds": [], "stalled": False}
                            await _trigger_lead_follow_run(
                                thread_id=tid,
                                main_task_id=key,
                                recommendation=hb_rec,
                                throttle_seconds=max(12.0, float(_HOSTED_HEARTBEAT_SECONDS)),
                            )
                except Exception:
                    logger.warning("background monitor: decision_required compute failed task_id=%s", key, exc_info=True)

                await asyncio.sleep(max(0.5, float(poll_seconds)))
        except Exception:
            logger.warning("background monitor: loop crashed task_id=%s", key, exc_info=True)
            _MONITOR_RESTART_COOLDOWN_UNTIL[key] = float(__import__("time").time()) + _MONITOR_RESTART_BACKOFF_SECONDS
        finally:
            log_poll_loop_end("supervisor_bg_monitor", task_id=key)
            _cleanup_monitor_state_for_task(key, (runtime_thread_id or "").strip() or None)
            cur = _bg_task_monitors.get(key)
            if cur is not None and cur.done():
                _bg_task_monitors.pop(key, None)

    _bg_task_monitors[key] = asyncio.create_task(_runner(), name=f"supervisor-monitor-{key}")


def _compute_monitor_recommendation(
    *,
    task_id: str,
    status: str,
    progress: int,
    sub_rows: list[dict[str, Any]],
    memory_payload: dict[str, Any] | None,
) -> dict[str, Any]:
    """Return backend-side recommendation for lead-agent decision making.

    Signals:
    - continue_wait: still moving
    - retry_or_reassign: there are failed subtasks
    - finalize_main: all subtasks completed but main task not terminal yet (lead must close)
    - check_stalled: no progress/current_step change for a period
    """
    now = __import__("time").time()  # avoid top-level time import
    step = ""
    if isinstance(memory_payload, dict):
        step = str(memory_payload.get("current_step") or "").strip()

    failed_ids = [str(s.get("subtaskId") or "") for s in sub_rows if str(s.get("status") or "").strip().lower() in {"failed", "timed_out"}]
    signature = json.dumps({"p": int(progress or 0), "step": step}, ensure_ascii=False)
    ws = _task_watch_state.get(task_id) or {}
    last_sig = str(ws.get("signature") or "")
    last_change_ts = float(ws.get("last_change_ts") or now)
    no_change_count = int(ws.get("no_change_count") or 0)
    if signature != last_sig:
        last_change_ts = now
        no_change_count = 0
    else:
        no_change_count += 1
        if no_change_count > _TASK_WATCH_NO_CHANGE_CAP:
            no_change_count = _TASK_WATCH_NO_CHANGE_CAP
    _task_watch_state[task_id] = {
        "signature": signature,
        "last_change_ts": last_change_ts,
        "updated_ts": now,
        "no_change_count": no_change_count,
    }

    stagnant_seconds = max(0, int(now - last_change_ts))
    # Practical threshold: 90s without progress/current_step change means probably stalled.
    stalled = stagnant_seconds >= 90 and status not in MAIN_TASK_TERMINAL_STATUSES

    if failed_ids:
        return {
            "action": "retry_or_reassign",
            "reason": "Detected failed subtasks.",
            "failedSubtaskIds": failed_ids,
            "stalled": stalled,
            "stagnantSeconds": stagnant_seconds,
            "noChangeCount": no_change_count,
        }

    if str(status or "").strip().lower() not in MAIN_TASK_TERMINAL_STATUSES and _all_sub_rows_strictly_completed(sub_rows):
        try:
            from evoflow.collab.thread_collab import advance_collab_phase_to_verifying_for_task
            from evoflow.config.paths import get_paths

            advance_collab_phase_to_verifying_for_task(get_paths(), task_id)
        except Exception:
            logger.warning("monitor: advance to verifying failed task_id=%s", task_id, exc_info=True)
        return {
            "action": "finalize_main",
            "reason": "All subtasks are completed but the main task is still non-terminal: run Plan validation, then set_task_state/update_progress on the main task (progress=100, status=completed).",
            "failedSubtaskIds": [],
            "stalled": stalled,
            "stagnantSeconds": stagnant_seconds,
            "noChangeCount": no_change_count,
        }

    if stalled:
        return {
            "action": "check_stalled",
            "reason": "No progress/current_step update for a while. Consider steer_subtask to unblock the worker.",
            "failedSubtaskIds": [],
            "stalled": True,
            "stagnantSeconds": stagnant_seconds,
            "noChangeCount": no_change_count,
            "suggestedPollSeconds": 15,
            "suggestedAction": "steer_subtask",
        }
    # Adaptive poll interval: lengthen when progressing, shorten when stagnant
    if no_change_count <= 1:
        suggested_poll = 60
    elif no_change_count <= 3:
        suggested_poll = 30
    else:
        suggested_poll = 15
    return {
        "action": "continue_wait",
        "reason": "Task is progressing or waiting normally.",
        "failedSubtaskIds": [],
        "stalled": False,
        "stagnantSeconds": stagnant_seconds,
        "noChangeCount": no_change_count,
        "suggestedPollSeconds": suggested_poll,
    }


async def _monitor_main_task_until_terminal(
    storage: Any,
    task_id: str,
    *,
    poll_seconds: float,
    timeout_seconds: int | None,
    timeline_step_seconds: int = 5,
    slice_seconds: int | None = None,
) -> dict[str, Any]:
    """Backend-side monitor loop used by start_execution auto-follow mode."""
    from evoflow.collab.storage import find_main_task, get_task_detail_storage, load_task_detail_for_task_id
    from evoflow.tools.builtins.supervisor.dependency import _auto_finalize_unrunnable_pending_subtasks
    from evoflow.tools.builtins.supervisor.display import _build_monitor_subtask_rows

    start_ts = asyncio.get_event_loop().time()
    last_timeline_emit_ts = start_ts
    timeline: list[dict[str, Any]] = []

    while True:
        try:
            _auto_finalize_unrunnable_pending_subtasks(storage, task_id)
        except Exception:
            logger.debug("auto-follow monitor: auto finalize pending failed task_id=%s", task_id, exc_info=True)
        row = find_main_task(storage, task_id)
        if not row:
            return {
                "success": False,
                "error": f"Task '{task_id}' not found while monitoring",
                "timeline": timeline,
            }
        _proj, task = row
        t_status = str(task.get("status") or "pending").strip().lower()
        t_progress = int(task.get("progress") or 0)
        subtasks = [st for st in (task.get("subtasks") or []) if isinstance(st, dict)]
        sub_rows, failed_subtasks = _build_monitor_subtask_rows(storage, subtasks, main_task=task)

        memory_payload: dict[str, Any] | None = None
        try:
            mem_store = get_task_detail_storage()
            mem_row = load_task_detail_for_task_id(storage, mem_store, task_id)
            if mem_row is not None:
                mem, _pid, _aid, _parent = mem_row
                facts = mem.get("facts") or []
                if not isinstance(facts, list):
                    facts = []
                memory_payload = {
                    "status": mem.get("status", ""),
                    "progress": mem.get("progress", 0),
                    "current_step": mem.get("current_step", ""),
                    "output_summary": mem.get("output_summary", ""),
                    "factsCount": len(facts),
                    "facts": facts[:5],
                }
        except Exception:
            logger.debug("auto-follow monitor: memory snapshot failed", exc_info=True)

        rec = _compute_monitor_recommendation(
            task_id=task_id,
            status=t_status,
            progress=t_progress,
            sub_rows=sub_rows,
            memory_payload=memory_payload,
        )

        now = asyncio.get_event_loop().time()
        if now - last_timeline_emit_ts >= float(max(1, timeline_step_seconds)):
            last_timeline_emit_ts = now
            snap = {
                "status": t_status,
                "progress": t_progress,
                "failedSubtasks": failed_subtasks[:5],
                "memory": memory_payload,
                "recommendation": rec,
                "elapsedSeconds": int(now - start_ts),
            }
            timeline.append(snap)
            if len(timeline) > 30:
                timeline = timeline[-30:]

        # Exit only when the **main** task is terminal; all subtasks done alone is not terminal here —
        # the lead must close or extend the main task explicitly.
        if t_status in MAIN_TASK_TERMINAL_STATUSES:
            return {
                "success": True,
                "terminal": True,
                "status": t_status,
                "progress": t_progress,
                "subtasks": sub_rows,
                "failedSubtasks": failed_subtasks,
                "memory": memory_payload,
                "recommendation": rec,
                "timeline": timeline,
            }

        if slice_seconds is not None and (now - start_ts) >= float(max(1, int(slice_seconds))):
            return {
                "success": True,
                "terminal": False,
                "status": t_status,
                "progress": t_progress,
                "subtasks": sub_rows,
                "failedSubtasks": failed_subtasks,
                "memory": memory_payload,
                "recommendation": rec,
                "timeline": timeline,
                "elapsedSeconds": int(now - start_ts),
            }

        if timeout_seconds is not None and (now - start_ts) > float(timeout_seconds):
            return {
                "success": False,
                "terminal": False,
                "status": t_status,
                "progress": t_progress,
                "error": f"auto-follow monitor timeout after {timeout_seconds}s",
                "subtasks": sub_rows,
                "failedSubtasks": failed_subtasks,
                "memory": memory_payload,
                "recommendation": rec,
                "timeline": timeline,
            }

        await asyncio.sleep(max(0.5, float(poll_seconds)))


__all__ = [
    "_ensure_background_task_monitor",
    "_expire_stale_running_subtasks",
    "_compute_monitor_recommendation",
    "_monitor_main_task_until_terminal",
    "_bg_task_monitors",
    "_task_watch_state",
]
