"""Scope filters for collab chat transcript rows."""

from __future__ import annotations

import json
from typing import Any


def tool_call_hits_subtask(tool_call: dict[str, Any], subtask_id: str) -> bool:
    """True when a tool call clearly targets ``subtask_id`` (not main-task orchestration)."""
    name = str(tool_call.get("name") or tool_call.get("tool_name") or "").strip().lower()
    if name == "supervisor":
        return False
    args = tool_call.get("args")
    if isinstance(args, str):
        try:
            args = json.loads(args)
        except Exception:
            args = {}
    if not isinstance(args, dict):
        args = {}
    for key in ("collab_subtask_id", "subtask_id", "subtaskId"):
        v = str(args.get(key) or "").strip()
        if v and v == subtask_id:
            return True
    return False


def conversation_msg_belongs_to_subtask(
    msg: dict[str, Any],
    subtask_id: str,
    *,
    dedicated_subtask_thread_id: str | None = None,
) -> bool:
    """Return whether ``msg`` belongs to one subtask's worker history.

    Do **not** match on the main lead ``thread_id`` — all subtask stream replicas share it.
    """
    target = str(subtask_id or "").strip()
    if not target or not isinstance(msg, dict):
        return False

    msg_sid = str(msg.get("collab_subtask_id") or msg.get("subtask_id") or "").strip()
    if msg_sid:
        return msg_sid == target

    source = str(msg.get("source") or "").strip().lower()
    if source in {"lead_chat_mirror", "lead_chat_reconcile"}:
        return False

    dst = str(dedicated_subtask_thread_id or "").strip()
    msg_tid = str(msg.get("thread_id") or "").strip()
    if dst and msg_tid and msg_tid == dst:
        return True

    tcs = msg.get("tool_calls")
    if isinstance(tcs, list):
        for tc in tcs:
            if isinstance(tc, dict) and tool_call_hits_subtask(tc, target):
                return True
    return False


def is_subtask_mirror_chat_row(row: dict[str, Any]) -> bool:
    """Chat DB rows mirrored from subtask worker streams (exclude from main session UI)."""
    if not isinstance(row, dict):
        return False
    mid = str(row.get("message_id") or "").strip()
    if mid:
        prefix = mid.split(":", 1)[0]
        if prefix.startswith("Subtask_"):
            return True
    parent = str(row.get("parent_thread_id") or "").strip()
    return bool(parent)


__all__ = [
    "conversation_msg_belongs_to_subtask",
    "is_subtask_mirror_chat_row",
    "tool_call_hits_subtask",
]
