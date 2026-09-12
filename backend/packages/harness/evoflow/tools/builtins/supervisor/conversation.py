"""Subtask execution conversation helpers for supervisor ``get_subtask_conversation``."""

from __future__ import annotations

import json
from typing import Any

from evoflow.collab.storage import ProjectStorage, find_main_task, find_subtask_by_ids, find_subtask_row_by_id


def _normalize_text_content(content: Any) -> str:
    if content is None:
        return ""
    if isinstance(content, str):
        return content.strip()
    if isinstance(content, list):
        parts: list[str] = []
        for block in content:
            if isinstance(block, dict):
                t = block.get("text") or block.get("content")
                if t is not None:
                    parts.append(str(t))
            elif block is not None:
                parts.append(str(block))
        return "\n".join(p for p in parts if p).strip()
    try:
        return json.dumps(content, ensure_ascii=False, sort_keys=True)
    except Exception:
        return str(content).strip()


def resolve_subtask_for_conversation(
    storage: ProjectStorage,
    *,
    task_id: str | None,
    subtask_id: str | None,
    legacy_subtask_selector: str | None = None,
) -> tuple[dict[str, Any], dict[str, Any], dict[str, Any]] | None:
    """Resolve ``(project, main_task, subtask_row)`` for conversation lookup."""
    main_id = str(task_id or "").strip()
    sid = str(subtask_id or legacy_subtask_selector or "").strip()

    if main_id and sid:
        found = find_subtask_by_ids(storage, main_id, sid)
        if found is not None:
            row = find_main_task(storage, main_id)
            if row is not None:
                project, task = row
                return project, task, found

    if sid and not main_id:
        found = find_subtask_row_by_id(storage, sid)
        if found is not None:
            return found

    if main_id and not sid:
        found = find_subtask_row_by_id(storage, main_id)
        if found is not None:
            return found

    if main_id and sid:
        row = find_main_task(storage, main_id)
        if row is not None:
            project, task = row
            st = next((s for s in (task.get("subtasks") or []) if str(s.get("id") or "").strip() == sid), None)
            if isinstance(st, dict):
                return project, task, st

    return None


def _compact_transcript(messages: list[dict[str, Any]], *, max_chars: int = 12000) -> str:
    lines: list[str] = []
    used = 0
    for msg in messages:
        role = str(msg.get("role") or "assistant").strip() or "assistant"
        text = _normalize_text_content(msg.get("content"))
        tool_name = str(msg.get("tool_name") or msg.get("name") or "").strip()
        if not text and tool_name:
            text = f"[tool:{tool_name}]"
        if not text:
            continue
        if len(text) > 2000:
            text = text[:2000] + "…"
        line = f"{role}: {text}"
        if used + len(line) + 1 > max_chars:
            lines.append("… (transcript truncated)")
            break
        lines.append(line)
        used += len(line) + 1
    return "\n".join(lines)


def build_subtask_conversation_payload(
    storage: ProjectStorage,
    *,
    task_id: str | None,
    subtask_id: str | None,
    legacy_subtask_selector: str | None = None,
    limit: int = 200,
    action: str = "get_subtask_conversation",
) -> dict[str, Any]:
    """Load subtask worker conversation from ``evoflow_chat_messages``."""
    resolved = resolve_subtask_for_conversation(
        storage,
        task_id=task_id,
        subtask_id=subtask_id,
        legacy_subtask_selector=legacy_subtask_selector,
    )
    if resolved is None:
        lookup = str(subtask_id or legacy_subtask_selector or task_id or "").strip()
        return {
            "success": False,
            "action": action,
            "error": f"Subtask '{lookup}' not found (provide task_id + subtask_id)",
        }

    _project, main_task, subtask_row = resolved
    main_task_id = str(main_task.get("id") or "").strip()
    sid = str(subtask_row.get("id") or "").strip()
    cap = max(1, min(int(limit or 200), 500))

    from evoflow.collab.conversation_persist import list_subtask_conversation_ui_messages
    from evoflow.collab.subtask_outcome import build_subtask_outcome_snapshot

    messages = list_subtask_conversation_ui_messages(
        main_task,
        sid,
        subtask_row=subtask_row if isinstance(subtask_row, dict) else None,
        limit=cap,
    )
    outcome = build_subtask_outcome_snapshot(subtask_row if isinstance(subtask_row, dict) else {})
    return {
        "success": True,
        "action": action,
        "taskId": main_task_id,
        "subtaskId": sid,
        "subtaskName": str(subtask_row.get("name") or "").strip(),
        "status": str(subtask_row.get("status") or "").strip(),
        "progress": int(subtask_row.get("progress") or 0),
        "assignedTo": str(subtask_row.get("assigned_to") or main_task.get("assigned_to") or "").strip(),
        "messageCount": len(messages),
        "messages": messages,
        "outcome": outcome,
        "transcript": _compact_transcript(messages),
    }


__all__ = [
    "build_subtask_conversation_payload",
    "resolve_subtask_for_conversation",
]
