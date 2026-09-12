"""Transform LangGraph POST ``runs/stream`` SSE into UI stream at the ASGI layer."""

from __future__ import annotations

import asyncio
import json
import logging
import os
import time
import traceback
from collections.abc import AsyncIterator
from typing import Any

from app.gateway.agui_stream_normalizer import AgUiStreamNormalizer, convert_evf_frames_to_agui, evf_payloads_to_agui_wire
from app.gateway.openai_stream_normalize import OpenAiStreamNormalizer, convert_evf_frames_to_openai
from app.gateway.routers.langgraph_proxy import (
    UI_SSE_ENABLED,
    _extract_evf_prior_assistant_from_stream_body,
    _extract_use_claude_code_from_stream_body,
    _extract_user_text_from_stream_body,
)
from app.gateway.sse_ui_normalize import UiStreamNormalizer, _normalize_sse_buffer
from app.gateway.streaming.session_stream_inject import (
    _TAIL_IDLE_MAX_S,
    _TAIL_PHASE_MAX_S,
    _has_pending_collab_subtasks_async,
    _inject_queue_has_pending,
    drain_inject_evf_frames,
    drain_inject_evf_payloads,
)

logger = logging.getLogger(__name__)

# Middle layer may inject/expand SSE frames; keeping upstream Content-Length
# makes uvicorn raise "Response content longer than Content-Length".
_RESPONSE_HOP_HEADERS = frozenset({b"content-length", b"transfer-encoding"})

# Hot-path normalize is sync CPU; only oversized frames go to a worker thread
# so a giant tool payload cannot stall the event loop for too long.
_FEED_TO_THREAD_MIN_BYTES = 256 * 1024


def _strip_fixed_length_response_headers(
    headers: list[tuple[bytes, bytes]],
) -> list[tuple[bytes, bytes]]:
    out: list[tuple[bytes, bytes]] = []
    for key, value in headers:
        if key.lower() in _RESPONSE_HOP_HEADERS:
            continue
        out.append((key, value))
    return out


_TAIL_POLL_S = max(0.25, min(5.0, float(os.getenv("EVOFLOW_STREAM_INJECT_TAIL_POLL_S", "0.75") or "0.75")))
_DEFER_CACHE: dict[str, tuple[float, bool]] = {}
_DEFER_CACHE_TTL_S = max(0.5, min(5.0, float(os.getenv("EVOFLOW_STREAM_DEFER_CACHE_S", "1.5") or "1.5")))
_DEFER_COMPLETION_POLL_MIN_S = max(
    0.25, min(2.0, float(os.getenv("EVOFLOW_STREAM_DEFER_POLL_MIN_S", "0.5") or "0.5"))
)
_DEFER_COMPLETION_POLL_MAX_S = max(
    1.0, min(5.0, float(os.getenv("EVOFLOW_STREAM_DEFER_POLL_MAX_S", "2.0") or "2.0"))
)


def invalidate_defer_run_finished_cache(thread_id: str | None = None) -> None:
    """Drop cached defer probe after inject / tool-approval state changes."""
    if thread_id:
        _DEFER_CACHE.pop(str(thread_id or "").strip(), None)
    else:
        _DEFER_CACHE.clear()


def mark_thread_tool_approval_pause(thread_id: str) -> None:
    """Mark thread as paused for tool approval (SSE defer without DB on every poll)."""
    from evoflow.agents.tool_approval_pause_registry import mark_tool_approval_pause

    mark_tool_approval_pause(thread_id)
    invalidate_defer_run_finished_cache(thread_id)


def clear_thread_tool_approval_pause(thread_id: str) -> None:
    from evoflow.agents.tool_approval_pause_registry import clear_tool_approval_pause

    clear_tool_approval_pause(thread_id)
    invalidate_defer_run_finished_cache(thread_id)


def thread_in_tool_approval_pause(thread_id: str) -> bool:
    from evoflow.agents.tool_approval_pause_registry import thread_in_tool_approval_pause as _in_pause

    return _in_pause(thread_id)


def defer_completion_poll_interval(stable_timeouts: int) -> float:
    """Adaptive poll spacing while waiting for tool-approval / collab inject resume."""
    n = max(0, int(stable_timeouts))
    step = max(0.1, (_DEFER_COMPLETION_POLL_MAX_S - _DEFER_COMPLETION_POLL_MIN_S) / 6.0)
    return min(_DEFER_COMPLETION_POLL_MAX_S, _DEFER_COMPLETION_POLL_MIN_S + n * step)


def _should_defer_run_finished(thread_id: str) -> bool:
    """Sync defer probe — safe on worker threads during SSE transform."""
    tid = str(thread_id or "").strip()
    if not tid:
        return False
    if thread_in_tool_approval_pause(tid):
        return True
    try:
        from app.gateway.streaming.stream_middle_layer import get_active_middle_layer

        layer = get_active_middle_layer(tid)
        if layer is not None and layer.should_hold_stream_open():
            return True
    except Exception:
        logger.debug("defer run_finished middle layer check failed thread=%s", tid, exc_info=True)
    try:
        from evoflow.agents.tool_approval_service import list_pending_approvals

        if list_pending_approvals(tid):
            return True
    except Exception:
        logger.debug("defer run_finished pending approvals check failed thread=%s", tid, exc_info=True)
    try:
        from app.gateway.streaming.session_stream_inject import _has_pending_collab_subtasks

        if _has_pending_collab_subtasks(tid):
            return True
    except Exception:
        logger.debug("defer run_finished collab check failed thread=%s", tid, exc_info=True)
    return False


async def _should_defer_run_finished_async(thread_id: str, *, force_refresh: bool = False) -> bool:
    """True when tool-approval pause or collab inject tail may still produce frames."""
    tid = str(thread_id or "").strip()
    if not tid:
        return False
    if _inject_queue_has_pending(tid):
        return True
    if thread_in_tool_approval_pause(tid):
        _DEFER_CACHE[tid] = (time.monotonic(), True)
        return True
    try:
        from app.gateway.streaming.stream_middle_layer import get_active_middle_layer

        layer = get_active_middle_layer(tid)
        if layer is not None and layer.should_hold_stream_open():
            _DEFER_CACHE[tid] = (time.monotonic(), True)
            return True
    except Exception:
        logger.debug("defer run_finished middle layer check failed thread=%s", tid, exc_info=True)
    if not force_refresh:
        cached = _DEFER_CACHE.get(tid)
        if cached is not None and (time.monotonic() - cached[0]) < _DEFER_CACHE_TTL_S:
            return cached[1]
    result = False
    try:
        from app.gateway.db_async import run_db
        from evoflow.agents.tool_approval_service import thread_has_pending_approvals

        if await run_db(thread_has_pending_approvals, tid):
            result = True
    except Exception:
        logger.debug("defer run_finished pending approvals check failed thread=%s", tid, exc_info=True)
    if not result:
        try:
            result = await _has_pending_collab_subtasks_async(tid)
        except Exception:
            logger.debug("defer run_finished collab check failed thread=%s", tid, exc_info=True)
    _DEFER_CACHE[tid] = (time.monotonic(), result)
    return result


def _resolve_normalizer_prior_fields(thread_id: str, body: bytes) -> dict[str, str]:
    """Load prior-turn strip from POST body or DB transcript (new user turn isolation)."""
    prefix, mid = _extract_evf_prior_assistant_from_stream_body(body)
    reasoning = ""
    tid = str(thread_id or "").strip()
    if tid and not str(prefix or "").strip():
        try:
            from evoflow.persistence.session_repositories import find_session_key_by_thread_id
            from evoflow.persistence.transcript_resume_anchor import build_prior_turn_isolation_anchor

            sk = str(find_session_key_by_thread_id(tid) or "").strip()
            if sk:
                anchor = build_prior_turn_isolation_anchor(sk)
                prefix = str(anchor.get("priorTurnBody") or prefix or "").strip()
                reasoning = str(anchor.get("priorTurnReasoning") or "").strip()
                if not str(mid or "").strip():
                    mid = str(anchor.get("priorTurnMessageId") or "").strip()
        except Exception:
            logger.debug("prior turn isolation load failed thread=%s", tid, exc_info=True)
    return {
        "client_prior_prefix": str(prefix or "").strip(),
        "client_prior_message_id": str(mid or "").strip(),
        "client_prior_reasoning": str(reasoning or "").strip(),
    }


def ui_sse_enabled_from_query(query_string: str) -> bool:
    q = (query_string or "").strip().lower()
    if not q:
        return UI_SSE_ENABLED
    for part in q.split("&"):
        if not part.startswith("ui_sse="):
            continue
        val = part.split("=", 1)[1].strip()
        return val not in {"0", "false", "no", "off"}
    return UI_SSE_ENABLED


def stream_format_from_query(query_string: str) -> str:
    """Wire format for UI SSE: ``agui`` (default) or ``openai``.

    Legacy ``evf`` / ``legacy`` query or env values are coerced to ``agui`` —
    ``event: evf`` is no longer emitted on the chat wire.
    """
    q = (query_string or "").strip().lower()
    fmt = ""
    if q:
        for part in q.split("&"):
            if part.startswith("stream_format="):
                fmt = part.split("=", 1)[1].strip().lower()
    if fmt in {"openai", "oai"}:
        return "openai"
    if fmt in {"evf", "legacy"}:
        return "agui"
    if fmt in {"agui", "ag-ui"}:
        return "agui"
    env = (os.getenv("EVOFLOW_STREAM_FORMAT", "") or "").strip().lower()
    if env in {"openai", "oai"}:
        return "openai"
    if env in {"evf", "legacy"}:
        return "agui"
    if env in {"agui", "ag-ui"}:
        return "agui"
    return "agui"


def _parse_sse_frame(frame: str) -> tuple[str, object | None]:
    event_name = ""
    data_raw = ""
    for ln in frame.split("\n"):
        ln = ln.strip()
        if ln.startswith("event:"):
            event_name = ln[6:].strip()
        elif ln.startswith("data:"):
            data_raw += ln[5:].strip()
    if not data_raw or data_raw in ("{}", "[DONE]"):
        # event:end 携带 data:[DONE] 或 data:{} 时仍需触发 _on_end，
        # 否则 run_end evf 不会在流式中产生，RUN_FINISHED 只能依赖 finish() 补发。
        if event_name.lower() == "end":
            return event_name, {}
        return event_name, None
    try:
        return event_name, json.loads(data_raw)
    except json.JSONDecodeError:
        return event_name, None


class PostStreamUiTransform:
    """Incremental LangGraph SSE → UI stream transform for middleware ``send`` wrapping.

    When ``mirror_enabled`` is set on the POST client transform, every outbound UI frame is
    tee'd into ``evoflow_chat_stream_mirror`` independently of browser ``send``. On disconnect,
    upstream drain continues mirroring; ``stream_mirror_background`` joins only as fallback.
    """

    def __init__(
        self,
        *,
        thread_id: str,
        body: bytes,
        stream_format: str = "agui",
        run_id: str | None = None,
        mirror_enabled: bool = False,
        mirror_source: str = "inline-tee",
        mirror_lane_owned: bool = False,
    ) -> None:
        self.thread_id = str(thread_id or "").strip()
        self.run_id = str(run_id or "").strip() or None
        self.mirror_enabled = bool(mirror_enabled)
        self.mirror_source = str(mirror_source or "inline-tee").strip() or "inline-tee"
        self._mirror_lane_owned = bool(mirror_lane_owned)
        # Wire formats: agui (default) | openai. Legacy ``evf`` is coerced to agui.
        fmt = str(stream_format or "agui").strip().lower()
        if fmt in {"evf", "legacy"}:
            fmt = "agui"
        self.stream_format = fmt if fmt in {"openai", "agui"} else "agui"
        self._buffer = ""
        self._upstream_closed = False
        self._run_end_emitted = False
        self._stream_closed = False
        self._bootstrap_sent = False
        # Fast path: use prior fields from POST body only. Defer DB transcript
        # lookup until first upstream chunk so SSE headers + bootstrap can leave
        # the Gateway before SQLite work blocks TTFT.
        body_prefix, body_mid = _extract_evf_prior_assistant_from_stream_body(body)
        self._pending_prior_db = bool(self.thread_id) and not str(body_prefix or "").strip()
        self._stream_body = body
        norm_kwargs = dict(
            user_input=_extract_user_text_from_stream_body(body),
            use_claude_code_chat=_extract_use_claude_code_from_stream_body(body),
            client_prior_prefix=str(body_prefix or "").strip(),
            client_prior_message_id=str(body_mid or "").strip(),
            client_prior_reasoning="",
            thread_id=self.thread_id,
        )
        if self.stream_format == "openai":
            self.normalizer: UiStreamNormalizer | OpenAiStreamNormalizer | AgUiStreamNormalizer = OpenAiStreamNormalizer(
                **norm_kwargs
            )
        else:
            self.normalizer = AgUiStreamNormalizer(**norm_kwargs, run_id=self.run_id)

    def _ensure_prior_from_db(self) -> None:
        """Lazy DB prior-turn isolation — after bootstrap SSE has already flushed."""
        if not getattr(self, "_pending_prior_db", False):
            return
        self._pending_prior_db = False
        body = getattr(self, "_stream_body", b"") or b""
        prior = _resolve_normalizer_prior_fields(self.thread_id, body)
        inner = getattr(self.normalizer, "inner", self.normalizer)
        for attr, key in (
            ("client_prior_prefix", "client_prior_prefix"),
            ("client_prior_message_id", "client_prior_message_id"),
            ("client_prior_reasoning", "client_prior_reasoning"),
        ):
            val = str(prior.get(key) or "").strip()
            if val and hasattr(inner, attr):
                try:
                    setattr(inner, attr, val)
                except Exception:
                    pass

    def _apply_upstream_run_id(self, run_id: str) -> None:
        rid = str(run_id or "").strip()
        if not rid:
            return
        prev = self.run_id
        self.run_id = rid
        if isinstance(self.normalizer, AgUiStreamNormalizer):
            self.normalizer.set_run_id(rid)
        if not self.thread_id or rid == prev:
            return
        try:
            from app.gateway.routers.langgraph_proxy import register_active_stream_proxy

            register_active_stream_proxy(self.thread_id, run_id=rid)
        except Exception:
            pass
        try:
            from evoflow.session_execution import adopt_session_run_id

            adopt_session_run_id(thread_id=self.thread_id, run_id=rid, source="stream_metadata")
        except Exception:
            pass

    def _mirror_out_frames(self, frames: list[bytes]) -> None:
        """Persist outbound UI SSE frames to the stream mirror table (stream resume)."""
        if not self.thread_id or not frames:
            return
        wire = b"".join(frame for frame in frames if frame)
        if not wire.strip():
            return
        if not self.mirror_enabled and not self._mirror_lane_owned:
            return
        try:
            from app.gateway.streaming.stream_mirror import enqueue_wire_chunk_sync

            enqueue_wire_chunk_sync(
                self.thread_id,
                wire,
                run_id=self.run_id,
                source=self.mirror_source,
            )
        except Exception:
            logger.debug(
                "stream mirror enqueue failed thread=%s run=%s",
                self.thread_id,
                self.run_id,
                exc_info=True,
            )

    def _mirror_inject_frames(self, frames: list[bytes]) -> None:
        """Mirror collab inject frames (not present on LangGraph upstream SSE)."""
        if self._mirror_lane_owned or not self.thread_id or not frames:
            return
        wire = b"".join(frame for frame in frames if frame)
        if not wire.strip():
            return
        try:
            from app.gateway.streaming.stream_mirror import enqueue_wire_chunk_sync

            enqueue_wire_chunk_sync(
                self.thread_id,
                wire,
                run_id=self.run_id,
                source="inject",
            )
        except Exception:
            logger.debug(
                "stream mirror inject enqueue failed thread=%s run=%s",
                self.thread_id,
                self.run_id,
                exc_info=True,
            )

    def _convert_out_frames(self, frames: list[bytes]) -> list[bytes]:
        if self.stream_format == "openai":
            if isinstance(self.normalizer, OpenAiStreamNormalizer):
                return frames
            return convert_evf_frames_to_openai(
                frames,
                completion_id="chatcmpl-inject",
                tool_index_by_id={},
            )
        # Default / agui: frames are already AG-UI when normalizer is AgUiStreamNormalizer.
        if isinstance(self.normalizer, AgUiStreamNormalizer):
            return frames
        from app.gateway.agui_stream_normalizer import AgUiEncoderState

        state = AgUiEncoderState(thread_id=self.thread_id or "thread", run_id="inject")
        return convert_evf_frames_to_agui(frames, state=state, ledger=None)

    def _drain_inject(self) -> list[bytes]:
        if not self.thread_id:
            return []
        if self.stream_format == "agui" and isinstance(self.normalizer, AgUiStreamNormalizer):
            payloads = drain_inject_evf_payloads(self.thread_id)
            if not payloads:
                return []
            out, run_end = evf_payloads_to_agui_wire(
                payloads,
                state=self.normalizer._state,
                ledger=self.normalizer.inner.block_ledger,
            )
            if run_end:
                self._run_end_emitted = True
            return out
        evf = drain_inject_evf_frames(self.thread_id)
        if self.stream_format == "openai":
            if isinstance(self.normalizer, OpenAiStreamNormalizer):
                return convert_evf_frames_to_openai(
                    evf,
                    completion_id=self.normalizer._completion_id,
                    tool_index_by_id=self.normalizer._tool_index_by_id,
                )
            return self._convert_out_frames(evf)
        return self._convert_out_frames(evf)

    def _feed_parsed_frames(self) -> list[bytes]:
        out: list[bytes] = []
        while "\n\n" in self._buffer:
            frame, self._buffer = self._buffer.split("\n\n", 1)
            if not frame.strip() or frame.strip().startswith(":"):
                continue
            event_name, data_json = _parse_sse_frame(frame)
            if data_json is None:
                continue
            if event_name.lower() == "end" or (
                isinstance(data_json, dict) and str(data_json.get("type") or "").strip() == "run_end"
            ):
                if _should_defer_run_finished(self.thread_id):
                    logger.info(
                        "【流式UI】抑制上游 run_end（仍待授权/恢复中）thread=%s event=%s",
                        self.thread_id,
                        event_name,
                    )
                    continue
            if event_name == "metadata" and isinstance(data_json, dict):
                rid = str(data_json.get("run_id") or data_json.get("runId") or "").strip()
                if rid:
                    self._apply_upstream_run_id(rid)
            # Per-frame guard: a single malformed/oversized model frame or any
            # bug inside the chosen normalizer (UiStreamNormalizer /
            # OpenAiStreamNormalizer / AgUiStreamNormalizer) must NOT
            # terminate the entire SSE stream. Previously any Exception here
            # bubbled to process_asgi_message → _dispatch_send (no try/except
            # there) → ASGI 500, silently dropping later upstream frames
            # (messages/values/custom/end). Same class of bug as the fix in
            # sse_ui_normalize.normalize_langgraph_sse_stream.
            try:
                frames = self.normalizer.feed_frame(event_name, data_json)
            except Exception as exc:
                # Build a compact context snippet so logs + wire trace tell us
                # exactly which upstream frame blew up next time.
                try:
                    data_preview = json.dumps(data_json, ensure_ascii=False, default=str)[:400]
                except Exception:
                    data_preview = repr(data_json)[:400]
                tb = traceback.format_exc()
                logger.error(
                    "[post-stream-ui] feed_frame raised — stream continues, frame skipped\n"
                    "  event=%s tid=%s fmt=%s\n  exc=%s: %s\n  data_preview=%s\n%s",
                    event_name,
                    self.thread_id,
                    self.stream_format,
                    exc.__class__.__name__,
                    exc,
                    data_preview,
                    tb,
                )
                # Surface to the SSE wire as a comment frame (line starting
                # with ":") so the browser devtools Network tab shows the
                # crash without breaking the EventSource parser.
                comment = (
                    f": [post-stream-ui][feed_frame error] event={event_name} "
                    f"exc={exc.__class__.__name__}: {str(exc)[:200]}\n\n"
                ).encode("utf-8", errors="replace")
                out.append(comment)
                continue
            out.extend(frames)
            if isinstance(self.normalizer, OpenAiStreamNormalizer) and self.normalizer._run_end_emitted:
                self._run_end_emitted = True
            elif isinstance(self.normalizer, AgUiStreamNormalizer) and self.normalizer._run_end_emitted:
                self._run_end_emitted = True
            if self.thread_id:
                try:
                    from app.gateway.streaming.live_run_snapshot import schedule_snapshot_from_normalizer

                    inner = (
                        self.normalizer.inner
                        if isinstance(self.normalizer, (OpenAiStreamNormalizer, AgUiStreamNormalizer))
                        else self.normalizer
                    )
                    schedule_snapshot_from_normalizer(self.thread_id, inner)
                except Exception:
                    pass
        return out

    def _feed_upstream_chunk(self, chunk: bytes) -> list[bytes]:
        if chunk and self.thread_id and not self._mirror_lane_owned:
            try:
                from app.gateway.streaming.stream_mirror_lane import feed_mirror_lane_upstream

                feed_mirror_lane_upstream(self.thread_id, chunk, source="post-upstream")
            except Exception:
                pass
        if not chunk:
            inject = self._drain_inject()
            self._mirror_inject_frames(inject)
            return inject
        text = bytes(chunk).decode("utf-8", errors="ignore")
        self._buffer = _normalize_sse_buffer(self._buffer + text)
        inject = self._drain_inject()
        self._mirror_inject_frames(inject)
        out = list(inject)
        out.extend(self._feed_parsed_frames())
        if self._mirror_lane_owned or self.mirror_enabled:
            self._mirror_out_frames(out)
        return out

    def feed_upstream_for_mirror(self, chunk: bytes) -> None:
        """Ingest raw LangGraph SSE bytes for background mirror-only paths."""
        if chunk:
            self._feed_upstream_chunk(chunk)

    def finish_upstream_for_mirror(self) -> None:
        """Flush transform tail frames into mirror after upstream closes."""
        if self._upstream_closed:
            return
        self._upstream_closed = True
        self._finish_normalizer()

    def _finish_normalizer(self) -> list[bytes]:
        self._buffer = _normalize_sse_buffer(self._buffer)
        out = self._feed_parsed_frames()
        if not self._run_end_emitted:
            try:
                finish_frames = self.normalizer.finish()
            except Exception as exc:
                tb = traceback.format_exc()
                logger.error(
                    "[post-stream-ui] normalizer.finish() raised — emitting empty run_end\n"
                    "  tid=%s fmt=%s\n  exc=%s: %s\n%s",
                    self.thread_id,
                    self.stream_format,
                    exc.__class__.__name__,
                    exc,
                    tb,
                )
                comment = (
                    f": [post-stream-ui][finish error] "
                    f"exc={exc.__class__.__name__}: {str(exc)[:200]}\n\n"
                ).encode("utf-8", errors="replace")
                finish_frames = [comment]
            out.extend(finish_frames)
            self._run_end_emitted = True
        if self.thread_id:
            try:
                from app.gateway.streaming.live_run_snapshot import clear_gateway_live_snapshot

                clear_gateway_live_snapshot(self.thread_id)
            except Exception:
                pass
        out.extend(self._drain_inject())
        if self._mirror_lane_owned or self.mirror_enabled:
            self._mirror_out_frames(out)
        else:
            self._mirror_inject_frames(out)
        return out

    def drain_inject_for_middle_layer(self) -> list[bytes]:
        """Drain inject queue → ag-ui frames → mirror DB (middle layer unified pipe)."""
        inject = self._drain_inject()
        if inject:
            self._mirror_out_frames(inject)
        return inject

    def _asgi_body_messages(self, payload: bytes, *, more_body: bool) -> list[dict[str, Any]]:
        if not payload and not more_body:
            return [{"type": "http.response.body", "body": b"", "more_body": False}]
        msgs: list[dict[str, Any]] = []
        if payload:
            msgs.append({"type": "http.response.body", "body": payload, "more_body": True})
        if not more_body:
            msgs.append({"type": "http.response.body", "body": b"", "more_body": False})
        return msgs

    async def process_asgi_message(self, message: dict[str, Any]) -> AsyncIterator[dict[str, Any]]:
        msg_type = message.get("type")
        if msg_type == "http.response.start":
            headers = _strip_fixed_length_response_headers(list(message.get("headers") or []))
            if self.stream_format == "openai":
                headers.append((b"x-evoflow-stream-format", b"openai"))
            else:
                headers.append((b"x-evoflow-stream-format", b"agui"))
            yield {"type": "http.response.start", "status": message.get("status", 200), "headers": headers}
            # Flush bootstrap AG-UI frames immediately so first SSE byte leaves
            # Gateway before LangGraph middleware / model TTFT (~headers_ms).
            if (
                not self._bootstrap_sent
                and self.stream_format == "agui"
                and isinstance(self.normalizer, AgUiStreamNormalizer)
            ):
                self._bootstrap_sent = True
                try:
                    for frame in self.normalizer.bootstrap_wire_bytes():
                        for out_msg in self._asgi_body_messages(frame, more_body=True):
                            yield out_msg
                except Exception:
                    logger.debug("bootstrap SSE emit failed thread=%s", self.thread_id, exc_info=True)
            return

        if msg_type != "http.response.body":
            yield message
            return

        raw = message.get("body", b"") or b""
        more = bool(message.get("more_body", False))
        if raw:
            self._ensure_prior_from_db()
            # Prefer sync feed to cut per-chunk thread-pool latency on TTFT / token stream.
            if len(raw) >= _FEED_TO_THREAD_MIN_BYTES:
                transformed = await asyncio.to_thread(self._feed_upstream_chunk, raw)
            else:
                transformed = self._feed_upstream_chunk(raw)
        else:
            transformed = []
        for frame in transformed:
            for out_msg in self._asgi_body_messages(frame, more_body=True):
                yield out_msg

        if not more:
            self._upstream_closed = True
            self._ensure_prior_from_db()
            # Middle layer: defer RUN_FINISHED only while tool-approval or collab inject
            # may still resume on the same SSE. Normal turn completion should finish here
            # so the browser clears "generating" even if SQLite run_status lags LangGraph.
            should_finish = not self._mirror_lane_owned or not await _should_defer_run_finished_async(
                self.thread_id
            )
            if should_finish and not self._run_end_emitted:
                finish_frames = await asyncio.to_thread(self._finish_normalizer)
                for frame in finish_frames:
                    for out_msg in self._asgi_body_messages(frame, more_body=True):
                        yield out_msg
            return

        if not transformed:
            return

    async def emit_inject_tail(self) -> AsyncIterator[dict[str, Any]]:
        """After upstream closes, keep forwarding collab inject frames on the same SSE connection."""
        if not self.thread_id or not self._upstream_closed:
            return
        tid = self.thread_id
        tail_start = asyncio.get_event_loop().time()
        silent_since = tail_start
        while True:
            emitted = False
            inject_frames = self._drain_inject()
            if inject_frames:
                emitted = True
                silent_since = asyncio.get_event_loop().time()
                self._mirror_inject_frames(inject_frames)
                for frame in inject_frames:
                    for out_msg in self._asgi_body_messages(frame, more_body=True):
                        yield out_msg
            now = asyncio.get_event_loop().time()
            if not await _has_pending_collab_subtasks_async(tid) and not _inject_queue_has_pending(tid):
                break
            if now - tail_start > _TAIL_PHASE_MAX_S:
                logger.info("post_stream_ui tail timeout thread=%s (%.0fs)", tid, _TAIL_PHASE_MAX_S)
                break
            if now - silent_since > _TAIL_IDLE_MAX_S and not _inject_queue_has_pending(tid):
                logger.info("post_stream_ui tail idle timeout thread=%s (%.0fs)", tid, _TAIL_IDLE_MAX_S)
                break
            if not emitted:
                await asyncio.sleep(_TAIL_POLL_S)
        tail_inject = self._drain_inject()
        if tail_inject:
            self._mirror_inject_frames(tail_inject)
            for frame in tail_inject:
                for out_msg in self._asgi_body_messages(frame, more_body=True):
                    yield out_msg

    async def close_stream(self) -> AsyncIterator[dict[str, Any]]:
        if self._stream_closed:
            return
        pending_collab = await _has_pending_collab_subtasks_async(self.thread_id)
        pending_inject = _inject_queue_has_pending(self.thread_id)
        if pending_collab or pending_inject:
            async for msg in self.emit_inject_tail():
                yield msg
        else:
            close_inject = self._drain_inject()
            if close_inject:
                self._mirror_inject_frames(close_inject)
                for frame in close_inject:
                    for out_msg in self._asgi_body_messages(frame, more_body=True):
                        yield out_msg
        if self._mirror_lane_owned and not self._run_end_emitted:
            if await _should_defer_run_finished_async(self.thread_id):
                logger.info(
                    "【流式UI】close_stream 延迟 RUN_FINISHED thread=%s（仍有 pending 或 resume 中）",
                    self.thread_id,
                )
            else:
                finish_frames = await asyncio.to_thread(self._finish_normalizer)
                for frame in finish_frames:
                    for out_msg in self._asgi_body_messages(frame, more_body=True):
                        yield out_msg
        self._stream_closed = True
        yield {"type": "http.response.body", "body": b"", "more_body": False}
