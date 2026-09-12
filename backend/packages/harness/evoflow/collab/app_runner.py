"""Application execution runner: unified entry for both execution modes.

- **lead_supervised**: Uses existing plan session task flow (thread-bound, requires
  user authorization, lead agent monitors and can intervene).
- **workflow**: Pure DAG execution without lead agent context (auto-authorized,
  auto follow-up wave pushes to completion).
"""

from __future__ import annotations

import asyncio
import concurrent.futures
import json
import re
import uuid
from typing import Any

from evoflow.collab.app_engine import render_plan, validate_parameters
from evoflow.collab.plan_session_task import bind_plan_to_thread_task, ensure_plan_session_task
from evoflow.collab.storage import get_project_storage, new_project_bundle_root_task
from evoflow.collab.thread_collab import advance_collab_phase_to_plan_ready_for_task
from evoflow.persistence import app_repositories
from evoflow.persistence.task_repositories import save_task_bundle
from evoflow.timeutil import utc_now_iso_z

_STEP_NAME_REF_RE = re.compile(r"(?i)^\s*step\s+(\d+)\s*[:：]")


def _dispatch_result_ok(parsed: dict[str, Any] | None) -> bool:
    if not isinstance(parsed, dict):
        return False
    if parsed.get("success"):
        return True
    delegated = parsed.get("delegatedSubtasks")
    return isinstance(delegated, list) and any(isinstance(d, dict) and d.get("ok") for d in delegated)


def is_workflow_bound_task(task: dict[str, Any] | None) -> bool:
    """Published App / workflow DAG runs do not need a Lead LangGraph thread."""
    if not isinstance(task, dict):
        return False
    if task.get("app_definition_snapshot"):
        return True
    if str(task.get("source_app_id") or "").strip():
        return True
    return False


async def dispatch_workflow_task_now(
    task_id: str,
    *,
    authorized_by: str = "api",
) -> dict[str, Any]:
    """Dispatch a workflow-app task (DAG / task_tool) without a Lead thread.

    Safe to call from the Gateway asyncio loop (automation manual trigger, app run API).
    """
    import logging

    logger = logging.getLogger(__name__)
    tid = str(task_id or "").strip()
    if not tid:
        return {"success": False, "error": "task_id is required"}

    storage = get_project_storage()
    row = storage.load_project(tid)
    if not row or not (row.get("tasks") or []):
        return {"success": False, "error": "task_not_found", "taskId": tid}
    task = row["tasks"][0]
    if not is_workflow_bound_task(task):
        return {"success": False, "error": "not_workflow_bound_task", "taskId": tid}

    from evoflow.collab.authorize_execution import authorize_main_task_execution, is_task_execution_authorized

    if not is_task_execution_authorized(storage, tid):
        ok, msg = authorize_main_task_execution(storage, tid, authorized_by)
        if not ok:
            return {"success": False, "error": f"authorize_failed:{msg}", "taskId": tid}

    from evoflow.collab.dispatch_authorized_execution import dispatch_authorized_main_task_execution
    from evoflow.collab.plan_subtasks_sync import ensure_subtasks_synced_before_start_execution

    try:
        ensure_subtasks_synced_before_start_execution(tid, storage=storage)
    except Exception as sync_exc:
        logger.warning("dispatch_workflow_task_now: subtasks pre-sync failed task_id=%s: %s", tid, sync_exc)
        return {"success": False, "error": f"subtasks_sync_failed:{sync_exc}", "taskId": tid}

    parsed = await dispatch_authorized_main_task_execution(
        tid,
        thread_id=None,
        authorized_by=authorized_by,
    )
    err: str | None = None
    if not _dispatch_result_ok(parsed):
        err = str((parsed or {}).get("error") or (parsed or {}).get("message") or "dispatch_failed")
        logger.warning(
            "dispatch_workflow_task_now: incomplete task_id=%s err=%s raw=%s",
            tid,
            err[:500],
            json.dumps(parsed or {}, ensure_ascii=False)[:800],
        )
    _persist_workflow_dispatch_outcome(tid, parsed, error=err)
    return parsed if isinstance(parsed, dict) else {"success": False, "error": err or "dispatch_failed", "taskId": tid}


def _run_coroutine_sync(coro: Any) -> Any:
    """Run async workflow dispatch from sync callers (platform tool, CLI, run_app)."""

    def _run() -> Any:
        return asyncio.run(coro)

    try:
        running = asyncio.get_running_loop()
    except RuntimeError:
        running = None
    if running is not None and running.is_running():
        with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
            return pool.submit(_run).result()
    return _run()


def dispatch_workflow_task_sync(
    task_id: str,
    *,
    authorized_by: str = "api",
) -> dict[str, Any]:
    """Synchronous wrapper for :func:`dispatch_workflow_task_now`."""
    return _run_coroutine_sync(
        dispatch_workflow_task_now(task_id, authorized_by=authorized_by)
    )


def apply_workflow_dispatch(
    result: dict[str, Any],
    *,
    authorized_by: str = "api",
) -> dict[str, Any]:
    """Dispatch a workflow run result and merge dispatch outcome into the caller payload."""
    if str(result.get("execution_mode") or "") != "workflow":
        return result
    task_id = str(result.get("task_id") or "").strip()
    if not task_id:
        return result

    existing = result.get("dispatch")
    if isinstance(existing, dict) and _dispatch_result_ok(existing):
        if str(result.get("status") or "").strip().lower() == "planned":
            result = {**result, "status": "executing"}
        return result

    dispatch = dispatch_workflow_task_sync(task_id, authorized_by=authorized_by)
    merged: dict[str, Any] = {**result, "dispatch": dispatch}
    if _dispatch_result_ok(dispatch):
        merged["status"] = "executing"
    else:
        run_id = str(result.get("run_id") or "").strip()
        _schedule_workflow_dispatch(task_id, run_id)
    return merged


def _persist_workflow_dispatch_outcome(
    task_id: str,
    parsed: dict[str, Any] | None,
    *,
    error: str | None = None,
) -> None:
    """Reflect workflow dispatch outcome on the Task Center row (not only app run record)."""
    import logging

    logger = logging.getLogger(__name__)
    tid = str(task_id or "").strip()
    if not tid:
        return
    storage = get_project_storage()
    row = storage.load_project(tid)
    if not row or not (row.get("tasks") or []):
        return
    task = dict(row["tasks"][0])
    now = utc_now_iso_z()
    err = str(error or "").strip()
    if not err and isinstance(parsed, dict):
        err = str(parsed.get("error") or parsed.get("message") or "").strip()
    if _dispatch_result_ok(parsed):
        task["status"] = "executing"
        task["started_at"] = task.get("started_at") or now
        task["error"] = None
        task["unattended_stage"] = "executing"
    elif err:
        task["error"] = err[:2000]
        task["unattended_stage"] = task.get("unattended_stage") or "dispatch_retry"
    task["updated_at"] = now
    row["tasks"] = [task] + list(row["tasks"][1:])
    row["updated_at"] = now
    if not storage.save_project(row):
        logger.warning("app_runner: persist dispatch outcome failed task_id=%s", tid)


def _schedule_unattended_queue_advance(task_id: str) -> None:
    """Best-effort pipeline advance on the persistent detached-poll loop."""
    tid = str(task_id or "").strip()
    if not tid:
        return

    async def _go() -> None:
        try:
            from app.gateway.unattended_task_pipeline import advance_unattended_task

            result = await advance_unattended_task(tid)
            import logging

            logging.getLogger(__name__).info(
                "app_runner: queue advance task_id=%s action=%s",
                tid,
                (result or {}).get("action") or (result or {}).get("error"),
            )
        except Exception:
            import logging

            logging.getLogger(__name__).warning(
                "app_runner: queue advance failed task_id=%s",
                tid,
                exc_info=True,
            )

    try:
        from evoflow.subagents.detached_poll_scheduler import schedule_detached_poll

        schedule_detached_poll(_go(), name=f"workflow-queue-{tid[:12]}")
    except Exception:
        import logging

        logging.getLogger(__name__).debug("app_runner: schedule queue advance failed task_id=%s", tid, exc_info=True)


def _schedule_workflow_dispatch(task_id: str, run_id: str) -> None:
    """Dispatch authorized execution on the persistent poll loop (reliable async context)."""
    tid = str(task_id or "").strip()
    if not tid:
        return

    async def _run() -> None:
        import logging

        logger = logging.getLogger(__name__)
        parsed: dict[str, Any] | None = None
        err: str | None = None
        try:
            from evoflow.collab.dispatch_authorized_execution import (
                dispatch_authorized_main_task_execution,
            )

            parsed = await dispatch_authorized_main_task_execution(
                tid, thread_id=None, authorized_by="api"
            )
            if not _dispatch_result_ok(parsed):
                err = str((parsed or {}).get("error") or (parsed or {}).get("message") or "dispatch_failed")
                logger.warning(
                    "app_runner: workflow dispatch incomplete task_id=%s err=%s parsed=%s",
                    tid,
                    err[:500],
                    json.dumps(parsed or {}, ensure_ascii=False)[:800],
                )
        except Exception as exc:
            err = str(exc)
            logger.exception("app_runner: workflow dispatch failed task_id=%s", tid)
        finally:
            _persist_workflow_dispatch_outcome(tid, parsed, error=err)
            if run_id:
                try:
                    if err and not _dispatch_result_ok(parsed):
                        app_repositories.update_run_status(
                            run_id, "executing", error=f"Dispatch error: {err[:500]}"
                        )
                except Exception:
                    pass
            if not _dispatch_result_ok(parsed):
                _schedule_unattended_queue_advance(tid)

    try:
        from evoflow.subagents.detached_poll_scheduler import schedule_detached_poll

        schedule_detached_poll(_run(), name=f"workflow-dispatch-{tid[:12]}")
    except Exception as exc:
        import logging

        logging.getLogger(__name__).exception(
            "app_runner: schedule workflow dispatch failed task_id=%s: %s",
            tid,
            exc,
        )
        _schedule_unattended_queue_advance(tid)


def _coerce_text_blob(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        return value.strip()
    if isinstance(value, dict):
        for key in ("summary", "result", "text", "content", "message", "output"):
            text = str(value.get(key) or "").strip()
            if text:
                return text
        try:
            return json.dumps(value, ensure_ascii=False)
        except Exception:
            return str(value).strip()
    if isinstance(value, (list, tuple)):
        parts = [_coerce_text_blob(x) for x in value]
        return "\n".join(p for p in parts if p).strip()
    return str(value).strip()


def _subtask_result_text(st: dict[str, Any]) -> str:
    """Prefer official task_report; fall back to result / summaries / last output."""
    try:
        from evoflow.collab.subtask_outcome import get_subtask_task_report

        report = get_subtask_task_report(st)
        if report:
            return report
    except Exception:
        pass
    for key in (
        "task_report",
        "result_summary",
        "result_text",
        "output_summary",
        "result",
        "summary",
        "last_assistant_text",
        "final_answer",
    ):
        text = _coerce_text_blob(st.get(key))
        if text:
            return text
    extra = st.get("extra") if isinstance(st.get("extra"), dict) else {}
    for key in ("result_summary", "task_report", "summary", "output"):
        text = _coerce_text_blob(extra.get(key))
        if text:
            return text
    return ""


def _resolve_subtask_ref(st: dict[str, Any], *, index: int, plan_steps: list[dict[str, Any]]) -> str:
    """Recover step ref lost across DB roundtrip (or never written)."""
    ref = str(st.get("ref") or "").strip()
    if ref:
        return ref
    name = str(st.get("name") or "").strip()
    m = _STEP_NAME_REF_RE.match(name)
    if m:
        return str(int(m.group(1)))
    if 0 <= index < len(plan_steps):
        step = plan_steps[index]
        step_ref = str(step.get("ref") or step.get("step_num") or "").strip()
        if step_ref:
            return step_ref
    return str(index + 1)


def _make_run_id() -> str:
    return f"Run_{utc_now_iso_z().replace(':', '').replace('-', '').replace('T', '').split('.')[0]}_{uuid.uuid4().hex[:6]}"


def _make_task_id() -> str:
    from evoflow.collab.id_format import make_task_id

    return make_task_id()


def _normalize_run_kind(value: str | None) -> str:
    """Canonical run kind for Task Center: debug | production | scheduled."""
    raw = str(value or "").strip().lower()
    if raw in {"debug", "调试", "debug_run"}:
        return "debug"
    if raw in {"scheduled", "cron", "定时", "timer"}:
        return "scheduled"
    if raw in {"production", "formal", "正式", "prod", "live"}:
        return "production"
    return "production" if raw else "debug"


def _stamp_task_app_source(
    task_data: dict[str, Any],
    *,
    app_id: str,
    run_id: str,
    app_version: int,
    app_name: str = "",
    channel: str = "app_runner",
    run_kind: str = "debug",
    trigger_kind: str = "manual",
    parameters: dict[str, str] | None = None,
) -> None:
    """Mark task as originating from an App run (lands in collab_tasks.extra_json).

    Also sets canonical ``source=workflow`` so Task Center type column / filters work.
    """
    from evoflow.collab.task_source import TASK_SOURCE_WORKFLOW, resolve_write_source

    src, ch = resolve_write_source(channel or "app_runner", default=TASK_SOURCE_WORKFLOW)
    task_data["source"] = src
    if ch:
        task_data["source_channel"] = ch
    task_data["source_app_id"] = app_id
    task_data["source_run_id"] = run_id
    task_data["source_app_version"] = int(app_version)
    if app_name:
        task_data["source_app_name"] = app_name
    task_data["run_kind"] = _normalize_run_kind(run_kind)
    trig = str(trigger_kind or "manual").strip().lower() or "manual"
    task_data["trigger_kind"] = trig
    if parameters is not None:
        # Snapshot for Task Center / detail without joining runs table.
        try:
            task_data["run_parameters"] = dict(parameters)
            task_data["run_parameter_count"] = len(parameters)
        except Exception:
            task_data["run_parameter_count"] = 0


def _persist_task_app_source(task_id: str, **fields: Any) -> None:
    """Best-effort patch of an already-saved task with App provenance fields."""
    try:
        from evoflow.collab.task_source import TASK_SOURCE_WORKFLOW, resolve_write_source

        storage = get_project_storage()
        bundle = storage.load_project(task_id)
        if not bundle:
            return
        tasks = bundle.get("tasks") or []
        if not tasks:
            return
        root = tasks[0]
        # Ensure canonical source when stamping app provenance
        if "source" not in fields and not str(root.get("source") or "").strip():
            src, ch = resolve_write_source("app_runner", default=TASK_SOURCE_WORKFLOW)
            root["source"] = src
            if ch:
                root["source_channel"] = ch
        for key, value in fields.items():
            if value is not None:
                root[key] = value
        save_task_bundle(task_id, bundle)
    except Exception:
        pass


def _create_lead_thread(*, app_id: str, app_name: str = "") -> str:
    """Create a LangGraph thread for lead_supervised when UI did not pass thread_id.

    Retries up to 3 times with exponential backoff to handle transient
    LangGraph startup / network issues.
    """
    import os
    import time

    import httpx

    base = (
        os.getenv("EVOFLOW_LANGGRAPH_URL", "http://127.0.0.1:8070/api/langgraph") or ""
    ).rstrip("/")
    if not base:
        raise ValueError("EVOFLOW_LANGGRAPH_URL is not configured")
    body = {
        "metadata": {
            "source": "app_runner_lead",
            "app_id": app_id,
            "app_name": app_name or "",
        }
    }
    last_err: Exception | None = None
    for attempt in range(3):
        try:
            with httpx.Client(timeout=30.0) as client:
                resp = client.post(f"{base}/threads", json=body)
                resp.raise_for_status()
                data = resp.json() if resp.content else {}
            tid = ""
            if isinstance(data, dict):
                tid = str(data.get("thread_id") or data.get("threadId") or data.get("id") or "").strip()
            if tid:
                return tid
            raise ValueError("Empty thread_id in response")
        except Exception as exc:
            last_err = exc
            if attempt < 2:
                time.sleep(0.5 * (attempt + 1))  # 0.5s, 1.0s backoff
    raise ValueError(
        f"Failed to create thread for lead_supervised mode after 3 retries: {last_err}"
    )


_TASK_STATUS_TO_RUN = {
    "completed": "completed",
    "failed": "failed",
    "cancelled": "cancelled",
    "canceled": "cancelled",
    "paused": "paused",
    "executing": "executing",
    "running": "executing",
    "planned": "planned",
    "plan_ready": "plan_ready",
    "waiting_dispatch": "planned",
    "planning": "plan_ready",
}


def _sync_run_from_task(run: dict[str, Any], *, task_status: str, progress: int) -> str:
    """Write task progress/status back onto evoflow_app_runs; return effective run status."""
    run_id = str(run.get("id") or "").strip()
    mapped = _TASK_STATUS_TO_RUN.get(str(task_status or "").strip().lower())
    current = str(run.get("status") or "").strip().lower()
    effective = mapped or current or "running"
    prog = int(progress or 0)
    # 应用运行：completed 一律展示 / 落库 100%（协作主任务中间态仍可能是 99）
    if effective == "completed" or mapped == "completed":
        prog = 100
    if not run_id:
        return effective
    fields: dict[str, Any] = {"progress": prog}
    if mapped and mapped != current:
        app_repositories.update_run_status(run_id, mapped, **fields)
        run["status"] = mapped
        run["progress"] = prog
        return mapped
    # 终态已 completed 但进度仍停在 99：补齐到 100
    if current == "completed" and int(run.get("progress") or 0) < 100:
        app_repositories.update_run_status(run_id, "completed", progress=100)
        run["progress"] = 100
        return current
    # Always refresh progress while running
    if current not in ("completed", "failed", "cancelled") and prog != int(run.get("progress") or 0):
        app_repositories.update_run_status(run_id, current or "running", **fields)
        run["progress"] = prog
    return effective


# ────────────────────────────────── Lead Supervised Mode ─────────────────────────────────


def run_app_lead_supervised(
    app_id: str,
    parameters: dict[str, str],
    thread_id: str,
    *,
    run_kind: str = "debug",
    trigger_kind: str = "manual",
) -> dict[str, Any]:
    """Run an application in lead-supervised mode (reuses plan session infrastructure).

    Creates a thread-bound plan placeholder task, binds the rendered plan,
    advances to `plan_ready` status (waits for user authorization before
    supervisor dispatches subtasks).

    Returns:
        Run metadata + task center bindings
    """
    # 1. Load app definition
    app = app_repositories.load_app(app_id)
    if app is None:
        raise ValueError(f"Application not found: {app_id}")

    # 2. Validate parameters
    is_valid, missing, undefined = validate_parameters(app, parameters)
    if not is_valid:
        raise ValueError(f"Parameter validation failed: missing={missing}, undefined={undefined}")

    # 3. Render plan from app + parameters
    plan_input = render_plan(app, parameters)

    # 4. Ensure placeholder task exists for this thread (reuses existing)
    task_id, _task_name = ensure_plan_session_task(thread_id, plan_input["goal"])

    # 5. Bind rendered plan to thread -> writes plan fields + syncs subtasks
    result = bind_plan_to_thread_task(thread_id, plan_input, existing_task_id=task_id)

    # 6. Advance collab phase to plan_ready (waiting for user authorize/start_execution)
    from evoflow.persistence.db import get_db

    advance_collab_phase_to_plan_ready_for_task(
        get_db(), get_project_storage(), task_id, "app_runner"
    )

    # 7. Create run record
    run_id = _make_run_id()
    app_version = int(app.get("version") or 1)
    kind = _normalize_run_kind(run_kind)
    app_name = str(app.get("name") or "").strip()
    app_repositories.save_run(
        run_id,
        {
            "app_id": app_id,
            "app_version": app_version,
            "parameters": parameters,
            "execution_mode": "lead_supervised",
            "task_id": task_id,
            "thread_id": thread_id,
            "status": "plan_ready",
            "progress": 0,
            "answer_from_ref": str(app.get("answer_from_ref") or "").strip(),
            "run_kind": kind,
            "trigger_kind": str(trigger_kind or "manual").strip().lower() or "manual",
        },
    )
    _persist_task_app_source(
        task_id,
        source_app_id=app_id,
        source_run_id=run_id,
        source_app_version=app_version,
        source_app_name=app_name,
        run_kind=kind,
        trigger_kind=str(trigger_kind or "manual").strip().lower() or "manual",
        run_parameters=dict(parameters or {}),
        run_parameter_count=len(parameters or {}),
        # Prefer short app name in Task Center when placeholder still holds goal text.
        **({"name": app_name[:120]} if app_name else {}),
    )
    app_repositories.increment_app_usage(app_id)

    return {
        "run_id": run_id,
        "task_id": task_id,
        "thread_id": thread_id,
        "execution_mode": "lead_supervised",
        "run_kind": kind,
        "status": "plan_ready",
        "plan": plan_input,
        "subtasks_sync": result.get("subtasks_sync", {}),
        "step_ref_to_subtask_id": result.get("step_ref_to_subtask_id", {}),
    }


# ─────────────────────────────────── Pure Workflow Mode ──────────────────────────────────


def run_app_workflow(
    app_id: str,
    parameters: dict[str, str],
    auto_authorize: bool = True,
    *,
    app: dict[str, Any] | None = None,
    app_version: int | None = None,
    run_kind: str = "debug",
    trigger_kind: str = "manual",
) -> dict[str, Any]:
    """Run an application in pure workflow mode (no lead agent, DAG auto-execution).

    Creates an independent task bundle (not thread-bound), binds the rendered
    plan, syncs subtasks, and auto-authorizes execution. Supervisor's
    auto-followup wave drives DAG completion without lead intervention.

    One workflow run = one Task Center row. Plan steps become nested node runs
    (``subtasks[]``), not separate top-level tasks.

    Args:
        app: Optional preloaded definition (e.g. pinned revision snapshot).
        app_version: Optional pin; used with :func:`load_app_for_run` when ``app`` omitted.
        run_kind: ``debug`` | ``production`` | ``scheduled`` (Task Center标签).
        trigger_kind: How the run was started (``manual`` | ``api`` | ``schedule`` …).

    Returns:
        Run metadata + task center bindings
    """
    # 1. Load app definition
    if app is None:
        if app_version is not None:
            from evoflow.collab.app_openai_compat import load_app_for_run

            app = load_app_for_run(app_id, pinned_version=int(app_version))
        else:
            app = app_repositories.load_app(app_id)
    if app is None:
        raise ValueError(f"Application not found: {app_id}")

    # 2. Validate parameters
    is_valid, missing, undefined = validate_parameters(app, parameters)
    if not is_valid:
        raise ValueError(f"Parameter validation failed: missing={missing}, undefined={undefined}")

    # 3. Render plan from app + parameters
    plan_input = render_plan(app, parameters)

    # 4. Create new task bundle (not thread-bound — workflow runs are standalone).
    # Task Center title = short app name; full goal lives in plan_goal / description.
    app_name = str(app.get("name") or "").strip() or "应用"
    goal_text = str(plan_input.get("goal") or "").strip()
    name = app_name[:120]
    description = goal_text[:4000] if goal_text else f"工作流运行：{app_name}"

    project_data, task_data = new_project_bundle_root_task(
        name, description, thread_id=None
    )
    task_id = str(task_data.get("id") or "")
    run_id = _make_run_id()
    app_version = int(app.get("version") or 1)
    _stamp_task_app_source(
        task_data,
        app_id=app_id,
        run_id=run_id,
        app_version=app_version,
        app_name=app_name,
        run_kind=run_kind,
        trigger_kind=trigger_kind,
        parameters=parameters,
    )

    # Mark as unattended so the task_queue_runner auto-advances through
    # authorize -> dispatch -> follow-up waves without a lead agent.
    task_data["run_mode"] = "unattended"

    # P0.5-6: Snapshot the app definition into the task row so that
    # debug_run_from_step / re-runs use the exact definition at run time,
    # not a potentially-mutated live copy. The snapshot is a compact copy
    # containing only the fields needed for execution (steps, parameters,
    # canvas, rollup config, schema_enforcement).
    task_data["app_definition_snapshot"] = {
        "app_id": app_id,
        "version": app_version,
        "name": app_name,
        "steps": app.get("steps") or [],
        "parameters": app.get("parameters") or [],
        "goal_template": str(app.get("goal_template") or ""),
        "flowchart_mermaid": str(app.get("flowchart_mermaid") or ""),
        "validation_template": app.get("validation_template") or [],
        "execution_mode": str(app.get("execution_mode") or "workflow"),
        "final_rollup": str(app.get("final_rollup") or "auto"),
        "final_rollup_agent": str(app.get("final_rollup_agent") or ""),
        "final_rollup_instruction": str(app.get("final_rollup_instruction") or ""),
        "answer_from_ref": str(app.get("answer_from_ref") or ""),
        "schema_enforcement": str(app.get("schema_enforcement") or "warn"),
    }

    # Stamp rollup mode onto the task so downstream rollup logic can read it
    # without joining the apps table. Rollup is mandatory for multi-step
    # workflows: legacy 'off' (and any unknown value) resolves to 'auto' — there
    # is no "disable rollup" state.
    rollup_mode = str(app.get("final_rollup") or "auto").strip().lower()
    if rollup_mode == "answer_node_only":
        task_data["final_rollup"] = "answer_node_only"
        task_data["answer_from_ref"] = str(app.get("answer_from_ref") or "").strip()
    else:
        # 'off' and unknown values are NOT a "no rollup" escape hatch.
        rollup_mode = "auto"
        task_data["final_rollup"] = "auto"
        task_data["answer_from_ref"] = str(app.get("answer_from_ref") or "").strip()

    # 5. Manually write plan fields (we don't go through bind_plan_to_thread_task
    # because workflow runs are not thread-bound and don't need collab_phase tracking)
    from evoflow.collab.plan_subtasks_sync import sync_subtasks_from_plan_steps
    from evoflow.collab.plan_task_storage import write_plan_fields

    storage = get_project_storage()
    write_plan_fields(
        task_data,
        goal=plan_input["goal"],
        steps=plan_input["steps"],
        flowchart_mermaid=plan_input.get("flowchart_mermaid"),
        validation=plan_input.get("validation"),
        open_questions=plan_input.get("open_questions", "无"),
    )

    # 6. Persist task bundle to DB (planned + plan_bound)
    task_data["status"] = "planned"
    task_data["plan_bound_at"] = utc_now_iso_z()
    # Root task is project_data["tasks"][0] — keep stamp on shared dict
    save_task_bundle(task_id, project_data)

    # 7. Sync subtasks from plan steps (reads task from DB)
    sync_result = sync_subtasks_from_plan_steps(
        task_id, plan_input["steps"], storage=storage, goal=plan_input["goal"]
    )

    # 7.5 Auto rollup: append virtual rollup subtask when mode=auto and multi-step.
    # Must happen after sync_subtasks and before auto_authorize so the rollup
    # step is included in the initial DAG dispatch graph.
    if rollup_mode == "auto":
        from evoflow.collab.app_rollup import append_rollup_subtask

        rollup_info = append_rollup_subtask(
            task_id,
            app,
            goal=plan_input.get("goal", ""),
            validation=plan_input.get("validation", []),
            storage=storage,
        )
        if rollup_info and isinstance(sync_result, dict):
            created_list = list(sync_result.get("created") or [])
            created_list.append(rollup_info)
            sync_result = {
                **sync_result,
                "created": created_list,
                "rollup_step_added": True,
                "rollup_step": rollup_info,
            }

    # 8. Auto-authorize execution (workflow mode skips user confirmation)
    if auto_authorize:
        from evoflow.collab.authorize_execution import authorize_main_task_execution

        authorize_main_task_execution(storage, task_id, "api")

    # 9. run_app() applies dispatch synchronously via apply_workflow_dispatch().
    #    detached_poll (_schedule_workflow_dispatch) is fallback when sync dispatch fails.

    # 10. Create run record
    kind = _normalize_run_kind(run_kind)
    app_repositories.save_run(
        run_id,
        {
            "app_id": app_id,
            "app_version": app_version,
            "parameters": parameters,
            "execution_mode": "workflow",
            "task_id": task_id,
            "thread_id": None,
            "status": "planned",
            "progress": 0,
            "answer_from_ref": str(app.get("answer_from_ref") or "").strip(),
            "run_kind": kind,
            "trigger_kind": str(trigger_kind or "manual").strip().lower() or "manual",
        },
    )
    app_repositories.increment_app_usage(app_id)

    return {
        "run_id": run_id,
        "task_id": task_id,
        "execution_mode": "workflow",
        "run_kind": kind,
        "status": str(task_data.get("status") or "planned"),
        "plan": plan_input,
        "subtasks_sync": sync_result,
        "auto_authorized": auto_authorize,
    }


# ─────────────────────────────────── Unified Entry Point ─────────────────────────────────


def run_app(
    app_id: str,
    parameters: dict[str, str],
    execution_mode: str | None = None,
    thread_id: str | None = None,
    *,
    app_version: int | None = None,
    app: dict[str, Any] | None = None,
    run_kind: str | None = None,
    trigger_kind: str | None = None,
) -> dict[str, Any]:
    """Unified entry point for running an application.

    Args:
        app_id: Application ID to run
        parameters: Parameter values {param_name -> value}
        execution_mode: Override app's default mode ("workflow" | "lead_supervised")
        thread_id: Optional for lead_supervised; auto-created when missing
        app_version: Optional pinned revision for workflow OpenAPI runs
        app: Optional preloaded definition (wins over app_version load)
        run_kind: ``debug`` | ``production`` | ``scheduled`` (defaults by channel)
        trigger_kind: ``manual`` | ``api`` | ``schedule`` …

    Returns:
        Run result dict with run_id, task_id, status, etc.
    """
    if app is None:
        if app_version is not None:
            from evoflow.collab.app_openai_compat import load_app_for_run

            app = load_app_for_run(app_id, pinned_version=int(app_version))
        else:
            app = app_repositories.load_app(app_id)
    if app is None:
        raise ValueError(f"Application not found: {app_id}")

    mode = execution_mode or app.get("execution_mode", "workflow")
    kind = run_kind
    trigger = trigger_kind

    if mode == "lead_supervised":
        tid = str(thread_id or "").strip()
        if not tid:
            # User clicked「运行」without an open chat — create a dedicated thread.
            tid = _create_lead_thread(app_id=app_id, app_name=str(app.get("name") or ""))
        return run_app_lead_supervised(
            app_id,
            parameters,
            tid,
            run_kind=kind or "debug",
            trigger_kind=trigger or "manual",
        )
    elif mode == "workflow":
        # Explicit run() always authorizes + dispatches. App.auto_run remains a
        # definition flag for unattended/scheduled triggers; clicking「运行」is consent.
        # Pass app_version through only when app wasn't preloaded (caller didn't
        # already pin a revision).
        result = run_app_workflow(
            app_id,
            parameters,
            auto_authorize=True,
            app=app,
            app_version=app_version if app is None else None,
            run_kind=kind or "debug",
            trigger_kind=trigger or "manual",
        )
        auth = str(trigger or "manual").strip().lower() or "api"
        if auth in {"manual", "schedule", "scheduled", "cron"}:
            auth = "api"
        return apply_workflow_dispatch(result, authorized_by=auth)
    else:
        raise ValueError(f"Unknown execution_mode: {mode} (expected 'workflow' or 'lead_supervised')")


# ────────────────────────────────── Run Management ──────────────────────────────────────


def get_run_status(run_id: str) -> dict[str, Any] | None:
    """Get current status of an application run."""
    run = app_repositories.load_run(run_id)
    if run is None:
        return None

    # Augment with task center status
    from evoflow.persistence.task_repositories import load_task_bundle

    task_id = run.get("task_id")
    task_status = "unknown"
    progress = run.get("progress", 0)
    subtask_status: dict[str, Any] = {}
    step_ref_to_subtask_id: dict[str, str] = {}
    steps_detail: list[dict[str, Any]] = []
    result_summary = run.get("result_summary", "")
    main_outputs: list[Any] = []
    main_evidence: list[str] = []
    app_steps: list[dict[str, Any]] = []
    if run.get("app_id"):
        try:
            pin = run.get("app_version")
            if pin is not None:
                from evoflow.collab.app_openai_compat import load_app_for_run

                app_row = load_app_for_run(str(run.get("app_id")), pinned_version=int(pin))
            else:
                app_row = app_repositories.load_app(str(run.get("app_id")))
            if isinstance(app_row, dict):
                app_steps = [s for s in (app_row.get("steps") or []) if isinstance(s, dict)]
        except Exception:
            app_steps = []

    if task_id:
        try:
            # 应用运行无 lead 收尾：轮询时补一次 rollup，全部子任务成功 → 100% completed
            try:
                from evoflow.collab.storage import get_project_storage
                from evoflow.collab.task_progress import sync_main_task_from_subtasks

                sync_main_task_from_subtasks(get_project_storage(), str(task_id))
            except Exception:
                pass

            bundle = load_task_bundle(task_id)
            if bundle and bundle.get("tasks"):
                from evoflow.collab.app_step_ref_bridge import (
                    build_step_ref_alias_map,
                    enrich_step_detail,
                    mirror_ref_aliases,
                    pick_preferred_run_outputs_step,
                )
                from evoflow.collab.task_outputs import (
                    evidence_paths_from_outputs,
                    task_outputs_of,
                )

                main_task = bundle["tasks"][0]
                task_status = main_task.get("status", "unknown")
                progress = main_task.get("progress", progress)
                if str(task_status).lower() in ("completed", "done", "success"):
                    progress = 100
                if not result_summary:
                    result_summary = str(
                        main_task.get("result_summary")
                        or main_task.get("result_text")
                        or main_task.get("error_text")
                        or ""
                    )
                main_outputs = task_outputs_of(main_task)
                main_evidence = evidence_paths_from_outputs(main_outputs)
                plan_steps = [
                    s for s in (main_task.get("plan_steps") or []) if isinstance(s, dict)
                ]
                subtasks = [s for s in (main_task.get("subtasks") or []) if isinstance(s, dict)]
                for idx, st in enumerate(subtasks):
                    ref = _resolve_subtask_ref(st, index=idx, plan_steps=plan_steps)
                    sid = str(st.get("id") or st.get("subtask_id") or "").strip()
                    st_status = str(st.get("status") or "unknown")
                    if ref:
                        subtask_status[ref] = st_status
                        if sid:
                            step_ref_to_subtask_id[ref] = sid
                    result_text = _subtask_result_text(st)
                    # Soft dependency waits use auto_blocked:/dispatch_block_reason — not real
                    # step failures. Hide them from the workflow "错误" panel.
                    raw_err = str(st.get("error_text") or st.get("error") or "").strip()
                    error_text = "" if raw_err.startswith("auto_blocked:") else raw_err
                    wp = st.get("worker_profile") if isinstance(st.get("worker_profile"), dict) else {}
                    assigned_agent = str(
                        st.get("assigned_agent")
                        or st.get("assigned_to")
                        or wp.get("base_subagent")
                        or st.get("agent_id")
                        or ""
                    )
                    step_outputs = task_outputs_of(st)
                    step_paths = evidence_paths_from_outputs(step_outputs)
                    plan_step = plan_steps[idx] if idx < len(plan_steps) else None
                    app_step = app_steps[idx] if idx < len(app_steps) else None
                    step_row = enrich_step_detail(
                        {
                            "ref": ref,
                            "subtask_id": sid,
                            "status": st_status,
                            "name": str(st.get("name") or ""),
                            "description": str(st.get("description") or "")[:2000],
                            "assigned_agent": assigned_agent,
                            "progress": int(st.get("progress") or 0),
                            "result_summary": result_text[:4000],
                            "error_text": error_text[:2000],
                            "started_at": st.get("started_at"),
                            "completed_at": st.get("completed_at"),
                            "subtask_thread_id": str(
                                st.get("subtask_thread_id") or st.get("thread_id") or ""
                            ).strip(),
                            "outputs": step_outputs,
                            "evidence_paths": step_paths,
                            "is_rollup_step": bool(
                                st.get("is_rollup_step")
                                or str(ref or "").strip() == "__rollup__"
                                or (
                                    isinstance(wp, dict)
                                    and bool(wp.get("is_rollup_step"))
                                )
                            ),
                        },
                        subtask=st,
                        plan_step=plan_step if isinstance(plan_step, dict) else None,
                        app_step=app_step if isinstance(app_step, dict) else None,
                        index=idx,
                    )
                    steps_detail.append(step_row)

                ref_aliases = build_step_ref_alias_map(
                    plan_steps, steps_detail, app_steps=app_steps
                )
                mirror_ref_aliases(subtask_status, ref_aliases)
                mirror_ref_aliases(step_ref_to_subtask_id, ref_aliases)
                # Prefer answer/rollup step deliverables for run-level outputs
                # (main task often only mirrors early step evidence).
                answer_ref_hint = str(run.get("answer_from_ref") or "").strip()
                preferred = pick_preferred_run_outputs_step(
                    steps_detail,
                    answer_ref=answer_ref_hint,
                    alias_map=ref_aliases,
                )
                if preferred and preferred.get("outputs"):
                    main_outputs = list(preferred["outputs"])
                    main_evidence = evidence_paths_from_outputs(main_outputs)
        except Exception:
            pass

    status = _sync_run_from_task(run, task_status=str(task_status), progress=int(progress or 0))
    # App runs: completed → always expose 100 to UI
    if status == "completed":
        progress = 100
    elif isinstance(progress, (int, float)):
        progress = int(progress)

    answer_from_ref = str(run.get("answer_from_ref") or "").strip()
    if not answer_from_ref and run.get("app_id"):
        try:
            app_row = app_repositories.load_app(str(run.get("app_id")))
            if app_row:
                pin = run.get("app_version")
                if pin is not None:
                    from evoflow.collab.app_openai_compat import load_app_for_run

                    app_row = load_app_for_run(
                        str(run.get("app_id")), pinned_version=int(pin)
                    )
                answer_from_ref = str(app_row.get("answer_from_ref") or "").strip()
        except Exception:
            pass

    # OpenAPI / 面板统一答案：有 answer 节点则优先；否则终态补写最后成功步
    terminal = {"completed", "failed", "error", "cancelled", "canceled"}
    if str(status or "").lower() in terminal:
        from evoflow.collab.app_openai_compat import summarize_run_content

        synthesized = summarize_run_content(
            {
                "status": status,
                "error": run.get("error"),
                "steps": steps_detail,
                "result_summary": result_summary if not answer_from_ref else "",
                "answer_from_ref": answer_from_ref,
            }
        )
        if synthesized and not (synthesized.startswith("Run finished with status:") and len(synthesized) < 80):
            if answer_from_ref or not str(result_summary or "").strip():
                result_summary = synthesized

    if result_summary and result_summary != run.get("result_summary"):
        try:
            app_repositories.update_run_status(
                run_id, status, progress=int(progress or 0), result_summary=result_summary
            )
        except Exception:
            pass

    return {
        "run_id": run_id,
        "app_id": run.get("app_id"),
        "app_version": run.get("app_version"),
        "answer_from_ref": answer_from_ref or None,
        "task_id": task_id,
        "thread_id": run.get("thread_id"),
        "execution_mode": run.get("execution_mode"),
        "status": status,
        "task_status": task_status,
        "progress": progress,
        "subtask_status": subtask_status,
        "step_ref_to_subtask_id": step_ref_to_subtask_id,
        "steps": steps_detail,
        "outputs": main_outputs,
        "evidence_paths": main_evidence,
        "result_summary": result_summary,
        "error": run.get("error"),
        "created_at": run.get("created_at"),
        "started_at": run.get("started_at"),
        "completed_at": run.get("completed_at"),
    }


def cancel_run(run_id: str, reason: str = "User cancelled") -> bool:
    """Cancel an application run and its in-flight subtasks."""
    run = app_repositories.load_run(run_id)
    if run is None:
        return False

    # Cancel in task center - main task + all subtasks
    from evoflow.persistence.task_repositories import load_task_bundle, save_task_bundle

    _terminal = (
        "completed",
        "done",
        "success",
        "failed",
        "error",
        "cancelled",
        "canceled",
        "skipped",
    )

    def _cancel_open_subtasks(subtasks: list) -> None:
        for st in subtasks:
            if not isinstance(st, dict):
                continue
            st_status = str(st.get("status") or "").strip().lower()
            if st_status not in _terminal:
                st["status"] = "cancelled"
                st["error_text"] = "Parent task cancelled"

    task_id = run.get("task_id")
    if task_id:
        try:
            bundle = load_task_bundle(task_id)
            if bundle and bundle.get("tasks"):
                main_task = bundle["tasks"][0]
                main_task["status"] = "cancelled"
                main_task["error_text"] = reason
                _cancel_open_subtasks(main_task.get("subtasks") or [])
                save_task_bundle(task_id, bundle)
        except Exception:
            pass
        # Project storage is the workflow SSOT for Panel / DAG / eval reads
        try:
            from evoflow.collab.storage import find_main_task, get_project_storage

            storage = get_project_storage()
            found = find_main_task(storage, str(task_id), bypass_cache=True)
            if found:
                project, main_task = found
                main_task["status"] = "cancelled"
                main_task["error_text"] = reason
                _cancel_open_subtasks(main_task.get("subtasks") or [])
                storage.save_project(project)
        except Exception:
            pass

    # Update run record
    app_repositories.update_run_status(run_id, "cancelled", error=reason)
    return True


def pause_run(run_id: str, reason: str = "User paused") -> bool:
    """Pause a running application run and its in-flight subtasks."""
    run = app_repositories.load_run(run_id)
    if run is None:
        return False

    from evoflow.persistence.task_repositories import load_task_bundle, save_task_bundle

    task_id = run.get("task_id")
    if task_id:
        try:
            bundle = load_task_bundle(task_id)
            if bundle and bundle.get("tasks"):
                main_task = bundle["tasks"][0]
                main_task["status"] = "paused"
                # Only pause truly in-flight subtasks. Leave pending/planned alone so
                # resume + DAG resolve won't treat waiting Step2 as "was running".
                _in_flight = frozenset(
                    {"executing", "running", "in_progress", "active", "planning"}
                )
                subtasks = main_task.get("subtasks") or []
                for st in subtasks:
                    if isinstance(st, dict):
                        st_status = str(st.get("status") or "").strip().lower()
                        if st_status in _in_flight:
                            st["status"] = "paused"
                save_task_bundle(task_id, bundle)
        except Exception:
            pass

    app_repositories.update_run_status(run_id, "paused")
    return True


def resume_run(run_id: str) -> bool:
    """Resume a paused application run and re-dispatch in-flight subtasks."""
    run = app_repositories.load_run(run_id)
    if run is None:
        return False

    from evoflow.persistence.task_repositories import load_task_bundle, save_task_bundle

    task_id = run.get("task_id")
    if task_id:
        try:
            bundle = load_task_bundle(task_id)
            if bundle and bundle.get("tasks"):
                main_task = bundle["tasks"][0]
                main_task["status"] = "executing"
                # Reset paused subtasks to pending; DAG dispatch (below) starts only
                # those whose depends_on are satisfied — never mark Step2 executing
                # while Step1 is still incomplete.
                subtasks = main_task.get("subtasks") or []
                for st in subtasks:
                    if isinstance(st, dict):
                        if str(st.get("status") or "").strip().lower() == "paused":
                            st["status"] = "pending"
                save_task_bundle(task_id, bundle)
        except Exception:
            pass

    app_repositories.update_run_status(run_id, "running")

    # Re-dispatch in background to resume DAG execution immediately
    # (don't wait for task_queue_runner poller to pick it up)
    if task_id:
        try:
            import threading

            def _resume_dispatch() -> None:
                import asyncio as _aio

                from evoflow.collab.dispatch_authorized_execution import (
                    dispatch_authorized_main_task_execution,
                )

                loop = _aio.new_event_loop()
                try:
                    loop.run_until_complete(
                        dispatch_authorized_main_task_execution(
                            task_id, thread_id=None, authorized_by="api"
                        )
                    )
                except Exception:
                    pass  # task_queue_runner will handle on next tick
                finally:
                    loop.close()

            t = threading.Thread(target=_resume_dispatch, daemon=True)
            t.start()
        except Exception:
            pass  # Non-fatal: poller will pick it up

    return True
