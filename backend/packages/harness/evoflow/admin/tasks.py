"""Admin service for collab task CRUD + state/progress updates.

Reuses ``ProjectStorage`` (SQLite ``evoflow_collab_tasks``) and
``supervisor_tool``'s string-based state machine, so CLI-driven and
LangGraph-driven task mutations share one source of truth.

Public API:
    list_tasks(assignee=, status=, main_task_id=, include_subtasks=, role=, source=)
    get_task(task_id, subtask_id=)
    update_progress(task_id, progress, status=, subtask_id=)
    set_task_state(task_id, status, subtask_id=, summary=, outputs=, handlers=)
    delete_task(task_id)
    create_task(name, description=, assignee=, assigned_role=, main_task_id=,
                initial_status=, result=, source=, source_ref=, raised_by=,
                risk_level=, action_type=, round_id=, parent_task_id=)
"""

from __future__ import annotations

import logging
from typing import Any

from evoflow.admin.errors import NotFoundError, ValidationError
from evoflow.collab.id_format import make_subtask_id
from evoflow.collab.storage import (
    find_main_task,
    find_subtask_row_by_id,
    get_project_storage,
    main_task_mutation_lock,
    new_project_bundle_root_task,
    patch_collab_main_task_in_project_storage,
    patch_collab_subtask_in_project_storage,
    rollup_root_task_progress_from_subtasks,
)
from evoflow.collab.task_handlers import normalize_task_handlers, task_handlers_of
from evoflow.collab.task_outputs import (
    absolutize_handlers_paths,
    absolutize_task_outputs,
    agent_code_for_task_row,
    evidence_paths_from_outputs,
    normalize_task_outputs,
    task_input_refs_of,
    task_outputs_of,
    workspace_root_for_task_row,
)
from evoflow.timeutil import utc_now_iso_z

logger = logging.getLogger(__name__)

_SUMMARY_MAX_LEN = 8000


# ── Status helpers (reuse supervisor_tool's state machine - single source of truth) ──


def _normalize_status(v: str | None) -> str:
    return str(v or "").strip().lower().replace("-", "_")


def normalize_task_summary(summary: str | None) -> str:
    """Canonical 任务总结 text (employee handoff / delivery narrative)."""
    return str(summary or "").strip()[:_SUMMARY_MAX_LEN]


def task_summary_of(row: dict[str, Any] | None) -> str:
    """Prefer dedicated ``summary``, then workflow/legacy result fields."""
    if not isinstance(row, dict):
        return ""
    for key in (
        "summary",
        "result_summary",
        "result_text",
        "task_report",
        "result",
        "execution_result",
        "outcome",
    ):
        text = str(row.get(key) or "").strip()
        if text:
            return text
    return ""


def _outcome_patch(
    summary: str | None,
    outputs: Any = None,
    *,
    target_status: str | None = None,
    workspace_root: str | None = None,
    agent_code: str | None = None,
) -> dict[str, Any]:
    """Persist 任务总结 + structured ``outputs`` (mirrored to ``result`` / evidence_paths).

    File-typed output values are stored as absolute paths when ``workspace_root``
    is known, so UIs can open them without joining a guessed root.
    """
    text = normalize_task_summary(summary)
    items = normalize_task_outputs(outputs) if outputs is not None else None
    if items is not None and workspace_root:
        items = absolutize_task_outputs(items, workspace_root, agent_code=agent_code)
    if not text and not items:
        return {}
    patch: dict[str, Any] = {}
    if text:
        patch["summary"] = text
        patch["result"] = text
        if _normalize_status(target_status) in {"failed", "error"}:
            patch["error"] = text[:2000]
    if items is not None:
        patch["outputs"] = items
        # Keep legacy path list in sync for readers that only know evidence_paths.
        paths = evidence_paths_from_outputs(items)
        if paths:
            patch["evidence_paths"] = paths
    return patch


def _summary_patch(summary: str | None, *, target_status: str | None = None) -> dict[str, Any]:
    """Backward-compatible alias — prefer :func:`_outcome_patch`."""
    return _outcome_patch(summary, None, target_status=target_status)


def _status_zh(v: str | None) -> str:
    from evoflow.tools.builtins.supervisor_tool import _STATUS_ZH_MAP

    return _STATUS_ZH_MAP.get(_normalize_status(v), "未知")


def _can_transition(current: str, target: str) -> bool:
    from evoflow.tools.builtins.supervisor_tool import _TASK_STATE_TRANSITIONS

    if current == target:
        return True
    allowed = _TASK_STATE_TRANSITIONS.get(current)
    if allowed is None:
        return False
    return target in allowed


def _validate_target_state(target: str) -> None:
    from evoflow.tools.builtins.supervisor_tool import _ALLOWED_TASK_STATES

    if target not in _ALLOWED_TASK_STATES:
        raise ValidationError(
            f"invalid status '{target}'; allowed: {sorted(_ALLOWED_TASK_STATES)}"
        )


def _row_matches(
    row: dict[str, Any],
    assignee_filter: str | None,
    status_filter: str | None,
    *,
    role_name_filter: str | None = None,
) -> bool:
    """Match list filters.

    ``role_name_filter`` matches ``assigned_role`` (岗位名) — NOT ``assigned_to``.
    One agent may hold multiple roles; only tasks stamped with that 岗位 show up.
    """
    if role_name_filter is not None:
        ar = str(row.get("assigned_role") or "").strip().lower()
        if ar != role_name_filter:
            return False
    elif assignee_filter:
        ra = str(row.get("assigned_to") or "").strip().lower()
        if ra != assignee_filter:
            return False
    if status_filter:
        if row.get("status") != status_filter:
            return False
    return True


def _task_role_fields(row: dict[str, Any]) -> dict[str, Any]:
    """Extract assigned_role from a task/subtask dict (column or extra_json merge)."""
    role = str(row.get("assigned_role") or "").strip() or None
    return {"assigned_role": role}


def _task_raiser_fields(row: dict[str, Any]) -> dict[str, Any]:
    """提起人: ``user`` or agent_code (orthogonal to assigned_role / assigned_to)."""
    raised = str(row.get("raised_by") or "").strip() or None
    return {"raised_by": raised}


def _task_parent_fields(row: dict[str, Any]) -> dict[str, Any]:
    """Cross-role handoff tree: parent is another main-task id (not collab subtasks[])."""
    parent = str(row.get("parent_task_id") or "").strip() or None
    return {"parent_task_id": parent}


def _task_proactive_fields(
    row: dict[str, Any],
    *,
    absolutize_paths: bool = True,
    enrich_handlers: bool = True,
) -> dict[str, Any]:
    """Optional duty metadata stamped on role work items."""
    out: dict[str, Any] = {}
    risk = str(row.get("risk_level") or "").strip()
    if risk:
        out["risk_level"] = risk
    action = str(row.get("action_type") or "").strip()
    if action:
        out["action_type"] = action
    rid = str(row.get("round_id") or "").strip()
    if rid:
        out["round_id"] = rid
    summary = task_summary_of(row)
    if summary:
        # Always expose canonical key; keep raw summary if present.
        out["summary"] = str(row.get("summary") or "").strip() or summary
    outputs = task_outputs_of(row, absolutize=absolutize_paths)
    if outputs:
        out["outputs"] = outputs
    input_refs = task_input_refs_of(row, absolutize=absolutize_paths)
    if input_refs:
        out["input_refs"] = input_refs
    handlers = task_handlers_of(row)
    if handlers:
        if enrich_handlers:
            try:
                from evoflow.proactive.repositories import ProactiveRepository

                enriched: list[dict[str, Any]] = []
                for h in handlers:
                    item = dict(h)
                    if not str(item.get("role") or "").strip():
                        code = str(item.get("agent_code") or "").strip()
                        role = ProactiveRepository.get_role(code) if code else None
                        if role and str(role.role_name or "").strip():
                            item["role"] = str(role.role_name).strip()
                    enriched.append(item)
                out["handlers"] = enriched
            except Exception:
                out["handlers"] = handlers
        else:
            out["handlers"] = handlers
    dispatched = str(row.get("handlers_dispatched_at") or "").strip()
    if dispatched:
        out["handlers_dispatched_at"] = dispatched
    if row.get("handlers_pending_approval") in (True, "true", "1", 1):
        out["handlers_pending_approval"] = True
    return out


def _task_source_fields(row: dict[str, Any]) -> dict[str, Any]:
    """Canonical source + optional fine-grained channel for list/get payloads."""
    from evoflow.collab.task_source import normalize_task_source, task_source_zh

    raw = str(row.get("source") or "").strip() or None
    channel = str(row.get("source_channel") or "").strip() or None
    canon = normalize_task_source(raw) if raw else ""
    return {
        "source": canon or raw,
        "source_zh": task_source_zh(canon or raw),
        "source_channel": channel,
        "source_ref": str(row.get("source_ref") or "").strip() or None,
    }


# ── list ────────────────────────────────────────────────────────────


def list_tasks(
    *,
    assignee: str | None = None,
    role: str | None = None,
    status: str | None = None,
    source: str | None = None,
    main_task_id: str | None = None,
    include_subtasks: bool = True,
    limit: int | None = None,
    offset: int = 0,
) -> dict[str, Any]:
    """List main tasks and/or subtasks, optionally filtered by assignee/role/status/source.

    ``role`` filters by ``assigned_role`` (岗位显示名). Tasks without that stamp
    are excluded — historical collab work assigned only via ``assigned_to`` (agent_code)
    does not appear under a 岗位看板.

    ``source`` filters by canonical 任务来源 (chat|workflow|role|…); aliases match.

    ``limit`` / ``offset`` paginate the filtered result (newest ``updated_at`` first).
    ``limit is None`` or ``<= 0`` returns the full filtered list (CLI / internal callers).

    Uses one/two light SQL queries (root + optional subtasks) instead of N× full
    project bundles. List payloads skip filesystem path absolutization so agent
    ``tasks`` list cannot stall the Gateway thread pool on Windows reparse walks.
    """
    from evoflow.collab.task_source import sources_equal
    from evoflow.persistence import repositories as repo

    assignee_filter = str(assignee or "").strip().lower() or None
    status_filter = _normalize_status(status) or None
    source_filter = str(source or "").strip() or None
    mid = str(main_task_id or "").strip() or None

    role_name_filter: str | None = None
    if role:
        role_name_norm = str(role).strip().lower()
        if not role_name_norm:
            raise ValidationError("role must be a non-empty role_name")
        # Validate the 岗位 exists (active/non-archived) so typos fail loudly.
        try:
            from evoflow.proactive.repositories import ProactiveRepository

            roles = ProactiveRepository.list_roles()
            known = {
                str(r.role_name or "").strip().lower()
                for r in roles
                if str(r.status or "").strip().lower() != "archived"
            }
        except ValidationError:
            raise
        except Exception as e:
            raise ValidationError(f"failed to resolve role '{role}': {e}") from e
        if role_name_norm not in known:
            raise ValidationError(
                f"no active role found with name '{role}'. "
                "Run `evoflow employees list` to see available role_name values. "
                "Create tasks with --role so they stamp assigned_role."
            )
        role_name_filter = role_name_norm

    # Light path: no N× load_project / Path.resolve absolutization on list.
    root_tasks = repo.list_root_task_summaries(main_task_id=mid)
    rows: list[dict[str, Any]] = []
    for task in root_tasks:
        tid = str(task.get("id") or "").strip()
        if not tid:
            continue
        pid = str(task.get("main_task_id") or tid).strip() or tid
        mt_row = {
            "task_id": tid,
            "subtask_id": None,
            "name": task.get("name"),
            "description": str(task.get("description") or "").strip() or None,
            "plan_goal": str(task.get("plan_goal") or "").strip() or None,
            "status": _normalize_status(task.get("status")),
            "status_zh": _status_zh(task.get("status")),
            "progress": int(task.get("progress") or 0),
            "assigned_to": str(task.get("assigned_to") or "").strip() or None,
            **_task_role_fields(task),
            **_task_raiser_fields(task),
            **_task_parent_fields(task),
            **_task_source_fields(task),
            **_task_proactive_fields(task, absolutize_paths=False, enrich_handlers=False),
            "main_task_id": pid,
            "is_subtask": False,
            "created_at": task.get("created_at"),
            "updated_at": task.get("updated_at"),
            "started_at": task.get("started_at"),
            "completed_at": task.get("completed_at"),
        }
        if not (
            source_filter and not sources_equal(task.get("source"), source_filter)
        ) and _row_matches(
            mt_row,
            assignee_filter,
            status_filter,
            role_name_filter=role_name_filter,
        ):
            rows.append(mt_row)

    if include_subtasks:
        for st in repo.list_subtask_summaries(main_task_id=mid):
            parent_tid = str(
                st.get("_collab_parent_task_id") or st.get("main_task_id") or ""
            ).strip()
            sid = str(st.get("id") or "").strip()
            if not parent_tid or not sid:
                continue
            st_row = {
                "task_id": parent_tid,
                "subtask_id": sid,
                "name": st.get("name"),
                "description": str(st.get("description") or "").strip() or None,
                "status": _normalize_status(st.get("status")),
                "status_zh": _status_zh(st.get("status")),
                "progress": int(st.get("progress") or 0),
                "assigned_to": str(st.get("assigned_to") or "").strip() or None,
                **_task_role_fields(st),
                **_task_raiser_fields(st),
                **_task_parent_fields(st),
                **_task_source_fields(st),
                **_task_proactive_fields(st, absolutize_paths=False, enrich_handlers=False),
                "main_task_id": parent_tid,
                "is_subtask": True,
                "created_at": st.get("created_at"),
                "updated_at": st.get("updated_at"),
                "started_at": st.get("started_at"),
                "completed_at": st.get("completed_at"),
            }
            if source_filter and not sources_equal(st.get("source"), source_filter):
                continue
            if _row_matches(
                st_row,
                assignee_filter,
                status_filter,
                role_name_filter=role_name_filter,
            ):
                rows.append(st_row)

    # Newest activity first so tool/CLI pages surface live work, not ancient noise.
    rows.sort(
        key=lambda r: str(r.get("updated_at") or r.get("created_at") or ""),
        reverse=True,
    )
    total = len(rows)
    start = max(0, int(offset or 0))
    limit_n = int(limit) if limit is not None else 0
    if limit_n > 0:
        page = rows[start : start + limit_n]
    else:
        page = rows[start:]
    return {
        "count": len(page),
        "total": total,
        "limit": limit_n if limit_n > 0 else None,
        "offset": start,
        "has_more": (start + len(page)) < total,
        "tasks": page,
    }


# ── get ─────────────────────────────────────────────────────────────


def get_task(task_id: str, *, subtask_id: str | None = None) -> dict[str, Any]:
    """Get one task (main or subtask) detail. ``task_id`` may itself be a subtask id."""
    storage = get_project_storage()
    tid = str(task_id or "").strip()
    if not tid:
        raise ValidationError("task_id is required")

    if subtask_id:
        sid = str(subtask_id).strip()
        sub = find_subtask_row_by_id(storage, sid)
        if not sub:
            raise NotFoundError(f"Subtask '{sid}' not found")
        _project, main_task, subtask = sub
        return {
            "task_id": str(main_task.get("id") or ""),
            "subtask_id": sid,
            "name": subtask.get("name"),
            "description": subtask.get("description"),
            "status": _normalize_status(subtask.get("status")),
            "status_zh": _status_zh(subtask.get("status")),
            "progress": int(subtask.get("progress") or 0),
            "assigned_to": str(subtask.get("assigned_to") or "").strip() or None,
            **_task_role_fields(subtask),
            **_task_raiser_fields(subtask),
            **_task_parent_fields(subtask),
            **_task_source_fields(subtask),
            **_task_proactive_fields(subtask),
            "summary": str(subtask.get("summary") or "").strip() or None,
            "result": subtask.get("result"),
            "error": subtask.get("error"),
            "created_at": subtask.get("created_at"),
            "completed_at": subtask.get("completed_at"),
            "is_subtask": True,
            "main_task": {
                "id": str(main_task.get("id") or ""),
                "name": main_task.get("name"),
                "status": _normalize_status(main_task.get("status")),
            },
        }

    found = find_main_task(storage, tid, bypass_cache=True)
    if not found:
        # maybe it's a subtask id - resolve its parent
        sub = find_subtask_row_by_id(storage, tid)
        if sub:
            _project, main_task, _subtask = sub
            return get_task(str(main_task.get("id") or ""), subtask_id=tid)
        raise NotFoundError(f"Task '{tid}' not found")

    _project, task = found
    subtasks = [
        {
            "subtask_id": str(st.get("id") or ""),
            "name": st.get("name"),
            "status": _normalize_status(st.get("status")),
            "status_zh": _status_zh(st.get("status")),
            "progress": int(st.get("progress") or 0),
            "assigned_to": str(st.get("assigned_to") or "").strip() or None,
            **_task_role_fields(st),
            **_task_raiser_fields(st),
            **_task_parent_fields(st),
        }
        for st in (task.get("subtasks") or [])
    ]
    parent_id = str(task.get("parent_task_id") or "").strip() or None
    parent_summary = None
    if parent_id:
        parent_found = find_main_task(storage, parent_id, bypass_cache=True)
        if parent_found:
            _pp, parent_task = parent_found
            parent_summary = {
                "task_id": parent_id,
                "name": parent_task.get("name"),
                "status": _normalize_status(parent_task.get("status")),
                "assigned_role": str(parent_task.get("assigned_role") or "").strip() or None,
                "raised_by": str(parent_task.get("raised_by") or "").strip() or None,
            }
    child_ids: list[str] = []
    for summary in storage.list_projects():
        proj = storage.load_project(summary["id"])
        if not proj:
            continue
        for t in proj.get("tasks") or []:
            if str(t.get("parent_task_id") or "").strip() == tid:
                cid = str(t.get("id") or "").strip()
                if cid:
                    child_ids.append(cid)
    return {
        "task_id": tid,
        "subtask_id": None,
        "name": task.get("name"),
        "description": task.get("description"),
        "status": _normalize_status(task.get("status")),
        "status_zh": _status_zh(task.get("status")),
        "progress": int(task.get("progress") or 0),
        "assigned_to": str(task.get("assigned_to") or "").strip() or None,
        **_task_role_fields(task),
        **_task_raiser_fields(task),
        **_task_parent_fields(task),
        **_task_source_fields(task),
        **_task_proactive_fields(task),
        "parent": parent_summary,
        "child_task_ids": child_ids,
        "execution_authorized": bool(task.get("execution_authorized")),
        "thread_id": task.get("thread_id"),
        "summary": str(task.get("summary") or "").strip() or None,
        "result": task.get("result"),
        "error": task.get("error") or task.get("error_text"),
        "created_at": task.get("created_at"),
        "started_at": task.get("started_at"),
        "completed_at": task.get("completed_at"),
        "is_subtask": False,
        "subtask_count": len(subtasks),
        "subtasks": subtasks,
    }


# ── update_progress ──────────────────────────────────────────────────


def update_progress(
    task_id: str,
    progress: int,
    *,
    status: str | None = None,
    subtask_id: str | None = None,
) -> dict[str, Any]:
    """Update progress (0-100) and optionally set status (validated by state machine).

    If progress > 0 and the row is still ``pending``/``idle`` (and no status
    override), promote to ``executing`` so the board shows「处理中」not「待处理」.
    """
    storage = get_project_storage()
    tid = str(task_id or "").strip()
    if not tid:
        raise ValidationError("task_id is required")
    progress_value = max(0, min(100, int(progress)))
    status_norm = _normalize_status(status) if status else None
    if status_norm:
        _validate_target_state(status_norm)
    now = utc_now_iso_z()

    def _maybe_promote_executing(current: str, *, explicit: str | None) -> str | None:
        if explicit:
            return explicit
        cur = _normalize_status(current) or "pending"
        if progress_value > 0 and progress_value < 100 and cur in {"pending", "idle"}:
            if _can_transition(cur, "executing"):
                return "executing"
        return None

    if subtask_id:
        sid = str(subtask_id).strip()
        sub = find_subtask_row_by_id(storage, sid)
        if not sub:
            raise NotFoundError(f"Subtask '{sid}' not found")
        _project, main_task, subtask = sub
        mtid = str(main_task.get("id") or "").strip()
        status_norm = _maybe_promote_executing(subtask.get("status"), explicit=status_norm) or status_norm
        if status_norm:
            current = _normalize_status(subtask.get("status"))
            if not _can_transition(current, status_norm):
                raise ValidationError(f"illegal state transition: {current} -> {status_norm}")
        updates: dict[str, Any] = {"progress": progress_value}
        if status_norm:
            updates["status"] = status_norm
            if status_norm == "completed":
                updates["progress"] = 100
                updates["completed_at"] = subtask.get("completed_at") or now
            elif status_norm in {"failed", "cancelled"}:
                updates["failed_at"] = subtask.get("failed_at") or now
            elif status_norm == "executing" and not subtask.get("started_at"):
                updates["started_at"] = now
        ok = patch_collab_subtask_in_project_storage(storage, mtid, sid, updates)
        if not ok:
            raise ValidationError("Failed to save subtask")
        rollup_root_task_progress_from_subtasks(storage, mtid)
        return {
            "task_id": mtid,
            "subtask_id": sid,
            "progress": updates["progress"],
            "status": status_norm or _normalize_status(subtask.get("status")),
            "status_zh": _status_zh(status_norm or subtask.get("status")),
        }

    found = find_main_task(storage, tid, bypass_cache=True)
    if not found:
        raise NotFoundError(f"Task '{tid}' not found")
    _project, task = found
    status_norm = _maybe_promote_executing(task.get("status"), explicit=status_norm) or status_norm
    if status_norm:
        current = _normalize_status(task.get("status"))
        if not _can_transition(current, status_norm):
            raise ValidationError(
                f"illegal state transition: {current} -> {status_norm}"
                + (
                    f"; use progress or state=executing first, then {status_norm}"
                    if current in {"pending", "planned", "planning", "waiting_user"}
                    and status_norm
                    in {"completed", "failed", "awaiting_close", "reviewed"}
                    else ""
                )
            )
    updates = {"progress": progress_value}
    if status_norm:
        updates["status"] = status_norm
        if status_norm == "completed":
            updates["progress"] = 100
            updates["completed_at"] = task.get("completed_at") or now
        elif status_norm in {"failed", "cancelled"}:
            updates["failed_at"] = task.get("failed_at") or now
        elif status_norm == "executing" and not task.get("started_at"):
            updates["started_at"] = now
    ok = patch_collab_main_task_in_project_storage(storage, tid, updates)
    if not ok:
        raise ValidationError("Failed to save task")
    out = {
        "task_id": tid,
        "progress": updates["progress"],
        "status": status_norm or _normalize_status(task.get("status")),
        "status_zh": _status_zh(status_norm or task.get("status")),
    }
    try:
        from evoflow.items.service import sync_item_from_linked_task

        merged = {**task, **updates, "id": tid}
        item_sync = sync_item_from_linked_task(tid, task=merged)
        if item_sync is not None:
            out["item_sync"] = item_sync
    except Exception:
        logger.debug("item sync after update_progress failed task=%s", tid, exc_info=True)
    return out


# ── set_task_state ──────────────────────────────────────────────────


def _assignee_role_for_task(task: dict[str, Any]):
    """Resolve ProactiveRole for the task assignee (handoff risk gate)."""
    code = str(task.get("assigned_to") or "").strip()
    if not code:
        return None
    try:
        from evoflow.proactive.repositories import ProactiveRepository

        return ProactiveRepository.get_role(code)
    except Exception:
        logger.debug("admin.tasks: resolve assignee role failed", exc_info=True)
        return None


def handoff_needs_approval(task: dict[str, Any]) -> bool:
    """Whether completing this task with handlers should wait for human approval."""
    role = _assignee_role_for_task(task)
    if role is None:
        return False
    try:
        from evoflow.proactive.work_items import task_needs_approval

        return bool(task_needs_approval(role, task))
    except Exception:
        logger.debug("admin.tasks: handoff_needs_approval check failed", exc_info=True)
        return False


def task_has_pending_handoff_approval(task: dict[str, Any] | None) -> bool:
    """True when completed (or legacy) task awaits handoff approval before wake."""
    if not isinstance(task, dict):
        return False
    if str(task.get("handlers_dispatched_at") or "").strip():
        return False
    if task.get("handlers_pending_approval") in (True, "true", "1", 1):
        return True
    status = _normalize_status(task.get("status"))
    if status not in {"completed", "reviewed", "awaiting_close"}:
        return False
    if not task_handlers_of(task):
        return False
    try:
        from evoflow.proactive.models import ApprovalStatus
        from evoflow.proactive.repositories import ProactiveRepository

        tid = str(task.get("id") or task.get("task_id") or "").strip()
        appr = ProactiveRepository.get_approval_by_task(tid) if tid else None
        return bool(appr and appr.status == ApprovalStatus.PENDING)
    except Exception:
        return False


def _request_handoff_approval(task: dict[str, Any]) -> dict[str, Any] | None:
    """Create/reuse pending Approval for a completed handoff (does not change status).

    Avoids the nested-event-loop anti-pattern: DB operations are performed
    synchronously; channel push (Feishu/desktop) is dispatched as a background
    ``asyncio.create_task`` when a running loop exists, or via ``asyncio.run``
    when no loop is present.
    """
    import asyncio

    from evoflow.proactive.decision_gate import DecisionGate
    from evoflow.proactive.models import Approval, ApprovalStatus, InitiativeStatus
    from evoflow.proactive.repositories import ProactiveRepository
    from evoflow.proactive.work_items import (
        task_action_type,
        task_risk_level,
        task_to_bridge_initiative,
    )
    from evoflow.timeutil import utc_now_iso_z

    role = _assignee_role_for_task(task)
    if role is None:
        return None
    tid = str(task.get("id") or task.get("task_id") or "").strip()
    existing = ProactiveRepository.get_approval_by_task(tid) if tid else None
    if existing and existing.status == ApprovalStatus.PENDING:
        return {"id": existing.id, "already_pending": True}

    if not tid:
        return None

    try:
        running_loop = asyncio.get_running_loop()
    except RuntimeError:
        running_loop = None

    if running_loop is None:
        # ── No running loop: use asyncio.run (the straightforward path) ──
        async def _run():
            return await DecisionGate().request_approval_for_task(role, task)

        try:
            approval = asyncio.run(_run())
        except Exception:
            logger.exception("admin.tasks: handoff approval request failed task=%s", tid)
            return None
        return {"id": getattr(approval, "id", None), "already_pending": False}

    # ── Running loop detected: sync DB ops + fire-and-forget push ──
    # This avoids ThreadPoolExecutor + asyncio.run which competes for
    # SQLite connections and thread-local state (deadlock risk).
    gate = DecisionGate()
    approval_id = ProactiveRepository.new_approval_id()
    channels = role.config.approval_channels or ["desktop", "feishu"]
    channel_str = "both" if len(channels) > 1 else (channels[0] if channels else "desktop")

    # Persist bridge initiative (synchronous DB write)
    synthetic = task_to_bridge_initiative(task)
    if not str(synthetic.role_agent_code or "").strip():
        synthetic.role_agent_code = role.agent_code
    synthetic.status = InitiativeStatus.PENDING_APPROVAL
    synthetic.approval_timeout_minutes = gate._resolve_timeout_minutes(role, synthetic)
    ProactiveRepository.save_initiative(synthetic)

    # Persist approval record (synchronous DB write)
    approval = Approval(
        id=approval_id,
        initiative_id=synthetic.id,
        task_id=tid,
        role_agent_code=role.agent_code,
        channel=channel_str,
        status=ApprovalStatus.PENDING,
        created_at=utc_now_iso_z(),
        updated_at=utc_now_iso_z(),
    )
    ProactiveRepository.save_approval(approval)

    synthetic.approval_id = approval_id
    ProactiveRepository.save_initiative(synthetic)

    # Fire-and-forget channel push on the existing event loop
    async def _push_bg():
        try:
            await gate._push_to_channels(role, synthetic, approval)
        except Exception:
            logger.debug(
                "admin.tasks: handoff approval bg push failed task=%s", tid, exc_info=True
            )

    running_loop.create_task(_push_bg())

    logger.info(
        "proactive.approval.requested task=%s role=%s risk=%s type=%s timeout=%dm (sync+push-bg)",
        tid,
        role.agent_code,
        task_risk_level(task).value,
        task_action_type(task).value,
        synthetic.approval_timeout_minutes,
    )
    return {"id": approval_id, "already_pending": False}


def dispatch_handlers_after_approval(parent_task_id: str) -> list[dict[str, Any]] | None:
    """Wake downstream handlers for a completed parent once handoff is approved."""
    storage = get_project_storage()
    tid = str(parent_task_id or "").strip()
    found = find_main_task(storage, tid, bypass_cache=True)
    if not found:
        return None
    _project, task = found
    if str(task.get("handlers_dispatched_at") or "").strip():
        return None
    final_handlers = task_handlers_of(task)
    if not final_handlers:
        return None
    # Clear gate before create+wake so employees.wake does not reject the child.
    patch_collab_main_task_in_project_storage(
        storage,
        tid,
        {"handlers_pending_approval": False},
    )
    now = utc_now_iso_z()
    from_agent = str(task.get("assigned_to") or "").strip() or "user"
    try:
        dispatched = dispatch_confirmed_handlers(
            tid,
            final_handlers,
            from_agent=from_agent,
            parent_name=str(task.get("name") or task.get("title") or tid).strip(),
        )
        patch_collab_main_task_in_project_storage(
            storage,
            tid,
            {
                "handlers": final_handlers,
                "handlers_pending_approval": False,
                "handlers_dispatched_at": now,
                "handlers_dispatched": [
                    {
                        "agent_code": d.get("agent_code"),
                        "task_id": d.get("task_id"),
                        "ok": d.get("ok"),
                    }
                    for d in (dispatched or [])
                ],
            },
        )
        return dispatched
    except Exception:
        logger.exception("dispatch_handlers_after_approval failed for %s", tid)
        return None


def set_task_state(
    task_id: str,
    status: str,
    *,
    subtask_id: str | None = None,
    summary: str | None = None,
    outputs: Any = None,
    handlers: Any = None,
) -> dict[str, Any]:
    """Set task/subtask status. Validates against the state machine.

    ``summary`` is the employee 任务总结 (交工交付摘要). When provided it is
    stored as ``summary`` and mirrored to ``result`` for legacy UI/readers.

    ``outputs`` is the structured deliverable list
    ``[{type, key, value, label?}, ...]`` (file|url|text|other). Same schema for
    standalone main tasks and collab subtasks.

    ``handlers`` is the per-person downstream list
    ``[{agent_code, content, read_outputs[], role?}, ...]``. On handoff
    (completed/awaiting_close + handlers), low-risk dispatches children + wake
    immediately; medium+ waits for human approval before wake.
    Passing ``status=completed`` **with** handlers is rewritten to
    ``awaiting_close`` (本岗已交、整单待闭环). Leaf work without handlers still
    uses ``completed``. Legacy ``reviewed`` maps to ``completed``.

    Employee-proposed handlers must target **direct reports** in the same org.
    """
    storage = get_project_storage()
    tid = str(task_id or "").strip()
    if not tid:
        raise ValidationError("task_id is required")
    raw_target = _normalize_status(status)
    # Legacy "reviewed" (待确认) → completed (final close).
    target = "completed" if raw_target == "reviewed" else raw_target
    handlers_norm = normalize_task_handlers(handlers) if handlers is not None else None
    # completed + handlers = 本岗交工派下游 → 待闭环（非整单结束）
    if target == "completed" and handlers_norm:
        target = "awaiting_close"
    _validate_target_state(target)
    now = utc_now_iso_z()
    # Resolve workspace early so relative output paths persist as absolute.
    # Subtask / main task rows are loaded below; when unknown yet, leave relative
    # and let readers absolutize via ``task_outputs_of``.
    outcome_updates: dict[str, Any] = {}

    if subtask_id:
        sid = str(subtask_id).strip()
        sub = find_subtask_row_by_id(storage, sid)
        if not sub:
            raise NotFoundError(f"Subtask '{sid}' not found")
        _project, main_task, subtask = sub
        mtid = str(main_task.get("id") or "").strip()
        current = _normalize_status(subtask.get("status"))
        if current == "reviewed" and target == "completed":
            pass
        elif current == "awaiting_close" and target == "completed":
            pass
        elif not _can_transition(current, target):
            if not (raw_target == "reviewed" and _can_transition(current, "reviewed")):
                hint = (
                    f"; use progress or state=executing first, then {target}"
                    if current in {"pending", "planned", "planning", "waiting_user"}
                    and target in {"completed", "failed", "awaiting_close", "reviewed"}
                    else ""
                )
                raise ValidationError(
                    f"illegal state transition: {current} -> {target}{hint}"
                )
        code = agent_code_for_task_row(subtask) or agent_code_for_task_row(main_task)
        outcome_updates = _outcome_patch(
            summary,
            outputs,
            target_status=target,
            workspace_root=ws,
            agent_code=code,
        )
        if handlers_norm is not None:
            handlers_norm = absolutize_handlers_paths(handlers_norm, ws, agent_code=code)
            outcome_updates["handlers"] = handlers_norm
        updates: dict[str, Any] = {"status": target, **outcome_updates}
        if target == "completed":
            updates["progress"] = 100
            updates["completed_at"] = subtask.get("completed_at") or now
        elif target == "awaiting_close":
            # 本岗已交工，进度记 100%（整单待闭环，但不影响本岗完成度）
            updates["progress"] = 100
        elif target in {"failed", "cancelled"}:
            updates["failed_at"] = subtask.get("failed_at") or now
        ok = patch_collab_subtask_in_project_storage(storage, mtid, sid, updates)
        if not ok:
            raise ValidationError("Failed to save subtask")
        rollup_root_task_progress_from_subtasks(storage, mtid)
        return {
            "task_id": mtid,
            "subtask_id": sid,
            "from_status": current,
            "status": target,
            "status_zh": _status_zh(target),
            "summary": outcome_updates.get("summary"),
            "outputs": outcome_updates.get("outputs"),
            "handlers": outcome_updates.get("handlers"),
        }

    found = find_main_task(storage, tid, bypass_cache=True)
    if not found:
        raise NotFoundError(f"Task '{tid}' not found")
    _project, task = found
    current = _normalize_status(task.get("status"))
    # Remap completed+existing handlers (caller omitted handlers=) → awaiting_close
    if (
        target == "completed"
        and handlers_norm is None
        and task_handlers_of(task)
        and not str(task.get("handlers_dispatched_at") or "").strip()
    ):
        target = "awaiting_close"
    if current == "reviewed" and target == "completed":
        pass
    elif current == "awaiting_close" and target == "completed":
        pass
    elif not _can_transition(current, target):
        # Employee may pass status=reviewed (mapped to completed); allow if reviewed was legal.
        if not (raw_target == "reviewed" and _can_transition(current, "reviewed")):
            hint = (
                f"; use progress or state=executing first, then {target}"
                if current in {"pending", "planned", "planning", "waiting_user"}
                and target in {"completed", "failed", "awaiting_close", "reviewed"}
                else ""
            )
            raise ValidationError(
                f"illegal state transition: {current} -> {target}{hint}"
            )

    ws = workspace_root_for_task_row(task)
    code = agent_code_for_task_row(task)
    outcome_updates = _outcome_patch(
        summary,
        outputs,
        target_status=target,
        workspace_root=ws,
        agent_code=code,
    )
    if handlers_norm is not None:
        handlers_norm = absolutize_handlers_paths(handlers_norm, ws, agent_code=code)
        outcome_updates["handlers"] = handlers_norm

    assignee = str(task.get("assigned_to") or "").strip()
    # Org: employee handoff → direct reports only.
    if handlers_norm is not None or (
        target in {"completed", "awaiting_close"}
        and task_handlers_of(task)
        and not str(task.get("handlers_dispatched_at") or "").strip()
    ):
        from evoflow.collab.handler_org import assert_handlers_org_ok

        to_check = handlers_norm if handlers_norm is not None else task_handlers_of(task)
        if to_check:
            proposer = assignee or str(task.get("raised_by") or "").strip() or "user"
            assert_handlers_org_ok(from_agent=proposer, handlers=to_check)

    updates = {"status": target, **outcome_updates}
    if target == "completed":
        updates["progress"] = 100
        updates["completed_at"] = task.get("completed_at") or now
    elif target == "awaiting_close":
        # 本岗已交工，进度记 100%（整单待闭环，但不影响本岗完成度）
        updates["progress"] = 100
    elif target in {"failed", "cancelled"}:
        updates["failed_at"] = task.get("failed_at") or now
    ok = patch_collab_main_task_in_project_storage(storage, tid, updates)
    if not ok:
        raise ValidationError("Failed to save task")

    dispatched: list[dict[str, Any]] | None = None
    handoff_approval: dict[str, Any] | None = None
    if target in {"completed", "awaiting_close"}:
        final_handlers = handlers_norm if handlers_norm is not None else task_handlers_of(task)
        if final_handlers and not str(task.get("handlers_dispatched_at") or "").strip():
            merged = {**task, **updates, "handlers": final_handlers}
            if handoff_needs_approval(merged):
                handoff_approval = _request_handoff_approval(merged)
                patch_collab_main_task_in_project_storage(
                    storage,
                    tid,
                    {
                        "handlers": final_handlers,
                        "handlers_pending_approval": True,
                    },
                )
            else:
                from_agent = assignee or "user"
                try:
                    dispatched = dispatch_confirmed_handlers(
                        tid,
                        final_handlers,
                        from_agent=from_agent,
                        parent_name=str(task.get("name") or task.get("title") or tid).strip(),
                    )
                    patch_collab_main_task_in_project_storage(
                        storage,
                        tid,
                        {
                            "handlers": final_handlers,
                            "handlers_pending_approval": False,
                            "handlers_dispatched_at": now,
                            "handlers_dispatched": [
                                {
                                    "agent_code": d.get("agent_code"),
                                    "task_id": d.get("task_id"),
                                    "ok": d.get("ok"),
                                }
                                for d in (dispatched or [])
                            ],
                        },
                    )
                except Exception:
                    logger.exception("dispatch_confirmed_handlers failed for %s", tid)

    out = {
        "task_id": tid,
        "subtask_id": None,
        "from_status": current,
        "status": target,
        "status_zh": _status_zh(target),
        "summary": outcome_updates.get("summary"),
        "outputs": outcome_updates.get("outputs"),
        "handlers": handlers_norm if handlers_norm is not None else task_handlers_of({**task, **updates}),
        "handlers_dispatched": dispatched,
    }
    if handoff_approval is not None:
        out["handlers_pending_approval"] = True
        out["handoff_approval"] = handoff_approval

    # Downstream receipt: child terminal / 待闭环 → soft-wake orchestrating superior(s).
    if target in {"completed", "failed", "cancelled", "awaiting_close"} and str(
        task.get("parent_task_id") or ""
    ).strip():
        try:
            from evoflow.collab.upstream_receipt import notify_upstream_on_child_terminal

            receipt = notify_upstream_on_child_terminal(
                {**task, **updates, "id": tid},
                terminal_status=target,
            )
            if receipt is not None:
                out["upstream_receipt"] = receipt
        except Exception:
            logger.exception("upstream receipt notify failed for %s", tid)

    # Minimal memory hygiene: terminal work → mark matching memories stale.
    if target in {"completed", "failed", "cancelled"} and not subtask_id:
        try:
            from evoflow.memory.stale_on_close import stale_memories_on_close

            title = str(task.get("name") or task.get("title") or "").strip()
            summary = str(outcome_updates.get("summary") or task.get("summary") or "").strip()
            stale = stale_memories_on_close(
                title=title,
                notes=summary,
                agent_code=assignee or str(task.get("assigned_to") or ""),
                source_ref=f"task:{tid}",
                reason=f"task {target}",
            )
            out["memories_stale"] = stale
        except Exception:
            logger.debug("task terminal → memory stale hook failed", exc_info=True)

    # User Item mirror: Task progress/status → linked item (done when Task completes).
    if not subtask_id:
        try:
            from evoflow.items.service import sync_item_from_linked_task

            merged = {**task, **updates, "id": tid}
            item_sync = sync_item_from_linked_task(tid, task=merged)
            if item_sync is not None:
                out["item_sync"] = item_sync
        except Exception:
            logger.debug("item sync after set_task_state failed task=%s", tid, exc_info=True)

    return out


def dispatch_confirmed_handlers(
    parent_task_id: str,
    handlers: list[dict[str, Any]],
    *,
    from_agent: str = "user",
    parent_name: str = "",
) -> list[dict[str, Any]]:
    """Create one child Task per handler and wake the assignee.

    Child description = content + referenced read_outputs.
    Child ``input_refs`` = those read refs (do **not** stamp child ``outputs``).
    Idempotent at the caller: only invoke once per parent (see handlers_dispatched_at).
    """
    from evoflow.admin import employees as employees_admin
    from evoflow.collab.handler_org import assert_handlers_org_ok
    from evoflow.collab.task_outputs import (
        absolutize_task_outputs,
        normalize_task_input_refs,
        workspace_root_for_agent,
        workspace_root_for_task_row,
    )

    parent = str(parent_task_id or "").strip()
    if not parent:
        raise ValidationError("parent_task_id is required")
    rows = normalize_task_handlers(handlers)
    # Human confirm path typically passes from_agent=assignee for wake attribution;
    # org was already checked in set_task_state. Re-check with user if from is employee
    # would fail peers — use user for assert here only when creating after confirm.
    assert_handlers_org_ok(from_agent="user", handlers=rows)
    results: list[dict[str, Any]] = []
    parent_label = str(parent_name or "").strip() or parent
    parent_ws = workspace_root_for_agent(str(from_agent or "").strip())
    if not parent_ws:
        try:
            found = find_main_task(get_project_storage(), parent, bypass_cache=True)
            if found:
                parent_ws = workspace_root_for_task_row(found[1])
        except Exception:
            parent_ws = ""

    for h in rows:
        code = str(h.get("agent_code") or "").strip()
        content = str(h.get("content") or "").strip()
        outs = normalize_task_input_refs(h.get("read_outputs") or h.get("outputs"))
        if outs and parent_ws:
            outs = absolutize_task_outputs(outs, parent_ws, agent_code=str(from_agent or "").strip())
        role_name = str(h.get("role") or "").strip() or None

        if not role_name:
            try:
                role = employees_admin.resolve_role_ref(code)
                role_name = str(role.role_name or "").strip() or None
                code = str(role.agent_code or code).strip()
            except Exception:
                pass

        title_bit = content[:36] if content else code
        name = f"处理：{title_bit}" if title_bit else f"跟进 {parent}"
        desc_parts: list[str] = []
        if content:
            desc_parts.append(content)
        desc_parts.append(f"\n上游交工：{parent_label}（`{parent}`）")
        if outs:
            desc_parts.append("\n参考产物（请先阅读，见 input_refs）：")
            for o in outs:
                label = str(o.get("label") or o.get("key") or "产物").strip()
                value = str(o.get("value") or "").strip()
                desc_parts.append(f"- [{label}] {value}")
        description = "\n".join(desc_parts).strip()

        created: dict[str, Any] = {}
        wake_result: dict[str, Any] | None = None
        err: str | None = None
        try:
            created = create_task(
                name=name,
                description=description,
                assignee=code,
                assigned_role=role_name,
                parent_task_id=parent,
                raised_by=str(from_agent or "user").strip() or "user",
                source="role",
                action_type="task_delegation",
                risk_level="medium",
                bypass_handoff_gate=True,
            )
            child_id = str(created.get("task_id") or "").strip()
            if outs and child_id:
                # Upstream refs only — never occupy the child's deliverable ``outputs``.
                patch_collab_main_task_in_project_storage(
                    get_project_storage(),
                    child_id,
                    {
                        "input_refs": outs,
                    },
                )
            if child_id:
                goal = content or f"请处理上游交工 `{parent}` 指派给你的工作"
                try:
                    wake_result = employees_admin.wake(
                        code,
                        goal=goal[:500],
                        from_agent=str(from_agent or "").strip(),
                        task_id=child_id,
                        description=description[:2000],
                        source="role",
                    )
                except Exception as wake_exc:
                    logger.warning(
                        "wake handler %s for child %s failed: %s",
                        code,
                        child_id,
                        wake_exc,
                    )
                    wake_result = {"ok": False, "error": str(wake_exc)}
            # Person Kernel Phase D: open commitment + relation/affect on formal handoff
            if child_id:
                try:
                    from evoflow.person_kernel import on_handoff_dispatched

                    on_handoff_dispatched(
                        from_agent=str(from_agent or "user").strip() or "user",
                        to_agent=code,
                        parent_task_id=parent,
                        child_task_id=child_id,
                        note=content[:200] if content else "正式交工",
                    )
                except Exception:
                    logger.debug(
                        "person_kernel on_handoff_dispatched skipped parent=%s child=%s",
                        parent,
                        child_id,
                        exc_info=True,
                    )
        except Exception as exc:
            err = str(exc)
            logger.exception("create handler child for %s -> %s failed", parent, code)

        results.append(
            {
                "ok": not err and bool(created.get("task_id")),
                "agent_code": code,
                "role": role_name,
                "content": content,
                "task_id": created.get("task_id"),
                "wake": wake_result,
                "error": err,
            }
        )
    return results


# ── delete_task ──────────────────────────────────────────────────────


def delete_task(task_id: str) -> dict[str, Any]:
    """Hard-delete a main task (and its project if it becomes empty).

    Mirrors Gateway ``DELETE /tasks/{task_id}``. Does not cascade-delete
    separately linked parent/child main tasks in a handoff tree.
    """
    storage = get_project_storage()
    tid = str(task_id or "").strip()
    if not tid:
        raise ValidationError("task_id is required")

    found = find_main_task(storage, tid, bypass_cache=True)
    if not found:
        raise NotFoundError(f"Task '{tid}' not found")

    project, task = found
    project_id = str(project.get("id") or "").strip()
    tasks = list(project.get("tasks") or [])
    new_tasks = [t for t in tasks if str(t.get("id") or "").strip() != tid]
    if len(new_tasks) == len(tasks):
        raise NotFoundError(f"Task '{tid}' not found")

    name = str(task.get("name") or task.get("title") or tid).strip()
    project_deleted = False
    if not new_tasks and project_id:
        try:
            project_deleted = bool(storage.delete_project(project_id))
        except Exception:
            logger.warning(
                "admin.tasks: delete_project failed project=%s; clearing tasks instead",
                project_id,
                exc_info=True,
            )
            project_deleted = False
        if not project_deleted:
            project["tasks"] = []
            if not storage.save_project(project):
                raise ValidationError("Failed to save project after task deletion")
    else:
        project["tasks"] = new_tasks
        if not storage.save_project(project):
            raise ValidationError("Failed to save project after task deletion")

    try:
        from evoflow.persistence.repositories import delete_task_bundle

        delete_task_bundle(tid)
    except Exception:
        logger.debug("admin.tasks: delete_task_bundle skipped task=%s", tid, exc_info=True)

    return {
        "ok": True,
        "deleted": True,
        "task_id": tid,
        "name": name,
        "project_deleted": project_deleted,
    }


# ── create_task ──────────────────────────────────────────────────────


def create_task(
    *,
    name: str,
    description: str = "",
    assignee: str | None = None,
    assigned_role: str | None = None,
    main_task_id: str | None = None,
    initial_status: str = "pending",
    result: str | None = None,
    source: str | None = None,
    source_ref: str | None = None,
    raised_by: str | None = None,
    risk_level: str | None = None,
    action_type: str | None = None,
    round_id: str | None = None,
    parent_task_id: str | None = None,
    bypass_handoff_gate: bool = False,
) -> dict[str, Any]:
    """Create a task or subtask.

    - ``main_task_id`` given: append a collab subtask under it (assigned_to=assignee).
    - else: create a new standalone main task.

    ``parent_task_id`` links a **new main task** to an upstream main task for
    cross-role handoff trees. Distinct from collab ``subtasks[]``.

    ``assigned_role`` stamps the 岗位显示名. ``raised_by`` is user or agent_code.
    ``bypass_handoff_gate``: system dispatch may create children while parent
    still carries ``handlers_pending_approval``.
    """
    from evoflow.collab.task_source import (
        TASK_SOURCE_CHAT,
        TASK_SOURCE_ROLE,
        resolve_write_source,
        task_source_zh,
    )

    storage = get_project_storage()
    nm = str(name or "").strip()
    if not nm:
        raise ValidationError("name is required")
    status_norm = _normalize_status(initial_status) or "pending"
    now = utc_now_iso_z()
    assignee_norm = str(assignee or "").strip() or None
    role_norm = str(assigned_role or "").strip() or None
    raised_norm = str(raised_by or "").strip() or None
    risk_norm = str(risk_level or "").strip() or None
    action_norm = str(action_type or "").strip() or None
    round_norm = str(round_id or "").strip() or None
    ref_norm = str(source_ref or "").strip() or None
    parent_norm = str(parent_task_id or "").strip() or None
    if not ref_norm and round_norm:
        ref_norm = round_norm
    if parent_norm:
        if not find_main_task(storage, parent_norm, bypass_cache=True):
            raise NotFoundError(f"parent task '{parent_norm}' not found")
        if not bypass_handoff_gate:
            parent_found = find_main_task(storage, parent_norm, bypass_cache=True)
            if parent_found and task_has_pending_handoff_approval(parent_found[1]):
                raise ValidationError(
                    f"parent task '{parent_norm}' 交接待审批：批准前禁止手动 create 下游子任务；"
                    "请等用户同意后再由系统派发，或本岗用 tasks(state=completed, handlers=…) 交工"
                )
    # Default: role-stamped → role; else chat
    default_src = TASK_SOURCE_ROLE if role_norm else TASK_SOURCE_CHAT
    source_canon, source_channel = resolve_write_source(source, default=default_src)

    def _stamp_meta(row: dict[str, Any]) -> None:
        if raised_norm:
            row["raised_by"] = raised_norm
        if risk_norm:
            row["risk_level"] = risk_norm
        if action_norm:
            row["action_type"] = action_norm
        if round_norm:
            row["round_id"] = round_norm
        if role_norm:
            row["assigned_role"] = role_norm
        if source_channel:
            row["source_channel"] = source_channel
        if ref_norm:
            row["source_ref"] = ref_norm
        if parent_norm:
            row["parent_task_id"] = parent_norm

    if main_task_id:
        if parent_norm:
            raise ValidationError(
                "parent_task_id is for main-task handoff trees; "
                "use main_task_id alone when creating a collab subtask"
            )
        mtid = str(main_task_id).strip()
        with main_task_mutation_lock(mtid):
            found = find_main_task(storage, mtid, bypass_cache=True)
            if not found:
                raise NotFoundError(f"Main task '{mtid}' not found")
            project, task = found
            subtask_data: dict[str, Any] = {
                "id": make_subtask_id(),
                "name": nm,
                "description": str(description or "").strip(),
                "status": status_norm,
                "dependencies": [],
                "assigned_to": assignee_norm,
                "result": result,
                "error": None,
                "created_at": now,
                "started_at": now if status_norm in {"executing", "reviewed", "completed"} else None,
                "completed_at": now if status_norm == "completed" else None,
                "progress": 100 if status_norm == "completed" else 0,
                "source": source_canon,
            }
            _stamp_meta(subtask_data)
            subs = list(task.get("subtasks") or [])
            subs.append(subtask_data)
            task["subtasks"] = subs
            task["updated_at"] = now
            project["updated_at"] = now
            ok = storage.save_project(project)
        if not ok:
            raise ValidationError("Failed to save subtask")
        rollup_root_task_progress_from_subtasks(storage, mtid)
        return {
            "task_id": mtid,
            "subtask_id": subtask_data["id"],
            "name": nm,
            "status": status_norm,
            "status_zh": _status_zh(status_norm),
            "assigned_to": assignee_norm,
            "assigned_role": role_norm,
            "raised_by": raised_norm,
            "parent_task_id": None,
            "source": source_canon,
            "source_zh": task_source_zh(source_canon),
            "source_channel": source_channel,
            "source_ref": ref_norm,
            "risk_level": risk_norm,
            "action_type": action_norm,
            "round_id": round_norm,
            "is_subtask": True,
        }

    # new standalone main task
    project, task = new_project_bundle_root_task(nm, str(description or "").strip())
    task["status"] = status_norm
    task["assigned_to"] = assignee_norm
    task["source"] = source_canon
    _stamp_meta(task)
    if result:
        task["result"] = result
    if status_norm == "completed":
        task["progress"] = 100
        task["completed_at"] = now
    if status_norm in {"executing", "reviewed", "completed"}:
        task["started_at"] = task.get("started_at") or now
    ok = storage.save_project(project)
    if not ok:
        raise ValidationError("Failed to create task")
    return {
        "task_id": task["id"],
        "name": nm,
        "status": status_norm,
        "status_zh": _status_zh(status_norm),
        "assigned_to": assignee_norm,
        "assigned_role": role_norm,
        "raised_by": raised_norm,
        "parent_task_id": parent_norm,
        "source": source_canon,
        "source_zh": task_source_zh(source_canon),
        "source_channel": source_channel,
        "source_ref": ref_norm,
        "risk_level": risk_norm,
        "action_type": action_norm,
        "round_id": round_norm,
        "is_subtask": False,
    }
