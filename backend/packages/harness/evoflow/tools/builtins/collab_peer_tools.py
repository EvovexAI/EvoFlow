"""Collab peer messaging — short names ``peer_send`` / ``peer_read`` / ``peer_reply``."""

from __future__ import annotations

import json
from typing import Annotated

from langchain.tools import InjectedToolCallId, ToolRuntime, tool
from langgraph.typing import ContextT

from evoflow.collab.collab_tool_names import PEER_READ, PEER_REPLY, PEER_SEND
from evoflow.collab.peer import peer_read, peer_reply, peer_send
from evoflow.tools.builtins.subtask_work_checklist_tool import _resolve_collab_ids


@tool(PEER_SEND, parse_docstring=True)
async def peer_send_tool(
    runtime: ToolRuntime[ContextT, dict],
    to_subtask: str,
    message: str,
    tool_call_id: Annotated[str, InjectedToolCallId],
    main_task_id: str | None = None,
    from_subtask_id: str | None = None,
    expect_reply: bool = True,
) -> str:
    """Ask another subtask (private peer thread).

    Args:
        to_subtask: Target id, ref (e.g. ``"2"``), or unique name.
        message: Question (max 4000 chars).
        main_task_id: Optional if runtime has collab ids.
        from_subtask_id: Optional if runtime has collab ids.
        expect_reply: Wake target to ``peer_reply`` (default true).
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


@tool("collab_peer_send", description="Alias of peer_send (legacy). Prefer peer_send.")
async def collab_peer_send_tool(
    runtime: ToolRuntime[ContextT, dict],
    to_subtask: str,
    message: str,
    tool_call_id: Annotated[str, InjectedToolCallId],
    main_task_id: str | None = None,
    from_subtask_id: str | None = None,
    expect_reply: bool = True,
) -> str:
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


@tool(PEER_REPLY, parse_docstring=True)
async def peer_reply_tool(
    runtime: ToolRuntime[ContextT, dict],
    in_reply_to: str,
    message: str,
    tool_call_id: Annotated[str, InjectedToolCallId],
    main_task_id: str | None = None,
    subtask_id: str | None = None,
) -> str:
    """Reply on a peer thread after a wake.

    Args:
        in_reply_to: Pending question ``message_id``.
        message: Reply body.
        main_task_id: Optional if runtime has collab ids.
        subtask_id: Optional if runtime has collab ids.
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


@tool("collab_peer_reply", description="Alias of peer_reply (legacy). Prefer peer_reply.")
async def collab_peer_reply_tool(
    runtime: ToolRuntime[ContextT, dict],
    in_reply_to: str,
    message: str,
    tool_call_id: Annotated[str, InjectedToolCallId],
    main_task_id: str | None = None,
    subtask_id: str | None = None,
) -> str:
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


@tool(PEER_READ, parse_docstring=True)
async def peer_read_tool(
    runtime: ToolRuntime[ContextT, dict],
    tool_call_id: Annotated[str, InjectedToolCallId],
    main_task_id: str | None = None,
    subtask_id: str | None = None,
    thread_key: str | None = None,
    limit: int = 20,
) -> str:
    """Read peer threads visible to this subtask.

    Args:
        main_task_id: Optional if runtime has collab ids.
        subtask_id: Optional if runtime has collab ids.
        thread_key: Optional ``from->to``; omit for all visible.
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


@tool("collab_peer_read", description="Alias of peer_read (legacy). Prefer peer_read.")
async def collab_peer_read_tool(
    runtime: ToolRuntime[ContextT, dict],
    tool_call_id: Annotated[str, InjectedToolCallId],
    main_task_id: str | None = None,
    subtask_id: str | None = None,
    thread_key: str | None = None,
    limit: int = 20,
) -> str:
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
