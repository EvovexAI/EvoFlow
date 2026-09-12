"""Push tool-approval status onto the live middle-layer SSE."""

from __future__ import annotations

import json
import logging

logger = logging.getLogger(__name__)


async def push_tool_approval_decision(
    thread_id: str,
    *,
    tool_call_id: str,
    tool_name: str = "",
    status: str,
    message: str = "",
    reason: str = "",
) -> bool:
    """立即把某个工具的授权结果推到当前 POST SSE（批准后 UI 马上离开 pending）。"""
    from app.gateway.streaming.session_stream_inject import inject_evf_frame

    tid = str(thread_id or "").strip()
    tc_id = str(tool_call_id or "").strip()
    wire_status = str(status or "").strip() or "approved_waiting"
    if not tid or not tc_id:
        return False
    content = json.dumps(
        {
            "_evoflow_tool": {"status": wire_status},
            "message": message
            or (
                "当前工具已批准，等待其他待授权工具确认后统一执行。"
                if wire_status in {"approved_waiting", "awaiting_other_approval"}
                else f"工具授权结果：{wire_status}"
            ),
        },
        ensure_ascii=False,
    )
    ok = await inject_evf_frame(
        tid,
        {
            "type": "custom",
            "chunk": {
                "type": "tool_approval_decision",
                "tool_call_id": tc_id,
                "tool_name": str(tool_name or "").strip() or "tool",
                "status": wire_status,
                "content": content,
            },
        },
    )
    logger.info(
        "【工具授权·SSE推送】决策 status=%s tool=%s tc=%s ok=%s reason=%s",
        wire_status,
        tool_name or "?",
        tc_id,
        ok,
        reason or "?",
    )
    return ok


async def push_pending_approvals_to_live_stream(thread_id: str, *, reason: str = "") -> int:
    """将 DB 中仍处于 pending 的工具授权项注入当前 POST SSE（await_next / 多工具场景）。"""
    from app.gateway.db_async import run_db
    from app.gateway.streaming.session_stream_inject import inject_evf_frame
    from evoflow.agents.tool_approval_config import format_approval_payload_text, tool_risk_level
    from evoflow.agents.tool_approval_service import list_pending_approvals

    tid = str(thread_id or "").strip()
    if not tid:
        return 0
    pending = await run_db(list_pending_approvals, tid)
    if not pending:
        logger.info(
            "【工具授权·SSE推送】thread=%s 无待授权项，跳过 reason=%s",
            tid,
            reason or "?",
        )
        return 0
    pushed = 0
    for row in pending:
        tc_id = str(row.get("tool_call_id") or "").strip()
        tool_name = str(row.get("tool_name") or "").strip()
        if not tc_id or not tool_name:
            continue
        args = row.get("args") if isinstance(row.get("args"), dict) else {}
        summary = str(row.get("summary") or "").strip()
        risk = tool_risk_level(tool_name, args)
        approval = json.loads(
            format_approval_payload_text(
                tool_name=tool_name,
                tool_call_id=tc_id,
                summary=summary,
                risk=risk,
            )
        )
        content = json.dumps(
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
        ok = await inject_evf_frame(
            tid,
            {
                "type": "custom",
                "chunk": {
                    "type": "tool_approval_pending",
                    "tool_call_id": tc_id,
                    "tool_name": tool_name,
                    "content": content,
                },
            },
        )
        if ok:
            pushed += 1
            logger.info(
                "【工具授权·SSE推送】已注入 pending tool=%s tc=%s reason=%s",
                tool_name,
                tc_id,
                reason or "?",
            )
        else:
            logger.warning(
                "【工具授权·SSE推送】注入失败 tool=%s tc=%s reason=%s",
                tool_name,
                tc_id,
                reason or "?",
            )
    logger.info(
        "【工具授权·SSE推送】thread=%s 完成 pushed=%s total_pending=%s reason=%s",
        tid,
        pushed,
        len(pending),
        reason or "?",
    )
    return pushed


async def push_tool_execution_result(
    thread_id: str,
    *,
    tool_call_id: str,
    tool_name: str = "",
    content: str = "",
    reason: str = "",
) -> bool:
    """Push a completed tool result onto the live POST SSE after gateway execution."""
    from app.gateway.streaming.session_stream_inject import inject_evf_frame

    tid = str(thread_id or "").strip()
    tc_id = str(tool_call_id or "").strip()
    if not tid or not tc_id:
        return False
    wire_content = str(content or "").strip()
    if not wire_content:
        wire_content = json.dumps(
            {"_evoflow_tool": {"status": "ok"}, "message": "工具已执行。"},
            ensure_ascii=False,
        )
    ok = await inject_evf_frame(
        tid,
        {
            "type": "custom",
            "chunk": {
                "type": "tool_execution_result",
                "tool_call_id": tc_id,
                "tool_name": str(tool_name or "").strip() or "tool",
                "content": wire_content,
                "status": "ok",
            },
        },
    )
    logger.info(
        "【工具授权·SSE推送】执行结果 tool=%s tc=%s ok=%s reason=%s",
        tool_name or "?",
        tc_id,
        ok,
        reason or "?",
    )
    return ok


__all__ = [
    "push_pending_approvals_to_live_stream",
    "push_tool_approval_decision",
    "push_tool_execution_result",
]
