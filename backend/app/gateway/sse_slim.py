"""Slim LangGraph SSE frames before they reach the browser.

The upstream stream often includes large LangGraph metadata tuples, empty
``response_metadata`` blobs, and full checkpoint fields the EvoPanel client
never reads. Trimming at the gateway proxy reduces parse work on the frontend
and avoids redundant ``values`` snapshots that worsen event ordering noise.
"""

from __future__ import annotations

import json
import os
from collections.abc import AsyncIterator
from typing import Any

_sse_slim_flag = (os.getenv("EVOFLOW_SSE_SLIM", "1") or "").strip().lower()
SSE_SLIM_ENABLED = _sse_slim_flag not in {"0", "false", "no", "off"}

_USAGE_KEYS = (
    "input_tokens",
    "output_tokens",
    "total_tokens",
    "prompt_tokens",
    "completion_tokens",
    "cache_read_input_tokens",
    "cache_creation_input_tokens",
    "cache_read_tokens",
    "cache_creation_tokens",
    "cache_miss_tokens",
)

_USAGE_DETAIL_KEYS = ("input_token_details", "prompt_tokens_details", "input_tokens_details")

_USAGE_DETAIL_CACHE_READ_KEYS = ("cached_tokens", "cache_read")

_USAGE_DETAIL_CACHE_CREATION_KEYS = (
    "cache_creation_input_tokens",
    "cache_creation_tokens",
    "cache_creation",
)

_VALUES_ROOT_KEYS = ("messages", "todos", "title", "artifacts")

_MESSAGE_SCALAR_KEYS = ("type", "role", "id", "name", "content", "tool_call_id", "status")

_TOOL_CALL_KEYS = ("name", "id", "tool_call_id", "type", "args", "input", "parameters", "kwargs", "function")

_METADATA_KEYS = ("run_id", "attempt")


def _slim_usage(obj: Any) -> dict[str, Any] | None:
    if not isinstance(obj, dict):
        return None
    out = {k: obj[k] for k in _USAGE_KEYS if k in obj}
    for details_key in _USAGE_DETAIL_KEYS:
        details = obj.get(details_key)
        if isinstance(details, dict):
            slim_details = {
                k: details[k]
                for k in (*_USAGE_DETAIL_CACHE_READ_KEYS, *_USAGE_DETAIL_CACHE_CREATION_KEYS)
                if k in details
            }
            if slim_details:
                out[details_key] = slim_details
    return out or None


def _slim_response_metadata(rm: Any) -> dict[str, Any] | None:
    if not isinstance(rm, dict):
        return None
    out: dict[str, Any] = {}
    for key in ("usage", "token_usage"):
        usage = _slim_usage(rm.get(key))
        if usage:
            out[key] = usage
    for k in _METADATA_KEYS:
        if k in rm and rm[k] is not None:
            out[k] = rm[k]
    return out or None


def _slim_additional_kwargs(ak: Any) -> dict[str, Any]:
    if not isinstance(ak, dict):
        return {}
    rc = ak.get("reasoning_content")
    if isinstance(rc, str) and rc.strip():
        return {"reasoning_content": rc}
    return {}


def _slim_tool_call(tc: Any) -> dict[str, Any]:
    if not isinstance(tc, dict):
        return {}
    out: dict[str, Any] = {}
    for k in _TOOL_CALL_KEYS:
        if k in tc and tc[k] is not None:
            out[k] = tc[k]
    return out


def _slim_message(msg: Any) -> Any:
    if not isinstance(msg, dict):
        return msg
    out: dict[str, Any] = {}
    for k in _MESSAGE_SCALAR_KEYS:
        if k in msg and msg[k] is not None:
            out[k] = msg[k]
    ak = _slim_additional_kwargs(msg.get("additional_kwargs"))
    if ak:
        out["additional_kwargs"] = ak
    um = _slim_usage(msg.get("usage_metadata"))
    if um:
        out["usage_metadata"] = um
    rm = _slim_response_metadata(msg.get("response_metadata"))
    if rm:
        out["response_metadata"] = rm
    tcs = msg.get("tool_calls")
    if isinstance(tcs, list) and tcs:
        slim_tcs = [_slim_tool_call(tc) for tc in tcs if isinstance(tc, dict) and _slim_tool_call(tc)]
        if slim_tcs:
            out["tool_calls"] = slim_tcs
    return out


def _message_has_signal(msg: dict[str, Any]) -> bool:
    content = msg.get("content")
    if isinstance(content, str) and content.strip():
        return True
    if isinstance(content, list) and content:
        return True
    ak = msg.get("additional_kwargs")
    if isinstance(ak, dict) and isinstance(ak.get("reasoning_content"), str) and ak["reasoning_content"].strip():
        return True
    tcs = msg.get("tool_calls")
    if isinstance(tcs, list) and tcs:
        return True
    if msg.get("tool_call_id"):
        return True
    if _slim_usage(msg.get("usage_metadata")):
        return True
    rm = msg.get("response_metadata")
    if isinstance(rm, dict) and (_slim_usage(rm.get("usage")) or _slim_usage(rm.get("token_usage"))):
        return True
    return False


def slim_messages_payload(data: Any) -> Any:
    """Drop LangGraph metadata tuple and unused chunk fields."""
    if isinstance(data, list):
        if len(data) >= 2 and isinstance(data[0], dict) and (data[0].get("type") or data[0].get("role")):
            slim = _slim_message(data[0])
            return slim if isinstance(slim, dict) and _message_has_signal(slim) else None
        if len(data) == 2 and isinstance(data[0], str) and isinstance(data[1], dict):
            slim = _slim_message(data[1])
            return slim if isinstance(slim, dict) and _message_has_signal(slim) else None
        out = [_slim_message(x) for x in data if not isinstance(x, dict) or _message_has_signal(_slim_message(x))]
        return out or None
    if isinstance(data, dict):
        slim = _slim_message(data)
        if isinstance(slim, dict) and _message_has_signal(slim):
            return slim
        return None
    return data


def slim_values_payload(data: Any) -> Any:
    if not isinstance(data, dict):
        return data
    wrapped = isinstance(data.get("values"), dict)
    raw = data["values"] if wrapped else data
    if not isinstance(raw, dict):
        return data
    inner: dict[str, Any] = {}
    for k in _VALUES_ROOT_KEYS:
        if k not in raw:
            continue
        if k == "messages":
            msgs = raw.get("messages")
            if isinstance(msgs, list):
                inner["messages"] = [_slim_message(m) for m in msgs if isinstance(m, dict)]
            else:
                inner["messages"] = []
        else:
            inner[k] = raw[k]
    return {"values": inner} if wrapped else inner


def slim_end_payload(data: Any) -> Any:
    if not isinstance(data, dict):
        return data
    for k in ("usage", "usage_metadata"):
        um = _slim_usage(data.get(k))
        if um:
            return {k: um}
    um = _slim_usage(data)
    return um if um else data


def slim_metadata_payload(data: Any) -> Any:
    if not isinstance(data, dict):
        return data
    out = {k: data[k] for k in _METADATA_KEYS if k in data}
    return out or data


def slim_custom_payload(data: Any) -> Any:
    if isinstance(data, list) and len(data) >= 2 and isinstance(data[1], dict):
        return data[1]
    if isinstance(data, dict) and isinstance(data.get("chunk"), dict):
        return data["chunk"]
    return data


def slim_sse_event_data(event_name: str, data: Any) -> Any | None:
    """Return slimmed JSON payload, or None to drop the frame."""
    ev = (event_name or "").strip().lower()
    if ev in {"messages", "messages-tuple", "message"}:
        return slim_messages_payload(data)
    if ev == "values":
        return slim_values_payload(data)
    if ev == "end":
        return slim_end_payload(data)
    if ev == "metadata":
        return slim_metadata_payload(data)
    if ev == "custom":
        return slim_custom_payload(data)
    return data


def _encode_sse_frame(event_name: str, data_json: Any) -> bytes:
    payload = json.dumps(data_json, ensure_ascii=False, separators=(",", ":"))
    lines = []
    if event_name:
        lines.append(f"event: {event_name}")
    lines.append(f"data: {payload}")
    return ("\n".join(lines) + "\n\n").encode("utf-8")


def _parse_sse_frame(frame: str) -> tuple[str, str]:
    event_name = ""
    data_raw = ""
    for ln in frame.split("\n"):
        ln = ln.strip("\r")
        if not ln:
            continue
        if ln.startswith("event:"):
            event_name = ln[6:].strip()
        elif ln.startswith("data:"):
            data_raw += ln[5:].strip()
    return event_name, data_raw


def _values_signature(data_json: Any) -> str:
    try:
        return json.dumps(data_json, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    except Exception:
        return ""


class SseSlimmer:
    """Stateful SSE frame processor (values dedupe + field trimming)."""

    def __init__(self, *, dedupe_values: bool = True) -> None:
        self.dedupe_values = dedupe_values
        self._last_values_sig = ""
        self.frames_in = 0
        self.frames_out = 0
        self.bytes_in = 0
        self.bytes_out = 0

    def process_frame(self, frame: str) -> bytes | None:
        self.frames_in += 1
        self.bytes_in += len(frame.encode("utf-8", errors="ignore"))
        event_name, data_raw = _parse_sse_frame(frame)
        if not data_raw or data_raw in {"{}", "[DONE]"}:
            out = (frame + "\n\n").encode("utf-8") if not frame.endswith("\n\n") else frame.encode("utf-8")
            self.frames_out += 1
            self.bytes_out += len(out)
            return out
        try:
            data_json = json.loads(data_raw)
        except json.JSONDecodeError:
            out = (frame + "\n\n").encode("utf-8") if not frame.endswith("\n\n") else frame.encode("utf-8")
            self.frames_out += 1
            self.bytes_out += len(out)
            return out

        inferred = event_name
        if not inferred:
            if isinstance(data_json, list) and data_json and isinstance(data_json[0], str):
                inferred = data_json[0]
            elif isinstance(data_json, dict):
                inferred = str(data_json.get("event") or "")

        slimmed = slim_sse_event_data(inferred, data_json)
        if slimmed is None:
            return None

        if self.dedupe_values and inferred == "values":
            sig = _values_signature(slimmed)
            if sig and sig == self._last_values_sig:
                return None
            self._last_values_sig = sig

        out = _encode_sse_frame(event_name or inferred, slimmed)
        self.frames_out += 1
        self.bytes_out += len(out)
        return out


async def slim_sse_byte_stream(
    upstream: AsyncIterator[bytes],
    *,
    dedupe_values: bool = True,
) -> AsyncIterator[bytes]:
    """Parse upstream SSE bytes, slim complete frames, re-emit."""
    slim = SseSlimmer(dedupe_values=dedupe_values)
    buffer = ""

    def _norm_buf(text: str) -> str:
        return (text or "").replace("\r\n", "\n")

    async for chunk in upstream:
        if not chunk:
            continue
        if isinstance(chunk, (bytes, bytearray)):
            buffer = _norm_buf(buffer + bytes(chunk).decode("utf-8", errors="ignore"))
        else:
            buffer = _norm_buf(buffer + str(chunk))
        while "\n\n" in buffer:
            frame, buffer = buffer.split("\n\n", 1)
            if not frame.strip():
                continue
            out = slim.process_frame(frame)
            if out:
                yield out
    buffer = _norm_buf(buffer).strip()
    if buffer:
        out = slim.process_frame(buffer)
        if out:
            yield out
