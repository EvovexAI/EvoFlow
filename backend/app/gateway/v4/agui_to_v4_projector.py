"""H3-B-2: AG-UI event-list -> v4 conversationDeltas translator.

NOT MOUNTED. 当前产品对话（含流式、工具卡、电脑控制图标/截图）走旧链路：
``sse_ui_normalize`` + ``evopanel/src/react/components/ToolCallList.tsx``。
本文件和 ``EvoFlowV4SessionPane`` 尚未接入。可见的聊天问题不要改这里。



This module is intentionally **stateless**: all per-session state lives in
``ConversationProjectionWriter`` via the registry, so multiple producers
(H1 demo + LangGraph main path) can share a single writer instance.

Input shape:
    ``events`` is the list of dicts returned by ``AgUiEncoderState``
    (``evf_payload_to_agui_events`` output). Each dict has at least:

    - ``{"type": "RUN_STARTED", "threadId": ..., "runId": ...}``
    - ``{"type": "TEXT_MESSAGE_START", "messageId": ...}``
    - ``{"type": "TEXT_MESSAGE_CONTENT", "messageId": ..., "delta": ...}``
    - ``{"type": "TEXT_MESSAGE_END", "messageId": ...}``
    - ``{"type": "REASONING_MESSAGE_*", ...}`` (REASONING_MESSAGE_START/CONTENT/END)
    - ``{"type": "TOOL_CALL_START", "toolCallId": ..., "toolCallName": ...}``
    - ``{"type": "TOOL_CALL_ARGS", "toolCallId": ..., "delta": ...}``
    - ``{"type": "TOOL_CALL_END", "toolCallId": ...}``
    - ``{"type": "TOOL_CALL_RESULT", "toolCallId": ..., "content": ..., "status": ...}``
    - ``{"type": "RUN_FINISHED", ...}`` / ``RUN_ERROR``

Output:
    forwards emit_row_appended / emit_row_upserted / emit_state_patch calls on
    the provided ``writer`` for ``subscription_id``. The list returned by
    ``translate_agui_events`` is the list of ``ConversationTopicFrame`` objects
    produced (in order). Callers store them in their pending-buffer pool.

Used by ``stream_resume_langgraph_tail.py`` (H3-B-3) to mirror the live
AG-UI stream into v4 projection, so ``EvoFlowV4SessionPane`` (H3-C) can
render main conversation sessions in addition to the H1 demo.
"""

from __future__ import annotations

import json
import time
from dataclasses import dataclass, field
from typing import Any

from ..v4_demo.projection import ConversationProjectionWriter

# Map AG-UI status -> v4 toolCall.status (snake_case, aligns with rows.ts)
_AGUI_TO_TOOL_STATUS: dict[str, str] = {
    "inputStreaming": "inputStreaming",
    "pendingApproval": "pendingApproval",
    "running": "running",
    "success": "success",
    "error": "error",
    "cancelled": "cancelled",
}

# node_repl js 工具结果尾部的展示标记（见 plugins/node_repl_tool.py）。
_CUA_DISPLAY_MARKER_PREFIX = "{evoflow-cua-display:"
# ZCode appKey scheme → 面板 ApplicationIconLocator kind。
_CUA_APP_KEY_LOCATOR_KINDS = {
    "darwin": "darwin-bundle-id",
    "windows-aumid": "windows-aumid",
    "windows-exe": "windows-executable-path",
}


def _split_evoflow_cua_display(content: str) -> tuple[str, dict[str, Any] | None]:
    """Strip the trailing ``{evoflow-cua-display:...}`` marker line from a js result.

    返回 ``(正文, display 载荷)``；无标记或载荷不合法时原样返回正文与 None。
    """
    for line in reversed(content.splitlines()):
        stripped = line.strip()
        if not stripped:
            continue
        if not stripped.startswith(_CUA_DISPLAY_MARKER_PREFIX):
            return content, None
        # 标记行 = 前缀（含开括号）+ 单行 JSON + 收尾大括号。
        payload_text = stripped[len(_CUA_DISPLAY_MARKER_PREFIX) : -1]
        try:
            payload = json.loads(payload_text)
        except ValueError:
            return content, None
        if not isinstance(payload, dict):
            return content, None
        cleaned = "\n".join(
            l for l in content.splitlines() if l.strip() != stripped
        ).rstrip()
        return cleaned, payload
    return content, None


def _cua_display_block(payload: dict[str, Any], body_text: str) -> dict[str, Any] | None:
    """Build a panel-compatible ``kind:"cua"`` tool result display block."""
    status = "failed" if payload.get("status") == "failed" else "success"
    block: dict[str, Any] = {
        "kind": "cua",
        "schemaVersion": 1,
        "toolName": "computer_use",
        "status": status,
    }
    text = (body_text or "").strip()
    if text:
        block["text"] = text[:32_000]
    media: list[dict[str, str]] = []
    for image in (payload.get("images") or [])[:4]:
        if not isinstance(image, dict):
            continue
        url = str(image.get("url") or "").strip()
        if not url:
            continue
        media.append({"mimeType": "image/png", "artifactUri": url})
    if media:
        block["media"] = media
    target = payload.get("target_app")
    if isinstance(target, dict):
        app_key = str(target.get("app_key") or "").strip()
        display_name = str(target.get("display_name") or "").strip()
        locators: list[dict[str, str]] = []
        if app_key:
            scheme, _, value = app_key.partition(":")
            kind = _CUA_APP_KEY_LOCATOR_KINDS.get(scheme.strip().lower())
            value = value.strip()
            if kind and value:
                locators.append(
                    {
                        "kind": kind,
                        # windows-executable-path 允许 32K，其余 512。
                        "value": value[:32_768] if kind == "windows-executable-path" else value[:512],
                    }
                )
        if display_name or locators:
            # 面板 parseCuaTargetApp 要求 iconLocators 为数组；仅有 displayName
            # 时也带空数组，避免整块 kind:"cua" display 被拒收。
            target_app: dict[str, Any] = {
                "schemaVersion": 1,
                "iconLocators": locators,
            }
            if display_name:
                target_app["displayName"] = display_name[:512]
            block["targetApp"] = target_app
    return block


def _now_ms() -> int:
    return int(time.time() * 1000)


@dataclass
class _TranslatorState:
    """Per-subscription translator state.

    Tracks stable id (AG-UI messageId / toolCallId) -> v4 rowId mapping so
    upserts target the right row across TEXT_MESSAGE_CONTENT chunks.
    """
    text_row_ids: dict[str, int] = field(default_factory=dict)
    reasoning_row_ids: dict[str, int] = field(default_factory=dict)
    tool_row_ids: dict[str, int] = field(default_factory=dict)
    run_started: bool = False
    turn_id: str = ""
    turn_header_row_id: int = 0


def translate_agui_events(
    events: list[dict[str, Any]],
    *,
    subscription_id: str,
    writer: ConversationProjectionWriter,
    state: _TranslatorState,
) -> list[Any]:
    """Translate ``events`` into v4 row deltas on ``writer``.

    ``state`` is mutated in-place; the caller owns its lifecycle and is
    expected to keep one instance per (subscription_id, session_id).
    """
    out: list[Any] = []
    now_ms = _now_ms()

    for ev in events:
        et = str(ev.get("type") or "").strip()

        if et == "RUN_STARTED":
            if state.run_started:
                continue
            state.run_started = True
            tid_short = str(ev.get("runId") or ev.get("threadId") or "").strip() or f"run-{int(time.time()*1000)}"
            state.turn_id = tid_short
            rid = writer.allocate_row_id()
            state.turn_header_row_id = rid
            out.append(
                writer.emit_row_appended(
                    subscription_id,
                    {
                        "rowId": rid,
                        "turnId": state.turn_id,
                        "kind": "turnHeader",
                        "origin": "userInput",
                        "state": "running",
                        "startedAt": now_ms,
                        "createdAt": now_ms,
                        "createdAtSeq": 0,
                    },
                )
            )
            # state.updated: control running, canStop=true
            out.append(
                writer.emit_state_patch(
                    subscription_id,
                    {
                        "control": {
                            "phase": "running",
                            "sessionEnded": False,
                            "canStop": True,
                            "stopState": "stoppable",
                            "activeWorks": [
                                {
                                    "kind": "primaryTurn",
                                    "startedAt": now_ms,
                                }
                            ],
                            "lastError": None,
                        }
                    },
                )
            )
            continue

        if et == "TEXT_MESSAGE_START":
            mid = str(ev.get("messageId") or "").strip()
            if not mid or mid in state.text_row_ids:
                continue
            rid = writer.allocate_row_id()
            state.text_row_ids[mid] = rid
            out.append(
                writer.emit_row_appended(
                    subscription_id,
                    {
                        "rowId": rid,
                        "turnId": state.turn_id,
                        "kind": "assistantText",
                        "state": "streaming",
                        "text": "",
                        "createdAt": now_ms,
                        "createdAtSeq": rid,
                        "assistantResponseId": mid,
                    },
                )
            )
            continue

        if et == "TEXT_MESSAGE_CONTENT":
            mid = str(ev.get("messageId") or "").strip()
            delta = str(ev.get("delta") or "")
            rid = state.text_row_ids.get(mid)
            if rid is None or not delta:
                continue
            existing = writer._state.rows_by_id.get(rid, {})  # type: ignore[attr-defined]
            new_text = str(existing.get("text") or "") + delta
            out.append(
                writer.emit_row_upserted(
                    subscription_id,
                    {
                        "rowId": rid,
                        "turnId": state.turn_id,
                        "kind": "assistantText",
                        "state": "streaming",
                        "text": new_text,
                        "createdAt": now_ms,
                        "createdAtSeq": rid,
                        "assistantResponseId": mid,
                    },
                )
            )
            continue

        if et == "TEXT_MESSAGE_END":
            mid = str(ev.get("messageId") or "").strip()
            rid = state.text_row_ids.get(mid)
            if rid is None:
                continue
            existing = writer._state.rows_by_id.get(rid, {})  # type: ignore[attr-defined]
            out.append(
                writer.emit_row_upserted(
                    subscription_id,
                    {
                        "rowId": rid,
                        "turnId": state.turn_id,
                        "kind": "assistantText",
                        "state": "complete",
                        "text": str(existing.get("text") or ""),
                        "createdAt": now_ms,
                        "createdAtSeq": rid,
                        "assistantResponseId": mid,
                    },
                )
            )
            continue

        if et == "REASONING_MESSAGE_START":
            mid = str(ev.get("messageId") or "").strip()
            if not mid or mid in state.reasoning_row_ids:
                continue
            rid = writer.allocate_row_id()
            state.reasoning_row_ids[mid] = rid
            out.append(
                writer.emit_row_appended(
                    subscription_id,
                    {
                        "rowId": rid,
                        "turnId": state.turn_id,
                        "kind": "reasoning",
                        "state": "streaming",
                        "text": "",
                        "createdAt": now_ms,
                        "createdAtSeq": rid,
                        "assistantResponseId": mid,
                    },
                )
            )
            continue

        if et == "REASONING_MESSAGE_CONTENT":
            mid = str(ev.get("messageId") or "").strip()
            delta = str(ev.get("delta") or "")
            rid = state.reasoning_row_ids.get(mid)
            if rid is None or not delta:
                continue
            existing = writer._state.rows_by_id.get(rid, {})  # type: ignore[attr-defined]
            new_text = str(existing.get("text") or "") + delta
            out.append(
                writer.emit_row_upserted(
                    subscription_id,
                    {
                        "rowId": rid,
                        "turnId": state.turn_id,
                        "kind": "reasoning",
                        "state": "streaming",
                        "text": new_text,
                        "createdAt": now_ms,
                        "createdAtSeq": rid,
                        "assistantResponseId": mid,
                    },
                )
            )
            continue

        if et == "REASONING_MESSAGE_END":
            mid = str(ev.get("messageId") or "").strip()
            rid = state.reasoning_row_ids.get(mid)
            if rid is None:
                continue
            existing = writer._state.rows_by_id.get(rid, {})  # type: ignore[attr-defined]
            out.append(
                writer.emit_row_upserted(
                    subscription_id,
                    {
                        "rowId": rid,
                        "turnId": state.turn_id,
                        "kind": "reasoning",
                        "state": "complete",
                        "text": str(existing.get("text") or ""),
                        "createdAt": now_ms,
                        "createdAtSeq": rid,
                        "assistantResponseId": mid,
                    },
                )
            )
            continue

        if et == "TOOL_CALL_START":
            tcid = str(ev.get("toolCallId") or "").strip()
            name = str(ev.get("toolCallName") or ev.get("name") or "tool").strip() or "tool"
            if not tcid or tcid in state.tool_row_ids:
                continue
            rid = writer.allocate_row_id()
            state.tool_row_ids[tcid] = rid
            out.append(
                writer.emit_row_appended(
                    subscription_id,
                    {
                        "rowId": rid,
                        "turnId": state.turn_id,
                        "kind": "toolCall",
                        "toolCallId": tcid,
                        "toolName": name,
                        "status": "running",
                        "inputText": "",
                        "createdAt": now_ms,
                        "createdAtSeq": rid,
                        "startedAt": now_ms,
                    },
                )
            )
            continue

        if et == "TOOL_CALL_ARGS":
            tcid = str(ev.get("toolCallId") or "").strip()
            delta = str(ev.get("delta") or "")
            rid = state.tool_row_ids.get(tcid)
            if rid is None or not delta:
                continue
            existing = writer._state.rows_by_id.get(rid, {})  # type: ignore[attr-defined]
            new_args = str(existing.get("inputText") or "") + delta
            out.append(
                writer.emit_row_upserted(
                    subscription_id,
                    {
                        "rowId": rid,
                        "turnId": state.turn_id,
                        "kind": "toolCall",
                        "toolCallId": tcid,
                        "toolName": str(existing.get("toolName") or "tool"),
                        "status": "running",
                        "inputText": new_args,
                        "createdAt": now_ms,
                        "createdAtSeq": rid,
                        "startedAt": existing.get("startedAt") or now_ms,
                    },
                )
            )
            continue

        if et == "TOOL_CALL_END":
            tcid = str(ev.get("toolCallId") or "").strip()
            rid = state.tool_row_ids.get(tcid)
            if rid is None:
                continue
            existing = writer._state.rows_by_id.get(rid, {})  # type: ignore[attr-defined]
            out.append(
                writer.emit_row_upserted(
                    subscription_id,
                    {
                        "rowId": rid,
                        "turnId": state.turn_id,
                        "kind": "toolCall",
                        "toolCallId": tcid,
                        "toolName": str(existing.get("toolName") or "tool"),
                        "status": "running",
                        "inputText": str(existing.get("inputText") or ""),
                        "createdAt": now_ms,
                        "createdAtSeq": rid,
                        "startedAt": existing.get("startedAt") or now_ms,
                    },
                )
            )
            continue

        if et == "TOOL_CALL_RESULT":
            tcid = str(ev.get("toolCallId") or "").strip()
            rid = state.tool_row_ids.get(tcid)
            if rid is None:
                continue
            existing = writer._state.rows_by_id.get(rid, {})  # type: ignore[attr-defined]
            agui_status = str(ev.get("status") or "success").strip().lower()
            v4_status = _AGUI_TO_TOOL_STATUS.get(agui_status, "success")
            tool_name = str(existing.get("toolName") or "")
            content = str(ev.get("content") or "")
            cua_display = None
            if "node_repl" in tool_name:
                content, cua_display = _split_evoflow_cua_display(content)
            tool_output: dict[str, Any]
            if v4_status == "error":
                tool_output = {"kind": "error", "error": {"code": "tool_error", "message": content}}
            else:
                tool_output = {"kind": "text", "text": content}
            if cua_display is not None:
                # 面板 readToolResultDisplay 从 output.display 取结构化展示块；
                # kind:"cua" 让 ToolCallBlock 走 ZCode 同款 CUA 卡片（targetApp 徽标 +
                # media 截图），普通文本渲染保留为正文兜底。
                block = _cua_display_block(cua_display, content)
                if block is not None:
                    tool_output["display"] = block
            out.append(
                writer.emit_row_upserted(
                    subscription_id,
                    {
                        "rowId": rid,
                        "turnId": state.turn_id,
                        "kind": "toolCall",
                        "toolCallId": tcid,
                        "toolName": str(existing.get("toolName") or "tool"),
                        "status": v4_status,
                        "inputText": str(existing.get("inputText") or ""),
                        "createdAt": now_ms,
                        "createdAtSeq": rid,
                        "startedAt": existing.get("startedAt") or now_ms,
                        "endedAt": now_ms,
                        "output": tool_output,
                    },
                )
            )
            continue

        if et in ("RUN_FINISHED", "RUN_ERROR"):
            if not state.run_started or state.turn_header_row_id == 0:
                continue
            v4_state = "completedSuccess" if et == "RUN_FINISHED" else "failed"
            existing = writer._state.rows_by_id.get(state.turn_header_row_id, {})  # type: ignore[attr-defined]
            out.append(
                writer.emit_row_upserted(
                    subscription_id,
                    {
                        "rowId": state.turn_header_row_id,
                        "turnId": state.turn_id,
                        "kind": "turnHeader",
                        "origin": str(existing.get("origin") or "userInput"),
                        "state": v4_state,
                        "startedAt": existing.get("startedAt") or now_ms,
                        "endedAt": now_ms,
                        "createdAt": existing.get("createdAt") or now_ms,
                        "createdAtSeq": 0,
                    },
                )
            )
            # state.updated: control terminal; canStop=false
            # Keep detail so composer ChatErrorBanner can copy/feedback the raw cause.
            if et == "RUN_ERROR":
                from app.gateway.v4.agui_mirror import _run_error_info

                last_error = _run_error_info(ev, now_ms=now_ms)
            else:
                last_error = None
            out.append(
                writer.emit_state_patch(
                    subscription_id,
                    {
                        "control": {
                            "phase": ("completedSuccess" if et == "RUN_FINISHED" else "error"),
                            "sessionEnded": True,
                            "canStop": False,
                            "stopState": "idle",
                            "activeWorks": [],
                            "lastError": last_error,
                        }
                    },
                )
            )
            continue

        # Unknown event types are silently ignored — translator is forwards-only.

    return out


__all__ = ["translate_agui_events", "_TranslatorState", "_AGUI_TO_TOOL_STATUS"]
