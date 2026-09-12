"""Collab subtask private peer messaging tools (task_tool workers)."""

from __future__ import annotations

import json
from typing import Annotated

from langchain.tools import InjectedToolCallId, ToolRuntime, tool
from langgraph.typing import ContextT

from evoflow.collab.peer import peer_read, peer_reply, peer_send
from evoflow.tools.builtins.subtask_work_checklist_tool import _resolve_collab_ids


@tool("collab_peer_send", parse_docstring=True)
async def collab_peer_send_tool(
    runtime: ToolRuntime[ContextT, dict],
    to_subtask: str,
    message: str,
    tool_call_id: Annotated[str, InjectedToolCallId],
    main_task_id: str | None = None,
    from_subtask_id: str | None = None,
    expect_reply: bool = True,
) -> str:
    """Send a private peer message to another collab subtask (isolated thread).

    Completed subtasks cannot send. In-progress subtasks may ask in-progress or completed peers.

    Args:
        to_subtask: Target subtask id, ref (e.g. ``"2"``), or unique name.
        message: Question body (max 4000 chars).
        main_task_id: Main task id (optional if runtime has ``collab_task_id``).
        from_subtask_id: Sender subtask id (optional if runtime has ``collab_subtask_id``).
        expect_reply: When true (default), wake the target to reply via ``collab_peer_reply``.
    """
    ctx_main, ctx_sub = _resolve_collab_ids(runtime)
    mid = str(main_task_id or ctx_main or "").strip()
    sid = str(from_subtask_id or ctx_sub or "").strip()
    if not mid or not sid:
        return json.dumps(
            {"ok": False, "error": "main_task_id and from_subtask_id required (or collab runtime ids)"},
            ensure_ascii=False,
        )
    res = await peer_send(
        main_task_id=mid,
        from_subtask_id=sid,
        to_subtask=to_subtask,
        message=message,
        expect_reply=bool(expect_reply),
    )
    return json.dumps(res, ensure_ascii=False)


@tool("collab_peer_reply", parse_docstring=True)
async def collab_peer_reply_tool(
    runtime: ToolRuntime[ContextT, dict],
    in_reply_to: str,
    message: str,
    tool_call_id: Annotated[str, InjectedToolCallId],
    main_task_id: str | None = None,
    subtask_id: str | None = None,
) -> str:
    """Reply on a private peer thread (after being woken for a peer question).

    Args:
        in_reply_to: ``message_id`` of the pending question.
        message: Reply body.
        main_task_id: Main task id (optional if runtime has ``collab_task_id``).
        subtask_id: This worker subtask id (optional if runtime has ``collab_subtask_id``).
    """
    ctx_main, ctx_sub = _resolve_collab_ids(runtime)
    mid = str(main_task_id or ctx_main or "").strip()
    sid = str(subtask_id or ctx_sub or "").strip()
    if not mid or not sid:
        return json.dumps(
            {"ok": False, "error": "main_task_id and subtask_id required (or collab runtime ids)"},
            ensure_ascii=False,
        )
    res = await peer_reply(
        main_task_id=mid,
        subtask_id=sid,
        in_reply_to=in_reply_to,
        message=message,
    )
    return json.dumps(res, ensure_ascii=False)


@tool("collab_peer_read", parse_docstring=True)
async def collab_peer_read_tool(
    runtime: ToolRuntime[ContextT, dict],
    tool_call_id: Annotated[str, InjectedToolCallId],
    main_task_id: str | None = None,
    subtask_id: str | None = None,
    thread_key: str | None = None,
    limit: int = 20,
) -> str:
    """Read private peer threads visible to this subtask (ACL filtered).

    Args:
        main_task_id: Main task id (optional if runtime has ``collab_task_id``).
        subtask_id: Reader subtask id (optional if runtime has ``collab_subtask_id``).
        thread_key: Optional ``from->to`` thread key; omit for all visible threads.
        limit: Max messages per thread (default 20).
    """
    ctx_main, ctx_sub = _resolve_collab_ids(runtime)
    mid = str(main_task_id or ctx_main or "").strip()
    sid = str(subtask_id or ctx_sub or "").strip()
    if not mid or not sid:
        return json.dumps(
            {"ok": False, "error": "main_task_id and subtask_id required (or collab runtime ids)"},
            ensure_ascii=False,
        )
    res = peer_read(main_task_id=mid, reader_party=sid, thread_key=thread_key, limit=int(limit or 20))
    return json.dumps(res, ensure_ascii=False)
