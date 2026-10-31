"""Chat (non-collab) subagents must get a dedicated {lead}__sub__{id} thread."""

from __future__ import annotations

import re

from evoflow.collab.thread_ids import (
    collab_subtask_executor_thread_id,
    is_collab_executor_thread,
    lead_thread_from_executor_thread,
)


def _chat_subagent_executor_thread(lead_thread_id: str, tool_call_id: str) -> str:
    """Mirror task_tool allocation (keep in sync with task_tool.py)."""
    lead = str(lead_thread_id or "").strip()
    sid = re.sub(r"[^A-Za-z0-9_\-]+", "_", str(tool_call_id or "").strip()).strip("_")
    assert lead and sid
    return collab_subtask_executor_thread_id(lead, sid)


def test_chat_subagent_thread_is_child_of_lead():
    lead = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"
    tid = _chat_subagent_executor_thread(lead, "call_Ab12")
    assert is_collab_executor_thread(tid)
    assert lead_thread_from_executor_thread(tid) == lead
    assert tid != lead
    assert "__sub__" in tid


def test_unsafe_tool_call_id_sanitized():
    lead = "lead-thread-1"
    tid = _chat_subagent_executor_thread(lead, "functions.task:10")
    assert is_collab_executor_thread(tid)
    assert ":" not in tid
    assert tid.endswith("__sub__functions_task_10")
    assert re.fullmatch(r"[A-Za-z0-9_\-]+", tid)
