"""Execution delegation and auto-followup for supervisor subtasks.

Provides:
- delegate_collab_subtasks_for_start_execution — parallel subagent invocation via collab_bridge
- auto_delegate_collab_followup_wave — automatic wave-2+ delegation when upstream completes
"""

from __future__ import annotations

import asyncio
import logging
import os
from typing import Any

from langchain.tools import ToolRuntime
from langgraph.config import get_stream_writer
from langgraph.typing import ContextT

from evoflow.collab.id_format import make_formatted_id
from evoflow.collab.step_runner import (
    CLAIMABLE_SUBTASK_STATUSES as _CLAIMABLE_SUBTASK_STATUSES,
    claim_subtasks_for_delegation as _claim_subtasks_for_delegation,
    revert_claimed_subtasks_to_pending as _revert_claimed_subtasks_to_pending,
)
from evoflow.timeutil import utc_now_iso_z

logger = logging.getLogger(__name__)

# E-3: wave locks + lead runtime registry now live in collab.execution_kernel so
# workflow-side schedulers and Lead supervisor share ONE dict process-wide.
# Historical private names stay importable from here as thin aliases.
from evoflow.collab.execution_kernel import (  # noqa: E402
    drop_lead_runtime as _kernel_drop_lead_runtime,
    followup_lock_for_task as _kernel_followup_lock_for_task,
    resolve_followup_runtime as _kernel_resolve_followup_runtime,
    store_lead_runtime as _kernel_store_lead_runtime,
    verify_upstream_artifacts_before_followup as _kernel_verify_upstream_artifacts,
)

_followup_lock_for_task = _kernel_followup_lock_for_task
_verify_upstream_artifacts_before_followup = _kernel_verify_upstream_artifacts


def _runtime_is_subtask_worker(runtime: ToolRuntime[ContextT, dict] | None) -> bool:
    from evoflow.collab.thread_ids import is_collab_executor_thread
    from evoflow.tools.builtins.supervisor.utils import _runtime_thread_id

    tid = _runtime_thread_id(runtime)
    return is_collab_executor_thread(tid)


def _is_workflow_bound_main_task(storage: Any, main_task_id: str) -> bool:
    """True when the main task came from an App/workflow run (owns its own plan)."""
    try:
        from evoflow.collab.storage import find_main_task

        row = find_main_task(storage, main_task_id)
        if not row:
            return False
        _project, task = row
        if not isinstance(task, dict):
            return False
        return bool(task.get("app_definition_snapshot") or str(task.get("source_app_id") or "").strip())
    except Exception:
        logger.debug("is_workflow_bound_main_task probe failed main=%s", main_task_id, exc_info=True)
        return False


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
        # Only Lead-supervised tasks may own a thread. An App/workflow run is a
        # pure DAG: stamping the invoking chat's thread here made the run share
        # its observability bucket with the whole conversation (reported 144
        # model calls for a 21-call run). See also app_runner.run_app_workflow.
        if lead_tid and not _is_workflow_bound_main_task(get_project_storage(), mid):
            patch["thread_id"] = lead_tid
        elif lead_tid:
            logger.info(
                "collab skip thread pin for workflow task main=%s lead_tid=%r",
                mid,
                lead_tid,
            )
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

    attach_gateway_writer_to_runtime(runtime, tid)
    _kernel_store_lead_runtime(tid, runtime)
    _pin_collab_session_model_on_main_task(tid, runtime)


def unregister_collab_lead_runtime(main_task_id: str) -> None:
    """Drop strong/weak refs to lead runtime when a task reaches terminal."""
    _kernel_drop_lead_runtime(main_task_id)


def _resolve_collab_followup_runtime(
    runtime: ToolRuntime[ContextT, dict] | None,
    main_task_id: str,
) -> ToolRuntime[ContextT, dict] | None:
    return _kernel_resolve_followup_runtime(
        runtime,
        main_task_id,
        is_subtask_worker=_runtime_is_subtask_worker,
    )


# Register followup handler at import time so task_tool can call us via bridge.
# This is done lazily below (after function definitions) to avoid forward-ref issues.


def _worker_delegation_error(subagent_type: str) -> str | None:
    """Return a user-visible error when the worker cannot run; None if delegation may proceed."""
    stype = str(subagent_type or "").strip()
    if not stype:
        return "No worker assigned to subtask (set assigned_to or worker_profile.base_subagent)."
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


def _is_task_tool_preflight_error(text: str) -> bool:
    """True when task_tool rejected before execution (gate / validation), not a worker failure."""
    t = str(text or "").strip()
    return t.startswith("Error:")



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
    from evoflow.tools.builtins.collab_bridge import delegate_via_task_tool, ensure_collab_bridge_ready
    from evoflow.tools.builtins.supervisor.dependency import (
        _build_ref_to_id_index,
        _build_subtask_name_index,
        _resolve_dep_ref_to_id,
        _subtask_dep_ids,
    )

    if not subtask_ids:
        return []

    want_ids = [str(s).strip() for s in subtask_ids if str(s).strip()]

    # Pause gate — last stop before a worker is actually handed a step.
    # ``workflow.stop(pause=true)`` only relabels rows; an already-detached
    # worker keeps running and its completion re-enters here through the
    # claim → delegate path (``execution_kernel.delegate_claimed_subtasks``),
    # NOT through scheduler.advance_dag, so the two upstream gates miss it.
    # Live 2026-11-08 with both upstream gates installed: pause at 3% still
    # released step 2 at 37% and the run walked to completion.
    try:
        _pause_row = find_main_task(storage, str(main_task_id or "").strip())
        _pause_task = _pause_row[1] if _pause_row else None
        if isinstance(_pause_task, dict) and str(_pause_task.get("status") or "").strip().lower() in {
            "paused",
            "pausing",
        }:
            logger.info(
                "delegate_collab_subtasks_for_start_execution: refused, main task paused main=%s subs=%s",
                main_task_id,
                want_ids,
            )
            return [
                {
                    "subtaskId": sid,
                    "ok": False,
                    "error": "paused",
                    "message": "主任务已暂停，不派发该子任务；workflow.resume 后重新派发。",
                }
                for sid in want_ids
            ]
    except Exception:
        logger.debug("delegate pause gate check failed main=%s", main_task_id, exc_info=True)

    _register_collab_lead_runtime(main_task_id, runtime)

    from evoflow.collab.dag_trace import dag_info, dag_warning
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
        tcid = make_formatted_id("SupervisorExec")
        # Pin the worker cwd to this run's project_path. task_tool understands
        # ``workspace_root`` but delegate signatures do not, so the value has to be
        # threaded explicitly; otherwise each worker inherits the host process cwd
        # and relative paths (outputs/...) resolve to different directories per step.
        worker_workspace_root = str(st.get("project_path") or "").strip() or str(default_project_path or "").strip() or None
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
                workspace_root=worker_workspace_root,
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

    # Belt-and-suspenders with wake.py: never re-claim a terminal step via peer.
    _PEER_WAKE_TERMINAL = frozenset({"completed", "failed", "cancelled", "canceled", "timed_out"})
    cur = str(st.get("status") or "").strip().lower()
    if cur in _PEER_WAKE_TERMINAL:
        return {
            "ok": True,
            "skipped": True,
            "reason": "terminal_no_redispatch",
            "status": cur,
        }

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

        to_run_peek, blocked = _resolve_subtasks_for_start_execution(storage, tid, None)
        dag_info(
            "followup_resolve main=%s runnable=%s blocked=%s",
            tid,
            to_run_peek,
            blocked[:16],
        )
        if not to_run_peek:
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
            from evoflow.collab.step_runner import advance_runnable_wave

            delegated = await advance_runnable_wave(
                runtime,
                storage,
                tid,
                wait_for_completion=False,
            )
        except Exception:
            logger.exception("auto_delegate_collab_followup_wave: delegate failed task_id=%s", tid)
            dag_warning("followup_delegate_exception main=%s subs=%s", tid, to_run_peek)
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
            len(to_run_peek),
            to_run_peek,
            _subtask_status_snapshot(storage, tid),
        )


def _resolved_subagent_type_for_subtask(st: dict) -> str:
    """Prefer explicit assigned_to on the subtask row; else worker_profile.base_subagent; else default.

    Falls back to ``Agent`` if nothing is assigned.
    """
    resolved = "agent"
    a = (st.get("assigned_to") or "").strip()
    if a:
        resolved = a
    else:
        wp = st.get("worker_profile")
        if isinstance(wp, dict):
            b = str(wp.get("base_subagent") or "").strip()
            if b:
                resolved = b
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
            # CRITICAL: production only cherry-picks the resolved-inputs block from
            # build_core_prompt — it must ALSO inject format_output_schema_for_prompt
            # or workers never see the structured-output contract (downstream
            # {{steps.N.output.field}} then fails at the next hop).
            ref = str(subtask_row.get("ref") or "").strip()
            semantic_ref = str(subtask_row.get("semantic_ref") or "").strip()
            if ref or semantic_ref:
                params = task.get("run_parameters") or {}
                if not isinstance(params, dict):
                    params = {}
                matching_step = None
                for ps in plan_steps or []:
                    if not isinstance(ps, dict):
                        continue
                    ps_ref = str(ps.get("ref") or "").strip()
                    ps_sem = str(ps.get("semantic_ref") or "").strip()
                    if (ref and ps_ref == ref) or (semantic_ref and (ps_ref == semantic_ref or ps_sem == semantic_ref)):
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
                            subtask_row["_input_schema_errors"] = [e["message"] for e in core_result.get("binding_errors", []) if e.get("code") == "TYPE_MISMATCH"]
                if matching_step:
                    from evoflow.collab.step_prompt_builder import format_output_schema_for_prompt

                    schema_block = format_output_schema_for_prompt(matching_step.get("output_schema"))
                    if schema_block:
                        # Prefer early placement so the contract is not buried under
                        # workspace-scan / self-check noise. Later inserts (peer /
                        # checklist / mandate) may still push ahead — that is fine;
                        # the contract must at least be present.
                        extra_blocks.insert(0, schema_block)
                        subtask_row["_has_output_schema_contract"] = True
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

    reporting_mode = "full"
    try:
        from evoflow.collab.storage import find_main_task
        from evoflow.collab.subtask_reporting import (
            format_subtask_outcome_mandate_block,
            format_subtask_progress_mandate_block,
            resolve_subtask_reporting_mode,
        )

        main_row = None
        found = find_main_task(storage, main_task_id) if storage is not None else None
        if found:
            _proj, main_row = found
        reporting_mode = resolve_subtask_reporting_mode(
            subtask_row=subtask_row if isinstance(subtask_row, dict) else None,
            main_task=main_row if isinstance(main_row, dict) else None,
        )
        extra_blocks.insert(0, format_subtask_progress_mandate_block(mode=reporting_mode))
        extra_blocks.insert(1, format_subtask_outcome_mandate_block(mode=reporting_mode))
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
            # Already set (Lead or prior turn) — keep snapshot even in light mode.
            extra_blocks.insert(0, format_checklist_system_block(checklist))
        elif reporting_mode != "light":
            # Full Lead collab: bootstrap requires set before heavy work.
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
