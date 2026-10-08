"""H3-B-2: AG-UI event-list -> v4 conversationDeltas translator.

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
            content = str(ev.get("content") or "")
            tool_output: dict[str, Any]
            if v4_status == "error":
                tool_output = {"kind": "error", "error": {"code": "tool_error", "message": content}}
            else:
                tool_output = {"kind": "text", "text": content}
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
            last_error = (
                {"code": "run_error", "message": str(ev.get("message") or ""), "recoverable": False, "at": now_ms, "source": "runtime"}
                if et == "RUN_ERROR"
                else None
            )
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
