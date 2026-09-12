"""Update subtask work checklist during execution (real-time progress)."""

from __future__ import annotations

import json
from typing import Annotated, Any

from langchain.tools import InjectedToolCallId, ToolRuntime, tool
from langgraph.typing import ContextT

from evoflow.collab.storage import get_project_storage
from evoflow.collab.work_checklist import (
    broadcast_checklist_progress,
    format_checklist_markdown_table,
    get_subtask_work_checklist,
    normalize_checklist_items,
    set_subtask_work_checklist,
    update_subtask_checklist_item,
)


def _resolve_collab_ids(runtime: ToolRuntime[ContextT, dict] | None) -> tuple[str | None, str | None]:
    if runtime is None:
        return None, None
    main_id: str | None = None
    sub_id: str | None = None
    try:
        ctx = runtime.context or {}
        main_id = str(ctx.get("collab_task_id") or "").strip() or None
        sub_id = str(ctx.get("collab_subtask_id") or "").strip() or None
    except Exception:
        pass
    try:
        cfg = getattr(runtime, "config", None) or {}
        configurable = cfg.get("configurable") or {}
        main_id = main_id or (str(configurable.get("collab_task_id") or "").strip() or None)
        sub_id = sub_id or (str(configurable.get("collab_subtask_id") or "").strip() or None)
    except Exception:
        pass
    return main_id, sub_id


@tool("subtask_work_checklist", parse_docstring=True)
async def subtask_work_checklist_tool(
    runtime: ToolRuntime[ContextT, dict],
    action: str,
    tool_call_id: Annotated[str, InjectedToolCallId],
    main_task_id: str | None = None,
    subtask_id: str | None = None,
    item_id: str | None = None,
    status: str | None = None,
    result: str | None = None,
    content: str | None = None,
    items: Any = None,
) -> str:
    """Persist and update this subtask's execution steps (content, status, result).

    **Worker-owned**: after you understand the subtask goal, call ``set`` with your step list
    before heavy work; call ``update`` as you progress. Lead dispatches and validates; does not
    maintain this list for you.

    Checklist updates automatically sync subtask ``progress`` (0–100). Also call
    ``subtask_progress_report`` at phase boundaries with ``current_step``.

    Args:
        action: ``list`` | ``set`` | ``update``
        main_task_id: Main collab task id (optional if runtime context has collab_task_id).
        subtask_id: Subtask id (optional if runtime context has collab_subtask_id).
        item_id: For ``update``: row id from ``list`` **or** 1-based table ``#`` (e.g. ``"2"`` for row 2).
        status: ``pending`` | ``in_progress`` | ``completed`` | ``cancelled`` (for ``update``).
        result: Outcome summary for the row (for ``update`` when completing).
        content: Replace row content (optional ``update``).
        items: For ``set``: list of ``{{content, status?, result?}}`` objects (replaces checklist).
    """
    act = str(action or "").strip().lower()
    ctx_main, ctx_sub = _resolve_collab_ids(runtime)
    mid = str(main_task_id or ctx_main or "").strip()
    sid = str(subtask_id or ctx_sub or "").strip()
    if not mid or not sid:
        return json.dumps(
            {
                "ok": False,
                "error": "main_task_id and subtask_id are required (or set collab_task_id/collab_subtask_id in runtime context)",
            },
            ensure_ascii=False,
        )

    storage = get_project_storage()

    if act == "list":
        from evoflow.collab.storage import find_subtask_by_ids

        st = find_subtask_by_ids(storage, mid, sid)
        if not st:
            return json.dumps({"ok": False, "error": "subtask not found"}, ensure_ascii=False)
        rows = get_subtask_work_checklist(st)
        return json.dumps(
            {
                "ok": True,
                "action": "list",
                "mainTaskId": mid,
                "subtaskId": sid,
                "items": rows,
                "tableMarkdown": format_checklist_markdown_table(rows),
            },
            ensure_ascii=False,
        )

    if act == "set":
        parsed = normalize_checklist_items(items)
        ok, msg, rows = set_subtask_work_checklist(storage, mid, sid, parsed, replace=True)
        if not ok:
            return json.dumps({"ok": False, "error": msg}, ensure_ascii=False)
        await broadcast_checklist_progress(mid, sid, rows)
        return json.dumps(
            {
                "ok": True,
                "action": "set",
                "count": len(rows),
                "tableMarkdown": format_checklist_markdown_table(rows),
            },
            ensure_ascii=False,
        )

    if act == "update":
        if not item_id:
            return json.dumps({"ok": False, "error": "item_id is required for update"}, ensure_ascii=False)
        ok, msg, rows = update_subtask_checklist_item(
            storage,
            mid,
            sid,
            str(item_id).strip(),
            status=status,
            result=result,
            content=content,
        )
        if not ok:
            return json.dumps({"ok": False, "error": msg}, ensure_ascii=False)
        await broadcast_checklist_progress(mid, sid, rows)
        return json.dumps(
            {
                "ok": True,
                "action": "update",
                "itemId": item_id,
                "tableMarkdown": format_checklist_markdown_table(rows),
            },
            ensure_ascii=False,
        )

    return json.dumps(
        {"ok": False, "error": f"Unknown action '{action}'. Use list, set, or update."},
        ensure_ascii=False,
    )
