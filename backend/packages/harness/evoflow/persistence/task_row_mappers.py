"""Map task bundles, details, global facts, and thread collab between rows and dicts."""

from __future__ import annotations

import json
from typing import Any

_BUNDLE_TOP = frozenset(
    {
        "id",
        "name",
        "description",
        "status",
        "supervisor_session_id",
        "created_at",
        "updated_at",
        "tasks",
    }
)

_TASK_KNOWN = frozenset(
    {
        "id",
        "name",
        "description",
        "status",
        "parent_id",
        "dependencies",
        "assigned_to",
        "result",
        "error",
        "created_at",
        "started_at",
        "completed_at",
        "progress",
        "execution_authorized",
        "thread_id",
        "authorized_at",
        "authorized_by",
        "subtasks",
        "execution_history",
        "execution_conversation",
        "plan_goal",
        "plan_flowchart_mermaid",
        "plan_validation",
        "plan_validation_json",
        "plan_open_questions",
        "plan_steps",
        "plan_steps_json",
        "plan_bound_at",
    }
)

_SUBTASK_KNOWN = frozenset(
    {
        "id",
        "ref",
        "name",
        "description",
        "status",
        "parent_id",
        "dependencies",
        "assigned_to",
        "result",
        "error",
        "created_at",
        "started_at",
        "completed_at",
        "progress",
        "execution_authorized",
        "thread_id",
        "authorized_at",
        "authorized_by",
        "worker_profile",
        "project_path",
        "claude_session_id",
        "external_session_id",
        "updated_at",
        "execution_history",
        "execution_conversation",
    }
)

_WORKER_KNOWN = frozenset(
    {
        "base_subagent",
        "model",
        "instruction",
        "tools",
        "skills",
        "depends_on",
        "expected_outputs",
        "validation",
        "max_retries",
    }
)

_COLLAB_KNOWN = frozenset(
    {
        "collab_phase",
        "bound_task_id",
        "activated_scenarios",
        "sidebar_supervisor_steps",
        "updated_at",
    }
)

_DETAIL_KNOWN = frozenset(
    {
        "task_id",
        "agent_id",
        "main_task_id",
        "status",
        "facts",
        "output_summary",
        "current_step",
        "progress",
        "created_at",
        "updated_at",
        "completed_at",
    }
)

_FACT_KNOWN = frozenset({"id", "content", "category", "confidence", "source_message"})


def _json_dumps(obj: Any) -> str:
    return json.dumps(obj, ensure_ascii=False, separators=(",", ":"))


def _json_loads(raw: str | None) -> Any:
    if not raw:
        return None
    return json.loads(raw)


def _bool_int(v: Any) -> int:
    return 1 if v else 0


def _split_extra(doc: dict[str, Any], known: frozenset[str]) -> tuple[dict[str, Any], str]:
    extra = {k: v for k, v in doc.items() if k not in known}
    known_doc = {k: doc[k] for k in known if k in doc}
    return known_doc, _json_dumps(extra) if extra else "{}"


def _merge_extra(out: dict[str, Any], extra_json: str | None) -> dict[str, Any]:
    extra = _json_loads(extra_json)
    if isinstance(extra, dict):
        out.update(extra)
    return out


def strip_legacy_task_name_prefix(name: Any) -> str:
    """Remove historical ``任务: `` / ``任务：`` prefixes from stored display names."""
    s = str(name or "").strip()
    for prefix in ("任务: ", "任务：", "任务:", "任务："):
        if s.startswith(prefix):
            rest = s[len(prefix) :].strip()
            return rest or s
    return s


def resolve_root_task_display_name(*, task_name: Any = "", bundle_name: Any = "") -> str:
    """Prefer the root task row name; fall back to bundle header (stripped)."""
    own = strip_legacy_task_name_prefix(task_name)
    if own:
        return own
    return strip_legacy_task_name_prefix(bundle_name)


def bundle_row_from_task_rows(main_task_id: str, tasks: list[dict[str, Any]]) -> dict[str, Any]:
    """Derive legacy bundle header fields from the root ``evoflow_collab_tasks`` row."""
    want = str(main_task_id or "").strip()
    root = next((t for t in tasks if str(t.get("task_id") or "").strip() == want), None)
    if root is None and tasks:
        root = sorted(tasks, key=lambda r: int(r.get("sort_order") or 0))[0]
    if root is None:
        return {
            "main_task_id": want,
            "name": "",
            "description": "",
            "status": "pending",
            "supervisor_session_id": None,
            "created_at": "",
            "updated_at": "",
        }
    extra = _json_loads(root.get("extra_json"))
    supervisor_session_id = extra.get("supervisor_session_id") if isinstance(extra, dict) else None
    return {
        "main_task_id": want,
        "name": str(root.get("name") or ""),
        "description": str(root.get("description") or ""),
        "status": str(root.get("status") or "pending"),
        "supervisor_session_id": supervisor_session_id,
        "created_at": str(root.get("created_at") or ""),
        "updated_at": str(root.get("updated_at") or ""),
    }


def apply_bundle_header_to_task_rows(
    main_task_id: str,
    bundle_row: dict[str, Any],
    tasks: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Persist bundle-level metadata on the root task row (``task_id == main_task_id``)."""
    want = str(main_task_id or "").strip()
    if not want:
        return tasks
    out = [dict(t) for t in tasks]
    root_idx = next(
        (i for i, t in enumerate(out) if str(t.get("task_id") or "").strip() == want),
        None,
    )
    if root_idx is None:
        extra_json = "{}"
        sid = bundle_row.get("supervisor_session_id")
        if sid:
            extra_json = _json_dumps({"supervisor_session_id": sid})
        out.insert(
            0,
            {
                "main_task_id": want,
                "task_id": want,
                "name": resolve_root_task_display_name(bundle_name=bundle_row.get("name")),
                "description": str(bundle_row.get("description") or ""),
                "status": str(bundle_row.get("status") or "pending"),
                "parent_id": None,
                "assigned_to": None,
                "error_text": None,
                "created_at": str(bundle_row.get("created_at") or ""),
                "started_at": None,
                "completed_at": None,
                "progress": 0,
                "execution_authorized": 0,
                "thread_id": None,
                "authorized_at": None,
                "authorized_by": None,
                "result_json": None,
                "plan_goal": "",
                "plan_flowchart_mermaid": "",
                "plan_validation_json": "[]",
                "plan_open_questions": "",
                "plan_steps_json": "[]",
                "plan_bound_at": "",
                "extra_json": extra_json,
                "sort_order": 0,
                "updated_at": str(bundle_row.get("updated_at") or ""),
            },
        )
        return out
    root = dict(out[root_idx])
    # Task row name wins; never re-introduce legacy「任务: 」from bundle header.
    root["name"] = resolve_root_task_display_name(
        task_name=root.get("name"),
        bundle_name=bundle_row.get("name"),
    )
    root["description"] = str(root.get("description") or bundle_row.get("description") or "")
    if str(root.get("plan_bound_at") or "").strip():
        root["status"] = str(root.get("status") or bundle_row.get("status") or "pending")
        if str(root["status"]).strip().lower() in {"planning", "pending", ""}:
            root["status"] = "planned"
    else:
        # root task's own status wins; bundle (project) status is project-level metadata
        # and must NOT overwrite the task-level status (else set_task_state never persists).
        root["status"] = str(root.get("status") or bundle_row.get("status") or "pending")
    if bundle_row.get("created_at") and not str(root.get("created_at") or "").strip():
        root["created_at"] = str(bundle_row.get("created_at") or "")
    root["updated_at"] = str(bundle_row.get("updated_at") or root.get("updated_at") or "")
    extra = _json_loads(root.get("extra_json"))
    if not isinstance(extra, dict):
        extra = {}
    sid = bundle_row.get("supervisor_session_id")
    if sid:
        extra["supervisor_session_id"] = sid
    root["extra_json"] = _json_dumps(extra) if extra else "{}"
    out[root_idx] = root
    return out


def _result_json(result: Any) -> str | None:
    if result is None:
        return None
    if isinstance(result, str):
        return result
    return _json_dumps(result)


def _result_from_json(raw: str | None) -> Any:
    if raw is None or raw == "":
        return None
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        return raw


def collab_task_row_to_summary(tr: dict[str, Any]) -> dict[str, Any]:
    """Map one ``evoflow_collab_tasks`` row to a list/API task dict (no subtasks/history).

    Used by task-center listing so we do not load full bundles (subtasks + execution
    history) for every root task — that path blocked the Gateway event loop.
    """
    task_id = str(tr.get("task_id") or "").strip()
    main_task_id = str(tr.get("main_task_id") or task_id).strip() or task_id
    task: dict[str, Any] = {
        "id": task_id,
        "main_task_id": main_task_id,
        "name": strip_legacy_task_name_prefix(tr.get("name") or ""),
        "description": tr.get("description") or "",
        "status": tr.get("status") or "pending",
        "parent_id": tr.get("parent_id"),
        "dependencies": [],
        "assigned_to": tr.get("assigned_to"),
        "result": _result_from_json(tr.get("result_json")),
        "error": tr.get("error_text"),
        "created_at": tr.get("created_at") or "",
        "updated_at": str(tr.get("updated_at") or tr.get("created_at") or ""),
        "started_at": tr.get("started_at"),
        "completed_at": tr.get("completed_at"),
        "progress": int(tr.get("progress") or 0),
        "execution_authorized": bool(tr.get("execution_authorized")),
        "thread_id": tr.get("thread_id"),
        "authorized_at": tr.get("authorized_at"),
        "authorized_by": tr.get("authorized_by"),
        "subtasks": [],
        "plan_goal": str(tr.get("plan_goal") or ""),
        "plan_flowchart_mermaid": str(tr.get("plan_flowchart_mermaid") or ""),
        "plan_open_questions": str(tr.get("plan_open_questions") or ""),
        "plan_bound_at": str(tr.get("plan_bound_at") or ""),
    }
    val_loaded = _json_loads(tr.get("plan_validation_json"))
    task["plan_validation"] = val_loaded if isinstance(val_loaded, list) else []
    steps_loaded = _json_loads(tr.get("plan_steps_json"))
    if isinstance(steps_loaded, list):
        task["plan_steps"] = [x for x in steps_loaded if isinstance(x, dict)]
    _merge_extra(task, tr.get("extra_json"))
    task.pop("execution_conversation", None)
    # Column updated_at wins over stale extra_json copies.
    col_updated = str(tr.get("updated_at") or "").strip()
    if col_updated:
        task["updated_at"] = col_updated
    return task


def collab_subtask_row_to_summary(sr: dict[str, Any]) -> dict[str, Any]:
    """Map one ``evoflow_collab_subtasks`` row to a light list dict (no history/blobs)."""
    sub_id = str(sr.get("subtask_id") or "").strip()
    parent_task_id = str(sr.get("parent_task_id") or "").strip()
    main_task_id = str(sr.get("main_task_id") or parent_task_id).strip() or parent_task_id
    st: dict[str, Any] = {
        "id": sub_id,
        "main_task_id": main_task_id,
        # SQL parent (collab nesting). Not the cross-role handoff field — that may
        # arrive via extra_json as ``parent_task_id`` after ``_merge_extra``.
        "_collab_parent_task_id": parent_task_id,
        "name": sr.get("name") or "",
        "description": sr.get("description") or "",
        "status": sr.get("status") or "pending",
        "parent_id": sr.get("parent_id"),
        "assigned_to": sr.get("assigned_to"),
        "error": sr.get("error_text"),
        "created_at": sr.get("created_at") or "",
        "updated_at": str(sr.get("updated_at") or sr.get("created_at") or ""),
        "started_at": sr.get("started_at"),
        "completed_at": sr.get("completed_at"),
        "progress": int(sr.get("progress") or 0),
        "thread_id": sr.get("thread_id"),
    }
    _merge_extra(st, sr.get("extra_json"))
    col_updated = str(sr.get("updated_at") or "").strip()
    if col_updated:
        st["updated_at"] = col_updated
    return st


def bundle_to_rows(document: dict[str, Any]) -> dict[str, Any]:
    """Split a project bundle dict into rows for v14 tables."""
    doc = dict(document)
    main_task_id = str(doc.get("id") or "").strip()
    bundle_row = {
        "main_task_id": main_task_id,
        "name": str(doc.get("name") or ""),
        "description": str(doc.get("description") or ""),
        "status": str(doc.get("status") or "pending"),
        "supervisor_session_id": doc.get("supervisor_session_id"),
        "created_at": str(doc.get("created_at") or ""),
        "updated_at": str(doc.get("updated_at") or ""),
    }
    tasks_out: list[dict[str, Any]] = []
    task_deps: list[dict[str, Any]] = []
    subtasks_out: list[dict[str, Any]] = []
    subtask_deps: list[dict[str, Any]] = []
    subtask_outputs: list[dict[str, Any]] = []
    subtask_tools: list[dict[str, Any]] = []
    subtask_skills: list[dict[str, Any]] = []
    task_exec_history: list[dict[str, Any]] = []

    for t_idx, task in enumerate(doc.get("tasks") or []):
        if not isinstance(task, dict):
            continue
        task_id = str(task.get("id") or "").strip()
        if not task_id:
            continue
        known, extra_json = _split_extra(task, _TASK_KNOWN)
        exec_hist = known.pop("execution_history", None)
        known.pop("execution_conversation", None)
        if isinstance(exec_hist, list):
            for h_idx, ev in enumerate(exec_hist):
                if isinstance(ev, dict):
                    task_exec_history.append(
                        {
                            "main_task_id": main_task_id,
                            "parent_task_id": task_id,
                            "subtask_id": "",
                            "sort_order": h_idx,
                            "event_json": _json_dumps(ev),
                        }
                    )
        plan_validation = known.get("plan_validation")
        plan_validation_json = known.get("plan_validation_json")
        if plan_validation_json is None:
            plan_validation_json = (
                _json_dumps(plan_validation) if isinstance(plan_validation, list) else "[]"
            )
        elif not isinstance(plan_validation_json, str):
            plan_validation_json = _json_dumps(plan_validation_json)

        plan_steps = known.get("plan_steps")
        plan_steps_json = known.get("plan_steps_json")
        if plan_steps_json is None:
            plan_steps_json = _json_dumps(plan_steps) if isinstance(plan_steps, list) else "[]"
        elif not isinstance(plan_steps_json, str):
            plan_steps_json = _json_dumps(plan_steps_json)

        tasks_out.append(
            {
                "main_task_id": main_task_id,
                "task_id": task_id,
                "name": str(known.get("name") or ""),
                "description": str(known.get("description") or ""),
                "status": str(known.get("status") or "pending"),
                "parent_id": known.get("parent_id"),
                "assigned_to": known.get("assigned_to"),
                "error_text": known.get("error"),
                "created_at": str(known.get("created_at") or ""),
                "started_at": known.get("started_at"),
                "completed_at": known.get("completed_at"),
                "progress": int(known.get("progress") or 0),
                "execution_authorized": _bool_int(known.get("execution_authorized")),
                "thread_id": known.get("thread_id"),
                "authorized_at": known.get("authorized_at"),
                "authorized_by": known.get("authorized_by"),
                "result_json": _result_json(known.get("result")),
                "plan_goal": str(known.get("plan_goal") or ""),
                "plan_flowchart_mermaid": str(known.get("plan_flowchart_mermaid") or ""),
                "plan_validation_json": plan_validation_json,
                "plan_open_questions": str(known.get("plan_open_questions") or ""),
                "plan_steps_json": plan_steps_json,
                "plan_bound_at": str(known.get("plan_bound_at") or ""),
                "extra_json": extra_json,
                "sort_order": t_idx,
                "updated_at": str(known.get("updated_at") or ""),
            }
        )
        for d_idx, dep in enumerate(known.get("dependencies") or []):
            dep_id = str(dep or "").strip()
            if dep_id:
                task_deps.append(
                    {
                        "main_task_id": main_task_id,
                        "task_id": task_id,
                        "depends_on_id": dep_id,
                        "sort_order": d_idx,
                    }
                )

        for s_idx, st in enumerate(task.get("subtasks") or []):
            if not isinstance(st, dict):
                continue
            sub_id = str(st.get("id") or "").strip()
            if not sub_id:
                continue
            st_known, st_extra = _split_extra(st, _SUBTASK_KNOWN)
            wp = st_known.pop("worker_profile", None)
            st_exec = st_known.pop("execution_history", None)
            st_known.pop("execution_conversation", None)
            if isinstance(st_exec, list):
                for h_idx, ev in enumerate(st_exec):
                    if isinstance(ev, dict):
                        merged_ev = dict(ev)
                        merged_ev.setdefault("collab_subtask_id", sub_id)
                        task_exec_history.append(
                            {
                                "main_task_id": main_task_id,
                                "parent_task_id": task_id,
                                "subtask_id": "",
                                "sort_order": h_idx,
                                "event_json": _json_dumps(merged_ev),
                            }
                        )

            wp_obj = wp if isinstance(wp, dict) else {}
            wp_known, wp_extra = _split_extra(wp_obj, _WORKER_KNOWN)
            extra = _json_loads(st_extra) or {}
            if not isinstance(extra, dict):
                extra = {}
            if wp_extra != "{}":
                extra["worker_profile_extra"] = _json_loads(wp_extra)
            # ref 无独立列：写入 extra，否则落库后再加载会丢，画布节点对不上
            ref_val = str(st_known.get("ref") or "").strip()
            if ref_val:
                extra["ref"] = ref_val
            st_extra = _json_dumps(extra)

            subtasks_out.append(
                {
                    "main_task_id": main_task_id,
                    "parent_task_id": task_id,
                    "subtask_id": sub_id,
                    "name": str(st_known.get("name") or ""),
                    "description": str(st_known.get("description") or ""),
                    "status": str(st_known.get("status") or "pending"),
                    "parent_id": st_known.get("parent_id"),
                    "assigned_to": st_known.get("assigned_to"),
                    "error_text": st_known.get("error"),
                    "created_at": str(st_known.get("created_at") or ""),
                    "started_at": st_known.get("started_at"),
                    "completed_at": st_known.get("completed_at"),
                    "progress": int(st_known.get("progress") or 0),
                    "execution_authorized": _bool_int(st_known.get("execution_authorized")),
                    "thread_id": st_known.get("thread_id"),
                    "authorized_at": st_known.get("authorized_at"),
                    "authorized_by": st_known.get("authorized_by"),
                    "project_path": st_known.get("project_path"),
                    "claude_session_id": st_known.get("claude_session_id"),
                    "external_session_id": st_known.get("external_session_id"),
                    "updated_at": st_known.get("updated_at"),
                    "result_json": _result_json(st_known.get("result")),
                    "extra_json": st_extra,
                    "worker_base_subagent": wp_known.get("base_subagent"),
                    "worker_model": wp_known.get("model"),
                    "worker_instruction": wp_known.get("instruction"),
                    "worker_validation": wp_known.get("validation"),
                    "worker_max_retries": int(wp_known.get("max_retries") or 3),
                    "sort_order": s_idx,
                }
            )
            for d_idx, dep in enumerate(st_known.get("dependencies") or []):
                dep_id = str(dep or "").strip()
                if dep_id:
                    subtask_deps.append(
                        {
                            "main_task_id": main_task_id,
                            "parent_task_id": task_id,
                            "subtask_id": sub_id,
                            "depends_on_subtask_id": dep_id,
                            "link_kind": "dependency",
                            "sort_order": d_idx,
                        }
                    )
            for d_idx, dep in enumerate(wp_known.get("depends_on") or []):
                dep_id = str(dep or "").strip()
                if dep_id:
                    subtask_deps.append(
                        {
                            "main_task_id": main_task_id,
                            "parent_task_id": task_id,
                            "subtask_id": sub_id,
                            "depends_on_subtask_id": dep_id,
                            "link_kind": "worker_depends",
                            "sort_order": d_idx,
                        }
                    )
            for o_idx, out_path in enumerate(wp_known.get("expected_outputs") or []):
                path = str(out_path or "").strip()
                if path:
                    subtask_outputs.append(
                        {
                            "main_task_id": main_task_id,
                            "parent_task_id": task_id,
                            "subtask_id": sub_id,
                            "output_path": path,
                            "sort_order": o_idx,
                        }
                    )
            for t_idx2, tool in enumerate(wp_known.get("tools") or []):
                val = str(tool or "").strip()
                if val:
                    subtask_tools.append(
                        {
                            "main_task_id": main_task_id,
                            "parent_task_id": task_id,
                            "subtask_id": sub_id,
                            "item_value": val,
                            "sort_order": t_idx2,
                        }
                    )
            for sk_idx, skill in enumerate(wp_known.get("skills") or []):
                val = str(skill or "").strip()
                if val:
                    subtask_skills.append(
                        {
                            "main_task_id": main_task_id,
                            "parent_task_id": task_id,
                            "subtask_id": sub_id,
                            "item_value": val,
                            "sort_order": sk_idx,
                        }
                    )

        # execution_conversation is legacy; transcript lives in evoflow_chat_messages.

    return {
        "bundle": bundle_row,
        "tasks": tasks_out,
        "task_deps": task_deps,
        "subtasks": subtasks_out,
        "subtask_deps": subtask_deps,
        "subtask_outputs": subtask_outputs,
        "subtask_tools": subtask_tools,
        "subtask_skills": subtask_skills,
        "execution_history": task_exec_history,
    }


def rows_to_bundle(
    bundle_row: dict[str, Any],
    tasks: list[dict[str, Any]],
    task_deps: list[dict[str, Any]],
    subtasks: list[dict[str, Any]],
    subtask_deps: list[dict[str, Any]],
    subtask_outputs: list[dict[str, Any]],
    subtask_tools: list[dict[str, Any]],
    subtask_skills: list[dict[str, Any]],
    execution_history: list[dict[str, Any]],
) -> dict[str, Any]:
    """Assemble a project bundle dict from v14 rows."""
    main_task_id = bundle_row["main_task_id"]
    out: dict[str, Any] = {
        "id": main_task_id,
        "name": strip_legacy_task_name_prefix(bundle_row.get("name") or ""),
        "description": bundle_row.get("description") or "",
        "status": bundle_row.get("status") or "pending",
        "supervisor_session_id": bundle_row.get("supervisor_session_id"),
        "created_at": bundle_row.get("created_at") or "",
        "updated_at": bundle_row.get("updated_at") or "",
        "tasks": [],
    }

    deps_by_task: dict[str, list[str]] = {}
    for d in task_deps:
        if d["main_task_id"] != main_task_id:
            continue
        deps_by_task.setdefault(d["task_id"], []).append(d["depends_on_id"])

    subs_by_parent: dict[str, list[dict[str, Any]]] = {}
    for st in subtasks:
        if st["main_task_id"] != main_task_id:
            continue
        subs_by_parent.setdefault(st["parent_task_id"], []).append(st)

    st_dep_map: dict[tuple[str, str], dict[str, list[str]]] = {}
    for d in subtask_deps:
        if d["main_task_id"] != main_task_id:
            continue
        key = (d["parent_task_id"], d["subtask_id"])
        kind = d.get("link_kind") or "dependency"
        st_dep_map.setdefault(key, {}).setdefault(kind, []).append(d["depends_on_subtask_id"])

    out_map: dict[tuple[str, str], list[str]] = {}
    for o in subtask_outputs:
        if o["main_task_id"] != main_task_id:
            continue
        out_map.setdefault((o["parent_task_id"], o["subtask_id"]), []).append(o["output_path"])

    tools_map: dict[tuple[str, str], list[str]] = {}
    for t in subtask_tools:
        if t["main_task_id"] != main_task_id:
            continue
        tools_map.setdefault((t["parent_task_id"], t["subtask_id"]), []).append(t["item_value"])

    skills_map: dict[tuple[str, str], list[str]] = {}
    for s in subtask_skills:
        if s["main_task_id"] != main_task_id:
            continue
        skills_map.setdefault((s["parent_task_id"], s["subtask_id"]), []).append(s["item_value"])

    hist_map: dict[tuple[str, str], list[dict[str, Any]]] = {}
    for h in execution_history:
        if h["main_task_id"] != main_task_id:
            continue
        parent = h["parent_task_id"]
        sub = h.get("subtask_id") or ""
        key = (parent, sub)
        ev = _json_loads(h.get("event_json"))
        if isinstance(ev, dict):
            hist_map.setdefault(key, []).append(ev)

    tasks_sorted = sorted(tasks, key=lambda r: int(r.get("sort_order") or 0))
    for tr in tasks_sorted:
        if tr["main_task_id"] != main_task_id:
            continue
        task_id = tr["task_id"]
        task: dict[str, Any] = {
            "id": task_id,
            "name": strip_legacy_task_name_prefix(tr.get("name") or ""),
            "description": tr.get("description") or "",
            "status": tr.get("status") or "pending",
            "parent_id": tr.get("parent_id"),
            "dependencies": deps_by_task.get(task_id, []),
            "assigned_to": tr.get("assigned_to"),
            "result": _result_from_json(tr.get("result_json")),
            "error": tr.get("error_text"),
            "created_at": tr.get("created_at") or "",
            "started_at": tr.get("started_at"),
            "completed_at": tr.get("completed_at"),
            "progress": int(tr.get("progress") or 0),
            "execution_authorized": bool(tr.get("execution_authorized")),
            "thread_id": tr.get("thread_id"),
            "authorized_at": tr.get("authorized_at"),
            "authorized_by": tr.get("authorized_by"),
            "subtasks": [],
            "plan_goal": str(tr.get("plan_goal") or ""),
            "plan_flowchart_mermaid": str(tr.get("plan_flowchart_mermaid") or ""),
            "plan_open_questions": str(tr.get("plan_open_questions") or ""),
            "plan_bound_at": str(tr.get("plan_bound_at") or ""),
        }
        val_loaded = _json_loads(tr.get("plan_validation_json"))
        task["plan_validation"] = val_loaded if isinstance(val_loaded, list) else []
        steps_loaded = _json_loads(tr.get("plan_steps_json"))
        if isinstance(steps_loaded, list):
            task["plan_steps"] = [x for x in steps_loaded if isinstance(x, dict)]
        _merge_extra(task, tr.get("extra_json"))
        task.pop("execution_conversation", None)
        task_hist = hist_map.get((task_id, ""), [])
        if task_hist:
            task["execution_history"] = task_hist
        # Legacy per-subtask history rows are hoisted onto the main task.
        for (parent_tid, sub_id), rows in hist_map.items():
            if parent_tid != task_id or not sub_id:
                continue
            main_hist = task.get("execution_history") or []
            if not isinstance(main_hist, list):
                main_hist = []
            for h in rows:
                if not isinstance(h, dict):
                    continue
                merged = dict(h)
                merged.setdefault("collab_subtask_id", sub_id)
                main_hist.append(merged)
            task["execution_history"] = main_hist

        sub_rows = sorted(subs_by_parent.get(task_id, []), key=lambda r: int(r.get("sort_order") or 0))
        for sr in sub_rows:
            sub_id = sr["subtask_id"]
            st: dict[str, Any] = {
                "id": sub_id,
                "name": sr.get("name") or "",
                "description": sr.get("description") or "",
                "status": sr.get("status") or "pending",
                "parent_id": sr.get("parent_id"),
                "dependencies": (st_dep_map.get((task_id, sub_id)) or {}).get("dependency", []),
                "assigned_to": sr.get("assigned_to"),
                "result": _result_from_json(sr.get("result_json")),
                "error": sr.get("error_text"),
                "created_at": sr.get("created_at") or "",
                "started_at": sr.get("started_at"),
                "completed_at": sr.get("completed_at"),
                "progress": int(sr.get("progress") or 0),
                "execution_authorized": bool(sr.get("execution_authorized")),
                "thread_id": sr.get("thread_id"),
                "authorized_at": sr.get("authorized_at"),
                "authorized_by": sr.get("authorized_by"),
                "subtasks": [],
            }
            if sr.get("project_path"):
                st["project_path"] = sr["project_path"]
            if sr.get("claude_session_id"):
                st["claude_session_id"] = sr["claude_session_id"]
            if sr.get("external_session_id"):
                st["external_session_id"] = sr["external_session_id"]
            if sr.get("updated_at"):
                st["updated_at"] = sr["updated_at"]
            _merge_extra(st, sr.get("extra_json"))
            st.pop("execution_conversation", None)

            wp_deps = (st_dep_map.get((task_id, sub_id)) or {}).get("worker_depends", [])
            wp: dict[str, Any] = {}
            if sr.get("worker_base_subagent"):
                wp["base_subagent"] = sr["worker_base_subagent"]
            if sr.get("worker_model"):
                wp["model"] = sr["worker_model"]
            if sr.get("worker_instruction"):
                wp["instruction"] = sr["worker_instruction"]
            if sr.get("worker_validation"):
                wp["validation"] = sr["worker_validation"]
            if sr.get("worker_max_retries") is not None:
                wp["max_retries"] = int(sr["worker_max_retries"] or 3)
            tools = tools_map.get((task_id, sub_id), [])
            if tools:
                wp["tools"] = tools
            skills = skills_map.get((task_id, sub_id), [])
            if skills:
                wp["skills"] = skills
            if wp_deps:
                wp["depends_on"] = wp_deps
            outputs = out_map.get((task_id, sub_id), [])
            if outputs:
                wp["expected_outputs"] = outputs
            extra = _json_loads(sr.get("extra_json"))
            if isinstance(extra, dict) and isinstance(extra.get("worker_profile_extra"), dict):
                wp.update(extra["worker_profile_extra"])
            if wp:
                st["worker_profile"] = wp

            task["subtasks"].append(st)
        out["tasks"].append(task)
    return out


def detail_to_rows(document: dict[str, Any]) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    doc = dict(document)
    known, _ = _split_extra(doc, _DETAIL_KNOWN)
    facts = known.pop("facts", None) or []
    row = {
        "main_task_id": str(known.get("main_task_id") or doc.get("main_task_id") or ""),
        "agent_id": str(known.get("agent_id") or doc.get("agent_id") or ""),
        "task_id": str(known.get("task_id") or doc.get("task_id") or ""),
        "status": str(known.get("status") or "pending"),
        "output_summary": str(known.get("output_summary") or ""),
        "current_step": str(known.get("current_step") or ""),
        "progress": int(known.get("progress") or 0),
        "created_at": str(known.get("created_at") or ""),
        "updated_at": str(known.get("updated_at") or ""),
        "completed_at": known.get("completed_at"),
    }
    fact_rows: list[dict[str, Any]] = []
    for idx, f in enumerate(facts):
        if not isinstance(f, dict):
            continue
        fact_rows.append(
            {
                "main_task_id": row["main_task_id"],
                "agent_id": row["agent_id"],
                "task_id": row["task_id"],
                "fact_id": str(f.get("id") or f"fact-{idx}"),
                "content": str(f.get("content") or ""),
                "category": str(f.get("category") or "finding"),
                "confidence": float(f.get("confidence") or 0.5),
                "source_message": f.get("source_message"),
                "sort_order": idx,
            }
        )
    return row, fact_rows


def rows_to_detail(row: dict[str, Any], facts: list[dict[str, Any]]) -> dict[str, Any]:
    out: dict[str, Any] = {
        "task_id": row["task_id"],
        "agent_id": row["agent_id"],
        "main_task_id": row["main_task_id"],
        "status": row.get("status") or "pending",
        "facts": [],
        "output_summary": row.get("output_summary") or "",
        "current_step": row.get("current_step") or "",
        "progress": int(row.get("progress") or 0),
        "created_at": row.get("created_at") or "",
        "updated_at": row.get("updated_at") or "",
        "completed_at": row.get("completed_at"),
    }
    for f in sorted(facts, key=lambda r: int(r.get("sort_order") or 0)):
        out["facts"].append(
            {
                "id": f.get("fact_id") or "",
                "content": f.get("content") or "",
                "category": f.get("category") or "finding",
                "confidence": float(f.get("confidence") or 0.5),
                "source_message": f.get("source_message"),
            }
        )
    return out


def global_facts_to_rows(document: dict[str, Any]) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    doc = dict(document)
    main_task_id = str(doc.get("main_task_id") or "").strip()
    header = {
        "main_task_id": main_task_id,
        "version": str(doc.get("version") or "1.0"),
        "last_updated": str(doc.get("last_updated") or ""),
    }
    fact_rows: list[dict[str, Any]] = []
    for idx, f in enumerate(doc.get("facts") or []):
        if not isinstance(f, dict):
            continue
        fact_rows.append(
            {
                "main_task_id": main_task_id,
                "fact_id": str(f.get("id") or f"fact-{idx}"),
                "content": str(f.get("content") or ""),
                "category": str(f.get("category") or "finding"),
                "confidence": float(f.get("confidence") or 0.5),
                "source_message": f.get("source_message"),
                "sort_order": idx,
            }
        )
    return header, fact_rows


def rows_to_global_facts(header: dict[str, Any], facts: list[dict[str, Any]]) -> dict[str, Any]:
    out: dict[str, Any] = {
        "version": header.get("version") or "1.0",
        "main_task_id": header["main_task_id"],
        "facts": [],
        "last_updated": header.get("last_updated") or "",
    }
    for f in sorted(facts, key=lambda r: int(r.get("sort_order") or 0)):
        out["facts"].append(
            {
                "id": f.get("fact_id") or "",
                "content": f.get("content") or "",
                "category": f.get("category") or "finding",
                "confidence": float(f.get("confidence") or 0.5),
                "source_message": f.get("source_message"),
            }
        )
    return out


def collab_to_rows(state: dict[str, Any]) -> tuple[dict[str, Any], list[dict[str, Any]], list[dict[str, Any]]]:
    doc = dict(state)
    known, _ = _split_extra(doc, _COLLAB_KNOWN)
    header = {
        "thread_id": "",
        "collab_phase": str(known.get("collab_phase") or "idle"),
        "bound_task_id": known.get("bound_task_id"),
        "updated_at": str(known.get("updated_at") or ""),
    }
    scenarios: list[dict[str, Any]] = []
    for idx, key in enumerate(known.get("activated_scenarios") or []):
        s = str(key or "").strip()
        if s:
            scenarios.append({"scenario_key": s, "sort_order": idx})
    steps: list[dict[str, Any]] = []
    for idx, step in enumerate(known.get("sidebar_supervisor_steps") or []):
        if isinstance(step, dict):
            steps.append({"sort_order": idx, "step_json": _json_dumps(step)})
    return header, scenarios, steps


def rows_to_collab(
    header: dict[str, Any],
    scenarios: list[dict[str, Any]],
    steps: list[dict[str, Any]],
) -> dict[str, Any]:
    out: dict[str, Any] = {
        "collab_phase": header.get("collab_phase") or "idle",
        "bound_task_id": header.get("bound_task_id"),
        "activated_scenarios": [s["scenario_key"] for s in sorted(scenarios, key=lambda r: int(r.get("sort_order") or 0))],
        "sidebar_supervisor_steps": [],
        "updated_at": header.get("updated_at") or "",
    }
    for s in sorted(steps, key=lambda r: int(r.get("sort_order") or 0)):
        step = _json_loads(s.get("step_json"))
        if isinstance(step, dict):
            out["sidebar_supervisor_steps"].append(step)
    return out
