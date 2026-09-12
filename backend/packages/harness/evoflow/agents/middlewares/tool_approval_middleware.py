"""Pause side-effect tools until the user approves; replay executes after approval."""

from __future__ import annotations

import json
import logging
from collections.abc import Awaitable, Callable
from typing import Any

try:
    from typing import override
except ImportError:
    from typing import override

from langchain.agents import AgentState
from langchain.agents.middleware import AgentMiddleware
from langchain_core.messages import HumanMessage, ToolMessage
from langgraph.prebuilt.tool_node import ToolCallRequest
from langgraph.runtime import Runtime
from langgraph.types import Command, interrupt

from evoflow.agents.human_gate_tools import message_id_prefix_for_gate
from evoflow.agents.lead_agent.runtime_context import LeadAgentRuntimeContext, runtime_context_mapping
from evoflow.agents.middleware_state import replace_messages_in_state
from evoflow.agents.middlewares.tool_approval_executor import aexecute_approved_tool_entry
from evoflow.agents.middlewares.transcript_middleware import persist_transcript_tool_message_now
from evoflow.agents.tool_approval_config import (
    _PREFIX,
    format_approval_payload_text,
    parse_user_approval_message,
    tool_risk_level,
)
from evoflow.agents.tool_approval_denylist import is_dangerous
from evoflow.agents.tool_approval_trace_log import log_tool_approval_trace
from evoflow.tools.tool_aliases import canonical_tool_name
from evoflow.agents.tool_approval_service import (
    REPLAY_MARKER,
    append_pending,
    apply_user_approval,
    build_replay_message,
    consume_signature_grant,
    consume_replay_queue,
    is_granted_for_thread,
    make_pending_entry,
    parse_replay_message,
    pop_replay_queue,
    summarize_tool_for_approval,
    tool_requires_approval,
)

logger = logging.getLogger(__name__)


# ── Deny retry prevention ──────────────────────────────────────────────────────
# Per-thread deny counters: {(thread_id, tool_name_lower): count}
_deny_counters: dict[tuple[str, str], int] = {}
_DENY_MAX_RETRIES = 2


def _record_deny(thread_id: str, tool_name: str) -> int:
    """记录一次拒绝，返回当前累计拒绝次数。"""
    tid = str(thread_id or "").strip()
    tn = str(tool_name or "").strip().lower()
    if not tid or not tn:
        return 0
    key = (tid, tn)
    _deny_counters[key] = _deny_counters.get(key, 0) + 1
    return _deny_counters[key]


def _get_deny_count(thread_id: str, tool_name: str) -> int:
    """获取当前 thread 中某工具的累计拒绝次数。"""
    tid = str(thread_id or "").strip()
    tn = str(tool_name or "").strip().lower()
    if not tid or not tn:
        return 0
    return _deny_counters.get((tid, tn), 0)


def _clear_deny_counter(thread_id: str, tool_name: str = "") -> None:
    """清除拒绝计数器（批准后调用，让模型可以正常使用该工具）。"""
    tid = str(thread_id or "").strip()
    if not tid:
        return
    if tool_name:
        tn = str(tool_name or "").strip().lower()
        _deny_counters.pop((tid, tn), None)
    else:
        # 清除该 thread 的所有计数器
        keys_to_remove = [k for k in _deny_counters if k[0] == tid]
        for k in keys_to_remove:
            _deny_counters.pop(k, None)


def _build_deny_retry_blocked_result(request: ToolCallRequest) -> ToolMessage:
    """工具被拒绝多次后返回的拦截消息，提示模型换方法。"""
    import json

    tool_name = _tool_name(request)
    tc_id = _tool_call_id(request)
    tid = _thread_id_from_request(request)
    count = _get_deny_count(tid, _canonical_tool_name(request))
    msg = json.dumps(
        {
            "_evoflow_tool": {"status": "denied"},
            "message": (
                f"工具 {tool_name} 已被用户拒绝 {count} 次，系统已阻止再次调用。"
                "请换用其他方法，或使用 ask_clarification 向用户询问如何继续。"
            ),
        },
        ensure_ascii=False,
    )
    return ToolMessage(content=msg, tool_call_id=tc_id, name=tool_name)


def _unattended_automation(request: ToolCallRequest) -> bool:
    try:
        from evoflow.agents.automation_runtime import is_unattended_automation

        rt = getattr(request, "runtime", None)
        return is_unattended_automation(rt)
    except Exception:
        return False


def _thread_id_from_configurable() -> str:
    try:
        from langgraph.config import get_config

        return str(get_config().get("configurable", {}).get("thread_id") or "").strip()
    except Exception:
        return ""


def _thread_id_from_request(request: ToolCallRequest) -> str:
    """``runtime.context`` is often ``LeadAgentRuntimeContext`` (dataclass), not a dict."""
    rt = getattr(request, "runtime", None)
    if rt is not None:
        tid = str(runtime_context_mapping(rt).get("thread_id") or "").strip()
        if tid:
            return tid
    return _thread_id_from_configurable()


def _workspace_root_from_request(request: ToolCallRequest) -> str:
    rt = getattr(request, "runtime", None)
    if rt is not None:
        return str(runtime_context_mapping(rt).get("local_workspace_root") or "").strip()
    return ""


def _tool_args(request: ToolCallRequest) -> dict[str, Any]:
    raw = request.tool_call.get("args")
    return dict(raw) if isinstance(raw, dict) else {}


def _tool_call_id(request: ToolCallRequest) -> str:
    return str(request.tool_call.get("id") or "").strip()


def _tool_name(request: ToolCallRequest) -> str:
    return str(request.tool_call.get("name") or "").strip()


def _canonical_tool_name(request: ToolCallRequest) -> str:
    return canonical_tool_name(_tool_name(request))


def _trace_decision(
    event: str,
    request: ToolCallRequest,
    *,
    extra: dict[str, Any] | None = None,
) -> None:
    tid = _thread_id_from_request(request)
    tc_id = _tool_call_id(request)
    canon = _canonical_tool_name(request)
    fields: dict[str, Any] = {
        "原始工具名": _tool_name(request),
        "规范工具名": canon,
        "args摘要": summarize_tool_for_approval(canon, _tool_args(request)),
    }
    if extra:
        fields.update(extra)
    log_tool_approval_trace(event, thread_id=tid, tool_name=canon, tool_call_id=tc_id, **fields)


def _emit_pending_approval_sse(tid: str, tool_name: str, tc_id: str, summary: str, risk: str) -> None:
    """Best-effort push a ``tool_approval:pending`` event via the gateway SSE broadcaster.

    The primary real-time channel is the LangGraph stream itself (the ToolMessage
    with ``_evoflow_tool.status = pending_approval`` is streamed to the frontend).
    This SSE broadcast is a secondary push for page-refresh / background scenarios.

    Uses ``sse_notify`` relay (direct when same-process, HTTP otherwise) to avoid
    a harness → gateway import dependency.
    """
    try:
        from evoflow.collab.sse_notify import schedule_tool_approval_pending_sse

        schedule_tool_approval_pending_sse(
            tid,
            tool_call_id=tc_id,
            tool_name=tool_name,
            summary=summary,
            risk=risk,
        )
    except Exception:
        logger.debug("SSE pending_approval broadcast failed (non-fatal)", exc_info=True)


def _messages_from_request(request: ToolCallRequest) -> list[Any]:
    state = request.state if isinstance(request.state, dict) else {}
    return list(state.get("messages") or [])


def _sibling_tool_calls_for_request(request: ToolCallRequest) -> list[dict[str, Any]]:
    """All tool_calls from the AIMessage batch that issued this request."""
    from langchain_core.messages import AIMessage

    cid = _tool_call_id(request)
    if not cid:
        return []
    for msg in reversed(_messages_from_request(request)):
        if not isinstance(msg, AIMessage):
            continue
        tcs = getattr(msg, "tool_calls", None) or []
        batch = [tc for tc in tcs if isinstance(tc, dict)]
        if any(str(tc.get("id") or "").strip() == cid for tc in batch):
            return batch
    return []


def _register_sibling_pending_approvals(
    request: ToolCallRequest,
    *,
    skip_tool_call_id: str,
    current_summary: str,
) -> None:
    """Register every approval-gated sibling in the same model turn before ``interrupt()``."""
    tid = _thread_id_from_request(request)
    ws_root = _workspace_root_from_request(request) or None
    skip = str(skip_tool_call_id or "").strip()
    for tc in _sibling_tool_calls_for_request(request):
        tc_id = str(tc.get("id") or "").strip()
        if not tc_id or tc_id == skip:
            continue
        raw_name = str(tc.get("name") or "").strip()
        name = canonical_tool_name(raw_name)
        args = tc.get("args") if isinstance(tc.get("args"), dict) else {}
        if not tool_requires_approval(name, args):
            continue
        if tid and is_granted_for_thread(tid, name, args, workspace_root=ws_root):
            continue
        summary = summarize_tool_for_approval(name, args)
        sibling_req = ToolCallRequest(
            tool_call={"id": tc_id, "name": raw_name, "args": args},
            tool=tc.get("tool"),
            state=request.state,
            runtime=request.runtime,
        )
        _register_pending_approval(sibling_req, summary=summary)
        logger.info(
            "Tool approval sibling queued: %s (%s) raw=%s leader=%s",
            name,
            tc_id,
            raw_name,
            skip,
        )
    if skip:
        logger.debug(
            "Tool approval batch register done leader=%s siblings=%s summary=%s",
            skip,
            len(_sibling_tool_calls_for_request(request)),
            current_summary[:80],
        )


def _stream_pending_tool_message(request: ToolCallRequest, pending_msg: ToolMessage) -> None:
    """Push ``pending_approval`` onto the live ``runs/stream`` *before* ``interrupt()`` pauses.

    ``interrupt()`` raises on first entry, so the pending ToolMessage never returns from
    ``wrap_tool_call`` and would not appear in ``messages-tuple``.  The gateway converts
    this custom chunk to ``tool_result`` / AG-UI ``TOOL_CALL_RESULT`` while the same POST
    SSE stays open (defer RUN_FINISHED until the user approves).
    """
    import json

    tc_id = str(pending_msg.tool_call_id or "").strip()
    if not tc_id:
        return
    raw_content = pending_msg.content
    if isinstance(raw_content, str):
        content = raw_content
    else:
        content = json.dumps(raw_content, ensure_ascii=False, default=str)
    payload = {
        "type": "tool_approval_pending",
        "tool_call_id": tc_id,
        "tool_name": str(pending_msg.name or "").strip(),
        "content": content,
    }
    try:
        from langgraph.config import get_stream_writer

        writer = get_stream_writer()
        if callable(writer):
            writer(payload)
            return
    except Exception:
        logger.debug("tool_approval_pending stream_writer failed (non-fatal)", exc_info=True)
    rt = getattr(request, "runtime", None)
    sw = getattr(rt, "stream_writer", None) if rt is not None else None
    if callable(sw):
        try:
            sw(payload)
        except Exception:
            logger.debug("tool_approval_pending runtime stream_writer failed", exc_info=True)


def _stream_pending_tool_approval(request: ToolCallRequest, pending_msg: ToolMessage) -> None:
    _stream_pending_tool_message(request, pending_msg)


def _stream_batch_pending_approvals(request: ToolCallRequest, *, leader_tool_call_id: str) -> None:
    """Push pending_approval frames for every gated sibling in the same model turn."""
    leader = str(leader_tool_call_id or "").strip()
    for tc in _sibling_tool_calls_for_request(request):
        tc_id = str(tc.get("id") or "").strip()
        if not tc_id or tc_id == leader:
            continue
        raw_name = str(tc.get("name") or "").strip()
        name = canonical_tool_name(raw_name)
        args = tc.get("args") if isinstance(tc.get("args"), dict) else {}
        if not tool_requires_approval(name, args):
            continue
        summary = summarize_tool_for_approval(name, args)
        pending_msg = _build_pending_tool_message(
            ToolCallRequest(
                tool_call={"id": tc_id, "name": raw_name, "args": args},
                tool=tc.get("tool"),
                state=request.state,
                runtime=request.runtime,
            ),
            summary=summary,
        )
        _stream_pending_tool_message(request, pending_msg)


def _build_pending_tool_message(request: ToolCallRequest, *, summary: str) -> ToolMessage:
    import json

    tool_name = _tool_name(request)
    tc_id = _tool_call_id(request)
    args = _tool_args(request)
    risk = tool_risk_level(tool_name, args)
    approval = json.loads(format_approval_payload_text(tool_name=tool_name, tool_call_id=tc_id, summary=summary, risk=risk))
    msg = json.dumps(
        {
            "_evoflow_tool": {"status": "pending_approval"},
            "message": (
                f"[pending_approval] {tool_name}（{summary}）尚未执行，等待用户在 EvoPanel 中点击该工具并授权。"
                "不要要求用户输入 /approve、slash 命令或再次调用本工具；用户批准后系统将自动执行，请等待后续工具结果消息再继续。"
            ),
            "approval": approval,
        },
        ensure_ascii=False,
    )
    return ToolMessage(
        content=msg,
        tool_call_id=tc_id,
        name=tool_name,
        id=f"{message_id_prefix_for_gate('tool_approval')}-{tc_id}" if tc_id else None,
    )


def _register_pending_approval(request: ToolCallRequest, *, summary: str) -> ToolMessage:
    tool_name = _canonical_tool_name(request)
    raw_name = _tool_name(request)
    tc_id = _tool_call_id(request)
    args = _tool_args(request)
    ws_root = _workspace_root_from_request(request) or None
    tid = _thread_id_from_request(request)
    risk = tool_risk_level(tool_name, args)
    pending_msg = _build_pending_tool_message(request, summary=summary)
    persist_transcript_tool_message_now(
        getattr(request, "runtime", None),
        pending_msg,
        message_id_prefix=message_id_prefix_for_gate("tool_approval"),
    )
    if tid:
        append_pending(
            tid,
            make_pending_entry(
                tool_call_id=tc_id,
                tool_name=tool_name,
                args=args,
                summary=summary,
                workspace_root=ws_root,
            ),
        )
        _emit_pending_approval_sse(tid, tool_name, tc_id, summary, risk)
    else:
        logger.warning(
            "Tool approval: missing thread_id; pending not persisted for %s (%s)",
            tool_name,
            tc_id,
        )
    return pending_msg


def _denied_tool_message(request: ToolCallRequest, *, reason: str = "用户已拒绝") -> ToolMessage:
    import json

    tool_name = _tool_name(request)
    tc_id = _tool_call_id(request)
    msg = json.dumps(
        {
            "_evoflow_tool": {"status": "denied"},
            "message": f"[denied] {reason}",
        },
        ensure_ascii=False,
    )
    return ToolMessage(content=msg, tool_call_id=tc_id, name=tool_name)


def _awaiting_other_approval_message(request: ToolCallRequest) -> ToolMessage:
    import json

    tool_name = _tool_name(request)
    tc_id = _tool_call_id(request)
    msg = json.dumps(
        {
            "_evoflow_tool": {"status": "awaiting_other_approval"},
            "message": "当前工具已批准，等待其他待授权工具确认后统一执行。",
        },
        ensure_ascii=False,
    )
    return ToolMessage(content=msg, tool_call_id=tc_id, name=tool_name)


def _should_execute_for_decision(decision: Any, tool_call_id: str) -> bool:
    if not isinstance(decision, dict):
        return False
    action = str(decision.get("action") or "").strip().lower()
    if action in {"grant_all", "approve_all", "execute_all"}:
        return True
    if action == "await_next":
        return False
    if action in {"approve", "execute_approved"}:
        ids = decision.get("tool_call_ids")
        if isinstance(ids, list):
            want = {str(x).strip() for x in ids if str(x).strip()}
            if not want:
                return False  # 空列表不等于全部批准；只有 grant_all 才无条件放行
            return tool_call_id in want
        single = str(decision.get("tool_call_id") or "").strip()
        return bool(single) and single == tool_call_id
    return False


async def _execute_other_approved_tools(
    request: ToolCallRequest,
    *,
    skip_tool_call_id: str,
) -> list[ToolMessage]:
    tid = _thread_id_from_request(request)
    if not tid:
        return []
    skip = str(skip_tool_call_id or "").strip()
    entries = pop_replay_queue(tid, None)
    out: list[ToolMessage] = []
    if not entries:
        return out

    log_tool_approval_trace("中间件·批量执行sibling工具", thread_id=tid, side="中间件",
        event_data={"skip": skip, "entry_count": len(entries),
                    "entry_ids": [str(e.get("tool_call_id") or "") for e in entries]})

    ctx = LeadAgentRuntimeContext.from_mapping(runtime_context_mapping(getattr(request, "runtime", None)))
    executed_ids: list[str] = []
    for entry in entries:
        tc_id = str(entry.get("tool_call_id") or "").strip()
        if skip and tc_id == skip:
            continue
        try:
            result_msg = await aexecute_approved_tool_entry(entry, runtime_context=ctx)
            out.append(result_msg)
            log_tool_approval_trace("中间件·sibling执行结果", thread_id=tid, side="中间件",
                event_data={"tool_call_id": tc_id, "success": True})
        except Exception as exc:
            logger.exception("Tool approval replay failed for sibling: %s", tc_id)
            log_tool_approval_trace("中间件·sibling执行失败", thread_id=tid, side="中间件",
                level=logging.ERROR, event_data={"tool_call_id": tc_id, "error": str(exc)[:300]})
            import json

            tool_name = str(entry.get("tool_name") or "tool").strip()
            out.append(ToolMessage(
                content=json.dumps(
                    {"_evoflow_tool": {"status": "error"}, "message": f"执行失败：{exc}"},
                    ensure_ascii=False,
                ),
                tool_call_id=tc_id,
                name=tool_name,
            ))
        # 无论成功还是失败，都标记为已执行，防止重复
        executed_ids.append(tc_id)
    if executed_ids:
        consume_replay_queue(tid, executed_ids)
    return out


def _execute_other_approved_tools_sync(
    request: ToolCallRequest,
    *,
    skip_tool_call_id: str,
) -> list[ToolMessage]:
    from evoflow.agents.middlewares.tool_approval_executor import execute_approved_tool_entry

    tid = _thread_id_from_request(request)
    if not tid:
        return []
    skip = str(skip_tool_call_id or "").strip()
    entries = pop_replay_queue(tid, None)
    out: list[ToolMessage] = []
    if not entries:
        return out

    log_tool_approval_trace("中间件·批量执行sibling工具(sync)", thread_id=tid, side="中间件",
        event_data={"skip": skip, "entry_count": len(entries),
                    "entry_ids": [str(e.get("tool_call_id") or "") for e in entries]})

    ctx = LeadAgentRuntimeContext.from_mapping(runtime_context_mapping(getattr(request, "runtime", None)))
    executed_ids: list[str] = []
    for entry in entries:
        tc_id = str(entry.get("tool_call_id") or "").strip()
        if skip and tc_id == skip:
            continue
        try:
            result_msg = execute_approved_tool_entry(entry, runtime_context=ctx)
            out.append(result_msg)
            log_tool_approval_trace("中间件·sibling执行结果(sync)", thread_id=tid, side="中间件",
                event_data={"tool_call_id": tc_id, "success": True})
        except Exception as exc:
            logger.exception("Tool approval replay failed for sibling: %s", tc_id)
            log_tool_approval_trace("中间件·sibling执行失败(sync)", thread_id=tid, side="中间件",
                level=logging.ERROR, event_data={"tool_call_id": tc_id, "error": str(exc)[:300]})
            import json

            tool_name = str(entry.get("tool_name") or "tool").strip()
            out.append(ToolMessage(
                content=json.dumps(
                    {"_evoflow_tool": {"status": "error"}, "message": f"执行失败：{exc}"},
                    ensure_ascii=False,
                ),
                tool_call_id=tc_id,
                name=tool_name,
            ))
        # 无论成功还是失败，都标记为已执行，防止重复
        executed_ids.append(tc_id)
    if executed_ids:
        consume_replay_queue(tid, executed_ids)
    return out


def _merge_tool_handler_result(
    result: ToolMessage | Command,
    extra: list[ToolMessage],
) -> ToolMessage | Command:
    """Combine primary handler output with batch-approved sibling tool messages."""
    if not extra:
        return result
    msgs: list[ToolMessage] = [result] if isinstance(result, ToolMessage) else []
    goto: Any = ()
    graph = None
    if isinstance(result, Command):
        upd = result.update if isinstance(result.update, dict) else {}
        raw = upd.get("messages")
        if isinstance(raw, list):
            msgs = [m for m in raw if isinstance(m, ToolMessage)]
        if result.goto not in (None, ()):
            goto = result.goto
        graph = result.graph
    merged = Command(update={"messages": [*msgs, *extra]})
    if goto not in (None, ()):
        merged = Command(update={"messages": [*msgs, *extra]}, goto=goto, graph=graph)
    return merged


def _resolve_after_resume_sync(
    request: ToolCallRequest,
    handler: Callable[[ToolCallRequest], ToolMessage | Command],
    decision: Any,
    *,
    pending_msg: ToolMessage,
) -> ToolMessage | Command:
    tc_id = _tool_call_id(request)
    tid = _thread_id_from_request(request)
    tool_name = _tool_name(request)
    args = _tool_args(request)
    ws_root = _workspace_root_from_request(request) or None
    action = str((decision or {}).get("action") or "").strip().lower() if isinstance(decision, dict) else ""

    log_tool_approval_trace("中间件·resume处理开始", thread_id=tid, side="中间件",
        event_data={"tool_call_id": tc_id, "action": action, "should_execute": _should_execute_for_decision(decision, tc_id)})

    if action == "deny":
        if tid:
            _record_deny(tid, tool_name)
        log_tool_approval_trace("中间件·用户拒绝工具", thread_id=tid, side="中间件",
            event_data={"tool_name": tool_name, "tool_call_id": tc_id})
        denied = _denied_tool_message(request)
        persist_transcript_tool_message_now(getattr(request, "runtime", None), denied)
        return denied

    if action == "await_next":
        awaiting = _awaiting_other_approval_message(request)
        logger.info(
            "【工具授权·resume】await_next：当前工具已批准，等待其他待授权 tool=%s tc=%s thread=%s",
            tool_name,
            tc_id,
            tid or "",
        )
        persist_transcript_tool_message_now(getattr(request, "runtime", None), awaiting)
        return awaiting

    if not _should_execute_for_decision(decision, tc_id):
        return pending_msg

    # 先消费签名（用户已批准），即使 handler 失败也不留签名让下次自动放行
    if tid:
        consume_signature_grant(tid, tool_name, args, workspace_root=ws_root)
        consume_replay_queue(tid, [tc_id])
        _clear_deny_counter(tid, tool_name)

    result = handler(request)
    extra = _execute_other_approved_tools_sync(request, skip_tool_call_id=tc_id)
    return _merge_tool_handler_result(result, extra)


async def _resolve_after_resume_async(
    request: ToolCallRequest,
    handler: Callable[[ToolCallRequest], Awaitable[ToolMessage | Command]],
    decision: Any,
    *,
    pending_msg: ToolMessage,
) -> ToolMessage | Command:
    tc_id = _tool_call_id(request)
    tid = _thread_id_from_request(request)
    tool_name = _tool_name(request)
    args = _tool_args(request)
    ws_root = _workspace_root_from_request(request) or None
    action = str((decision or {}).get("action") or "").strip().lower() if isinstance(decision, dict) else ""

    log_tool_approval_trace("中间件·resume处理开始", thread_id=tid, side="中间件",
        event_data={"tool_call_id": tc_id, "action": action, "should_execute": _should_execute_for_decision(decision, tc_id)})

    if action == "deny":
        if tid:
            _record_deny(tid, tool_name)
        log_tool_approval_trace("中间件·用户拒绝工具", thread_id=tid, side="中间件",
            event_data={"tool_name": tool_name, "tool_call_id": tc_id})
        denied = _denied_tool_message(request)
        persist_transcript_tool_message_now(getattr(request, "runtime", None), denied)
        return denied

    if action == "await_next":
        awaiting = _awaiting_other_approval_message(request)
        logger.info(
            "【工具授权·resume】await_next：当前工具已批准，等待其他待授权 tool=%s tc=%s thread=%s",
            tool_name,
            tc_id,
            tid or "",
        )
        persist_transcript_tool_message_now(getattr(request, "runtime", None), awaiting)
        return awaiting

    if not _should_execute_for_decision(decision, tc_id):
        return pending_msg

    # 先消费签名（用户已批准），即使 handler 失败也不留签名让下次自动放行
    if tid:
        consume_signature_grant(tid, tool_name, args, workspace_root=ws_root)
        consume_replay_queue(tid, [tc_id])
        _clear_deny_counter(tid, tool_name)

    log_tool_approval_trace("中间件·开始执行工具", thread_id=tid, side="中间件",
        event_data={"tool_name": tool_name, "tool_call_id": tc_id})
    try:
        result = await handler(request)
        log_tool_approval_trace("中间件·工具执行完成", thread_id=tid, side="中间件",
            event_data={"tool_name": tool_name, "tool_call_id": tc_id, "result_type": type(result).__name__})
    except Exception as exc:
        log_tool_approval_trace("中间件·工具执行异常", thread_id=tid, side="中间件",
            level=logging.ERROR, event_data={"tool_name": tool_name, "error": str(exc)[:300]})
        raise
    extra = await _execute_other_approved_tools(request, skip_tool_call_id=tc_id)
    return _merge_tool_handler_result(result, extra)


def _gate_tool_call_sync(
    request: ToolCallRequest,
    handler: Callable[[ToolCallRequest], ToolMessage | Command],
    *,
    summary: str,
) -> ToolMessage | Command:
    tc_id = _tool_call_id(request)
    batch_ids = [
        str(tc.get("id") or "").strip()
        for tc in _sibling_tool_calls_for_request(request)
        if str(tc.get("id") or "").strip()
    ]
    if not batch_ids and tc_id:
        batch_ids = [tc_id]
    tid = _thread_id_from_request(request)
    if tid:
        from evoflow.agents.tool_approval_service import begin_approval_batch

        begin_approval_batch(tid, batch_ids)
    pending_msg = _register_pending_approval(request, summary=summary)
    _register_sibling_pending_approvals(request, skip_tool_call_id=tc_id, current_summary=summary)
    _stream_pending_tool_approval(request, pending_msg)
    _stream_batch_pending_approvals(request, leader_tool_call_id=tc_id)
    _trace_decision(
        "闸门：interrupt 暂停同 run 等待授权",
        request,
        extra={"决策": "interrupt_same_run", "摘要": summary, "批次工具数": len(batch_ids)},
    )
    log_tool_approval_trace("中间件·interrupt暂停", thread_id=tid, side="中间件",
        event_data={"tool_name": _canonical_tool_name(request), "tool_call_id": tc_id,
                    "batch_ids": batch_ids, "summary": summary[:200]})
    # Same POST SSE stays open: gateway defers RUN_FINISHED while pending rows exist.
    # UI receives ``tool_approval_pending`` (→ TOOL_CALL_RESULT) before this raises.
    decision = interrupt(
        {
            "type": "tool_approval",
            "tool_call_id": tc_id,
            "tool_call_ids": batch_ids,
            "tool_name": _canonical_tool_name(request),
            "summary": summary,
        }
    )
    log_tool_approval_trace("中间件·interrupt返回(resume)", thread_id=tid, side="中间件",
        event_data={"tool_call_id": tc_id, "decision": str(decision)[:300] if decision else "None"})
    return _resolve_after_resume_sync(request, handler, decision, pending_msg=pending_msg)


async def _gate_tool_call_async(
    request: ToolCallRequest,
    handler: Callable[[ToolCallRequest], Awaitable[ToolMessage | Command]],
    *,
    summary: str,
) -> ToolMessage | Command:
    tc_id = _tool_call_id(request)
    batch_ids = [
        str(tc.get("id") or "").strip()
        for tc in _sibling_tool_calls_for_request(request)
        if str(tc.get("id") or "").strip()
    ]
    if not batch_ids and tc_id:
        batch_ids = [tc_id]
    tid = _thread_id_from_request(request)
    if tid:
        from evoflow.agents.tool_approval_service import begin_approval_batch

        begin_approval_batch(tid, batch_ids)
    pending_msg = _register_pending_approval(request, summary=summary)
    _register_sibling_pending_approvals(request, skip_tool_call_id=tc_id, current_summary=summary)
    _stream_pending_tool_approval(request, pending_msg)
    _stream_batch_pending_approvals(request, leader_tool_call_id=tc_id)
    _trace_decision(
        "闸门：interrupt 暂停同 run 等待授权",
        request,
        extra={"决策": "interrupt_same_run", "摘要": summary, "批次工具数": len(batch_ids)},
    )
    log_tool_approval_trace("中间件·interrupt暂停", thread_id=tid, side="中间件",
        event_data={"tool_name": _canonical_tool_name(request), "tool_call_id": tc_id,
                    "batch_ids": batch_ids, "summary": summary[:200]})
    # Same POST SSE stays open: gateway defers RUN_FINISHED while pending rows exist.
    decision = interrupt(
        {
            "type": "tool_approval",
            "tool_call_id": tc_id,
            "tool_call_ids": batch_ids,
            "tool_name": _canonical_tool_name(request),
            "summary": summary,
        }
    )
    log_tool_approval_trace("中间件·interrupt返回(resume)", thread_id=tid, side="中间件",
        event_data={"tool_call_id": tc_id, "decision": str(decision)[:300] if decision else "None"})
    return await _resolve_after_resume_async(request, handler, decision, pending_msg=pending_msg)


def _build_denylist_blocked_result(request: ToolCallRequest, *, reason: str) -> ToolMessage:
    """Return a blocked ToolMessage when denylist matches — model sees it and can adjust."""
    import json

    tool_name = _tool_name(request)
    tc_id = _tool_call_id(request)
    tid = _thread_id_from_request(request)
    try:
        from evoflow.persistence.sandbox_audit_repositories import write_sandbox_audit_log

        write_sandbox_audit_log(
            event_type="denylist_blocked",
            path="",
            tool_name=tool_name,
            tool_call_id=tc_id,
            reason=reason or "匹配危险模式",
            thread_id=tid,
        )
    except Exception:
        logger.debug("denylist audit log failed (non-fatal)", exc_info=True)
    msg = json.dumps(
        {
            "_evoflow_tool": {"status": "blocked"},
            "message": f"此工具调用已被安全策略阻止：{reason}。请使用更安全的替代方案。",
        },
        ensure_ascii=False,
    )
    tool_message = ToolMessage(
        content=msg,
        tool_call_id=tc_id,
        name=tool_name,
    )
    persist_transcript_tool_message_now(
        getattr(request, "runtime", None),
        tool_message,
    )
    logger.warning("Tool denylist blocked: %s (%s) — %s", tool_name, tc_id, reason)
    return tool_message


class ToolApprovalMiddleware(AgentMiddleware[AgentState]):
    """Intercept configured tools until user grants via UI or chat command."""

    @override
    def wrap_tool_call(
        self,
        request: ToolCallRequest,
        handler: Callable[[ToolCallRequest], ToolMessage | Command],
    ) -> ToolMessage | Command:
        raw_name = _tool_name(request)
        name = _canonical_tool_name(request)
        args = _tool_args(request)
        requires = tool_requires_approval(name, args)
        _trace_decision(
            "wrap_tool_call 进入",
            request,
            extra={
                "需要授权": requires,
                "风险": tool_risk_level(name, args),
            },
        )
        # Layer 0: denylist — non-overridable, blocks before any policy check
        blocked, reason = is_dangerous(name, args)
        if blocked:
            _trace_decision("拒绝：命中危险命令黑名单", request, extra={"原因": reason})
            return _build_denylist_blocked_result(request, reason=reason or "匹配危险模式")
        if not requires:
            _trace_decision("放行：无需授权（风险=auto 或策略允许）", request)
            return handler(request)
        if _unattended_automation(request):
            _trace_decision("放行：无人值守自动化模式", request)
            return handler(request)

        # 防止 deny 后无限重试：同一工具被拒绝超过阈值后直接拦截
        tid = _thread_id_from_request(request)
        canon_name = _canonical_tool_name(request)
        if tid and _get_deny_count(tid, canon_name) >= _DENY_MAX_RETRIES:
            _trace_decision(
                "拦截：工具被拒绝过多，阻止重试",
                request,
                extra={"拒绝次数": _get_deny_count(tid, canon_name), "工具名": canon_name},
            )
            log_tool_approval_trace("中间件·deny重试拦截", thread_id=tid, side="中间件",
                level=logging.WARNING, event_data={"tool_name": canon_name, "deny_count": _get_deny_count(tid, canon_name)})
            blocked_msg = _build_deny_retry_blocked_result(request)
            persist_transcript_tool_message_now(
                getattr(request, "runtime", None),
                blocked_msg,
                message_id_prefix=message_id_prefix_for_gate("tool_approval"),
            )
            return blocked_msg

        ws_root = _workspace_root_from_request(request) or None
        if tid and is_granted_for_thread(tid, name, args, workspace_root=ws_root):
            _trace_decision("放行：会话已授权（grant_all / 签名 / 工具名）", request)
            result = handler(request)
            consume_signature_grant(tid, name, args, workspace_root=ws_root)
            return result

        summary = summarize_tool_for_approval(name, args)
        logger.info("Tool approval required: %s (%s) raw=%s", name, _tool_call_id(request), raw_name)
        return _gate_tool_call_sync(request, handler, summary=summary)

    @override
    async def awrap_tool_call(
        self,
        request: ToolCallRequest,
        handler: Callable[[ToolCallRequest], Awaitable[ToolMessage | Command]],
    ) -> ToolMessage | Command:
        raw_name = _tool_name(request)
        name = _canonical_tool_name(request)
        args = _tool_args(request)
        requires = tool_requires_approval(name, args)
        _trace_decision(
            "awrap_tool_call 进入",
            request,
            extra={
                "需要授权": requires,
                "风险": tool_risk_level(name, args),
            },
        )
        blocked, reason = is_dangerous(name, args)
        if blocked:
            _trace_decision("拒绝：命中危险命令黑名单", request, extra={"原因": reason})
            return _build_denylist_blocked_result(request, reason=reason or "匹配危险模式")
        if not requires:
            _trace_decision("放行：无需授权（风险=auto 或策略允许）", request)
            return await handler(request)
        if _unattended_automation(request):
            _trace_decision("放行：无人值守自动化模式", request)
            return await handler(request)

        # 防止 deny 后无限重试：同一工具被拒绝超过阈值后直接拦截
        tid = _thread_id_from_request(request)
        canon_name = _canonical_tool_name(request)
        if tid and _get_deny_count(tid, canon_name) >= _DENY_MAX_RETRIES:
            _trace_decision(
                "拦截：工具被拒绝过多，阻止重试",
                request,
                extra={"拒绝次数": _get_deny_count(tid, canon_name), "工具名": canon_name},
            )
            log_tool_approval_trace("中间件·deny重试拦截", thread_id=tid, side="中间件",
                level=logging.WARNING, event_data={"tool_name": canon_name, "deny_count": _get_deny_count(tid, canon_name)})
            blocked_msg = _build_deny_retry_blocked_result(request)
            persist_transcript_tool_message_now(
                getattr(request, "runtime", None),
                blocked_msg,
                message_id_prefix=message_id_prefix_for_gate("tool_approval"),
            )
            return blocked_msg

        ws_root = _workspace_root_from_request(request) or None
        if tid and is_granted_for_thread(tid, name, args, workspace_root=ws_root):
            _trace_decision("放行：会话已授权（grant_all / 签名 / 工具名）", request)
            result = await handler(request)
            consume_signature_grant(tid, name, args, workspace_root=ws_root)
            return result

        summary = summarize_tool_for_approval(name, args)
        logger.info("Tool approval required: %s (%s) raw=%s", name, _tool_call_id(request), raw_name)
        return await _gate_tool_call_async(request, handler, summary=summary)


def _thread_id_from_runtime(runtime: Runtime) -> str:
    try:
        tid = str(runtime_context_mapping(runtime).get("thread_id") or "").strip()
        if tid:
            return tid
    except Exception:
        pass
    return _thread_id_from_configurable()


class ToolApprovalAnswersMiddleware(AgentMiddleware[AgentState]):
    """Parse approval commands; queue replay when user approves."""

    state_schema = AgentState

    def _normalize(self, state: AgentState, runtime: Runtime) -> dict[str, Any] | None:
        messages = state.get("messages") or []
        if not messages:
            return None
        last = messages[-1]
        if not isinstance(last, HumanMessage) or not isinstance(last.content, str):
            return None

        raw = str(last.content or "").strip()
        if raw.lower().startswith(REPLAY_MARKER.lower()):
            return None

        data = parse_user_approval_message(last.content)
        if data is None and not raw.lower().startswith(_PREFIX.lower()):
            return None
        if data is None:
            return None

        tid = _thread_id_from_runtime(runtime)
        if not tid:
            try:
                from langgraph.config import get_config

                gconf = (get_config() or {}).get("configurable") or {}
                if isinstance(gconf, dict):
                    tid = str(gconf.get("thread_id") or "").strip()
            except Exception:
                pass

        ws_root = ""
        ctx_map = runtime_context_mapping(runtime)
        if ctx_map:
            ws_root = str(ctx_map.get("local_workspace_root") or "").strip()

        result = apply_user_approval(tid, data, workspace_root=ws_root or None) if tid else None
        if result is None:
            reply = "缺少 thread_id，无法记录授权。"
            replay_ids: list[str] = []
        else:
            reply = result.reply
            replay_ids = list(result.replay_tool_call_ids)

        if replay_ids:
            rewritten = last.model_copy(
                update={
                    "content": build_replay_message(replay_ids),
                    "name": "tool_approval_resume",
                }
            )
            return {"messages": [rewritten]}

        rewritten = last.model_copy(
            update={
                "content": f"用户工具授权操作：{reply}\n（原始指令: {last.content[:200]}）",
                "name": "tool_approval_command",
            }
        )
        return {"messages": [rewritten]}

    @override
    def before_model(self, state: AgentState, runtime: Runtime) -> dict[str, Any] | None:
        return self._normalize(state, runtime)

    @override
    async def abefore_model(self, state: AgentState, runtime: Runtime) -> dict[str, Any] | None:
        return self._normalize(state, runtime)


class ToolApprovalReplayMiddleware(AgentMiddleware[AgentState]):
    """Execute approved tools when replay marker message is submitted."""

    state_schema = AgentState

    @staticmethod
    def _human_text(content: Any) -> str:
        if isinstance(content, str):
            return content
        if isinstance(content, list):
            parts: list[str] = []
            for p in content:
                if isinstance(p, str):
                    parts.append(p)
                elif isinstance(p, dict) and str(p.get("type") or "") == "text":
                    parts.append(str(p.get("text") or ""))
            return "".join(parts)
        return str(content or "")

    def _resolve_replay_ids(self, state: AgentState, runtime: Runtime) -> list[str] | None:
        """Locate replay ids from marker message, run config, or pending+approved DB rows."""
        messages = list(state.get("messages") or [])

        for msg in reversed(messages):
            if not isinstance(msg, HumanMessage):
                continue
            ids = parse_replay_message(self._human_text(getattr(msg, "content", None)))
            if ids:
                return ids

        bags: list[dict[str, Any]] = [runtime_context_mapping(runtime)]
        try:
            cfg = getattr(runtime, "config", None) or {}
            if isinstance(cfg, dict):
                conf = cfg.get("configurable")
                if isinstance(conf, dict):
                    bags.append(conf)
        except Exception:
            pass
        try:
            from langgraph.config import get_config

            gconf = (get_config() or {}).get("configurable") or {}
            if isinstance(gconf, dict):
                bags.append(gconf)
        except Exception:
            pass

        for bag in bags:
            raw_ids = bag.get("tool_approval_replay_ids")
            ids: list[str] = []
            if isinstance(raw_ids, (list, tuple)):
                ids = [str(x).strip() for x in raw_ids if str(x).strip()]
            elif isinstance(raw_ids, str) and raw_ids.strip():
                try:
                    parsed = json.loads(raw_ids)
                    if isinstance(parsed, list):
                        ids = [str(x).strip() for x in parsed if str(x).strip()]
                except Exception:
                    ids = []
            if not ids:
                continue
            tid_cfg = _thread_id_from_runtime(runtime)
            if not tid_cfg:
                return ids
            # Configurable survives across model cycles; only fire while approved rows remain.
            entries = pop_replay_queue(tid_cfg, ids)
            if entries:
                return [
                    str(e.get("tool_call_id") or "").strip()
                    for e in entries
                    if str(e.get("tool_call_id") or "").strip()
                ]
            return None

        tid = _thread_id_from_runtime(runtime)
        if not tid:
            return None

        pending_ids: list[str] = []
        for msg in reversed(messages):
            if not isinstance(msg, ToolMessage):
                break
            body = str(getattr(msg, "content", "") or "")
            if "pending_approval" not in body:
                break
            tc = str(getattr(msg, "tool_call_id", "") or "").strip()
            if tc:
                pending_ids.append(tc)
        if not pending_ids:
            return None

        entries = pop_replay_queue(tid, pending_ids)
        if not entries:
            entries = pop_replay_queue(tid, None)
        ids = [str(e.get("tool_call_id") or "").strip() for e in entries if str(e.get("tool_call_id") or "").strip()]
        return ids or None

    def _merge_executed_tool_messages(
        self,
        messages: list[Any],
        tool_messages: list[ToolMessage],
        executed_ids: list[str],
        *,
        denied_ids: list[str] | None = None,
    ) -> list[Any]:
        executed_set = {x for x in executed_ids if x}
        denied_set = {x for x in (denied_ids or []) if x}
        by_id = {
            str(getattr(tm, "tool_call_id", "") or "").strip(): tm
            for tm in tool_messages
            if str(getattr(tm, "tool_call_id", "") or "").strip()
        }
        out: list[Any] = []
        for msg in messages:
            if isinstance(msg, HumanMessage):
                if parse_replay_message(self._human_text(getattr(msg, "content", None))):
                    continue
            if isinstance(msg, ToolMessage):
                tc = str(getattr(msg, "tool_call_id", "") or "").strip()
                if tc in executed_set and tc in by_id:
                    out.append(by_id.pop(tc))
                    continue
                if tc in denied_set:
                    import json

                    tool_name = str(getattr(msg, "name", "") or "").strip()
                    out.append(
                        ToolMessage(
                            content=json.dumps(
                                {
                                    "_evoflow_tool": {"status": "denied"},
                                    "message": "[denied] 用户已拒绝",
                                },
                                ensure_ascii=False,
                            ),
                            tool_call_id=tc,
                            name=tool_name or None,
                            id=f"{message_id_prefix_for_gate('tool_approval')}-{tc}" if tc else None,
                        )
                    )
                    continue
            out.append(msg)
        out.extend(by_id.values())
        return out

    async def _replay(self, state: AgentState, runtime: Runtime) -> dict[str, Any] | None:
        messages = state.get("messages") or []

        # ── 诊断：记录中间件入口（覆盖所有静默早退路径） ──
        _diag_tid = _thread_id_from_runtime(runtime) or "?"
        _last_type = type(messages[-1]).__name__ if messages else "none"
        _last_preview = ""
        if messages:
            _c = getattr(messages[-1], "content", "")
            _last_preview = (_c[:120] if isinstance(_c, str) else str(_c)[:120])
        log_tool_approval_trace(
            "Replay中间件·进入检查",
            thread_id=_diag_tid, side="中间件",
            event_data={"msg_count": len(messages), "last_type": _last_type, "last_preview": _last_preview},
        )

        if not messages:
            log_tool_approval_trace("Replay中间件·早退(消息为空)", thread_id=_diag_tid, side="中间件")
            return None

        replay_ids = self._resolve_replay_ids(state, runtime)
        if not replay_ids:
            log_tool_approval_trace(
                "Replay中间件·早退(parse失败或非replay消息)",
                thread_id=_diag_tid, side="中间件",
                event_data={
                    "last_type": type(messages[-1]).__name__,
                    "content_type": type(getattr(messages[-1], "content", None)).__name__,
                },
            )
            return None

        tid = _thread_id_from_runtime(runtime)
        if not tid:
            log_tool_approval_trace("Replay中间件·早退(tid为空)", side="中间件")
            return None

        log_tool_approval_trace("中间件·replay执行已批准工具", thread_id=tid, side="中间件",
            event_data={"replay_ids": replay_ids, "queue_length": len(replay_ids)})

        log_tool_approval_trace(
            "Replay 中间件：开始执行已批准工具",
            thread_id=tid,
            replay_ids=replay_ids,
            队列长度=len(replay_ids),
        )

        entries = pop_replay_queue(tid, replay_ids)
        if not entries:
            log_tool_approval_trace(
                "Replay 中间件：队列为空（可能已执行或已取消）",
                thread_id=tid,
                replay_ids=replay_ids,
            )
            try:
                from evoflow.agents.tool_approval_pause_registry import clear_tool_approval_pause

                clear_tool_approval_pause(tid)
            except Exception:
                logger.debug("clear tool approval pause on empty replay queue failed thread=%s", tid, exc_info=True)
            cleaned = [
                m
                for m in messages
                if not (
                    isinstance(m, HumanMessage)
                    and parse_replay_message(self._human_text(getattr(m, "content", None)))
                )
            ]
            note = HumanMessage(content="用户已批准，但 replay 队列中无对应工具（可能已执行或已取消）。")
            return replace_messages_in_state([*cleaned, note])

        ctx = LeadAgentRuntimeContext.from_mapping(runtime_context_mapping(runtime))
        tool_messages: list[ToolMessage] = []
        summaries: list[str] = []
        executed_ids: list[str] = []
        for entry in entries:
            tm = await aexecute_approved_tool_entry(entry, runtime_context=ctx)
            tool_messages.append(tm)
            summaries.append(f"{entry.get('tool_name')}: 已执行")
            executed_ids.append(str(entry.get("tool_call_id") or "").strip())

        consume_replay_queue(tid, executed_ids)

        log_tool_approval_trace(
            "Replay 中间件：工具执行完成",
            thread_id=tid,
            已执行数=len(tool_messages),
            工具列表=[str(e.get("tool_name") or "") for e in entries],
        )

        # Replace pending_approval transcript rows so UI/history stop showing 待授权.
        try:
            from evoflow.persistence.chat_message_repositories import update_tool_transcript_content
            from evoflow.persistence.session_repositories import find_session_key_by_thread_id

            sk = str(find_session_key_by_thread_id(tid) or "").strip()
            if sk:
                for tm in tool_messages:
                    tc = str(getattr(tm, "tool_call_id", "") or "").strip()
                    if not tc:
                        continue
                    update_tool_transcript_content(
                        sk,
                        tc,
                        content=getattr(tm, "content", "") or "",
                        tool_name=str(getattr(tm, "name", "") or "") or None,
                    )
        except Exception:
            logger.debug("update tool transcript after replay failed thread=%s", tid, exc_info=True)

        # Resume path kept pause until tools ran; clear so after_agent can mark idle.
        try:
            from evoflow.agents.tool_approval_pause_registry import clear_tool_approval_pause

            clear_tool_approval_pause(tid)
        except Exception:
            logger.debug("clear tool approval pause after replay failed thread=%s", tid, exc_info=True)

        denied_ids: list[str] = []
        try:
            from evoflow.persistence.tool_approval_repositories import list_denied_for_thread

            denied_ids = [
                str(e.get("tool_call_id") or "").strip()
                for e in list_denied_for_thread(tid)
                if str(e.get("tool_call_id") or "").strip()
            ]
        except Exception:
            logger.debug("list denied after replay failed thread=%s", tid, exc_info=True)

        if denied_ids:
            try:
                from evoflow.agents.tool_approval_service import _persist_denied_tool_transcript
                from evoflow.persistence.session_repositories import find_session_key_by_thread_id

                sk = str(find_session_key_by_thread_id(tid) or "").strip()
                if sk:
                    for dtc in denied_ids:
                        _persist_denied_tool_transcript(sk, dtc)
            except Exception:
                logger.debug("persist denied transcripts after replay failed thread=%s", tid, exc_info=True)

        merged = self._merge_executed_tool_messages(
            list(messages),
            tool_messages,
            executed_ids,
            denied_ids=denied_ids,
        )
        return replace_messages_in_state(merged)

    @override
    def before_model(self, state: AgentState, runtime: Runtime) -> dict[str, Any] | None:
        # Sync 安全网：确保即使 LangGraph runtime 走 sync 路径也能触发 replay 逻辑。
        # _replay 是 async，但其中只有 pop_replay_queue 是同步 DB 读取 + aexecute_approved_tool_entry 是 async。
        # 在 sync 路径下，我们只做「检测 + 队列弹出」，工具执行通过 asyncio 事件循环桥接。
        import asyncio

        messages = state.get("messages") or []

        # ── 诊断：sync 路径入口 + 所有早退路径 ──
        _diag_tid = _thread_id_from_runtime(runtime) or "?"
        _last_type = type(messages[-1]).__name__ if messages else "none"
        _last_preview = ""
        if messages:
            _c = getattr(messages[-1], "content", "")
            _last_preview = (_c[:120] if isinstance(_c, str) else str(_c)[:120])
        log_tool_approval_trace(
            "Replay中间件·sync入口检查",
            thread_id=_diag_tid, side="中间件",
            event_data={"msg_count": len(messages), "last_type": _last_type,
                        "last_preview": _last_preview},
        )

        if not messages:
            log_tool_approval_trace("Replay中间件·sync早退(消息为空)", thread_id=_diag_tid, side="中间件")
            return None

        replay_ids = self._resolve_replay_ids(state, runtime)
        if not replay_ids:
            log_tool_approval_trace(
                "Replay中间件·sync早退(parse失败或非replay消息)",
                thread_id=_diag_tid, side="中间件",
                event_data={"last_type": type(messages[-1]).__name__},
            )
            return None
        tid = _thread_id_from_runtime(runtime)
        if not tid:
            log_tool_approval_trace("Replay中间件·sync早退(tid为空)", side="中间件")
            return None

        log_tool_approval_trace("Replay中间件·sync路径触发", thread_id=tid, side="中间件",
            event_data={"replay_ids": replay_ids})

        # 尝试在已有事件循环中运行 async _replay；若没有则创建新循环
        try:
            loop = asyncio.get_event_loop()
            if loop.is_running():
                # 已在 async 上下文但走了 sync 路径——不应发生，但兜底
                log_tool_approval_trace("Replay中间件·sync在running loop中，跳过", thread_id=tid, side="中间件")
                return None
        except RuntimeError:
            loop = None

        try:
            if loop is None:
                loop = asyncio.new_event_loop()
                asyncio.set_event_loop(loop)
            return loop.run_until_complete(self._replay(state, runtime))
        except Exception:
            logger.exception("Replay中间件·sync桥接失败 thread=%s", tid)
            return None

    @override
    async def abefore_model(self, state: AgentState, runtime: Runtime) -> dict[str, Any] | None:
        log_tool_approval_trace("Replay中间件·abefore_model入口", thread_id=_thread_id_from_runtime(runtime) or "?",
            side="中间件")
        return await self._replay(state, runtime)


class ToolApprovalDenyContinueMiddleware(AgentMiddleware[AgentState]):
    """Replace pending-approval ToolMessages with denied results when API deny resumes the graph."""

    state_schema = AgentState

    @staticmethod
    def _deny_ids_from_runtime(runtime: Runtime) -> list[str]:
        ctx = runtime_context_mapping(runtime)
        ids = [
            str(x).strip()
            for x in (ctx.get("tool_approval_deny_tool_call_ids") or [])
            if str(x).strip()
        ]
        single = str(ctx.get("tool_approval_deny_tool_call_id") or "").strip()
        if single and single not in ids:
            ids.insert(0, single)
        if not ids:
            return []
        # Fold in other DB-denied siblings from the same batch so one deny_run
        # clears every pending_approval ToolMessage that was already marked denied.
        tid = _thread_id_from_runtime(runtime)
        if tid:
            try:
                from evoflow.persistence.tool_approval_repositories import list_denied_for_thread

                for row in list_denied_for_thread(tid):
                    tc = str(row.get("tool_call_id") or "").strip()
                    if tc and tc not in ids:
                        ids.append(tc)
            except Exception:
                logger.debug("list denied for deny middleware failed", exc_info=True)
        return ids

    def _apply(self, state: AgentState, runtime: Runtime) -> dict[str, Any] | None:
        deny_ids = set(self._deny_ids_from_runtime(runtime))
        if not deny_ids:
            return None
        log_tool_approval_trace(
            "Deny 中间件：替换 pending 为拒绝结果",
            thread_id=_thread_id_from_runtime(runtime),
            tool_call_id=next(iter(deny_ids)),
            event_data={"denied_ids": sorted(deny_ids)},
        )
        messages = list(state.get("messages") or [])
        if not messages:
            return None
        out: list[Any] = []
        replaced = 0
        for msg in messages:
            tc = (
                str(getattr(msg, "tool_call_id", "") or "").strip()
                if isinstance(msg, ToolMessage)
                else ""
            )
            if isinstance(msg, ToolMessage) and tc in deny_ids:
                import json

                tool_name = str(getattr(msg, "name", "") or "").strip()
                denied_content = json.dumps(
                    {
                        "_evoflow_tool": {"status": "denied"},
                        "message": "[denied] 用户已拒绝",
                    },
                    ensure_ascii=False,
                )
                denied = ToolMessage(
                    content=denied_content,
                    tool_call_id=tc,
                    name=tool_name or None,
                    id=f"{message_id_prefix_for_gate('tool_approval')}-{tc}" if tc else None,
                )
                # append 会因同 tool_call_id 去重跳过；必须 UPDATE pending 行
                try:
                    from evoflow.agents.tool_approval_service import _persist_denied_tool_transcript
                    from evoflow.persistence.session_repositories import find_session_key_by_thread_id

                    tid = _thread_id_from_runtime(runtime)
                    sk = str(find_session_key_by_thread_id(tid) or "").strip() if tid else ""
                    if sk:
                        _persist_denied_tool_transcript(sk, tc, tool_name=tool_name)
                except Exception:
                    logger.debug("deny middleware transcript update failed", exc_info=True)
                    persist_transcript_tool_message_now(
                        runtime,
                        denied,
                        message_id_prefix=message_id_prefix_for_gate("tool_approval"),
                    )
                out.append(denied)
                replaced += 1
            else:
                out.append(msg)
        if not replaced:
            return None
        return replace_messages_in_state(out)

    @override
    def before_model(self, state: AgentState, runtime: Runtime) -> dict[str, Any] | None:
        return self._apply(state, runtime)

    @override
    async def abefore_model(self, state: AgentState, runtime: Runtime) -> dict[str, Any] | None:
        return self._apply(state, runtime)
