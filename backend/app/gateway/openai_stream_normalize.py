"""LangGraph SSE → standard OpenAI ``chat.completion.chunk`` (+ ``event: meta`` side channel)."""

from __future__ import annotations

import json
from typing import Any

from app.gateway.openai_stream_encode import (
    decode_evf_payload,
    encode_meta_event,
    encode_openai_chunk,
    encode_openai_done,
    new_completion_id,
)
from app.gateway.sse_ui_normalize import UiStreamNormalizer


def _tool_index_for_id(tool_index_by_id: dict[str, int], tool_call_id: str) -> int:
    tid = str(tool_call_id or "").strip()
    if not tid:
        return 0
    if tid not in tool_index_by_id:
        tool_index_by_id[tid] = len(tool_index_by_id)
    return tool_index_by_id[tid]


def _arguments_text(raw: Any) -> str:
    if raw is None:
        return ""
    if isinstance(raw, str):
        return raw
    if isinstance(raw, (dict, list)):
        return json.dumps(raw, ensure_ascii=False, separators=(",", ":"))
    return str(raw)


def _tool_args_stream_delta(accum: str, incoming: str) -> tuple[str, str]:
    """Return (merged_full, delta_piece) for OpenAI ``tool_calls[].function.arguments``."""
    r = incoming or ""
    if not r:
        return accum or "", ""
    prev = accum or ""
    if r.startswith(prev):
        return r, r[len(prev) :]
    if prev.startswith(r):
        return prev, ""
    max_check = min(len(prev), len(r), 800)
    for n in range(max_check, 7, -1):
        if prev[-n:] == r[:n]:
            merged = prev + r[n:]
            return merged, r[n:]
    return prev + r, r


def evf_payload_to_openai_frames(
    payload: dict[str, Any],
    *,
    completion_id: str,
    tool_index_by_id: dict[str, int],
    tool_args_accum: dict[str, str] | None = None,
) -> list[bytes]:
    t = str(payload.get("type") or "").strip()
    if t == "delta":
        text = payload.get("text")
        if isinstance(text, str) and text:
            delta: dict[str, Any] = {"content": text}
            phase = payload.get("content_phase")
            if phase in {"post_tools", "pre_tools"}:
                delta["content_phase"] = phase
            return [encode_openai_chunk(completion_id, delta)]
        return []
    if t == "reasoning":
        preview = payload.get("preview")
        if isinstance(preview, str) and preview:
            return [encode_openai_chunk(completion_id, {"reasoning_content": preview})]
        return []
    if t == "tool_call_chunk":
        chunk = payload.get("chunk")
        if isinstance(chunk, dict):
            return _tool_call_dict_to_openai(chunk, completion_id, tool_index_by_id, include_id=True)
        return []
    if t == "tool_call":
        out: list[bytes] = []
        tcs = payload.get("tool_calls")
        if isinstance(tcs, list):
            for tc in tcs:
                if isinstance(tc, dict):
                    out.extend(_tool_call_dict_to_openai(tc, completion_id, tool_index_by_id, include_id=True))
        return out
    if t == "block_close":
        return []
    if t in {
        "thread_state",
        "activity",
        "usage",
        "custom",
        "write_file_progress",
        "tool_result",
        "run_end",
        "error",
        "aborted",
        "model_fallback_switch",
        "_debug_upstream",
    }:
        return [encode_meta_event(payload)]
    return []


def _tool_call_dict_to_openai(
    tc: dict[str, Any],
    completion_id: str,
    tool_index_by_id: dict[str, int],
    *,
    include_id: bool,
    tool_args_accum: dict[str, str] | None = None,
) -> list[bytes]:
    tid = str(tc.get("id") or tc.get("tool_call_id") or "").strip()
    fn = tc.get("function") if isinstance(tc.get("function"), dict) else {}
    name = str(tc.get("name") or tc.get("tool_name") or fn.get("name") or "").strip()
    args_in = _arguments_text(fn.get("arguments") if fn else tc.get("arguments"))
    idx = _tool_index_for_id(tool_index_by_id, tid or f"anon:{name}:{len(args_in)}")
    args_key = tid or f"idx:{idx}"
    args = args_in
    if tool_args_accum is not None and args_in:
        merged, delta = _tool_args_stream_delta(tool_args_accum.get(args_key, ""), args_in)
        tool_args_accum[args_key] = merged
        args = delta
    delta_tc: dict[str, Any] = {"index": idx, "type": "function", "function": {}}
    if include_id and tid:
        delta_tc["id"] = tid
    fn_delta: dict[str, Any] = {}
    if name:
        fn_delta["name"] = name
    if args:
        fn_delta["arguments"] = args
    if fn_delta:
        delta_tc["function"] = fn_delta
    if not fn_delta and not tid:
        return []
    return [encode_openai_chunk(completion_id, {"tool_calls": [delta_tc]})]


def convert_evf_frames_to_openai(
    frames: list[bytes],
    *,
    completion_id: str,
    tool_index_by_id: dict[str, int],
    tool_args_accum: dict[str, str] | None = None,
) -> list[bytes]:
    out: list[bytes] = []
    for frame in frames:
        payload = decode_evf_payload(frame)
        if not payload:
            continue
        out.extend(
            evf_payload_to_openai_frames(
                payload,
                completion_id=completion_id,
                tool_index_by_id=tool_index_by_id,
                tool_args_accum=tool_args_accum,
            )
        )
    return out


class OpenAiStreamNormalizer:
    """Reuse ``UiStreamNormalizer`` anchoring; emit OpenAI wire format."""

    def __init__(self, **kwargs: Any) -> None:
        self._inner = UiStreamNormalizer(**kwargs)
        self._completion_id = new_completion_id()
        self._tool_index_by_id: dict[str, int] = {}
        self._tool_args_accum: dict[str, str] = {}
        self._run_end_emitted = False

    @property
    def inner(self) -> UiStreamNormalizer:
        return self._inner

    def feed_frame(self, event_name: str, data: Any) -> list[bytes]:
        evf_frames = self._inner.feed_frame(event_name, data)
        out = convert_evf_frames_to_openai(
            evf_frames,
            completion_id=self._completion_id,
            tool_index_by_id=self._tool_index_by_id,
            tool_args_accum=self._tool_args_accum,
        )
        for f in evf_frames:
            payload = decode_evf_payload(f)
            if payload and payload.get("type") == "run_end":
                self._run_end_emitted = True
        return out

    def finish(self) -> list[bytes]:
        evf_frames = self._inner.finish()
        out = convert_evf_frames_to_openai(
            evf_frames,
            completion_id=self._completion_id,
            tool_index_by_id=self._tool_index_by_id,
            tool_args_accum=self._tool_args_accum,
        )
        for f in evf_frames:
            payload = decode_evf_payload(f)
            if payload and payload.get("type") == "run_end":
                self._run_end_emitted = True
        if not self._run_end_emitted:
            out.append(encode_openai_chunk(self._completion_id, {}, finish_reason="stop"))
        out.append(encode_openai_done())
        return out
