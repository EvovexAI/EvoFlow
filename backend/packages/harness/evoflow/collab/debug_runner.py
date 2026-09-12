"""Workflow debug runner - single-step execution, run-from-step, and trace.

Provides:
- debug_run_step: Execute one step in isolation with mock upstream inputs
- debug_run_from_step: Re-run from a specific step, reusing upstream results
- get_step_trace: Retrieve actual inputs/outputs for a completed step
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
import uuid
from typing import Any

from evoflow.collab.app_engine import render_plan
from evoflow.persistence import app_repositories

logger = logging.getLogger(__name__)


def _find_step_by_ref(steps: list[dict[str, Any]], ref: str) -> dict[str, Any] | None:
    """Find a plan step by its ref string."""
    ref_s = str(ref or "").strip()
    if not ref_s:
        return None
    for step in steps:
        if not isinstance(step, dict):
            continue
        if str(step.get("ref") or "").strip() == ref_s:
            return step
    return None


def _build_mock_steps_output(
    mock_inputs: dict[str, dict[str, Any]] | None,
) -> dict[str, dict[str, Any]]:
    """Convert user-provided mock_inputs into the steps_output format.

    mock_inputs shape::
        {
            "1": {"output": {...}, "summary": "...", "artifacts": [...]},
            "2": {"output": {...}, "summary": "..."}
        }
    """
    if not mock_inputs:
        return {}
    out: dict[str, dict[str, Any]] = {}
    for ref, data in mock_inputs.items():
        ref_s = str(ref).strip()
        if not ref_s or not isinstance(data, dict):
            continue
        out[ref_s] = {
            "output": data.get("output") or {},
            "summary": str(data.get("summary") or ""),
            "artifacts": data.get("artifacts") or [],
            "artifacts_keyed": {},
        }
    return out


def _build_debug_prompt(
    step: dict[str, Any],
    *,
    params: dict[str, str],
    mock_steps_output: dict[str, dict[str, Any]],
    goal: str = "",
) -> tuple[str, dict[str, Any]]:
    """Build a debug prompt for a single step.

    P0.5-5: Delegates core prompt assembly to ``build_core_prompt`` for
    unified Debug/Production prompt structure.

    Returns (prompt, resolved_bindings).
    """
    from evoflow.collab.step_prompt_builder import build_core_prompt

    core = build_core_prompt(
        step=step,
        params=params,
        steps_output=mock_steps_output,
        goal=goal,
        mode="debug",
    )

    # Add debug mode note on top of the shared core prompt
    parts = [core["prompt"]]
    parts.append(
        "\n## 调试模式说明\n"
        "这是单节点调试运行。请执行本步骤的任务并返回结果。"
        "完成后请用结构化格式输出结果（JSON 代码块），便于下游步骤引用。"
    )

    prompt = "\n".join(parts)
    return prompt, core["resolved"]


async def _execute_step_async(
    prompt: str,
    *,
    subagent_type: str = "general-purpose",
    project_path: str = "",
) -> str:
    """Execute a single step via delegate_via_task_tool (synchronous wait)."""
    from evoflow.collab.dispatch_authorized_execution import gateway_tool_runtime
    from evoflow.collab.id_format import make_formatted_id

    # Create a temporary collab task for the debug run
    from evoflow.collab.storage import get_project_storage, new_project_bundle_root_task
    from evoflow.tools.builtins.collab_bridge import delegate_via_task_tool

    debug_task_name = f"Debug_{uuid.uuid4().hex[:8]}"
    project_data, task_data = new_project_bundle_root_task(
        debug_task_name, "Debug single-step execution", thread_id=None
    )
    task_data["run_mode"] = "unattended"
    task_data["execution_authorized"] = True
    task_id = str(task_data.get("id") or "")

    # Create a single subtask
    from evoflow.timeutil import utc_now_iso_z

    subtask_id = f"ST_debug_{uuid.uuid4().hex[:12]}"
    subtask = {
        "id": subtask_id,
        "ref": "1",
        "name": debug_task_name,
        "description": "Debug step execution",
        "status": "executing",
        "dependencies": [],
        "assigned_to": subagent_type,
        "result": None,
        "error": None,
        "created_at": utc_now_iso_z(),
        "started_at": utc_now_iso_z(),
        "completed_at": None,
        "progress": 0,
        "worker_profile": {"base_subagent": subagent_type},
    }
    task_data["subtasks"] = [subtask]

    from evoflow.persistence.task_repositories import save_task_bundle

    save_task_bundle(task_id, project_data)

    # Build runtime and execute
    runtime = gateway_tool_runtime(None, main_task_id=task_id, subtask_id=subtask_id)
    tool_call_id = make_formatted_id("DebugStep")

    try:
        result_text = await delegate_via_task_tool(
            runtime,
            description=f"debug:{debug_task_name[:60]}",
            prompt=prompt,
            subagent_type=subagent_type,
            tool_call_id=tool_call_id,
            max_turns=None,
            collab_task_id=task_id,
            collab_subtask_id=subtask_id,
            detach=False,
        )
        return result_text if isinstance(result_text, str) else str(result_text)
    finally:
        # Best-effort cleanup: mark task as completed
        try:
            storage = get_project_storage()
            bundle = storage.load_project(task_id)
            if bundle and bundle.get("tasks"):
                bundle["tasks"][0]["status"] = "completed"
                save_task_bundle(task_id, bundle)
        except Exception:
            logger.debug("debug task cleanup failed for %s", task_id, exc_info=True)


def debug_run_step(
    app_id: str,
    step_ref: str,
    *,
    parameters: dict[str, str] | None = None,
    mock_inputs: dict[str, dict[str, Any]] | None = None,
    execution_mode: str = "workflow",
) -> dict[str, Any]:
    """Execute a single step in debug mode.

    Does not create a full run. Resolves input_bindings against mock upstream
    data, builds the prompt, executes via subagent, and returns the result.

    Returns:
        Dict with step_ref, status, output, summary, actual_prompt, duration_ms.
    """
    start_time = time.monotonic()

    if not str(app_id or "").strip():
        return {"step_ref": step_ref, "status": "error", "error": "Application id is required"}

    # 1. Load app + render plan
    app = app_repositories.load_app(app_id)
    if app is None:
        return {"step_ref": step_ref, "status": "error", "error": f"Application not found: {app_id}"}

    params = parameters or {}
    plan = render_plan(app, params)
    steps = plan.get("steps") or []
    goal = str(plan.get("goal") or "").strip()

    # 2. Find target step
    step = _find_step_by_ref(steps, step_ref)
    if not step:
        return {"step_ref": step_ref, "status": "error", "error": f"Step not found: {step_ref}"}

    # 3. Build mock steps_output + resolve bindings + build prompt
    mock_steps_output = _build_mock_steps_output(mock_inputs)
    prompt, resolved_bindings = _build_debug_prompt(
        step,
        params=params,
        mock_steps_output=mock_steps_output,
        goal=goal,
    )

    # 4. Determine subagent type
    subagent_type = str(
        step.get("assigned_agent")
        or step.get("assigned_to")
        or (step.get("worker_profile") or {}).get("base_subagent")
        or "general-purpose"
    ).strip() or "general-purpose"

    # 5. Execute
    try:
        loop = asyncio.new_event_loop()
        try:
            result_text = loop.run_until_complete(
                _execute_step_async(
                    prompt,
                    subagent_type=subagent_type,
                    project_path=str(step.get("project_path") or ""),
                )
            )
        finally:
            loop.close()
    except Exception as e:
        logger.exception("debug_run_step failed for app=%s step=%s", app_id, step_ref)
        return {
            "step_ref": step_ref,
            "status": "error",
            "error": str(e),
            "actual_prompt": prompt,
            "resolved_bindings": resolved_bindings,
            "duration_ms": int((time.monotonic() - start_time) * 1000),
        }

    # 6. Extract structured output
    from evoflow.collab.structured_output import extract_structured_output

    structured, source = extract_structured_output(result_text)

    duration_ms = int((time.monotonic() - start_time) * 1000)

    return {
        "step_ref": step_ref,
        "status": "completed",
        "output": structured,
        "summary": result_text[:4000] if result_text else "",
        "actual_prompt": prompt,
        "resolved_bindings": resolved_bindings,
        "extraction_source": source,
        "duration_ms": duration_ms,
    }


def debug_run_from_step(
    app_id: str,
    from_step_ref: str,
    *,
    base_run_id: str | None = None,
    parameters: dict[str, str] | None = None,
) -> dict[str, Any]:
    """Re-run a workflow from a specific step, reusing upstream results.

    Creates a new run, copies upstream subtask results from the base run
    (or uses fresh parameters if no base run), and dispatches only the
    target step and its downstream dependencies.

    Returns:
        Dict with new_run_id, reused_steps, rerun_steps.
    """
    from evoflow.collab.app_runner import run_app_workflow

    # 1. Load app + render plan
    app = app_repositories.load_app(app_id)
    if app is None:
        return {"error": f"Application not found: {app_id}"}

    params = parameters or {}
    plan = render_plan(app, params)
    steps = plan.get("steps") or []

    # 2. Find target step + compute downstream steps
    target_step = _find_step_by_ref(steps, from_step_ref)
    if not target_step:
        return {"error": f"Step not found: {from_step_ref}"}

    # Compute which steps to reuse (upstream) vs rerun (target + downstream)
    ref_set = {str(s.get("ref") or "").strip() for s in steps}
    rerun_refs: set[str] = {from_step_ref}

    # BFS downstream: any step that depends on a rerun step is also rerun
    queue = [from_step_ref]
    while queue:
        current = queue.pop(0)
        for s in steps:
            s_ref = str(s.get("ref") or "").strip()
            deps = [str(d).strip() for d in (s.get("depends_on") or s.get("depends_refs") or []) if str(d).strip()]
            if current in deps and s_ref not in rerun_refs:
                rerun_refs.add(s_ref)
                queue.append(s_ref)

    reused_refs = sorted(ref_set - rerun_refs, key=lambda r: int(r) if r.isdigit() else 999)

    # 3. Load base run upstream results (if provided)
    upstream_results: dict[str, dict[str, Any]] = {}
    snapshot_app: dict[str, Any] | None = None
    if base_run_id is not None:
        rid = str(base_run_id).strip()
        if not rid:
            return {"error": "base_run_id is empty"}
        base_run = app_repositories.load_run(rid)
        if not base_run:
            return {"error": f"Base run not found: {rid}"}
        base_task_id = str(base_run.get("task_id") or "").strip()
        if base_task_id:
            try:
                from evoflow.persistence.task_repositories import load_task_bundle

                bundle = load_task_bundle(base_task_id)
                if bundle and bundle.get("tasks"):
                    base_task = bundle["tasks"][0]
                    # P0.5-6: Read app definition snapshot from the base run's
                    # task row, so re-runs use the exact definition from when
                    # the base run was created (not a potentially-mutated live app).
                    snapshot = base_task.get("app_definition_snapshot")
                    if isinstance(snapshot, dict) and snapshot.get("steps"):
                        snapshot_app = snapshot
                    for st in base_task.get("subtasks") or []:
                        if not isinstance(st, dict):
                            continue
                        st_ref = str(st.get("ref") or "").strip()
                        if st_ref and st_ref in reused_refs:
                            st_status = str(st.get("status") or "").lower()
                            if st_status in ("completed", "done", "success"):
                                upstream_results[st_ref] = {
                                    "structured_output": st.get("structured_output"),
                                    "task_report": st.get("task_report") or st.get("result") or "",
                                    "outputs": st.get("outputs") or [],
                                }
            except Exception:
                logger.debug("failed to load base run for run-from", exc_info=True)

    # P0.5-6: Prefer app definition snapshot from base run over live app
    # so that re-runs execute against the same definition that was used
    # when the original run was created.
    app_for_run = snapshot_app if snapshot_app else app

    # 4. Create new workflow run
    run_result = run_app_workflow(
        app_id,
        params,
        auto_authorize=False,  # We'll authorize after marking upstream as done
        app=app_for_run,  # P0.5-6: use snapshot if available
        run_kind="debug",
        trigger_kind="manual",
    )

    new_task_id = str(run_result.get("task_id") or "")
    new_run_id = str(run_result.get("run_id") or "")

    if not new_task_id:
        return {"error": "Failed to create new run", "run_result": run_result}

    # 5. Mark upstream steps as completed with reused results
    if upstream_results or reused_refs:
        try:
            from evoflow.persistence.task_repositories import load_task_bundle, save_task_bundle
            from evoflow.timeutil import utc_now_iso_z

            bundle = load_task_bundle(new_task_id)
            if bundle and bundle.get("tasks"):
                task = bundle["tasks"][0]
                now = utc_now_iso_z()
                for st in task.get("subtasks") or []:
                    if not isinstance(st, dict):
                        continue
                    st_ref = str(st.get("ref") or "").strip()
                    if st_ref in reused_refs:
                        st["status"] = "completed"
                        st["progress"] = 100
                        st["completed_at"] = now
                        st["started_at"] = st.get("started_at") or now
                        if st_ref in upstream_results:
                            result = upstream_results[st_ref]
                            if result.get("structured_output"):
                                st["structured_output"] = result["structured_output"]
                            if result.get("task_report"):
                                st["task_report"] = result["task_report"]
                                st["result"] = result["task_report"]
                            if result.get("outputs"):
                                st["outputs"] = result["outputs"]
                save_task_bundle(new_task_id, bundle)
        except Exception:
            logger.debug("failed to mark upstream as completed", exc_info=True)

    # 6. Authorize + dispatch from target step
    try:
        from evoflow.collab.authorize_execution import authorize_main_task_execution
        from evoflow.collab.dispatch_authorized_execution import (
            dispatch_authorized_main_task_execution,
        )
        from evoflow.collab.storage import get_project_storage

        storage = get_project_storage()
        authorize_main_task_execution(storage, new_task_id, "debug")

        # Dispatch in background (non-blocking)
        import threading

        def _dispatch() -> None:
            loop = asyncio.new_event_loop()
            try:
                loop.run_until_complete(
                    dispatch_authorized_main_task_execution(
                        new_task_id, thread_id=None, authorized_by="debug"
                    )
                )
            except Exception:
                logger.exception("debug run-from dispatch failed task=%s", new_task_id)
            finally:
                loop.close()

        t = threading.Thread(target=_dispatch, daemon=True)
        t.start()
    except Exception:
        logger.exception("debug run-from authorize/dispatch failed task=%s", new_task_id)

    return {
        "new_run_id": new_run_id,
        "new_task_id": new_task_id,
        "reused_steps": sorted(reused_refs, key=lambda r: int(r) if r.isdigit() else 999),
        "rerun_steps": sorted(rerun_refs, key=lambda r: int(r) if r.isdigit() else 999),
    }


def get_step_trace(run_id: str, step_ref: str) -> dict[str, Any]:
    """Retrieve trace data for a completed step in a run.

    Returns actual prompt, resolved bindings, structured output, and model response.
    """
    run = app_repositories.load_run(run_id)
    if run is None:
        return {"error": f"Run not found: {run_id}"}

    task_id = str(run.get("task_id") or "").strip()
    if not task_id:
        return {"error": "Run has no associated task"}

    try:
        from evoflow.persistence.task_repositories import load_task_bundle

        bundle = load_task_bundle(task_id)
        if not bundle or not bundle.get("tasks"):
            return {"error": "Task bundle not found"}
        task = bundle["tasks"][0]
    except Exception:
        return {"error": "Failed to load task bundle"}

    # Find subtask by ref
    subtask = None
    for st in task.get("subtasks") or []:
        if not isinstance(st, dict):
            continue
        if str(st.get("ref") or "").strip() == str(step_ref).strip():
            subtask = st
            break

    if not subtask:
        return {"error": f"Step {step_ref} not found in run {run_id}"}

    # Extract trace data
    from evoflow.collab.subtask_outcome import get_subtask_task_report

    task_report = get_subtask_task_report(subtask) or ""

    # Structured output
    structured_output = subtask.get("structured_output")
    if isinstance(structured_output, str):
        try:
            structured_output = json.loads(structured_output)
        except (json.JSONDecodeError, TypeError):
            pass
    elif not isinstance(structured_output, dict):
        structured_output = None

    # Schema validation status
    schema_valid = subtask.get("schema_valid")
    schema_errors = subtask.get("schema_errors") or []

    # Resolved bindings: reconstruct from plan steps + run parameters
    resolved_bindings: dict[str, Any] = {}
    binding_errors: list[dict[str, Any]] = []
    input_schema_valid: bool = True
    schema_policy: str = "warn"
    step_definition_snapshot: dict[str, Any] | None = None
    try:
        from evoflow.collab.expression_resolver import detect_binding_errors, resolve_step_inputs
        from evoflow.collab.plan_task_storage import load_plan_steps
        from evoflow.collab.schema_enforcement import resolve_schema_policy

        plan_steps = load_plan_steps(task)
        ref_s = str(step_ref).strip()
        matching_step = None
        for ps in plan_steps or []:
            if str(ps.get("ref") or "").strip() == ref_s:
                matching_step = ps
                break

        if matching_step:
            # Step definition snapshot for trace (the exact definition used at run time)
            step_definition_snapshot = {
                "ref": matching_step.get("ref"),
                "name": matching_step.get("name"),
                "goal": matching_step.get("goal"),
                "description": matching_step.get("description"),
                "input_bindings": matching_step.get("input_bindings"),
                "input_schema": matching_step.get("input_schema"),
                "output_schema": matching_step.get("output_schema"),
                "schema_enforcement": matching_step.get("schema_enforcement"),
                "depends_on": matching_step.get("depends_on") or matching_step.get("depends_refs"),
                "instruction": matching_step.get("instruction"),
                "assigned_agent": matching_step.get("assigned_agent"),
                "model": matching_step.get("model"),
                "tools": matching_step.get("tools"),
                "skills": matching_step.get("skills"),
            }

            # Resolve schema policy (step-level > app-level/snapshot > default)
            app_snapshot = task.get("app_definition_snapshot")
            schema_policy = resolve_schema_policy(
                step=matching_step,
                app_def=app_snapshot if isinstance(app_snapshot, dict) else None,
                task_row=task,
            )

            if matching_step.get("input_bindings"):
                params = task.get("run_parameters") or {}
                all_subtasks = task.get("subtasks") or []
                resolve_result = resolve_step_inputs(
                    matching_step,
                    params=params,
                    subtasks=all_subtasks,
                )
                if resolve_result["has_bindings"]:
                    resolved_bindings = resolve_result["resolved"]
                    # P0.5 Final Closure: structured binding errors with codes
                    structured_errors = detect_binding_errors(
                        resolved_bindings,
                        bindings=matching_step.get("input_bindings"),
                        params=params,
                        steps_output=resolve_result.get("steps_output", {}),
                        subtasks=all_subtasks,
                    )
                    binding_errors = [e.to_dict() for e in structured_errors]

                    # Input schema validation result
                    input_schema = matching_step.get("input_schema")
                    if isinstance(input_schema, dict) and input_schema:
                        from evoflow.collab.step_prompt_builder import _validate_input_types

                        type_errors = _validate_input_types(resolved_bindings, input_schema)
                        input_schema_valid = len(type_errors) == 0
                        if type_errors:
                            for te in type_errors:
                                binding_errors.append({
                                    "code": "TYPE_MISMATCH",
                                    "binding_key": te.split(":")[0] if ":" in te else "unknown",
                                    "expression": "",
                                    "message": te,
                                    "detail": {"input_schema": input_schema},
                                })
    except Exception:
        logger.debug("trace: failed to reconstruct resolved_bindings", exc_info=True)

    # P0.5 Final Closure: Determine reused/rerun status from subtask metadata
    run_status = str(subtask.get("status") or "unknown")
    is_reused = bool(subtask.get("_reused_from_base_run"))
    reused_from_run = str(subtask.get("_reused_from_run_id") or "").strip() or None

    # Actual agent/model used
    wp = subtask.get("worker_profile") if isinstance(subtask.get("worker_profile"), dict) else {}
    actual_agent = str(
        subtask.get("assigned_to")
        or subtask.get("assigned_agent")
        or wp.get("base_subagent")
        or ""
    ).strip()
    actual_model = str(wp.get("model") or "").strip() or None

    # Artifacts
    from evoflow.collab.task_outputs import normalize_task_outputs

    artifacts = normalize_task_outputs(subtask.get("outputs"))

    return {
        "step_ref": str(step_ref),
        "status": run_status,
        "actual_prompt": "",  # Full prompt not persisted; would need prompt logging
        "resolved_bindings": resolved_bindings,
        "binding_errors": binding_errors,
        "input_schema_valid": input_schema_valid,
        "model_response": task_report[:8000] if task_report else "",
        "structured_output": structured_output,
        "schema_valid": schema_valid,
        "schema_errors": schema_errors if isinstance(schema_errors, list) else [],
        "schema_policy": schema_policy,
        "schema_enforcement_action": str(subtask.get("schema_enforcement_action") or "").strip() or None,
        "schema_enforcement_reason": str(subtask.get("schema_enforcement_reason") or "").strip() or None,
        "step_definition_snapshot": step_definition_snapshot,
        "actual_agent": actual_agent or None,
        "actual_model": actual_model,
        "is_reused": is_reused,
        "reused_from_run_id": reused_from_run,
        "artifacts": artifacts,
        "started_at": subtask.get("started_at"),
        "completed_at": subtask.get("completed_at"),
    }


__all__ = [
    "debug_run_step",
    "debug_run_from_step",
    "get_step_trace",
]
