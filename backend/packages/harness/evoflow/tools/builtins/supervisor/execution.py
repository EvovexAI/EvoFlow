"""Execution delegation and auto-followup for supervisor subtasks.

Provides:
- delegate_collab_subtasks_for_start_execution — parallel subagent invocation via collab_bridge
- auto_delegate_collab_followup_wave — automatic wave-2+ delegation when upstream completes
"""

from __future__ import annotations

import asyncio
import logging
import os
import weakref
from typing import Any

from langchain.tools import ToolRuntime
from langgraph.config import get_stream_writer
from langgraph.typing import ContextT

from evoflow.claude_subagent_type import effective_subagent_type, is_claude_code_subagent_type
from evoflow.collab.id_format import make_formatted_id
from evoflow.timeutil import utc_now_iso_z

logger = logging.getLogger(__name__)

# Per main-task lock: concurrent subtask completions must not double-start follow-up waves.
_followup_wave_locks: dict[str, asyncio.Lock] = {}
# Lead ToolRuntime from start_execution — used when follow-up fires from a worker subthread.
_collab_lead_runtime_by_task: dict[str, weakref.ReferenceType[ToolRuntime[ContextT, dict]]] = {}
# Strong refs: weakref alone is often collected before wave-2 follow-up runs.
_collab_lead_runtime_strong: dict[str, ToolRuntime[ContextT, dict]] = {}
_CLAIMABLE_SUBTASK_STATUSES = frozenset({"pending", "planned", "waiting_dispatch"})


def _runtime_is_subtask_worker(runtime: ToolRuntime[ContextT, dict] | None) -> bool:
    from evoflow.collab.thread_ids import is_collab_executor_thread
    from evoflow.tools.builtins.supervisor.utils import _runtime_thread_id

    tid = _runtime_thread_id(runtime)
    return is_collab_executor_thread(tid)


def _pin_collab_session_model_on_main_task(
    main_task_id: str,
    runtime: ToolRuntime[ContextT, dict] | None,
) -> None:
    """Persist lead session model on the collab main task for wave-2+ delegation."""
    mid = str(main_task_id or "").strip()
    if not mid or runtime is None or _runtime_is_subtask_worker(runtime):
        return
    try:
        from evoflow.agents.lead_agent.runtime_context import (
            resolve_session_model_name_from_runtime,
            runtime_context_mapping,
        )
        from evoflow.collab.storage import get_project_storage, patch_collab_main_task_in_project_storage
        from evoflow.tools.builtins.supervisor.utils import _runtime_thread_id

        ctx = runtime_context_mapping(runtime)
        lead_tid = _runtime_thread_id(runtime)
        model = resolve_session_model_name_from_runtime(
            runtime,
            lead_thread_id=lead_tid,
            session_key=str(ctx.get("session_key") or "").strip() or None,
        )
        if not model:
            return
        patch: dict[str, Any] = {"session_model_name": model}
        if lead_tid:
            patch["thread_id"] = lead_tid
        patch_collab_main_task_in_project_storage(get_project_storage(), mid, patch)
        logger.info("collab pinned session_model_name=%r on main_task=%s", model, mid)
    except Exception:
        logger.debug("pin collab session_model_name failed main=%s", mid, exc_info=True)


def _register_collab_lead_runtime(main_task_id: str, runtime: ToolRuntime[ContextT, dict] | None) -> None:
    tid = str(main_task_id or "").strip()
    if not tid or runtime is None:
        return
    if _runtime_is_subtask_worker(runtime):
        logger.debug("skip collab lead runtime pin for task %s (subtask worker runtime)", tid)
        return
    from evoflow.collab.unified_stream import attach_gateway_writer_to_runtime

    _collab_lead_runtime_strong[tid] = runtime
    attach_gateway_writer_to_runtime(runtime, tid)
    _pin_collab_session_model_on_main_task(tid, runtime)
    try:
        _collab_lead_runtime_by_task[tid] = weakref.ref(
            runtime,
            lambda _r, task_id=tid: _collab_lead_runtime_strong.pop(task_id, None),
        )
    except TypeError:
        # Gateway/minimal runtimes must not abort delegation (follow-up may lack lead runtime).
        logger.debug("collab lead runtime not weakref-able for task %s type=%s", tid, type(runtime).__name__)


def unregister_collab_lead_runtime(main_task_id: str) -> None:
    """Drop strong/weak refs to lead runtime when a task reaches terminal."""
    tid = str(main_task_id or "").strip()
    if not tid:
        return
    _collab_lead_runtime_strong.pop(tid, None)
    _collab_lead_runtime_by_task.pop(tid, None)


def _resolve_collab_followup_runtime(
    runtime: ToolRuntime[ContextT, dict] | None,
    main_task_id: str,
) -> ToolRuntime[ContextT, dict] | None:
    from evoflow.collab.dag_trace import dag_info

    tid = str(main_task_id or "").strip()
    strong = _collab_lead_runtime_strong.get(tid)
    if strong is not None:
        dag_info("followup_runtime main=%s source=strong_ref type=%s", tid, type(strong).__name__)
        return strong
    if runtime is not None and not _runtime_is_subtask_worker(runtime):
        dag_info("followup_runtime main=%s source=caller_lead_runtime type=%s", tid, type(runtime).__name__)
        return runtime
    ref = _collab_lead_runtime_by_task.get(tid)
    if ref is not None:
        resolved = ref()
        if resolved is not None:
            dag_info("followup_runtime main=%s source=weakref_alive type=%s", tid, type(resolved).__name__)
            return resolved
        dag_info("followup_runtime main=%s source=weakref_dead", tid)
    if runtime is not None:
        dag_info("followup_runtime main=%s source=caller_worker_runtime type=%s", tid, type(runtime).__name__)
        return runtime
    dag_info("followup_runtime main=%s source=none (no caller runtime, no stored lead runtime)", tid)
    return None

# Register followup handler at import time so task_tool can call us via bridge.
# This is done lazily below (after function definitions) to avoid forward-ref issues.


def _is_claude_session_worker(subagent_type: str) -> bool:
    """True for Claude Code worker (``claude-code`` or legacy ``claude-session`` / ``claude``)."""
    return is_claude_code_subagent_type(subagent_type)


def _followup_lock_for_task(main_task_id: str) -> asyncio.Lock:
    tid = str(main_task_id or "").strip()
    lock = _followup_wave_locks.get(tid)
    if lock is None:
        lock = asyncio.Lock()
        _followup_wave_locks[tid] = lock
    return lock


def _claim_subtasks_for_delegation(
    storage: Any,
    main_task_id: str,
    subtask_ids: list[str],
) -> list[str]:
    """Atomically mark pending subtasks as in-flight before parallel delegate (TOCTOU guard)."""
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
                dag_info("claim_skip main=%s sub=%s reason=background_active bg=%s", main_task_id, sid, st.get("background_task_id"))
                continue
            if status not in _CLAIMABLE_SUBTASK_STATUSES:
                skipped.append({"subtaskId": sid, "status": status, "reason": "not_claimable"})
                continue
            st["status"] = "executing"
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


def _revert_claimed_subtasks_to_pending(
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


def _is_acp_worker(subagent_type: str) -> bool:
    n = str(subagent_type or "").strip().lower().replace("_", "-")
    try:
        from evoflow.config.acp_config import get_acp_agents

        agents = get_acp_agents()
        return n in {str(k).strip().lower().replace("_", "-") for k in agents.keys()}
    except Exception:
        return False


def _persist_subtask_session_id(storage: Any, main_task_id: str, subtask_id: str, session_id: str) -> None:
    """Persist claude_session id onto subtask row for future reuse."""
    from evoflow.collab.storage import find_main_task

    row = find_main_task(storage, main_task_id)
    if not row:
        return
    project, task = row
    touched = False
    for st in task.get("subtasks") or []:
        if not isinstance(st, dict):
            continue
        if str(st.get("id") or "").strip() != subtask_id:
            continue
        st["claude_session_id"] = session_id
        st["external_session_id"] = session_id
        wp = st.get("worker_profile")
        if isinstance(wp, dict):
            st["worker_profile"] = {**wp, "claude_session_id": session_id}
        touched = True
        break
    if touched:
        try:
            storage.save_project(project)
        except Exception:
            logger.debug("persist subtask claude_session_id failed", exc_info=True)


def _worker_delegation_error(subagent_type: str) -> str | None:
    """Return a user-visible error when the worker cannot run; None if delegation may proceed."""
    stype = str(subagent_type or "").strip()
    if not stype:
        return "No worker assigned to subtask (set assigned_to or worker_profile.base_subagent)."
    if _is_claude_session_worker(stype) or _is_acp_worker(stype):
        return None
    from evoflow.subagents import get_available_subagent_names, get_subagent_config

    if get_subagent_config(stype) is not None:
        return None
    available = ", ".join(get_available_subagent_names()[:24])
    return f"Unknown or misconfigured worker '{stype}' (custom agents need a non-empty system_prompt in agents/{{code}}/config.yaml). Available: {available}"


async def _mark_subtask_delegate_failed(
    storage: Any,
    main_task_id: str,
    subtask_id: str,
    error: str,
) -> None:
    """Persist failed status and notify UI so detached runs do not appear stuck."""
    from evoflow.collab.storage import patch_collab_subtask_in_project_storage, rollup_root_task_progress_from_subtasks

    err = str(error or "delegation failed").strip()[:4000]
    now = utc_now_iso_z()
    try:
        patch_collab_subtask_in_project_storage(
            storage,
            main_task_id,
            subtask_id,
            {
                "status": "failed",
                "error": err,
                "failed_at": now,
                "updated_at": now,
            },
        )
        rollup_root_task_progress_from_subtasks(storage, main_task_id)
    except Exception:
        logger.exception(
            "mark subtask failed after delegate error main=%s sub=%s",
            main_task_id,
            subtask_id,
        )
        return
    try:
        from evoflow.collab.sse_notify import broadcast_collab_task_event

        await broadcast_collab_task_event(
            main_task_id,
            "task:failed",
            {"task_id": subtask_id, "error": err},
        )
    except Exception:
        logger.debug("broadcast task:failed after delegate error failed", exc_info=True)


def _runtime_thread_id(runtime: ToolRuntime[ContextT, dict] | None) -> str | None:
    if runtime is None:
        return None
    try:
        cfg = getattr(runtime, "config", None) or {}
        if isinstance(cfg, dict):
            configurable = cfg.get("configurable") or {}
            tid = str(configurable.get("thread_id") or "").strip()
            return tid or None
    except Exception:
        return None
    return None


async def _delegate_via_acp_tool(
    *,
    storage: Any,
    runtime: ToolRuntime[ContextT, dict] | None,
    main_task_id: str,
    subtask_id: str,
    subtask_row: dict[str, Any],
    prompt: str,
    provider: str,
    default_project_path: str | None = None,
    wait_for_completion: bool = True,
) -> dict[str, Any]:
    """Run a subtask via invoke_acp_agent tool with reusable ACP session."""
    from evoflow.collab.storage import find_main_task
    from evoflow.config.acp_config import get_acp_agents
    from evoflow.tools.builtins.invoke_acp_agent_tool import build_invoke_acp_agent_tool
    from evoflow.tools.builtins.supervisor.acp_session_registry import find_reusable_for_task

    writer = None
    try:
        writer = get_stream_writer()
    except Exception:
        writer = None
    if writer is not None:
        try:
            writer(
                {
                    "type": "task_started",
                    "task_id": subtask_id,
                    "collab_subtask_id": subtask_id,
                    "description": str(subtask_row.get("name") or subtask_id),
                    "subagent_type": provider,
                }
            )
        except Exception:
            logger.debug("emit task_started for acp provider failed", exc_info=True)

    existing_supervisor_sid = str(subtask_row.get("acp_supervisor_session_id") or "").strip()
    project_path = str(subtask_row.get("project_path") or "").strip() or str(default_project_path or "").strip() or "./"
    thread_id = _runtime_thread_id(runtime)
    tool = build_invoke_acp_agent_tool(get_acp_agents())

    async def _lease_heartbeat(stop_evt: asyncio.Event) -> None:
        """Refresh subtask heartbeat lease to avoid watchdog timed_out while ACP is running."""
        try:
            import time as _time

            from evoflow.collab.storage import patch_collab_subtask_in_project_storage

            # Refresh faster than the 60s lease window used elsewhere.
            while not stop_evt.is_set():
                now_ts = float(_time.time())
                try:
                    patch_collab_subtask_in_project_storage(
                        storage,
                        main_task_id,
                        subtask_id,
                        {
                            "last_heartbeat_ts": now_ts,
                            "lease_until_ts": now_ts + 180.0,
                            "updated_at": utc_now_iso_z(),
                        },
                    )
                except Exception:
                    # Best-effort; never fail ACP execution because heartbeat patch failed.
                    pass
                # Sleep in small increments so stop_evt can cut it quickly.
                for _ in range(20):
                    if stop_evt.is_set():
                        break
                    try:
                        await asyncio.sleep(1)
                    except asyncio.CancelledError:
                        return
        except asyncio.CancelledError:
            return
        except Exception:
            return

    # Default policy: one ACP session per main task/provider/thread.
    if not existing_supervisor_sid:
        reusable = find_reusable_for_task(provider=provider, thread_id=thread_id, task_id=main_task_id)
        if reusable is not None:
            existing_supervisor_sid = str(reusable.supervisor_session_id or "").strip()
            if existing_supervisor_sid:
                _persist_subtask_session_id(storage, main_task_id, subtask_id, existing_supervisor_sid)
                from evoflow.collab.storage import find_main_task

                row = find_main_task(storage, main_task_id)
                if row:
                    proj, task = row
                    for st in task.get("subtasks") or []:
                        if str(st.get("id") or "").strip() == subtask_id:
                            st["acp_supervisor_session_id"] = existing_supervisor_sid
                            st["assigned_to"] = provider
                            # Share the same workspace path across the task by default.
                            st["project_path"] = str(st.get("project_path") or "").strip() or project_path
                            break
                    storage.save_project(proj)

    if not existing_supervisor_sid:
        start_res = await tool.ainvoke(
            {
                "agent": provider,
                "action": "start",
                "task_id": main_task_id,
                "subtask_id": subtask_id,
                "project_path": project_path,
            },
            config={"configurable": {"thread_id": thread_id}} if thread_id else None,
        )
        try:
            import json

            start_obj = json.loads(start_res) if isinstance(start_res, str) else {}
        except Exception:
            start_obj = {}
        if not bool(start_obj.get("ok")):
            return {
                "subtaskId": subtask_id,
                "ok": False,
                "error": str(start_obj.get("error") or start_res or "acp start failed"),
            }
        existing_supervisor_sid = str(start_obj.get("supervisor_session_id") or "").strip()
        if existing_supervisor_sid:
            _persist_subtask_session_id(storage, main_task_id, subtask_id, existing_supervisor_sid)
            # keep dedicated field for ACP session id binding
            from evoflow.collab.storage import find_main_task

            row = find_main_task(storage, main_task_id)
            if row:
                proj, task = row
                for st in task.get("subtasks") or []:
                    if str(st.get("id") or "").strip() == subtask_id:
                        st["acp_supervisor_session_id"] = existing_supervisor_sid
                        st["assigned_to"] = provider
                        st["project_path"] = project_path
                        break
                storage.save_project(proj)

    async def _send_once() -> dict[str, Any]:
        acp_timeout = max(60.0, float(os.getenv("EVOFLOW_ACP_SEND_TIMEOUT_SECONDS", "1800") or 1800))

        async def _invoke_send() -> Any:
            return await tool.ainvoke(
                {
                    "agent": provider,
                    "action": "send",
                    "prompt": prompt,
                    "supervisor_session_id": existing_supervisor_sid,
                    "task_id": main_task_id,
                    "subtask_id": subtask_id,
                },
                config={"configurable": {"thread_id": thread_id}} if thread_id else None,
            )

        try:
            send_res = await asyncio.wait_for(_invoke_send(), timeout=acp_timeout)
        except TimeoutError:
            return {
                "subtaskId": subtask_id,
                "ok": False,
                "error": f"acp send timed out after {int(acp_timeout)}s",
                "supervisor_session_id": existing_supervisor_sid,
                "provider": provider,
            }
        try:
            import json

            send_obj = json.loads(send_res) if isinstance(send_res, str) else {}
        except Exception:
            send_obj = {}
        ok = bool(send_obj.get("ok"))
        result = str(send_obj.get("result") or send_res or "")
        return {
            "subtaskId": subtask_id,
            "ok": ok,
            "result": result if ok else None,
            "error": None if ok else str(send_obj.get("error") or result or "acp send failed"),
            "supervisor_session_id": existing_supervisor_sid,
            "provider": provider,
        }

    if not bool(wait_for_completion):
        # Mark subtask running immediately for collab sidebar snapshot visibility.
        try:
            row = find_main_task(storage, main_task_id)
            if row:
                proj, task = row
                for st in task.get("subtasks") or []:
                    if str(st.get("id") or "").strip() == subtask_id:
                        st["status"] = "in_progress"
                        st["updated_at"] = utc_now_iso_z()
                        break
                storage.save_project(proj)
        except Exception:
            logger.debug("ACP detached: mark in_progress failed task=%s subtask=%s", main_task_id, subtask_id, exc_info=True)

        async def _bg_send() -> None:
            stop_evt = asyncio.Event()
            hb_task: asyncio.Task[None] | None = None
            try:
                try:
                    hb_task = asyncio.create_task(_lease_heartbeat(stop_evt), name=f"acp-lease-hb-{subtask_id[:18]}")
                except Exception:
                    hb_task = None
                # Stream deltas are emitted directly by invoke_acp_agent_tool.session_update.
                # Here we only wait for terminal result and persist final state.
                res = await _send_once()
                try:
                    row = find_main_task(storage, main_task_id)
                    if row:
                        proj, task = row
                        for st in task.get("subtasks") or []:
                            if str(st.get("id") or "").strip() == subtask_id:
                                st["updated_at"] = utc_now_iso_z()
                                draft = str(res.get("result") or "").strip()
                                if bool(res.get("ok")):
                                    # ACP 无 LangGraph 工具链：勿以 send 返回当作 completed
                                    st["status"] = "in_progress"
                                    st["progress"] = max(10, min(90, int(st.get("progress") or 0) or 50))
                                    st["current_step"] = "ACP 回合已返回正文，待 Lead 验收或 subtask_outcome_report"
                                else:
                                    st["status"] = "failed"
                                    st["error"] = str(res.get("error") or "acp send failed")
                                    if draft:
                                        st["result"] = draft
                                break
                        storage.save_project(proj)
                except Exception:
                    logger.debug("ACP detached: finalize subtask status failed", exc_info=True)
            except Exception:
                logger.debug("ACP detached send failed: subtask=%s provider=%s", subtask_id, provider, exc_info=True)
            finally:
                try:
                    stop_evt.set()
                except Exception:
                    pass
                if hb_task is not None:
                    try:
                        hb_task.cancel()
                    except Exception:
                        pass

        asyncio.create_task(_bg_send())
        return {
            "subtaskId": subtask_id,
            "ok": True,
            "detached": True,
            "result": "Task Detached. ACP session is running in background; stream events will be emitted.",
            "error": None,
            "supervisor_session_id": existing_supervisor_sid,
            "provider": provider,
        }

    # Synchronous wait path: keep refreshing lease while ACP runs.
    stop_evt2 = asyncio.Event()
    hb_task2: asyncio.Task[None] | None = None
    try:
        try:
            hb_task2 = asyncio.create_task(_lease_heartbeat(stop_evt2), name=f"acp-lease-hb-{subtask_id[:18]}")
        except Exception:
            hb_task2 = None
        return await _send_once()
    finally:
        try:
            stop_evt2.set()
        except Exception:
            pass
        if hb_task2 is not None:
            try:
                hb_task2.cancel()
            except Exception:
                pass


async def _emit_claude_subtask_task_started(
    *,
    main_task_id: str,
    subtask_id: str,
    subtask_row: dict[str, Any],
    writer: Any | None,
    runtime: Any | None = None,
) -> None:
    """Emit ``task_started`` on the unified collab stream path."""
    from evoflow.collab.unified_stream import emit_collab_subtask_lifecycle

    await emit_collab_subtask_lifecycle(
        runtime=runtime,
        main_task_id=main_task_id,
        subtask_id=subtask_id,
        event="started",
        description=str(subtask_row.get("name") or subtask_id),
        subagent_type="claude-code",
    )


def _is_task_tool_preflight_error(text: str) -> bool:
    """True when task_tool rejected before execution (gate / validation), not a worker failure."""
    t = str(text or "").strip()
    return t.startswith("Error:")


async def _claude_send_and_finalize(
    *,
    storage: Any,
    main_task_id: str,
    subtask_id: str,
    subtask_row: dict[str, Any],
    session_id: str,
    prompt: str,
    runtime: Any | None = None,
    keep_session_open: bool = True,
) -> dict[str, Any]:
    """Run claude_session send to completion and persist draft output (streams via SSE during send)."""
    from evoflow.collab.dag_trace import dag_info, dag_warning
    from evoflow.collab.storage import get_task_detail_storage, persist_subtask_runtime_snapshot
    from evoflow.collab.unified_stream import emit_collab_subtask_lifecycle
    from evoflow.tools.builtins.claude_session_tool import claude_session_tool

    try:
        await emit_collab_subtask_lifecycle(
            runtime=runtime,
            main_task_id=main_task_id,
            subtask_id=subtask_id,
            event="running",
            subagent_type="claude-code",
            message={"type": "ai", "content": "（Claude Code 执行中…）"},
        )
    except Exception:
        logger.debug("claude send: initial running sse failed", exc_info=True)

    send_result = await claude_session_tool.ainvoke(
        {
            "action": "send",
            "session_id": session_id,
            "message": prompt,
            "stream_to_chat": True,
            "stream_to_subtask_id": subtask_id,
            "stream_to_main_task_id": main_task_id,
        }
    )
    if not bool(send_result.get("ok")):
        send_error = str(send_result.get("error") or "claude_session send failed")
        dag_warning(
            "claude_delegate_send_failed main=%s sub=%s error=%s",
            main_task_id,
            subtask_id,
            send_error[:300],
        )
        try:
            persist_subtask_runtime_snapshot(
                storage,
                get_task_detail_storage(),
                main_task_id,
                subtask_id,
                status="failed",
                progress=0,
                error=send_error[:2000],
                output_summary=send_error[:8000],
                current_step="claude_session send failed",
            )
        except Exception:
            logger.debug("claude_session send failure snapshot persist failed", exc_info=True)
        return {
            "subtaskId": subtask_id,
            "ok": False,
            "error": send_error,
            "session_id": session_id,
        }

    text = str(send_result.get("accumulated_text") or "").strip()
    if not text:
        read_result = await claude_session_tool.ainvoke({"action": "read", "session_id": session_id, "lines": 200})
        lines = read_result.get("lines", []) if isinstance(read_result, dict) else []
        text = "".join(str(x) for x in lines if str(x).strip()).strip()
    if not text:
        text = f"claude_session completed (streamed_lines={send_result.get('streamed_lines', 0)})"
    if not keep_session_open:
        try:
            await claude_session_tool.ainvoke({"action": "close", "session_id": session_id})
        except Exception:
            logger.debug("auto close claude_session after send failed", exc_info=True)
    try:
        persist_subtask_runtime_snapshot(
            storage,
            get_task_detail_storage(),
            main_task_id,
            subtask_id,
            status="in_progress",
            progress=max(10, min(90, int(subtask_row.get("progress") or 0) or 50)),
            current_step="claude_session 已返回正文，待 subtask_outcome_report 或 Lead 确认终态",
        )
    except Exception:
        logger.debug("claude_session draft snapshot persist failed", exc_info=True)
    try:
        from evoflow.collab.storage import find_main_task
        from evoflow.tools.builtins.task_tool import _append_subtask_conversation_replica

        _parent_tid: str | None = None
        _main_row = find_main_task(storage, main_task_id)
        if _main_row:
            _parent_tid = str(_main_row[1].get("thread_id") or "").strip() or None
        _append_subtask_conversation_replica(
            main_task_id,
            subtask_id,
            {"role": "assistant", "content": text},
            1,
            parent_thread_id=_parent_tid,
        )
    except Exception:
        logger.debug("claude_session: execution_conversation replica append failed", exc_info=True)

    dag_info(
        "claude_delegate_done main=%s sub=%s streamed_lines=%s text_len=%s status=in_progress",
        main_task_id,
        subtask_id,
        send_result.get("streamed_lines", 0),
        len(text),
    )
    try:
        preview = text[:160] if text else "（Claude Code 已返回，等待 outcome 确认）"
        await emit_collab_subtask_lifecycle(
            runtime=runtime,
            main_task_id=main_task_id,
            subtask_id=subtask_id,
            event="running",
            subagent_type="claude-code",
            message={"type": "ai", "content": preview},
        )
    except Exception:
        logger.debug("claude_delegate_done: sse running snapshot failed", exc_info=True)
    return {
        "subtaskId": subtask_id,
        "ok": True,
        "result": text,
        "session_id": session_id,
    }


async def _delegate_via_claude_session_tool(
    *,
    storage: Any,
    main_task_id: str,
    subtask_id: str,
    subtask_row: dict[str, Any],
    prompt: str,
    default_project_path: str | None = None,
    wait_for_completion: bool = True,
) -> dict[str, Any]:
    """Run a subtask via claude_session tool instead of task_tool/subagent path."""
    from evoflow.collab.dag_trace import dag_info
    from evoflow.collab.storage import get_task_detail_storage, persist_subtask_runtime_snapshot
    from evoflow.tools.builtins.claude_session_tool import claude_session_tool

    dag_info("claude_delegate_begin main=%s sub=%s detached=%s", main_task_id, subtask_id, not wait_for_completion)

    project_path = str(subtask_row.get("project_path") or "").strip() or str(default_project_path or "").strip() or "./"
    existing_sid = str(subtask_row.get("claude_session_id") or "").strip() or str(subtask_row.get("external_session_id") or "").strip()

    session_id = existing_sid
    lead_rt = _collab_lead_runtime_strong.get(str(main_task_id or "").strip())
    from evoflow.collab.unified_stream import resolve_collab_parent_stream_writer

    writer = resolve_collab_parent_stream_writer(
        runtime=lead_rt,
        main_task_id=main_task_id,
    )
    await _emit_claude_subtask_task_started(
        main_task_id=main_task_id,
        subtask_id=subtask_id,
        subtask_row=subtask_row,
        writer=writer,
        runtime=lead_rt,
    )
    if not session_id:
        created = await claude_session_tool.ainvoke(
            {
                "action": "create",
                "project_path": project_path,
            }
        )
        if not bool(created.get("ok")):
            create_error = str(created.get("error") or "claude_session create failed")
            low = create_error.lower()
            if ("allow" in low and "directory" in low) or ("not in" in low and "allow" in low):
                create_error = f"{create_error}. Hint: add this path to Claude Code allowed directories, or create the subtask with project_path under an already allowed workspace."
            try:
                persist_subtask_runtime_snapshot(
                    storage,
                    get_task_detail_storage(),
                    main_task_id,
                    subtask_id,
                    status="failed",
                    progress=0,
                    error=create_error[:2000],
                    output_summary=create_error[:8000],
                    current_step="claude_session create failed",
                    sync_agent_memory=True,
                )
            except Exception:
                logger.debug("claude_session create failure snapshot persist failed", exc_info=True)
            return {
                "subtaskId": subtask_id,
                "ok": False,
                "error": create_error,
            }
        session_id = str(created.get("session_id") or "").strip()
        if not session_id:
            return {
                "subtaskId": subtask_id,
                "ok": False,
                "error": "claude_session create succeeded but no session_id returned",
            }
        _persist_subtask_session_id(storage, main_task_id, subtask_id, session_id)

    if not wait_for_completion:

        async def _bg_claude() -> None:
            try:
                res = await _claude_send_and_finalize(
                    storage=storage,
                    main_task_id=main_task_id,
                    subtask_id=subtask_id,
                    subtask_row=subtask_row,
                    session_id=session_id,
                    prompt=prompt,
                    runtime=lead_rt,
                    keep_session_open=True,
                )
                if not bool(res.get("ok")):
                    await _mark_subtask_delegate_failed(
                        storage,
                        main_task_id,
                        subtask_id,
                        str(res.get("error") or "claude_session send failed"),
                    )
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                logger.exception("claude detached send failed sub=%s", subtask_id)
                await _mark_subtask_delegate_failed(storage, main_task_id, subtask_id, str(exc))

        try:
            asyncio.get_running_loop().create_task(
                _bg_claude(),
                name=f"claude-detached-{subtask_id[:18]}",
            )
        except RuntimeError:
            return await _claude_send_and_finalize(
                storage=storage,
                main_task_id=main_task_id,
                subtask_id=subtask_id,
                subtask_row=subtask_row,
                session_id=session_id,
                prompt=prompt,
                runtime=lead_rt,
                keep_session_open=True,
            )
        return {
            "subtaskId": subtask_id,
            "ok": True,
            "detached": True,
            "session_id": session_id,
        }

    return await _claude_send_and_finalize(
        storage=storage,
        main_task_id=main_task_id,
        subtask_id=subtask_id,
        subtask_row=subtask_row,
        session_id=session_id,
        prompt=prompt,
        runtime=lead_rt,
        keep_session_open=True,
    )


async def delegate_collab_subtasks_for_start_execution(
    runtime: ToolRuntime[ContextT, dict] | None,
    storage: Any,
    main_task_id: str,
    subtask_ids: list[str],
    *,
    wait_for_completion: bool = False,
) -> list[dict[str, Any]]:
    """Invoke ``task`` for each subtask (parallel). Used by ``start_execution`` so workers actually run.

    When ``wait_for_completion`` is False (default), each subagent runs in the background and this
    function returns as soon as all starts succeed; project rows are updated on completion by the
    existing ``task_tool`` polling path.
    """
    from evoflow.collab.storage import (
        find_main_task,
        find_subtask_by_ids,
    )
    from evoflow.tools.builtins.collab_bridge import delegate_via_task_tool, ensure_collab_bridge_ready, is_bridge_ready
    from evoflow.tools.builtins.supervisor.dependency import (
        _build_ref_to_id_index,
        _build_subtask_name_index,
        _resolve_dep_ref_to_id,
        _subtask_dep_ids,
    )

    if not subtask_ids:
        return []

    _register_collab_lead_runtime(main_task_id, runtime)

    from evoflow.collab.dag_trace import dag_info, dag_warning

    want_ids = [str(s).strip() for s in subtask_ids if str(s).strip()]
    dag_info(
        "delegate_begin main=%s subs=%s wait_for_completion=%s runtime=%s",
        main_task_id,
        want_ids,
        wait_for_completion,
        runtime is not None,
    )

    if runtime is None:
        dag_warning("delegate_abort main=%s subs=%s reason=no_runtime", main_task_id, want_ids)
        return [
            {
                "subtaskId": sid,
                "ok": False,
                "error": "No runtime: cannot delegate to task tool",
            }
            for sid in want_ids
        ]

    _task_ok, _follow_ok = ensure_collab_bridge_ready()
    if not _task_ok:
        dag_warning("delegate_abort main=%s subs=%s reason=task_tool_bridge_not_ready", main_task_id, want_ids)
        return [{"subtaskId": sid, "ok": False, "error": "task_tool unavailable (bridge not ready)"} for sid in want_ids]

    subtask_ids = _claim_subtasks_for_delegation(storage, main_task_id, want_ids)
    if not subtask_ids:
        dag_warning("delegate_abort main=%s subs=%s reason=nothing_claimed", main_task_id, want_ids)
        return []

    try:
        from evoflow.collab.storage import patch_collab_subtask_in_project_storage
        from evoflow.collab.unified_stream import emit_collab_subtask_lifecycle

        for sid in subtask_ids:
            st_row = find_subtask_by_ids(storage, main_task_id, sid) or {}
            worker = _resolved_subagent_type_for_subtask(st_row)
            desc = str(st_row.get("name") or sid)
            try:
                await emit_collab_subtask_lifecycle(
                    runtime=runtime,
                    main_task_id=main_task_id,
                    subtask_id=sid,
                    event="started",
                    description=desc,
                    subagent_type=worker,
                )
                await emit_collab_subtask_lifecycle(
                    runtime=runtime,
                    main_task_id=main_task_id,
                    subtask_id=sid,
                    event="running",
                    description=desc,
                    subagent_type=worker,
                    message={"type": "ai", "content": "（已启动，等待输出…）"},
                )
                patch_collab_subtask_in_project_storage(
                    storage,
                    main_task_id,
                    sid,
                    {
                        "current_step": "子任务已派发",
                    },
                )
            except Exception:
                dag_warning("delegate pre_broadcast failed main=%s sub=%s", main_task_id, sid)
                logger.debug("delegate: pre-broadcast failed sub=%s", sid, exc_info=True)
    except Exception:
        logger.debug("delegate: pre-broadcast task:started failed", exc_info=True)

    def _abort_claimed(reason: str) -> list[dict[str, Any]]:
        _revert_claimed_subtasks_to_pending(storage, main_task_id, subtask_ids, reason=reason)
        return [{"subtaskId": sid, "ok": False, "error": reason} for sid in subtask_ids]

    dep_by_id: dict[str, dict[str, Any]] = {}
    try:
        dep_row = find_main_task(storage, main_task_id)
        if dep_row:
            _dep_proj, dep_task = dep_row
            for _st in dep_task.get("subtasks") or []:
                if isinstance(_st, dict):
                    _sid = str(_st.get("id") or "").strip()
                    if _sid:
                        dep_by_id[_sid] = _st
    except Exception:
        dep_by_id = {}
    dep_name_index = _build_subtask_name_index(dep_by_id)
    dep_ref_index = _build_ref_to_id_index(dep_by_id)

    def _runtime_default_project_path() -> str | None:
        if runtime is None:
            return None
        cfg: dict[str, Any] = {}
        try:
            _rconf = getattr(runtime, "config", None) or {}
            cfg = (_rconf.get("configurable") or {}) if isinstance(_rconf, dict) else {}
        except Exception:
            cfg = {}
        p = str(cfg.get("local_workspace_root") or "").strip()
        if not p:
            return None
        return p

    default_project_path = _runtime_default_project_path()

    def _build_dependency_context(sid: str, st: dict[str, Any]) -> str:
        """Build upstream dependency handoff context for dependent subtasks."""
        dep_refs = _subtask_dep_ids(st)
        if not dep_refs:
            return ""
        chunks: list[str] = []
        for dep_ref in dep_refs:
            dep_id = _resolve_dep_ref_to_id(
                dep_ref,
                current_sid=sid,
                by_id=dep_by_id,
                name_index=dep_name_index,
                ref_index=dep_ref_index,
            )
            if not dep_id:
                continue
            dep = find_subtask_by_ids(storage, main_task_id, dep_id)
            if not dep:
                continue
            dep_status = str(dep.get("status") or "").strip().lower()
            if dep_status != "completed":
                continue
            dep_name = str(dep.get("name") or dep_id).strip()
            from evoflow.collab.workflow_handoff_sanitize import format_upstream_subtask_handoff

            handoff = format_upstream_subtask_handoff(dep, dep_name=dep_name, dep_id=dep_id)
            if not handoff:
                continue
            chunks.append(handoff)
        if not chunks:
            return ""
        return "\n\n[Upstream dependency output for downstream consumption]\n" + "\n".join(chunks) + "\nPlease continue execution based on upstream output; do not re-do upstream work."

    async def _one(sid: str) -> dict[str, Any]:
        st = find_subtask_by_ids(storage, main_task_id, sid)
        if not st:
            return {"subtaskId": sid, "ok": False, "error": "subtask not found"}
        name = (st.get("name") or "subtask").strip() or "subtask"
        prompt = _build_subtask_enriched_prompt(
            subtask_row=st,
            main_task_id=main_task_id,
            subtask_id=sid,
            storage=storage,
        )
        # P0-1.3: When input_bindings were resolved into structured data inside
        # _build_subtask_enriched_prompt, skip the legacy full-task_report dump
        # from _build_dependency_context (which blindly injects all upstream text).
        has_resolved_bindings = bool(st.pop("_has_resolved_input_bindings", False))
        if not has_resolved_bindings:
            dep_ctx = _build_dependency_context(sid, st)
            if dep_ctx:
                prompt = f"{prompt}{dep_ctx}"
        # P0.5-2: Production failure on unresolved input bindings.
        # When build_core_prompt detected unresolved {{...}} expressions, the
        # subtask cannot proceed deterministically – fail it instead of
        # dispatching to a worker with broken inputs.
        has_unresolved = bool(st.pop("_has_unresolved_bindings", False))
        if has_unresolved:
            unresolved_warnings = st.pop("_unresolved_binding_warnings", [])
            binding_errors = st.pop("_binding_errors", [])
            warn_text = "; ".join(unresolved_warnings) if unresolved_warnings else "unknown unresolved bindings"
            err_msg = f"Unresolved input bindings (production mode): {warn_text}"
            logger.error(
                "delegate subtask %s blocked: unresolved bindings main=%s warnings=%s errors=%s",
                sid,
                main_task_id,
                warn_text,
                binding_errors,
            )
            await _mark_subtask_delegate_failed(storage, main_task_id, sid, err_msg)
            return {"subtaskId": sid, "ok": False, "error": err_msg}
        # P0.5 Final Closure: input_schema runtime validation gate.
        # When build_core_prompt detected type mismatches between resolved
        # binding values and the step's declared input_schema, block dispatch
        # rather than sending wrong-typed data to the worker.
        has_input_schema_errors = bool(st.pop("_has_input_schema_errors", False))
        if has_input_schema_errors:
            schema_errs = st.pop("_input_schema_errors", [])
            err_detail = "; ".join(schema_errs) if schema_errs else "input_schema type validation failed"
            err_msg = f"Input schema validation failed (production mode): {err_detail}"
            logger.error(
                "delegate subtask %s blocked: input_schema type mismatch main=%s errors=%s",
                sid,
                main_task_id,
                schema_errs,
            )
            await _mark_subtask_delegate_failed(storage, main_task_id, sid, err_msg)
            return {"subtaskId": sid, "ok": False, "error": err_msg}
        subagent_type = _resolved_subagent_type_for_subtask(st)
        worker_err = _worker_delegation_error(subagent_type)
        if worker_err:
            logger.error(
                "delegate subtask %s blocked: worker=%r main=%s error=%s",
                sid,
                subagent_type,
                main_task_id,
                worker_err,
            )
            await _mark_subtask_delegate_failed(storage, main_task_id, sid, worker_err)
            return {"subtaskId": sid, "ok": False, "error": worker_err}
        if _is_claude_session_worker(subagent_type):
            try:
                return await _delegate_via_claude_session_tool(
                    storage=storage,
                    main_task_id=main_task_id,
                    subtask_id=sid,
                    subtask_row=st,
                    prompt=prompt,
                    default_project_path=default_project_path,
                    wait_for_completion=wait_for_completion,
                )
            except Exception as e:
                from evoflow.platform.asyncio_windows import is_subprocess_spawn_runtime_error

                if is_subprocess_spawn_runtime_error(e):
                    logger.warning(
                        "delegate subtask %s: claude_session subprocess failed (%s); "
                        "retrying via task_tool general-purpose",
                        sid,
                        e,
                    )
                    subagent_type = "general-purpose"
                else:
                    logger.exception("delegate subtask %s via claude_session failed", sid)
                    return {"subtaskId": sid, "ok": False, "error": str(e)}
        if _is_acp_worker(subagent_type):
            try:
                return await _delegate_via_acp_tool(
                    storage=storage,
                    runtime=runtime,
                    main_task_id=main_task_id,
                    subtask_id=sid,
                    subtask_row=st,
                    prompt=prompt,
                    provider=subagent_type,
                    default_project_path=default_project_path,
                    wait_for_completion=wait_for_completion,
                )
            except Exception as e:
                logger.exception("delegate subtask %s via ACP failed", sid)
                return {"subtaskId": sid, "ok": False, "error": str(e)}
        tcid = make_formatted_id("SupervisorExec")
        try:
            out = await delegate_via_task_tool(
                runtime,
                description=name[:120],
                prompt=prompt,
                subagent_type=subagent_type,
                tool_call_id=tcid,
                max_turns=None,
                collab_task_id=main_task_id,
                collab_subtask_id=sid,
                detach=not wait_for_completion,
            )
            text = out if isinstance(out, str) else str(out)
            if _is_task_tool_preflight_error(text):
                _revert_claimed_subtasks_to_pending(
                    storage,
                    main_task_id,
                    [sid],
                    reason=text[:500],
                )
                return {
                    "subtaskId": sid,
                    "ok": False,
                    "error": text,
                    "gate_rejected": True,
                }
            if text.startswith("Task Detached."):
                return {
                    "subtaskId": sid,
                    "ok": True,
                    "detached": True,
                    "result": text,
                }
            from evoflow.collab.subtask_outcome import is_subtask_outcome_reported

            st_after = find_subtask_by_ids(storage, main_task_id, sid) or {}
            if is_subtask_outcome_reported(st_after):
                status = str(st_after.get("status") or "").strip().lower()
                ok = status == "completed"
                err = None if ok else str(st_after.get("error") or text)[:4000]
            else:
                ok = False
                err = text[:4000]
            if not ok and err:
                logger.error(
                    "delegate subtask %s via task_tool failed main=%s worker=%r: %s",
                    sid,
                    main_task_id,
                    subagent_type,
                    err[:500],
                )
                await _mark_subtask_delegate_failed(storage, main_task_id, sid, err)
            return {"subtaskId": sid, "ok": ok, "result": text if ok else None, "error": err}
        except Exception as e:
            logger.exception("delegate subtask %s via task_tool failed", sid)
            err = str(e)
            await _mark_subtask_delegate_failed(storage, main_task_id, sid, err)
            return {"subtaskId": sid, "ok": False, "error": err}

    results = list(await asyncio.gather(*[_one(sid) for sid in subtask_ids]))
    for row in results:
        dag_info(
            "delegate_result main=%s sub=%s ok=%s detached=%s error=%s",
            main_task_id,
            row.get("subtaskId"),
            row.get("ok"),
            row.get("detached"),
            str(row.get("error") or "")[:240],
        )
    return results


async def delegate_collab_subtask_peer_wake(
    storage: Any,
    *,
    main_task_id: str,
    subtask_id: str,
    thread_key: str,
    mode: str,
) -> dict[str, Any]:
    """Delegate one peer-wake round via task_tool (detach)."""
    from evoflow.collab.id_format import make_formatted_id
    from evoflow.collab.storage import find_subtask_by_ids
    from evoflow.tools.builtins.collab_bridge import delegate_via_task_tool

    sid = str(subtask_id or "").strip()
    mid = str(main_task_id or "").strip()
    st = find_subtask_by_ids(storage, mid, sid)
    if not st:
        return {"ok": False, "error": "subtask not found"}

    runtime = _resolve_collab_followup_runtime(None, mid)
    if runtime is None:
        return {"ok": False, "error": "no lead runtime for peer wake"}

    name = str(st.get("name") or "subtask").strip() or "subtask"
    prompt = _build_subtask_enriched_prompt(
        subtask_row=st,
        main_task_id=mid,
        subtask_id=sid,
        storage=storage,
    )
    subagent_type = _resolved_subagent_type_for_subtask(st)
    tcid = make_formatted_id("PeerWake")
    try:
        out = await delegate_via_task_tool(
            runtime,
            description=f"peer:{name[:80]}",
            prompt=prompt,
            subagent_type=subagent_type,
            tool_call_id=tcid,
            max_turns=None,
            collab_task_id=mid,
            collab_subtask_id=sid,
            detach=True,
        )
        text = out if isinstance(out, str) else str(out)
        ok = text.startswith("Task Detached.") or "Succeeded" in text
        return {"ok": ok, "detached": text.startswith("Task Detached."), "result": text[:4000]}
    except Exception as e:
        logger.exception("peer wake delegate failed main=%s sub=%s", mid, sid)
        return {"ok": False, "error": str(e)}


def _subtask_status_snapshot(storage: Any, main_task_id: str) -> list[dict[str, str]]:
    from evoflow.collab.storage import find_main_task

    row = find_main_task(storage, main_task_id)
    if not row:
        return []
    _proj, task = row
    out: list[dict[str, str]] = []
    for st in task.get("subtasks") or []:
        if not isinstance(st, dict):
            continue
        sid = str(st.get("id") or "").strip()
        if not sid:
            continue
        out.append(
            {
                "id": sid,
                "ref": str(st.get("ref") or ""),
                "status": str(st.get("status") or "pending"),
                "worker": str(st.get("assigned_to") or (st.get("worker_profile") or {}).get("base_subagent") or ""),
            }
        )
    return out


async def auto_delegate_collab_followup_wave(
    runtime: ToolRuntime[ContextT, dict] | None,
    main_task_id: str,
) -> None:
    """When a subtask finishes, start any newly runnable dependents without another ``start_execution``."""
    from evoflow.collab.dag_trace import dag_info, dag_warning
    from evoflow.collab.storage import find_main_task, get_project_storage
    from evoflow.collab.thread_collab import advance_collab_phase_to_executing_for_task
    from evoflow.config.paths import get_paths
    from evoflow.tools.builtins.supervisor.dependency import _resolve_subtasks_for_start_execution
    from evoflow.tools.builtins.supervisor.monitor import _ensure_background_task_monitor
    from evoflow.tools.builtins.supervisor.utils import _runtime_thread_id

    tid = str(main_task_id or "").strip()
    if not tid:
        return

    dag_info("followup_enter main=%s caller_runtime=%s", tid, runtime is not None)

    runtime = _resolve_collab_followup_runtime(runtime, tid)
    if runtime is None:
        dag_warning(
            "followup_skip main=%s reason=no_runtime (lead ToolRuntime missing or weakref collected; wave-2+ will not start)",
            tid,
        )
        return

    async with _followup_lock_for_task(tid):
        storage = get_project_storage()
        dag_info("followup_locked main=%s subtasks_before=%s", tid, _subtask_status_snapshot(storage, tid))

        _verify_upstream_artifacts_before_followup(storage, tid)

        to_run, blocked = _resolve_subtasks_for_start_execution(storage, tid, None)
        dag_info(
            "followup_resolve main=%s runnable=%s blocked=%s",
            tid,
            to_run,
            blocked[:16],
        )
        if not to_run:
            dag_info("followup_skip main=%s reason=no_runnable", tid)
            return
        row = find_main_task(storage, tid)
        if not row:
            dag_warning("followup_skip main=%s reason=task_not_found", tid)
            return
        _proj, main_task = row
        if not bool(main_task.get("execution_authorized")):
            dag_warning("followup_skip main=%s reason=not_execution_authorized", tid)
            return

        try:
            advance_collab_phase_to_executing_for_task(get_paths(), tid, runtime_thread_id=_runtime_thread_id(runtime))
        except Exception:
            logger.exception("auto_delegate_collab_followup_wave: advance_collab_phase failed task_id=%s", tid)

        try:
            delegated = await delegate_collab_subtasks_for_start_execution(
                runtime,
                storage,
                tid,
                to_run,
                wait_for_completion=False,
            )
        except Exception:
            logger.exception("auto_delegate_collab_followup_wave: delegate failed task_id=%s", tid)
            dag_warning("followup_delegate_exception main=%s subs=%s", tid, to_run)
            return

        if delegated and any(bool(d.get("detached")) for d in delegated):
            try:
                _ensure_background_task_monitor(
                    storage,
                    tid,
                    runtime_thread_id=_runtime_thread_id(runtime),
                )
            except Exception:
                logger.debug("auto_delegate_collab_followup_wave: background monitor failed", exc_info=True)

        dag_info(
            "followup_done main=%s started=%d subs=%s subtasks_after=%s",
            tid,
            len(to_run),
            to_run,
            _subtask_status_snapshot(storage, tid),
        )


def _verify_upstream_artifacts_before_followup(storage: Any, main_task_id: str) -> None:
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

        if missing:
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


def _resolved_subagent_type_for_subtask(st: dict) -> str:
    """Prefer explicit assigned_to on the subtask row; else worker_profile.base_subagent; else default.

    Falls back from ``claude-code`` to ``general-purpose`` when ``claude_agent_sdk`` is not
    installed in this process (LangGraph runtime), so delegation does not hard-fail.
    On Windows with Selector event loop (EvoFlow default), also falls back because Claude Code
    CLI subprocess spawn requires Proactor.
    """
    resolved = "general-purpose"
    a = (st.get("assigned_to") or "").strip()
    if a:
        resolved = a
    else:
        wp = st.get("worker_profile")
        if isinstance(wp, dict):
            b = str(wp.get("base_subagent") or "").strip()
            if b:
                resolved = b
    resolved = effective_subagent_type(resolved) or "general-purpose"
    if _is_claude_session_worker(resolved):
        try:
            from evoflow.platform.asyncio_windows import claude_session_subprocess_supported

            if not claude_session_subprocess_supported():
                logger.info(
                    "claude-code worker unavailable on Selector loop (Windows); using general-purpose"
                )
                return "general-purpose"
        except Exception:
            logger.debug("claude subprocess capability check failed", exc_info=True)
    return resolved


def _format_plan_step_context_block(step: dict[str, Any]) -> str:
    lines = [f"### Step {step.get('ref') or ''}: {step.get('name') or step.get('short_name') or ''}".strip()]
    for label, key in (
        ("目标", "goal"),
        ("输入物", "inputs"),
        ("输出物", "outputs"),
        ("验收标准", "acceptance"),
        ("失败处理", "failure"),
    ):
        val = str(step.get(key) or "").strip()
        if val:
            lines.append(f"- **{label}**: {val}")
    return "\n".join(lines)


def _extract_plan_context_for_subtask_from_steps(
    steps: list[dict[str, Any]],
    subtask_name: str,
    subtask_desc: str,
) -> str:
    """Match subtask to a structured plan step by name/description overlap."""
    name = str(subtask_name or "").strip()
    desc = str(subtask_desc or "").strip()
    if not steps:
        return ""
    name_lower = name.lower()
    desc_lower = desc.lower()

    # Prefer exact / substring name match before token overlap scoring.
    for step in steps:
        if not isinstance(step, dict):
            continue
        step_name = str(step.get("name") or step.get("short_name") or "").strip().lower()
        if name_lower and step_name and (name_lower == step_name or name_lower in step_name or step_name in name_lower):
            block = _format_plan_step_context_block(step)
            return "\n\n## 你在整体计划中的位置（来自 Plan）\n" + block + "\n\n请严格按照上述「目标」「输入物」「输出物」「验收标准」执行，" + "完成后对照「验收标准」自检并贴出证据。"

    best: dict[str, Any] | None = None
    best_score = 0
    for step in steps:
        if not isinstance(step, dict):
            continue
        blob = " ".join(str(step.get(k) or "") for k in ("name", "short_name", "goal", "inputs", "outputs", "acceptance")).lower()
        score = 0
        for token in name_lower.replace(":", " ").replace("-", " ").split():
            if len(token) >= 2 and token in blob:
                score += 1
        for token in desc_lower.replace(":", " ").replace("-", " ").split():
            if len(token) >= 2 and token in blob:
                score += 1
        if score > best_score:
            best_score = score
            best = step
    if best_score < 2 or not best:
        return ""
    block = _format_plan_step_context_block(best)
    return "\n\n## 你在整体计划中的位置（来自 Plan）\n" + block + "\n\n请严格按照上述「目标」「输入物」「输出物」「验收标准」执行，" + "完成后对照「验收标准」自检并贴出证据。"


def _build_subtask_enriched_prompt(
    *,
    subtask_row: dict[str, Any],
    main_task_id: str,
    subtask_id: str,
    storage: Any,
) -> str:
    """Build enriched prompt for a subtask with Plan context, worker_profile.instruction,
    expected_outputs, validation, retry context, and default self-check injected.
    """
    name = (subtask_row.get("name") or "subtask").strip() or "subtask"
    desc = (subtask_row.get("description") or "").strip()
    base_prompt = desc if desc else (f"Complete subtask '{name}'. Collab main task id: {main_task_id}; subtask id: {subtask_id}.")

    extra_blocks: list[str] = []

    retry_count = int(subtask_row.get("retry_count") or 0)
    retry_reason = str(subtask_row.get("retry_reason") or "").strip()
    last_retry_from_status = str(subtask_row.get("last_retry_from_status") or "").strip()
    if retry_count > 0:
        retry_lines = [
            f"## ⚠️ 这是第 {retry_count} 次重试",
            f"上次状态：{last_retry_from_status or 'unknown'}",
        ]
        if retry_reason:
            retry_lines.append(f"上次失败原因（来自 lead agent）：\n{retry_reason}")

        # Inject previous run's output so worker knows what was already done
        # and doesn't waste steps re-exploring the same code.
        prev_report = str(subtask_row.get("task_report") or subtask_row.get("result") or "").strip()
        if prev_report and prev_report not in ("None", "[STEP_LIMIT_REACHED] 已达到本轮最大推理轮次。请根据已有工具结果输出最终结论，不要再调用工具。"):
            # Truncate to avoid token bloat
            prev_summary = prev_report[:2000]
            if len(prev_report) > 2000:
                prev_summary += "\n...(已截断，完整内容见子任务对话记录)"
            retry_lines.append(f"## 上次运行产出摘要（供参考，避免重复已完成的工作）\n{prev_summary}")

        # Inject evidence paths from previous run (files already modified)
        prev_evidence = subtask_row.get("evidence_paths")
        if isinstance(prev_evidence, list) and prev_evidence:
            paths = "\n".join(f"- `{p}`" for p in prev_evidence if isinstance(p, str) and p.strip())
            if paths:
                retry_lines.append(f"## 上次已修改的文件（不要重复修改，除非需要修正）\n{paths}")

        retry_lines.append("请仔细分析上次失败原因，调整方案后重新执行。不要重复上次的错误做法。")
        extra_blocks.append("\n".join(retry_lines))

    wp = subtask_row.get("worker_profile")
    if isinstance(wp, dict):
        instr = str(wp.get("instruction") or "").strip()
        if instr:
            extra_blocks.append(f"## 额外指令（来自 lead agent）\n{instr}")

        expected = wp.get("expected_outputs")
        if isinstance(expected, list) and expected:
            paths = "\n".join(f"- `{p}`" for p in expected if isinstance(p, str) and p.strip())
            if paths:
                extra_blocks.append(f"## 必须产出的文件（缺一不可）\n{paths}\n\n完成后请逐一确认以上文件存在且内容正确。")

        validation_cmd = str(wp.get("validation") or "").strip()
        if validation_cmd:
            extra_blocks.append(f"## 自检验收命令（必须执行并贴出输出）\n```\n{validation_cmd}\n```\n\n如果验收不通过，在结果中明确报告：哪个检查失败了、完整错误输出、你的分析。")

    if not any("自检" in b for b in extra_blocks):
        extra_blocks.append("## 完成前自检（必须执行）\n在报告完成之前，请确认：\n1. 所有要求的文件/代码已产出且内容正确\n2. 如果有测试，已运行并通过\n3. 在结果中贴出关键产出物或验证证据\n如果自检不通过，请修复后再报告完成。")

    try:
        from evoflow.collab.storage import find_main_task

        row = find_main_task(storage, main_task_id)
        if row:
            _proj, task = row
            from evoflow.collab.plan_task_storage import load_plan_steps

            plan_steps = load_plan_steps(task)
            if plan_steps:
                plan_ctx = _extract_plan_context_for_subtask_from_steps(plan_steps, name, desc)
                if plan_ctx:
                    extra_blocks.append(plan_ctx)

            # P0.5-2 + P0.5-5: Resolve input_bindings via shared build_core_prompt
            # for unified Debug/Production prompt assembly with unresolved binding detection.
            ref = str(subtask_row.get("ref") or "").strip()
            if ref:
                params = task.get("run_parameters") or {}
                if not isinstance(params, dict):
                    params = {}
                matching_step = None
                for ps in (plan_steps or []):
                    if str(ps.get("ref") or "").strip() == ref:
                        matching_step = ps
                        break
                if matching_step and matching_step.get("input_bindings"):
                    from evoflow.collab.expression_resolver import format_resolved_inputs_for_prompt
                    from evoflow.collab.step_prompt_builder import build_core_prompt

                    all_subtasks = task.get("subtasks") or []
                    core_result = build_core_prompt(
                        step=matching_step,
                        params=params,
                        subtasks=all_subtasks,
                        mode="production",
                        subtask_row=subtask_row,
                    )
                    if core_result["has_bindings"] and core_result["resolved"]:
                        inputs_block = format_resolved_inputs_for_prompt(core_result["resolved"])
                        if inputs_block:
                            extra_blocks.append(inputs_block)
                            # Signal caller to skip legacy full task_report injection
                            subtask_row["_has_resolved_input_bindings"] = True
                        # P0.5-2: Flag unresolved bindings for production failure handling
                        if core_result["unresolved_count"] > 0:
                            subtask_row["_has_unresolved_bindings"] = True
                            subtask_row["_unresolved_binding_warnings"] = core_result["unresolved"]
                            subtask_row["_binding_errors"] = core_result.get("binding_errors", [])
                        # P0.5 Final Closure: Flag input_schema type mismatches as
                        # dispatch blocker (runtime contract enforcement).
                        if not core_result.get("input_schema_valid", True):
                            subtask_row["_has_input_schema_errors"] = True
                            subtask_row["_input_schema_errors"] = [
                                e["message"] for e in core_result.get("binding_errors", [])
                                if e.get("code") == "TYPE_MISMATCH"
                            ]
    except Exception:
        logger.debug("extract plan context failed for subtask=%s", subtask_id, exc_info=True)

    # Inject workspace environment context so workers don't waste turns discovering project structure
    try:
        import os

        from evoflow.config.paths import get_paths

        paths = get_paths()
        workspace_root = str(getattr(paths, "workspace_root", "") or getattr(paths, "project_root", "") or "").strip()
        if workspace_root and os.path.isdir(workspace_root):
            env_lines: list[str] = ["## 工作区环境上下文（自动扫描）"]
            for entry in os.listdir(workspace_root):
                full = os.path.join(workspace_root, entry)
                if not os.path.isdir(full):
                    continue
                hf_json = os.path.join(full, "hyperframes.json")
                pkg_json = os.path.join(full, "package.json")
                cargo_toml = os.path.join(full, "Cargo.toml")
                pyproject = os.path.join(full, "pyproject.toml")
                if os.path.isfile(hf_json):
                    env_lines.append(f"- `{entry}/` 是 HyperFrames 项目目录（含 hyperframes.json）——lint/render 命令应指向此目录")
                if os.path.isfile(pkg_json):
                    env_lines.append(f"- `{entry}/` 含 package.json（Node.js 项目）")
                if os.path.isfile(cargo_toml):
                    env_lines.append(f"- `{entry}/` 含 Cargo.toml（Rust 项目）")
                if os.path.isfile(pyproject):
                    env_lines.append(f"- `{entry}/` 含 pyproject.toml（Python 项目）")
            if len(env_lines) > 1:
                extra_blocks.append("\n".join(env_lines))
    except Exception:
        logger.debug("workspace env context scan failed for subtask=%s", subtask_id, exc_info=True)

    try:
        from evoflow.collab.subtask_outcome import format_subtask_outcome_mandate_block
        from evoflow.collab.task_progress import format_subtask_progress_mandate_block

        extra_blocks.insert(0, format_subtask_progress_mandate_block())
        extra_blocks.insert(1, format_subtask_outcome_mandate_block())
    except Exception:
        logger.debug("collab mandate prompt blocks failed subtask=%s", subtask_id, exc_info=True)

    try:
        from evoflow.collab.work_checklist import (
            checklist_is_ready,
            format_checklist_system_block,
            format_worker_checklist_bootstrap_block,
            get_subtask_work_checklist,
        )

        checklist = get_subtask_work_checklist(subtask_row)
        if checklist_is_ready(checklist):
            extra_blocks.insert(0, format_checklist_system_block(checklist))
        else:
            extra_blocks.insert(0, format_worker_checklist_bootstrap_block())
    except Exception:
        logger.debug("work_checklist prompt block failed subtask=%s", subtask_id, exc_info=True)

    try:
        from evoflow.collab.peer.prompt import format_peer_wake_prompt_block
        from evoflow.collab.peer.wake_context import peek_peer_wake_context

        wake = peek_peer_wake_context(main_task_id, subtask_id)
        tk = str((wake or {}).get("thread_key") or "").strip()
        mode = str((wake or {}).get("mode") or "collaboration").strip()
        if tk:
            extra_blocks.insert(0, format_peer_wake_prompt_block(storage, main_task_id, thread_key=tk, mode=mode))
    except Exception:
        logger.debug("peer wake prompt block failed subtask=%s", subtask_id, exc_info=True)

    if not extra_blocks:
        return base_prompt

    return base_prompt + "\n\n" + "\n\n".join(extra_blocks)


__all__ = [
    "delegate_collab_subtasks_for_start_execution",
    "delegate_collab_subtask_peer_wake",
    "auto_delegate_collab_followup_wave",
    "_resolved_subagent_type_for_subtask",
    "_extract_plan_context_for_subtask_from_steps",
    "_build_subtask_enriched_prompt",
    "_verify_upstream_artifacts_before_followup",
]

# ── Register followup handler on collab_bridge at import time ─────────
# This allows task_tool.py to call auto_delegate_collab_followup_wave
# without directly importing supervisor (breaks circular dependency).
try:
    from evoflow.tools.builtins.collab_bridge import register_followup_handler

    register_followup_handler(auto_delegate_collab_followup_wave)
except Exception:
    logger.debug("collab_bridge: failed to register followup handler", exc_info=True)
