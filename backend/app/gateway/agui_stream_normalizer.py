"""LangGraph SSE → AG-UI event stream (``event: ag-ui``)."""

from __future__ import annotations

import json
import uuid
from dataclasses import dataclass, field
from typing import Any

from app.gateway.agui_stream_encode import decode_evf_payload, encode_agui_event
from app.gateway.openai_stream_normalize import _arguments_text, _tool_args_stream_delta
from app.gateway.sse_ui_normalize import UiStreamNormalizer

# AG-UI EventType string constants (aligned with @ag-ui/core)
RUN_STARTED = "RUN_STARTED"
RUN_FINISHED = "RUN_FINISHED"
RUN_ERROR = "RUN_ERROR"
TEXT_MESSAGE_START = "TEXT_MESSAGE_START"
TEXT_MESSAGE_CONTENT = "TEXT_MESSAGE_CONTENT"
TEXT_MESSAGE_END = "TEXT_MESSAGE_END"
REASONING_START = "REASONING_START"
REASONING_MESSAGE_START = "REASONING_MESSAGE_START"
REASONING_MESSAGE_CONTENT = "REASONING_MESSAGE_CONTENT"
REASONING_MESSAGE_END = "REASONING_MESSAGE_END"
REASONING_END = "REASONING_END"
TOOL_CALL_START = "TOOL_CALL_START"
TOOL_CALL_ARGS = "TOOL_CALL_ARGS"
TOOL_CALL_END = "TOOL_CALL_END"
TOOL_CALL_RESULT = "TOOL_CALL_RESULT"
STEP_STARTED = "STEP_STARTED"
STEP_FINISHED = "STEP_FINISHED"
ACTIVITY_SNAPSHOT = "ACTIVITY_SNAPSHOT"
MESSAGES_SNAPSHOT = "MESSAGES_SNAPSHOT"
CUSTOM = "CUSTOM"


@dataclass
class AgUiEncoderState:
    thread_id: str
    run_id: str
    run_started: bool = False
    run_finished: bool = False
    text_started: set[str] = field(default_factory=set)
    text_ended: set[str] = field(default_factory=set)
    reasoning_started: set[str] = field(default_factory=set)
    reasoning_message_started: set[str] = field(default_factory=set)
    reasoning_ended: set[str] = field(default_factory=set)
    planning_step_open: bool = False
    tool_started: set[str] = field(default_factory=set)
    tool_names: dict[str, str] = field(default_factory=dict)
    tool_args_accum: dict[str, str] = field(default_factory=dict)
    tool_ended: set[str] = field(default_factory=set)
    tool_results: dict[str, str] = field(default_factory=dict)
    tool_args_emitted: set[str] = field(default_factory=set)
    # Bytes already sent via TOOL_CALL_ARGS for each toolCallId (for remainder/force).
    tool_args_emitted_len: dict[str, int] = field(default_factory=dict)
    subagent_root_task_ids: set[str] = field(default_factory=set)
    subagent_nested_tool_call_ids: set[str] = field(default_factory=set)
    subagent_content_fingerprints: set[str] = field(default_factory=set)
    activity_message_id: str = "activity-0"


def _tool_name_from_tc(tc: dict[str, Any]) -> str:
    fn = tc.get("function") if isinstance(tc.get("function"), dict) else {}
    return str(tc.get("name") or tc.get("tool_name") or fn.get("name") or "tool").strip()


def _tool_id_from_tc(tc: dict[str, Any]) -> str:
    return str(tc.get("id") or tc.get("tool_call_id") or "").strip()


def _tool_args_text_from_tc(tc: dict[str, Any]) -> str:
    fn = tc.get("function") if isinstance(tc.get("function"), dict) else {}
    args_in = _arguments_text(fn.get("arguments") if fn else None)
    if args_in:
        return args_in
    direct = tc.get("args")
    if direct is None:
        direct = tc.get("input")
    if direct is not None:
        return _arguments_text(direct)
    return _arguments_text(tc.get("arguments"))


def _ensure_run_started(state: AgUiEncoderState) -> list[dict[str, Any]]:
    if state.run_started:
        return []
    state.run_started = True
    return [
        {
            "type": RUN_STARTED,
            "threadId": state.thread_id,
            "runId": state.run_id,
        }
    ]


def _block_meta_from_payload(payload: dict[str, Any]) -> dict[str, Any]:
    """Ledger block metadata for AG-UI wire (camelCase, aligned with frontend parseStreamBlockWire)."""
    meta: dict[str, Any] = {}
    block_id = str(payload.get("block_id") or "").strip()
    block_kind = str(payload.get("block_kind") or "").strip()
    seq_raw = payload.get("seq")
    try:
        seq = int(seq_raw) if seq_raw is not None else None
    except (TypeError, ValueError):
        seq = None
    if block_id:
        meta["blockId"] = block_id
    if block_kind:
        meta["blockKind"] = block_kind
    if seq is not None and seq > 0:
        meta["seq"] = seq
    return meta


def _attach_block_meta(event: dict[str, Any], payload: dict[str, Any]) -> dict[str, Any]:
    event.update(_block_meta_from_payload(payload))
    return event


def _close_reasoning_block(state: AgUiEncoderState, block_id: str) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    if block_id in state.reasoning_message_started and block_id not in state.reasoning_ended:
        out.append({"type": REASONING_MESSAGE_END, "messageId": block_id})
    if block_id in state.reasoning_started and block_id not in state.reasoning_ended:
        out.append({"type": REASONING_END, "messageId": block_id})
        state.reasoning_ended.add(block_id)
    return out


def _tool_registry(state: AgUiEncoderState) -> dict[str, dict[str, Any]]:
    reg: dict[str, dict[str, Any]] = {}
    for tid in state.tool_started:
        reg[tid] = {
            "name": state.tool_names.get(tid, "tool"),
            "arguments": state.tool_args_accum.get(tid, ""),
            "result": state.tool_results.get(tid, ""),
        }
    return reg


def _emit_tool_args_if_needed(
    state: AgUiEncoderState,
    tid: str,
    out: list[dict[str, Any]],
    *,
    force: bool = False,
) -> None:
    accum = state.tool_args_accum.get(tid, "")
    if not accum:
        return
    if tid in state.tool_args_emitted:
        # ``force``: allow a remainder when earlier streaming only emitted a prefix
        # (e.g. path-only first chunk) and later chunk deltas were dropped.
        if not force:
            return
        already = int(state.tool_args_emitted_len.get(tid, 0) or 0)
        if already <= 0 or len(accum) <= already:
            return
        delta = accum[already:]
        if not delta:
            return
        out.append({"type": TOOL_CALL_ARGS, "toolCallId": tid, "delta": delta})
        state.tool_args_emitted_len[tid] = len(accum)
        return
    out.append({"type": TOOL_CALL_ARGS, "toolCallId": tid, "delta": accum})
    state.tool_args_emitted.add(tid)
    state.tool_args_emitted_len[tid] = len(accum)


def _append_tool_call_args(
    state: AgUiEncoderState,
    tid: str,
    delta: str,
    out: list[dict[str, Any]],
) -> None:
    if not delta:
        return
    out.append({"type": TOOL_CALL_ARGS, "toolCallId": tid, "delta": delta})
    state.tool_args_emitted.add(tid)
    # Track how much of accum has been streamed (accum is updated before emit).
    state.tool_args_emitted_len[tid] = len(state.tool_args_accum.get(tid, ""))


def _canonical_tool_args_json(text: str) -> str | None:
    raw = str(text or "").strip()
    if not raw.startswith("{"):
        return None
    try:
        obj = json.loads(raw)
    except json.JSONDecodeError:
        return None
    if not isinstance(obj, dict):
        return None
    return json.dumps(obj, ensure_ascii=False, separators=(",", ":"))


def _merge_tool_args_incoming(prev: str, incoming: str, *, snapshot: bool = False) -> tuple[str, str]:
    if not incoming:
        return prev or "", ""
    if not prev:
        return incoming, incoming
    if incoming.startswith(prev):
        return incoming, incoming[len(prev) :]
    if prev.startswith(incoming):
        return prev, ""
    # JSON object extension: prev is a complete JSON object {"path":"..."} and
    # incoming extends it with more keys {"path":"...","content":"..."}.
    # prev ends with '}' but incoming has ',' at that position, so startswith fails.
    # Detect by stripping prev's trailing '}' and checking if incoming continues with ','.
    if prev.endswith("}") and len(prev) > 1:
        prev_body = prev[:-1]  # e.g. {"path":"..."
        if incoming.startswith(prev_body + ","):
            return incoming, incoming[len(prev_body) :]
    if snapshot:
        inc_norm = _canonical_tool_args_json(incoming)
        if inc_norm:
            prev_norm = _canonical_tool_args_json(prev) or prev
            if inc_norm == prev_norm:
                return prev_norm, ""
            if inc_norm.startswith(prev_norm):
                return inc_norm, inc_norm[len(prev_norm) :]
            # JSON object extension for canonical forms too
            if prev_norm.endswith("}") and len(prev_norm) > 1:
                prev_body_n = prev_norm[:-1]
                if inc_norm.startswith(prev_body_n + ","):
                    return inc_norm, inc_norm[len(prev_body_n) :]
            return inc_norm, inc_norm
    return _tool_args_stream_delta(prev, incoming)


def _ensure_tool_started(
    state: AgUiEncoderState,
    tc: dict[str, Any],
    out: list[dict[str, Any]],
) -> str:
    tid = _tool_id_from_tc(tc)
    if not tid or tid in state.tool_started:
        return tid
    name = _tool_name_from_tc(tc)
    state.tool_started.add(tid)
    state.tool_names[tid] = name
    out.append({"type": TOOL_CALL_START, "toolCallId": tid, "toolCallName": name})
    return tid


def _ingest_tool_call_args(
    state: AgUiEncoderState,
    tc: dict[str, Any],
    out: list[dict[str, Any]],
    *,
    snapshot: bool = False,
) -> None:
    """Emit ``TOOL_CALL_START`` / ``TOOL_CALL_ARGS`` when args arrive after wire ``tool_call``."""
    tid = _ensure_tool_started(state, tc, out)
    if not tid:
        return
    args_in = _tool_args_text_from_tc(tc)
    if not args_in:
        return
    prev = state.tool_args_accum.get(tid, "")
    merged, delta = _merge_tool_args_incoming(prev, args_in, snapshot=snapshot)
    if merged == prev and tid in state.tool_args_emitted:
        return
    state.tool_args_accum[tid] = merged
    emit_args = delta or (merged if tid not in state.tool_args_emitted else "")
    if not emit_args:
        return
    _append_tool_call_args(state, tid, emit_args, out)
    # write_file_progress (phase: "args") is generated by the SSE normalizer's
    # _sanitize_write_tool_call using the full merged args, then transparently
    # converted to a CUSTOM event by evf_payload_to_agui_events' write_file_progress
    # branch. Do NOT duplicate it here -- the slimmed tool_call only has path,
    # so a progress event generated from it would have content_len=0 and no
    # content_delta, clobbering the correct SSE-layer event.


def _extract_tool_calls_from_payload(t: str, payload: dict[str, Any]) -> list[dict[str, Any]]:
    if t == "thread_state":
        raw = payload.get("toolCalls") or payload.get("tool_calls")
    elif t == "activity":
        raw = payload.get("tool_calls")
    elif t == "custom":
        chunk = payload.get("chunk")
        raw = chunk.get("tool_calls") if isinstance(chunk, dict) else None
        if raw is None:
            raw = payload.get("tool_calls")
    else:
        return []
    return [tc for tc in raw if isinstance(tc, dict)] if isinstance(raw, list) else []


def _ingest_delayed_tool_args(
    state: AgUiEncoderState,
    t: str,
    payload: dict[str, Any],
    out: list[dict[str, Any]],
) -> None:
    for tc in _extract_tool_calls_from_payload(t, payload):
        tid = _tool_id_from_tc(tc)
        if tid and tid in state.subagent_nested_tool_call_ids:
            continue
        _ingest_tool_call_args(state, tc, out, snapshot=True)


def _track_subagent_from_custom(payload: dict[str, Any], state: AgUiEncoderState) -> None:
    chunk = payload.get("chunk")
    if not isinstance(chunk, dict):
        return
    t = str(chunk.get("type") or "").strip()
    if t == "task_started":
        tid = str(chunk.get("task_id") or "").strip()
        if tid:
            state.subagent_root_task_ids.add(tid)
        return
    if t in {"task_completed", "task_failed", "task_timed_out", "task_cancelled"}:
        tid = str(chunk.get("task_id") or "").strip()
        if tid:
            state.subagent_root_task_ids.discard(tid)
        return
    if t != "task_running":
        return
    msg = chunk.get("message")
    if not isinstance(msg, dict):
        return
    content = str(msg.get("content") or "").strip()
    if content:
        state.subagent_content_fingerprints.add(content[:4000])
    raw_calls = msg.get("tool_calls")
    if isinstance(raw_calls, list):
        for tc in raw_calls:
            if not isinstance(tc, dict):
                continue
            cid = _tool_id_from_tc(tc)
            if cid:
                state.subagent_nested_tool_call_ids.add(cid)


def _is_subagent_leaked_text(state: AgUiEncoderState, piece: str) -> bool:
    p = str(piece or "").strip()
    if not p:
        return False
    for block in state.subagent_content_fingerprints:
        if p == block or block.startswith(p) or p.startswith(block):
            return True
    return False


def evf_payload_to_agui_events(
    payload: dict[str, Any],
    *,
    state: AgUiEncoderState,
    ledger: Any | None = None,
) -> list[dict[str, Any]]:
    t = str(payload.get("type") or "").strip()
    out: list[dict[str, Any]] = []
    out.extend(_ensure_run_started(state))

    if t == "delta":
        text = payload.get("text")
        if not isinstance(text, str) or not text:
            return out
        if _is_subagent_leaked_text(state, text):
            return out
        block_id = str(payload.get("block_id") or "").strip() or f"text-{len(state.text_started)}"
        block_kind = str(payload.get("block_kind") or "")
        if block_id not in state.text_started:
            state.text_started.add(block_id)
            if block_kind == "plan_text" and not state.planning_step_open:
                state.planning_step_open = True
                out.append({"type": STEP_STARTED, "stepName": "planning"})
            out.append(
                _attach_block_meta(
                    {"type": TEXT_MESSAGE_START, "messageId": block_id, "role": "assistant"},
                    payload,
                )
            )
        out.append(
            _attach_block_meta(
                {"type": TEXT_MESSAGE_CONTENT, "messageId": block_id, "delta": text},
                payload,
            )
        )
        return out

    if t == "block_close":
        block_id = str(payload.get("block_id") or "").strip()
        block_kind = str(payload.get("block_kind") or "")
        if block_kind in {"plan_text", "body_text"} and block_id and block_id not in state.text_ended:
            state.text_ended.add(block_id)
            out.append(
                _attach_block_meta({"type": TEXT_MESSAGE_END, "messageId": block_id}, payload)
            )
            if block_kind == "plan_text" and state.planning_step_open:
                state.planning_step_open = False
                out.append({"type": STEP_FINISHED, "stepName": "planning"})
        elif block_kind == "reasoning" and block_id:
            out.extend(_close_reasoning_block(state, block_id))
        return out

    if t == "reasoning":
        preview = payload.get("preview")
        if not isinstance(preview, str) or not preview:
            return out
        block_id = str(payload.get("block_id") or "").strip() or "reasoning-default"
        if block_id not in state.reasoning_started:
            state.reasoning_started.add(block_id)
            out.append(
                _attach_block_meta({"type": REASONING_START, "messageId": block_id}, payload)
            )
        if block_id not in state.reasoning_message_started:
            state.reasoning_message_started.add(block_id)
            out.append(
                _attach_block_meta(
                    {"type": REASONING_MESSAGE_START, "messageId": block_id, "role": "reasoning"},
                    payload,
                )
            )
        out.append(
            _attach_block_meta(
                {"type": REASONING_MESSAGE_CONTENT, "messageId": block_id, "delta": preview},
                payload,
            )
        )
        return out

    if t == "tool_call":
        tcs = payload.get("tool_calls")
        if isinstance(tcs, list):
            for tc in tcs:
                if not isinstance(tc, dict):
                    continue
                tid = _tool_id_from_tc(tc)
                if not tid or tid in state.subagent_nested_tool_call_ids:
                    continue
                if tid in state.tool_started:
                    _ingest_tool_call_args(state, tc, out)
                    continue
                name = _tool_name_from_tc(tc)
                state.tool_started.add(tid)
                state.tool_names[tid] = name
                out.append(
                    _attach_block_meta(
                        {"type": TOOL_CALL_START, "toolCallId": tid, "toolCallName": name},
                        payload,
                    )
                )
                _ingest_tool_call_args(state, tc, out)
        return out

    if t == "tool_call_chunk":
        chunk = payload.get("chunk")
        if not isinstance(chunk, dict):
            return out
        tid = _tool_id_from_tc(chunk)
        if tid and tid in state.subagent_nested_tool_call_ids:
            return out
        name = _tool_name_from_tc(chunk)
        if tid and tid not in state.tool_started:
            state.tool_started.add(tid)
            state.tool_names[tid] = name
            out.append(
                _attach_block_meta(
                    {"type": TOOL_CALL_START, "toolCallId": tid, "toolCallName": name},
                    payload,
                )
            )
        if not tid:
            return out
        args_in = _tool_args_text_from_tc(chunk)
        if args_in:
            prev = state.tool_args_accum.get(tid, "")
            # Write sanitize emits growing *complete* JSON snapshots (path+content).
            # Raw model chunks are incomplete JSON prefixes. ``snapshot=True`` handles
            # both: canonical replace when parseable, else prefix-delta merge.
            # The previous ``tid not in tool_args_emitted`` gate dropped all chunks
            # after the first, so write content only appeared late (tool end / leak).
            merged, delta = _merge_tool_args_incoming(prev, args_in, snapshot=True)
            if merged == prev and tid in state.tool_args_emitted:
                return out
            state.tool_args_accum[tid] = merged
            emit_args = delta or (merged if tid not in state.tool_args_emitted else "")
            if emit_args:
                _append_tool_call_args(state, tid, emit_args, out)
        return out

    if t == "tool_result":
        tid = str(payload.get("tool_call_id") or "").strip()
        if not tid:
            tool = payload.get("tool")
            if isinstance(tool, dict):
                tid = str(tool.get("tool_call_id") or "").strip()
        if tid and tid in state.subagent_nested_tool_call_ids:
            return out
        content = ""
        if isinstance(payload.get("content"), str):
            content = payload["content"]
        elif isinstance(payload.get("tool"), dict) and isinstance(payload["tool"].get("content"), str):
            content = payload["tool"]["content"]
        tool_obj = payload.get("tool") if isinstance(payload.get("tool"), dict) else {}
        status = str(payload.get("status") or tool_obj.get("status") or "ok").strip() or "ok"
        if status == "pending_approval":
            tid_thread = str(state.thread_id or "").strip()
            if tid_thread:
                try:
                    from app.gateway.streaming.post_stream_ui_normalize import mark_thread_tool_approval_pause

                    mark_thread_tool_approval_pause(tid_thread)
                except Exception:
                    pass
        truncated = bool(payload.get("truncated") or tool_obj.get("truncated"))
        content_bytes = payload.get("content_bytes") or tool_obj.get("content_bytes")
        if tid:
            state.tool_results[tid] = content
            _emit_tool_args_if_needed(state, tid, out, force=True)
            if tid not in state.tool_ended:
                state.tool_ended.add(tid)
                out.append({"type": TOOL_CALL_END, "toolCallId": tid})
            result_evt: dict[str, Any] = {
                "type": TOOL_CALL_RESULT,
                "messageId": f"{tid}-result",
                "toolCallId": tid,
                "content": content,
                "role": "tool",
                "status": status,
            }
            if truncated:
                result_evt["truncated"] = True
                result_evt["output_truncated"] = True
            if content_bytes is not None:
                result_evt["content_bytes"] = content_bytes
                result_evt["output_bytes"] = content_bytes
            out.append(result_evt)
        return out

    if t == "activity":
        kind = str(payload.get("kind") or "").strip()
        # 内部中间件执行阶段（load_mission_state_ms 等）不应暴露给前端
        if kind == "middleware":
            return out
        detail = str(payload.get("detail") or payload.get("kind") or "").strip()
        if kind == "tool_approval":
            tid = str(state.thread_id or "").strip()
            if tid:
                try:
                    from app.gateway.streaming.post_stream_ui_normalize import mark_thread_tool_approval_pause

                    mark_thread_tool_approval_pause(tid)
                except Exception:
                    pass
        out.append(
            {
                "type": ACTIVITY_SNAPSHOT,
                "messageId": state.activity_message_id,
                "activityType": "system",
                "content": {
                    "kind": kind,
                    "detail": detail,
                    "tool_name": payload.get("tool_name"),
                },
            }
        )
        return out

    if t == "model_fallback_switch":
        out.append(
            {
                "type": CUSTOM,
                "name": "model_fallback_switch",
                "value": {
                    "model_name": str(payload.get("model_name") or "").strip(),
                    "from_model": str(payload.get("from_model") or "").strip(),
                    "text": str(payload.get("text") or "").strip(),
                },
            }
        )
        return out

    if t == "pending_inject_consumed":
        ids = payload.get("message_ids") or payload.get("messageIds") or []
        if not isinstance(ids, list):
            ids = []
        out.append(
            {
                "type": CUSTOM,
                "name": "pending_inject_consumed",
                "value": {
                    "message_ids": [str(x).strip() for x in ids if str(x or "").strip()],
                    "messageIds": [str(x).strip() for x in ids if str(x or "").strip()],
                    "consumed_by_run_id": payload.get("consumed_by_run_id")
                    or payload.get("consumedByRunId"),
                    "session_key": payload.get("session_key") or payload.get("sessionKey"),
                },
            }
        )
        return out

    if t == "write_file_progress":
        value: dict[str, Any] = {
            "tool_call_id": payload.get("tool_call_id"),
            "tool_name": payload.get("tool_name"),
            "path": payload.get("path"),
            "phase": payload.get("phase") or "args",
            "lines_added": payload.get("lines_added"),
            "lines_removed": payload.get("lines_removed"),
        }
        if payload.get("content_len") is not None:
            value["content_len"] = payload.get("content_len")
        if payload.get("bytes_total") is not None:
            value["bytes_total"] = payload.get("bytes_total")
        if payload.get("bytes_written") is not None:
            value["bytes_written"] = payload.get("bytes_written")
        if isinstance(payload.get("message"), str) and payload["message"]:
            value["message"] = payload["message"]
        if isinstance(payload.get("content_delta"), str) and payload["content_delta"]:
            value["content_delta"] = payload["content_delta"]
        if isinstance(payload.get("old_string_delta"), str) and payload["old_string_delta"]:
            value["old_string_delta"] = payload["old_string_delta"]
        if isinstance(payload.get("new_string_delta"), str) and payload["new_string_delta"]:
            value["new_string_delta"] = payload["new_string_delta"]
        if isinstance(payload.get("content"), str) and payload["content"]:
            value["content"] = payload["content"]
        if isinstance(payload.get("old_string"), str) and payload["old_string"]:
            value["old_string"] = payload["old_string"]
        if isinstance(payload.get("new_string"), str) and payload["new_string"]:
            value["new_string"] = payload["new_string"]
        out.append(
            {
                "type": CUSTOM,
                "name": "write_file_progress",
                "value": value,
            }
        )
        return out

    if t == "right_stage":
        out.append(
            {
                "type": CUSTOM,
                "name": "right_stage",
                "value": {
                    "action": payload.get("action"),
                    "surface": payload.get("surface"),
                },
            }
        )
        return out

    if t == "right_stage_stream":
        out.append(
            {
                "type": CUSTOM,
                "name": "right_stage_stream",
                "value": {
                    "action": payload.get("action"),
                    "streamId": payload.get("streamId") or payload.get("stream_id"),
                    "text": payload.get("text"),
                    "newline": payload.get("newline", True),
                    "level": payload.get("level"),
                    "format": payload.get("format"),
                    "path": payload.get("path"),
                    "title": payload.get("title"),
                },
            }
        )
        return out

    if t in {"error", "aborted"}:
        msg = str(payload.get("error") or payload.get("reason") or t)
        out.append({"type": RUN_ERROR, "message": msg, "code": t.upper()})
        return out

    if t == "run_end":
        if state.run_finished:
            return out
        state.run_finished = True
        # Forward final usage as CUSTOM(name='usage') BEFORE RUN_FINISHED so the
        # browser can update token totals even when intermediate usage frames
        # were deduplicated upstream (UiStreamNormalizer.last_usage_emit_sig).
        run_end_usage = payload.get("usage")
        if isinstance(run_end_usage, dict) and run_end_usage:
            out.append(
                {
                    "type": CUSTOM,
                    "name": "usage",
                    "value": {"type": "usage", "usage": run_end_usage},
                }
            )
        # Close any open reasoning blocks
        for bid in list(state.reasoning_message_started):
            if bid not in state.reasoning_ended:
                out.extend(_close_reasoning_block(state, bid))
        # Close open text blocks
        for bid in list(state.text_started):
            if bid not in state.text_ended:
                state.text_ended.add(bid)
                out.append({"type": TEXT_MESSAGE_END, "messageId": bid})
        if state.planning_step_open:
            state.planning_step_open = False
            out.append({"type": STEP_FINISHED, "stepName": "planning"})
        out.append({"type": RUN_FINISHED, "threadId": state.thread_id, "runId": state.run_id})
        messages: list[dict[str, Any]] = []
        if ledger is not None and hasattr(ledger, "snapshot_agui_messages"):
            messages = ledger.snapshot_agui_messages(_tool_registry(state))
        if messages:
            out.append({"type": MESSAGES_SNAPSHOT, "messages": messages})
        # Preserve display_segments for history compat
        segs = payload.get("display_segments")
        if isinstance(segs, list) and segs:
            out.append({"type": CUSTOM, "name": "display_segments", "value": segs})
        return out

    if t in {"thread_state", "usage", "custom", "_debug_upstream"}:
        if t == "custom":
            _track_subagent_from_custom(payload, state)
            chunk = payload.get("chunk")
            chunk_type = str(chunk.get("type") or "").strip() if isinstance(chunk, dict) else ""
            if chunk_type not in {"task_started", "task_running", "task_completed", "task_failed", "task_timed_out", "task_cancelled"}:
                _ingest_delayed_tool_args(state, t, payload, out)
        elif t == "thread_state":
            _ingest_delayed_tool_args(state, t, payload, out)
        out.append({"type": CUSTOM, "name": t, "value": payload})
        return out

    return out


def evf_payloads_to_agui_wire(
    payloads: list[dict[str, Any]],
    *,
    state: AgUiEncoderState,
    ledger: Any | None = None,
) -> tuple[list[bytes], bool]:
    """Map semantic EVF payloads → AG-UI SSE wire (no encode/decode round-trip)."""
    out: list[bytes] = []
    run_end = False
    for payload in payloads:
        if str(payload.get("type") or "").strip() == "run_end":
            run_end = True
        for ev in evf_payload_to_agui_events(payload, state=state, ledger=ledger):
            out.append(encode_agui_event(ev))
    return out, run_end


def convert_evf_frames_to_agui(
    frames: list[bytes] | list[dict[str, Any]],
    *,
    state: AgUiEncoderState,
    ledger: Any | None = None,
) -> list[bytes]:
    payloads: list[dict[str, Any]] = []
    for frame in frames:
        if isinstance(frame, dict):
            payloads.append(frame)
            continue
        payload = decode_evf_payload(frame)
        if payload:
            payloads.append(payload)
    wire, _ = evf_payloads_to_agui_wire(payloads, state=state, ledger=ledger)
    return wire


class AgUiStreamNormalizer:
    """LangGraph SSE → AG-UI wire via in-memory semantic payloads (no EVF encode hop)."""

    def __init__(self, **kwargs: Any) -> None:
        rid = str(kwargs.pop("run_id", None) or "").strip() or f"run-{uuid.uuid4().hex[:12]}"
        tid = str(kwargs.get("thread_id") or "").strip() or "thread"
        self._inner = UiStreamNormalizer(**kwargs)
        self._state = AgUiEncoderState(thread_id=tid, run_id=rid)
        self._run_end_emitted = False

    def set_run_id(self, run_id: str) -> None:
        """Adopt LangGraph ``metadata`` run id before ``RUN_STARTED`` is emitted."""
        rid = str(run_id or "").strip()
        if rid:
            self._state.run_id = rid

    @property
    def inner(self) -> UiStreamNormalizer:
        return self._inner

    def feed_evf_payloads(self, event_name: str, data: Any) -> list[dict[str, Any]]:
        return self._inner.feed_evf_payloads(event_name, data)

    def finish_evf_payloads(self) -> list[dict[str, Any]]:
        return self._inner.finish_evf_payloads()

    def feed_frame(self, event_name: str, data: Any) -> list[bytes]:
        payloads = self._inner.feed_evf_payloads(event_name, data)
        out, run_end = evf_payloads_to_agui_wire(
            payloads,
            state=self._state,
            ledger=self._inner.block_ledger,
        )
        if run_end:
            self._run_end_emitted = True
        return out

    def finish(self) -> list[bytes]:
        payloads = self._inner.finish_evf_payloads()
        out, run_end = evf_payloads_to_agui_wire(
            payloads,
            state=self._state,
            ledger=self._inner.block_ledger,
        )
        if run_end:
            self._run_end_emitted = True
        return out

    def bootstrap_wire_bytes(self) -> list[bytes]:
        """Immediate RUN_STARTED + activity frame — sent on SSE headers before upstream tokens."""
        if self._state.run_started:
            return []
        out: list[bytes] = []
        for ev in _ensure_run_started(self._state):
            out.append(encode_agui_event(ev))
        out.append(
            encode_agui_event(
                {
                    "type": ACTIVITY_SNAPSHOT,
                    "messageId": self._state.activity_message_id,
                    "activityType": "agent_status",
                    "content": {"kind": "pre_model", "detail": "准备中…"},
                }
            )
        )
        return out
