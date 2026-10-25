"""Deterministic template node executor — F-1 first slice (workflow-audit-roadmap §5.1).

``executor=template`` steps run inline in the DAG wave: no subagent, no LLM,
no reporting ceremony. The step's ``template`` is rendered with the shared
expression resolver (``{{params.x}}`` / ``{{steps.<ref>.output.field}}`` /
``.summary`` / ``.artifacts`` — same grammar as LLM-node input bindings), the
rendered text becomes the node's ``outputs`` + ``task_report``, and the wave
loop drains template chains so they never wait on a worker's ``done`` call.

Semantics:
- Rendered output is always text; a single-``{{expr}}`` template resolving to
  a dict/list is JSON-serialised (interpolation path already does this).
- Unresolvable references stay verbatim in the output and are recorded in
  ``unresolved_bindings`` — auditable, not silently empty (same contract as
  LLM-node binding resolution).
- Render failure marks the subtask ``failed`` with ``error_kind=business``;
  dependents then soft-block via the normal dependency rules.
"""

from __future__ import annotations

import json
import logging
import re
from typing import Any

from evoflow.timeutil import utc_now_iso_z

logger = logging.getLogger(__name__)

_EXPR_RE = re.compile(r"\{\{(.+?)\}\}")

TEMPLATE_EXECUTOR = "template"


def is_template_subtask(st: Any) -> bool:
    """True when a subtask row is a deterministic template node."""
    if not isinstance(st, dict):
        return False
    if str(st.get("executor") or "").strip().lower() != TEMPLATE_EXECUTOR:
        return False
    return bool(str(st.get("template") or "").strip())


def render_template(
    template: str,
    *,
    params: dict[str, Any] | None,
    subtasks: list[Any] | None,
) -> tuple[str, list[str]]:
    """Render a template against run params + upstream subtask results.

    Returns ``(rendered_text, unresolved_expressions)``.
    """
    from evoflow.collab.expression_resolver import (
        build_steps_output_from_subtasks,
        resolve_expression,
    )

    clean_params = {
        str(k): v
        for k, v in (params or {}).items()
        if v is not None
    }
    steps_output = build_steps_output_from_subtasks(subtasks or [])
    text = str(template or "")

    value = resolve_expression(text, params=clean_params, steps_output=steps_output)
    if isinstance(value, (dict, list)):
        try:
            rendered = json.dumps(value, ensure_ascii=False, indent=2)
        except (TypeError, ValueError):
            rendered = str(value)
    else:
        rendered = str(value)

    unresolved = [m.group(0) for m in _EXPR_RE.finditer(rendered)]
    return rendered, unresolved


def execute_template_subtask(
    storage: Any,
    main_task_id: str,
    st: dict[str, Any],
    *,
    params: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Claim → render → complete one template subtask inline (no worker).

    Mutates the subtask row under the main-task mutation lock and persists the
    bundle; stamps timing + ``task_report`` / ``outputs`` like a worker ``done``
    would. Returns a result dict (``ok`` / ``rendered`` / ``error`` …).
    """
    from evoflow.collab.storage import find_main_task, main_task_mutation_lock
    from evoflow.collab.subtask_state_machine import advance_subtask_row_status
    from evoflow.collab.timing import stamp_subtask_row

    mid = str(main_task_id or "").strip()
    sid = str(st.get("id") or "").strip()
    now = utc_now_iso_z()
    out: dict[str, Any] = {"subtaskId": sid, "ok": False, "executor": TEMPLATE_EXECUTOR}

    task: dict[str, Any] | None = None
    with main_task_mutation_lock(mid):
        found = find_main_task(storage, mid, bypass_cache=True)
        if not found:
            out["error"] = "task_not_found"
            return out
        project, task = found
        row = next(
            (
                x
                for x in (task.get("subtasks") or [])
                if isinstance(x, dict) and str(x.get("id") or "").strip() == sid
            ),
            None,
        )
        if row is None:
            out["error"] = "subtask_not_found"
            return out
        status = str(row.get("status") or "").strip().lower()
        if status in ("completed", "done", "success"):
            out.update(ok=True, skipped="already_completed")
            return out

        advance_subtask_row_status(row, "executing")
        row.setdefault("started_at", now)
        row["updated_at"] = now
        try:
            rendered, unresolved = render_template(
                str(row.get("template") or ""),
                params=params,
                subtasks=task.get("subtasks") or [],
            )
            rendered = rendered.strip()
            if not rendered:
                raise ValueError("template rendered to empty output")

            advance_subtask_row_status(row, "completed", progress=100)
            row["progress"] = 100
            row["completed_at"] = now
            row["updated_at"] = now
            row["task_report"] = rendered[:4000]
            row["result_summary"] = rendered[:4000]
            row["outputs"] = [{"type": "text", "key": "text", "value": rendered}]
            row["error"] = None
            row["error_text"] = None
            if unresolved:
                row["unresolved_bindings"] = unresolved[:20]
            out.update(ok=True, rendered=rendered[:4000], unresolved=unresolved)
        except Exception as exc:
            advance_subtask_row_status(row, "failed")
            row["error"] = f"template render failed: {exc}"[:2000]
            row["error_kind"] = "business"
            row["completed_at"] = now
            row["updated_at"] = now
            out["error"] = row["error"]
            logger.warning(
                "template_node: render failed main=%s sub=%s: %s",
                mid,
                sid,
                exc,
            )
        stamp_subtask_row(row)
        task["updated_at"] = now
        storage.save_project(project)

    # Keep run/progress projections on the write path (no GET heal dependency).
    try:
        from evoflow.collab.app_run_events import emit_app_run_for_task_id

        emit_app_run_for_task_id(mid, reason="template_node_complete")
    except Exception:
        logger.debug("template_node: emit_app_run failed main=%s", mid, exc_info=True)
    try:
        from evoflow.collab.task_progress import sync_main_task_from_subtasks

        sync_main_task_from_subtasks(storage, mid)
    except Exception:
        logger.debug("template_node: rollup failed main=%s", mid, exc_info=True)
    return out


__all__ = [
    "TEMPLATE_EXECUTOR",
    "execute_template_subtask",
    "is_template_subtask",
    "render_template",
]
