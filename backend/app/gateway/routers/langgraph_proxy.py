"""Reverse proxy for LangGraph API under gateway /api/langgraph."""

from __future__ import annotations

import asyncio
import json
import logging
import os
import threading
import time
from collections import OrderedDict
from collections.abc import AsyncGenerator
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import httpx
from fastapi import APIRouter, Query, Request
from evoflow.authz.http_guard import require_thread_visible
from fastapi.responses import JSONResponse, StreamingResponse

router = APIRouter(prefix="/api/langgraph", tags=["langgraph-proxy"])
logger = logging.getLogger(__name__)

from evoflow.runtime.long_run_limits import LONG_RUN_STREAM_READ_SECONDS, LONG_RUN_WALL_SECONDS  # noqa: E402

LANGGRAPH_BASE_URL = os.getenv("EVOFLOW_LANGGRAPH_URL", "http://127.0.0.1:8070/api/langgraph").rstrip("/")

# SSE heartbeat: when upstream is silent for this long, emit a ping frame to keep
# the browser/Nginx connection alive.  Configurable via env var (seconds).
_SSE_HEARTBEAT_INTERVAL_S = max(
    5.0,
    float(os.getenv("EVOFLOW_SSE_HEARTBEAT_INTERVAL", "15") or "15"),
)

# 已禁用：SSE 调试日志写入 temp 文件（避免 IO/磁盘噪音）
DISABLE_SSE_DEBUG_FILE_LOGS = True

# 强力排查开关：打印每个 SSE frame（包含 reasoning 检测）
# 默认开启，便于现场排查；如需关闭，设置 EVOFLOW_DEBUG_SSE_REASONING=0/false/off。
_sse_debug_flag = (os.getenv("EVOFLOW_DEBUG_SSE_REASONING", "") or "").strip().lower()
DEBUG_SSE_REASONING = False if _sse_debug_flag in {"0", "false", "no", "off"} else True
_sse_slim_flag = (os.getenv("EVOFLOW_SSE_SLIM", "1") or "").strip().lower()
SSE_SLIM_ENABLED = _sse_slim_flag not in {"0", "false", "no", "off"}
_sse_dedupe_values_flag = (os.getenv("EVOFLOW_SSE_SLIM_DEDUPE_VALUES", "1") or "").strip().lower()
SSE_SLIM_DEDUPE_VALUES = _sse_dedupe_values_flag not in {"0", "false", "no", "off"}
_ui_sse_flag = (os.getenv("EVOFLOW_UI_SSE", "1") or "").strip().lower()
UI_SSE_ENABLED = _ui_sse_flag not in {"0", "false", "no", "off"}
SSE_REASONING_TRACE_LOG = os.path.join("logs", "debug", "sse_reasoning_trace.log")
SSE_PROXY_HIT_LOG = os.path.join("logs", "debug", "sse_proxy_hit.log")

# 活跃流式代理记录：thread_id -> 开始时间
_active_stream_proxies: dict[str, float] = {}
# Best-effort run_id captured when a primary stream starts (for cleanup reconcile).
_active_stream_run_ids: dict[str, str] = {}
_active_stream_lock = threading.Lock()


def register_active_stream_proxy(thread_id: str | None, *, run_id: str | None = None) -> None:
    """Track an in-flight LangGraph SSE proxy for fast active-run checks."""
    tid = str(thread_id or "").strip()
    if not tid:
        return
    rid = str(run_id or "").strip()
    if not rid:
        try:
            from evoflow.persistence.session_run_state import peek_current_run_id

            rid = str(peek_current_run_id(thread_id=tid) or "").strip()
        except Exception:
            rid = ""
    with _active_stream_lock:
        _active_stream_proxies[tid] = time.time()
        if rid:
            _active_stream_run_ids[tid] = rid


def unregister_active_stream_proxy(thread_id: str | None) -> None:
    tid = str(thread_id or "").strip()
    if not tid:
        return
    with _active_stream_lock:
        _active_stream_proxies.pop(tid, None)
        _active_stream_run_ids.pop(tid, None)


def list_active_stream_proxies() -> list[dict[str, Any]]:
    """Snapshot of in-flight SSE proxies (for hang reclaim / diagnostics)."""
    now = time.time()
    with _active_stream_lock:
        items = [
            {
                "thread_id": tid,
                "run_id": _active_stream_run_ids.get(tid) or None,
                "started_at_epoch": started,
                "elapsed_seconds": round(max(0.0, now - float(started)), 3),
            }
            for tid, started in list(_active_stream_proxies.items())
        ]
    items.sort(key=lambda row: float(row.get("elapsed_seconds") or 0), reverse=True)
    return items


def reclaim_stale_active_stream_proxies(
    *,
    max_age_s: float = 120.0,
    require_missing_run_id: bool = True,
) -> list[str]:
    """Drop proxy bookkeeping for streams that never got a run_id / hung too long.

    Does not cancel LangGraph runs by itself — callers that need cancel should
    follow up via ``stop_session_execution`` / reconcile. Unregistering frees
    ``active_streams`` slots that otherwise look like HOL zombies forever.
    """
    age = max(30.0, float(max_age_s or 120.0))
    now = time.time()
    victims: list[str] = []
    with _active_stream_lock:
        for tid, started in list(_active_stream_proxies.items()):
            elapsed = now - float(started)
            if elapsed < age:
                continue
            rid = str(_active_stream_run_ids.get(tid) or "").strip()
            if require_missing_run_id and rid:
                continue
            victims.append(tid)
            _active_stream_proxies.pop(tid, None)
            _active_stream_run_ids.pop(tid, None)
    if victims:
        logger.warning(
            "reclaimed stale active stream proxies count=%d max_age_s=%.0f missing_run_id=%s threads=%s",
            len(victims),
            age,
            require_missing_run_id,
            ",".join(victims[:8]),
        )
    return victims

# Short TTL cache for GET /active-sessions (avoids N× LangGraph /runs per poll).
_ACTIVE_SESSIONS_CACHE: OrderedDict[str, tuple[float, dict[str, Any]]] = OrderedDict()
_ACTIVE_SESSIONS_CACHE_TTL_S = max(
    2.0,
    float(os.getenv("EVOFLOW_ACTIVE_SESSIONS_CACHE_TTL", "10") or "10"),
)
_ACTIVE_SESSIONS_CACHE_MAX = 64
_ACTIVE_SESSIONS_CACHE_LOCK = threading.Lock()
FIRST_TOKEN_TRACE_LOG = os.path.join("logs", "debug", "first_token_trace.log")
_trace_gateway_first_token_ts_ms: dict[str, int] = {}

HOP_BY_HOP_HEADERS = {
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
    "host",
    "content-length",
}


def _now_iso() -> str:
    return datetime.now(UTC).isoformat()


def _write_run_latency_event(
    thread_id: str | None,
    event: str,
    *,
    trace_id: str | None = None,
    **fields: Any,
) -> None:
    try:
        from evoflow.observability.run_latency_trace import write_run_latency_event

        payload = dict(fields)
        write_run_latency_event(thread_id, event, payload, trace_id=trace_id)
    except Exception:
        logger.debug("run_latency trace write failed event=%s", event, exc_info=True)


def _append_first_token_trace(payload: dict[str, Any]) -> None:
    try:
        os.makedirs(os.path.dirname(FIRST_TOKEN_TRACE_LOG), exist_ok=True)
        line = json.dumps(payload, ensure_ascii=False)
        with open(FIRST_TOKEN_TRACE_LOG, "a", encoding="utf-8") as f:
            f.write(line + "\n")
    except Exception:
        logger.debug("failed to append first token trace", exc_info=True)


def _append_sse_reasoning_trace(payload: dict[str, Any]) -> None:
    if not DEBUG_SSE_REASONING:
        return
    try:
        Path(os.path.dirname(SSE_REASONING_TRACE_LOG)).mkdir(parents=True, exist_ok=True)
        with open(SSE_REASONING_TRACE_LOG, "a", encoding="utf-8") as f:
            f.write(json.dumps(payload, ensure_ascii=False) + "\n")
    except Exception:
        logger.debug("failed to append sse reasoning trace", exc_info=True)


def _append_sse_proxy_hit(payload: dict[str, Any]) -> None:
    """Ultra-light sentinel to confirm /runs/stream branch is hit."""
    if not DEBUG_SSE_REASONING:
        return
    try:
        Path(os.path.dirname(SSE_PROXY_HIT_LOG)).mkdir(parents=True, exist_ok=True)
        with open(SSE_PROXY_HIT_LOG, "a", encoding="utf-8") as f:
            f.write(json.dumps(payload, ensure_ascii=False) + "\n")
    except Exception:
        logger.debug("failed to append sse proxy hit", exc_info=True)


def _extract_reasoning_preview_from_sse_data(data_json: object) -> tuple[bool, int, str]:
    """Best-effort detect reasoning_content in LangGraph SSE payload."""
    try:
        # Common shapes:
        # - ["messages-tuple", { ... message ... }]
        # - { "type": "ai", "additional_kwargs": {"reasoning_content": "..."} }
        # - { "event": "...", "data": ... } (rare)
        obj = data_json
        if isinstance(obj, list) and len(obj) == 2 and isinstance(obj[0], str):
            obj = obj[1]
        if isinstance(obj, dict):
            ak = obj.get("additional_kwargs")
            if isinstance(ak, dict):
                rc = ak.get("reasoning_content")
                if isinstance(rc, str) and rc.strip():
                    s = rc.strip().replace("\r\n", "\n").replace("\r", "\n")
                    return True, len(rc), s[:160]
        return False, 0, ""
    except Exception:
        return False, 0, ""


def _extract_trace_fields(path: str, body: bytes) -> tuple[str, int | None]:
    trace_id = ""
    user_input_ts_ms: int | None = None
    if "/runs/stream" not in path:
        return trace_id, user_input_ts_ms
    try:
        raw = json.loads(body.decode("utf-8")) if body else {}
    except Exception:
        return trace_id, user_input_ts_ms
    if not isinstance(raw, dict):
        return trace_id, user_input_ts_ms
    context = raw.get("context") if isinstance(raw.get("context"), dict) else {}
    trace_id = str(context.get("evf_trace_id") or "").strip()
    ts_raw = context.get("evf_user_input_ts_ms")
    try:
        user_input_ts_ms = int(ts_raw) if ts_raw is not None else None
    except Exception:
        user_input_ts_ms = None
    return trace_id, user_input_ts_ms


def _extract_thread_id_from_path(path: str) -> str:
    if "threads/" not in path:
        return ""
    part = path.split("threads/", 1)[1]
    return str(part.split("/", 1)[0]).strip()


async def _heartbeat_sse_stream(
    upstream: Any,
    interval_s: float = _SSE_HEARTBEAT_INTERVAL_S,
) -> AsyncGenerator[bytes, None]:
    """Wrap an SSE byte stream with self-generated heartbeat frames.

    When the upstream is silent for *interval_s* seconds, emit a standard SSE
    ``: heartbeat`` comment frame to keep the browser / Nginx / reverse-proxy
    connection alive.  This prevents sudden disconnects during long model
    thinking, slow tool execution, or middleware processing delays.
    """
    upstream_iter = upstream.__aiter__()
    pending: asyncio.Task | None = None

    def _schedule_next() -> asyncio.Task:
        return asyncio.create_task(upstream_iter.__anext__())

    from evoflow.observability.poll_loop_log import log_poll_loop_end, log_poll_loop_start, log_poll_tick

    log_poll_loop_start("sse_heartbeat_wrap", interval_s=interval_s)

    try:
        while True:
            log_poll_tick("sse_heartbeat_wrap", key="upstream", interval_s=60.0)
            if pending is None:
                pending = _schedule_next()

            done, _ = await asyncio.wait({pending}, timeout=interval_s, return_when=asyncio.FIRST_COMPLETED)
            if not done:
                # Upstream silent for too long — emit heartbeat.
                yield b": heartbeat\n\n"
                continue

            try:
                chunk = pending.result()
            except StopAsyncIteration:
                log_poll_loop_end("sse_heartbeat_wrap")
                return
            pending = None
            yield chunk
    finally:
        log_poll_loop_end("sse_heartbeat_wrap")
        if pending is not None and not pending.done():
            pending.cancel()
            try:
                await pending
            except (asyncio.CancelledError, StopAsyncIteration):
                pass


def _extract_messages_for_mission_bootstrap(body: bytes) -> list[dict[str, Any]]:
    try:
        raw = json.loads(body.decode("utf-8")) if body else {}
    except Exception:
        return []
    if not isinstance(raw, dict):
        return []
    inp = raw.get("input")
    messages: Any = None
    if isinstance(inp, dict):
        messages = inp.get("messages")
    elif isinstance(inp, list):
        messages = inp
    if not isinstance(messages, list):
        return []
    out: list[dict[str, Any]] = []
    for m in messages:
        if not isinstance(m, dict):
            continue
        role = str(m.get("role") or m.get("type") or "").strip().lower()
        content = m.get("content")
        out.append({"role": role, "content": content})
    return out


def _content_to_plain_text(content: Any) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts: list[str] = []
        for block in content:
            if isinstance(block, dict) and str(block.get("type") or "").lower() == "text":
                parts.append(str(block.get("text") or ""))
            elif isinstance(block, str):
                parts.append(block)
        return "".join(parts)
    return ""


def _extract_user_text_from_stream_body(body: bytes) -> str:
    for m in reversed(_extract_messages_for_mission_bootstrap(body)):
        role = str(m.get("role") or m.get("type") or "").strip().lower()
        if role not in {"user", "human"}:
            continue
        text = _content_to_plain_text(m.get("content"))
        if text.strip():
            return text.strip()
    return ""


def _extract_evf_prior_assistant_from_stream_body(body: bytes) -> tuple[str, str]:
    """UI 封存的上轮 assistant（停后继续），用于 Gateway 按 message_id 剥离重放。"""
    try:
        raw = json.loads(body.decode("utf-8")) if body else {}
    except Exception:
        return "", ""
    if not isinstance(raw, dict):
        return "", ""
    ctx = raw.get("context")
    if not isinstance(ctx, dict):
        return "", ""
    prefix = str(ctx.get("evf_prior_assistant_prefix") or "").strip()
    mid = str(ctx.get("evf_prior_assistant_message_id") or "").strip()
    if len(prefix) > 120_000:
        prefix = prefix[:120_000]
    # Log prefix for debugging duplication issues
    if prefix:
        # Check for potential duplication (same text repeated)
        half_len = len(prefix) // 2
        if half_len > 10 and prefix[:half_len] == prefix[half_len:half_len * 2]:
            logger.warning(
                "evf_prior_assistant_prefix appears duplicated (len=%d, first_half=%r)",
                len(prefix),
                prefix[:min(100, half_len)],
            )
        else:
            logger.debug(
                "evf_prior_assistant_prefix extracted (len=%d, preview=%r)",
                len(prefix),
                prefix[:100],
            )
    return prefix, mid


def _extract_use_claude_code_from_stream_body(body: bytes) -> bool:
    try:
        raw = json.loads(body.decode("utf-8")) if body else {}
    except Exception:
        return False
    if not isinstance(raw, dict):
        return False
    ctx = raw.get("context")
    if isinstance(ctx, dict):
        agent = str(ctx.get("agent_name") or "").strip().lower()
        if agent in {"claude-code", "claude_code"}:
            return True
    return False


def _infer_sse_event_name(event_name: str, data_json: object) -> str:
    """Infer LangGraph SSE event name when upstream omits `event:` line."""
    if event_name:
        return event_name
    if isinstance(data_json, list) and data_json and isinstance(data_json[0], str):
        return data_json[0]
    if isinstance(data_json, dict):
        ev = data_json.get("event")
        if isinstance(ev, str) and ev.strip():
            return ev.strip()
    return "message"


@router.get("/threads/{thread_id}/runs/{run_id}/stream", summary="Attach to an in-progress run stream (refresh continuation)")
async def attach_run_stream(
    thread_id: str,
    run_id: str,
    request: Request,
    poll_interval_ms: int = 1500,
    max_wait_seconds: int = LONG_RUN_WALL_SECONDS,
) -> StreamingResponse:
    """刷新续挂：为已有 run 提供 GET 续流入口。

    输出 LangGraph 兼容 SSE：
    - `event: values` + thread state snapshot（shape 与 /runs/stream values 一致/兼容）
    - `event: end`：检测到 run 终态后关闭（best-effort）
    """
    require_thread_visible(request, thread_id)
    import sys
    print(f"[proxy] >>> GET attach_run_stream thread={thread_id} run={run_id}", file=sys.stderr, flush=True)

    poll_seconds = max(0.2, min(5.0, float(poll_interval_ms) / 1000.0))
    timeout_seconds = max(1, int(max_wait_seconds))
    ui_sse_q = (request.query_params.get("ui_sse") or "").strip().lower()
    use_ui_sse = UI_SSE_ENABLED
    if ui_sse_q:
        use_ui_sse = ui_sse_q not in {"0", "false", "no", "off"}
    from app.gateway.streaming.post_stream_ui_normalize import stream_format_from_query

    query_bits = "&".join(f"{k}={request.query_params[k]}" for k in request.query_params.keys())
    attach_stream_fmt = stream_format_from_query(query_bits) if use_ui_sse else "agui"
    headers = {
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",
    }
    if use_ui_sse:
        headers["X-EvoFlow-Stream-Format"] = "agui" if attach_stream_fmt != "openai" else "openai"

    # Forward auth/cookies and other relevant headers to LangGraph.
    upstream_headers = {k: v for k, v in request.headers.items() if k.lower() not in HOP_BY_HOP_HEADERS}

    async def _gen() -> AsyncGenerator[str, None]:
        from app.gateway.streaming.session_stream_inject import (
            begin_thread_inject,
            drain_inject_langgraph_frames,
            end_thread_inject,
        )

        begin_thread_inject(thread_id)
        _touch_session_run_started(thread_id, run_id=run_id)
        started = time.monotonic()
        last_sig: str = ""
        poll_tick = 0
        timeout = httpx.Timeout(connect=5.0, read=LONG_RUN_STREAM_READ_SECONDS, write=60.0, pool=120.0)
        from app.gateway.streaming.attach_evf_stream import AttachEvfDiffEmitter

        evf_emitter = AttachEvfDiffEmitter() if use_ui_sse else None
        agui_attach_state = None
        if use_ui_sse and attach_stream_fmt == "agui":
            from app.gateway.agui_stream_normalizer import AgUiEncoderState

            agui_attach_state = AgUiEncoderState(thread_id=thread_id, run_id=run_id)

        def _attach_ui_wire_frame(frame: str) -> list[str]:
            if attach_stream_fmt != "agui" or agui_attach_state is None:
                return [frame]
            from app.gateway.agui_stream_normalizer import convert_evf_frames_to_agui

            out_bytes = convert_evf_frames_to_agui([frame.encode("utf-8")], state=agui_attach_state)
            return [b.decode("utf-8") for b in out_bytes] if out_bytes else []
        from evoflow.observability.poll_loop_log import log_poll_loop_end, log_poll_loop_start, log_poll_tick

        log_poll_loop_start(
            "attach_run_stream",
            thread_id=thread_id,
            run_id=run_id,
            poll_s=poll_seconds,
        )

        async with httpx.AsyncClient(timeout=timeout) as client:
            # Immediately emit a frame so browser sees the stream is alive.
            yield "event: connected\n"
            yield f"data: {json.dumps({'thread_id': thread_id, 'run_id': run_id}, ensure_ascii=False)}\n\n"

            try:
                while True:
                    log_poll_tick(
                        "attach_run_stream",
                        key=f"{thread_id}:{run_id}",
                        interval_s=30.0,
                        tick=poll_tick,
                    )
                    for frame in drain_inject_langgraph_frames(thread_id):
                        yield frame.decode("utf-8")

                    if time.monotonic() - started > timeout_seconds:
                        try:
                            from app.gateway.run_status_reconcile import (
                                _langgraph_has_active_run,
                                notify_attach_run_terminal,
                            )

                            still_active = await _langgraph_has_active_run(
                                client, thread_id, run_id=run_id
                            )
                            if still_active is False:
                                await notify_attach_run_terminal(thread_id, run_id=run_id)
                        except Exception:
                            pass
                        yield "event: end\n"
                        yield "data: {}\n\n"
                        return

                    emitted = False
                    poll_tick += 1

                    # 1) 最新 state 快照 -> values 事件
                    state_url = f"{LANGGRAPH_BASE_URL}/threads/{thread_id}/state"
                    try:
                        resp = await client.get(state_url, headers=upstream_headers)
                        if resp.status_code == 200:
                            data: Any = resp.json()
                            sig = str(hash(resp.content))
                            if sig != last_sig:
                                last_sig = sig
                                from app.gateway.sse_slim import slim_values_payload

                                slim_data = slim_values_payload(data) if SSE_SLIM_ENABLED else data
                                if use_ui_sse and evf_emitter is not None:
                                    for frame in evf_emitter.frames_for_state(slim_data):
                                        for wire in _attach_ui_wire_frame(frame):
                                            yield wire
                                else:
                                    yield "event: values\n"
                                    yield f"data: {json.dumps(slim_data, ensure_ascii=False, separators=(',', ':'))}\n\n"
                                emitted = True
                    except Exception:
                        pass

                    # 2) run 终态检测 -> end (every 3rd poll unless state just changed)
                    if emitted or poll_tick % 3 == 0:
                        try:
                            from app.gateway.run_status_reconcile import (
                                _langgraph_has_active_run,
                                notify_attach_run_terminal,
                            )

                            still_active = await _langgraph_has_active_run(
                                client, thread_id, run_id=run_id
                            )
                            if still_active is False:
                                await notify_attach_run_terminal(thread_id, run_id=run_id)
                                if use_ui_sse and evf_emitter is not None:
                                    for frame in evf_emitter.finish_frames():
                                        for wire in _attach_ui_wire_frame(frame):
                                            yield wire
                                else:
                                    yield "event: end\n"
                                    yield "data: {}\n\n"
                                return
                            if still_active is True:
                                _touch_session_run_started(thread_id, run_id=run_id)
                        except Exception:
                            pass

                    if not emitted:
                        yield "event: ping\n"
                        yield "data: {}\n\n"

                    await asyncio.sleep(poll_seconds)
            except asyncio.CancelledError:
                return
            except Exception:
                logger.exception("Attach run stream generator error: thread=%s run=%s", thread_id, run_id)
                return
            finally:
                log_poll_loop_end("attach_run_stream", thread_id=thread_id, run_id=run_id)
                try:
                    from app.gateway.routers.langgraph_proxy import unregister_active_stream_proxy

                    unregister_active_stream_proxy(thread_id)
                except Exception:
                    logger.debug(
                        "attach stream cleanup unregister failed thread=%s run=%s",
                        thread_id,
                        run_id,
                        exc_info=True,
                    )
                end_thread_inject(thread_id)

    async def _gen_with_mirror() -> AsyncGenerator[str, None]:
        from app.gateway.streaming.stream_mirror import enqueue_wire_text, shrink_mirror_for_thread

        try:
            async for chunk in _gen():
                enqueue_wire_text(thread_id, chunk, run_id=run_id)
                yield chunk
        finally:
            shrink_mirror_for_thread(thread_id)

    return StreamingResponse(_gen_with_mirror(), headers=headers, media_type="text/event-stream")


async def _wait_langgraph_ready(
    attempts: int = 12,
    delay_seconds: float = 0.4,
) -> bool:
    ok_url = f"{LANGGRAPH_BASE_URL}/ok"
    timeout = httpx.Timeout(connect=2.0, read=2.0, write=2.0, pool=2.0)
    async with httpx.AsyncClient(timeout=timeout) as client:
        for _ in range(max(1, attempts)):
            try:
                resp = await client.get(ok_url)
                if resp.status_code == 200:
                    return True
            except Exception:
                pass
            await asyncio.sleep(delay_seconds)
    return False


def _empty_active_sessions_response(
    *,
    error: str | None = None,
    langgraph_ready: bool = False,
) -> JSONResponse:
    body: dict[str, Any] = {
        "active_sessions": [],
        "count": 0,
        "langgraph_ready": langgraph_ready,
    }
    if error:
        body["error"] = error
    return JSONResponse(content=body)


def _parse_active_session_keys(session_keys: str | None) -> list[str]:
    if not session_keys:
        return []
    out: list[str] = []
    seen: set[str] = set()
    for part in str(session_keys).split(","):
        sk = part.strip()
        if not sk or sk in seen:
            continue
        seen.add(sk)
        out.append(sk)
        if len(out) >= 32:
            break
    return out


def _active_sessions_cache_get(cache_key: str) -> dict[str, Any] | None:
    now = time.monotonic()
    with _ACTIVE_SESSIONS_CACHE_LOCK:
        hit = _ACTIVE_SESSIONS_CACHE.get(cache_key)
        if hit is None:
            return None
        ts, body = hit
        if now - ts > _ACTIVE_SESSIONS_CACHE_TTL_S:
            _ACTIVE_SESSIONS_CACHE.pop(cache_key, None)
            return None
        _ACTIVE_SESSIONS_CACHE.move_to_end(cache_key)
        return body


def _active_sessions_cache_put(cache_key: str, body: dict[str, Any]) -> None:
    with _ACTIVE_SESSIONS_CACHE_LOCK:
        _ACTIVE_SESSIONS_CACHE[cache_key] = (time.monotonic(), body)
        _ACTIVE_SESSIONS_CACHE.move_to_end(cache_key)
        while len(_ACTIVE_SESSIONS_CACHE) > _ACTIVE_SESSIONS_CACHE_MAX:
            _ACTIVE_SESSIONS_CACHE.popitem(last=False)


def _collab_phase_is_active(thread_id: str) -> bool:
    try:
        from evoflow.collab.thread_collab import load_thread_collab_state
        from evoflow.config.paths import get_paths

        collab_state = load_thread_collab_state(get_paths(), thread_id)
        phase = getattr(collab_state, "collab_phase", None)
        phase_str = getattr(phase, "value", phase)
        phase_str = str(phase_str).strip().lower() if phase_str is not None else "idle"
        return phase_str in {"executing", "running"}
    except Exception:
        return False


async def _fetch_latest_run_status(
    client: httpx.AsyncClient,
    thread_id: str,
) -> tuple[str | None, str | None]:
    """Return (run_id, status) for the newest run, or (None, None)."""
    runs_url = f"{LANGGRAPH_BASE_URL}/threads/{thread_id}/runs"
    runs_resp = await client.get(runs_url, params={"limit": 1})
    if runs_resp.status_code != 200:
        return None, None
    runs_data = runs_resp.json()
    runs_items: Any = runs_data
    if isinstance(runs_data, dict):
        runs_items = runs_data.get("items", runs_data.get("runs", []))
    if not isinstance(runs_items, list) or not runs_items:
        return None, None
    run = runs_items[0]
    if not isinstance(run, dict):
        return None, None
    status = str(run.get("status", "")).strip().lower()
    run_id = run.get("run_id") or run.get("runId")
    return (str(run_id) if run_id is not None else None, status or None)


async def _check_binding_active(
    client: httpx.AsyncClient,
    session_key: str,
    thread_id: str,
) -> dict[str, Any] | None:
    if thread_id in _active_stream_proxies:
        return {
            "session_key": session_key,
            "thread_id": thread_id,
            "run_id": None,
            "status": "running",
            "source": "proxy_memory",
        }
    if _collab_phase_is_active(thread_id):
        return {
            "session_key": session_key,
            "thread_id": thread_id,
            "run_id": None,
            "status": "running",
            "source": "collab_phase",
        }
    try:
        run_id, status = await _fetch_latest_run_status(client, thread_id)
    except Exception as e:
        logger.debug("active-sessions: runs check failed thread=%s: %s", thread_id, e)
        return None
    if status in ("pending", "running"):
        return {
            "session_key": session_key,
            "thread_id": thread_id,
            "run_id": run_id,
            "status": status,
            "source": "langgraph_runs",
        }
    return None


def _touch_session_run_started(thread_id: str | None, *, run_id: str | None = None) -> None:
    tid = str(thread_id or "").strip()
    if not tid:
        return
    register_active_stream_proxy(tid, run_id=run_id)
    rid = str(run_id or "").strip()
    if not rid:
        try:
            from evoflow.persistence.session_run_state import peek_current_run_id

            rid = str(peek_current_run_id(thread_id=tid) or "").strip()
        except Exception:
            rid = ""
    try:
        from evoflow.session_execution import start_session_turn

        start_session_turn(thread_id=tid, run_id=rid or run_id, source="stream_proxy")
    except Exception:
        logger.debug("mark session run started failed thread_id=%s", tid, exc_info=True)
    if rid:
        try:
            from evoflow.persistence.session_repositories import find_session_key_by_thread_id
            from evoflow.persistence.stream_mirror_repositories import touch_mirror_meta

            sk = find_session_key_by_thread_id(tid)
            if sk:
                touch_mirror_meta(sk, thread_id=tid, run_id=rid)
        except Exception:
            logger.debug("touch mirror meta on run start failed thread_id=%s", tid, exc_info=True)


def _resolve_stream_cleanup_run_id(thread_id: str | None) -> str | None:
    tid = str(thread_id or "").strip()
    if not tid:
        return None
    rid = str(_active_stream_run_ids.get(tid) or "").strip()
    if rid:
        return rid
    try:
        from evoflow.persistence.session_run_state import peek_current_run_id

        return str(peek_current_run_id(thread_id=tid) or "").strip() or None
    except Exception:
        logger.debug("resolve cleanup run_id failed thread_id=%s", tid, exc_info=True)
        return None


@router.get("/active-sessions", summary="获取正在执行中的会话列表")
async def get_active_sessions(
    session_keys: str | None = Query(default=None, description="Comma-separated session_key whitelist"),
) -> JSONResponse:
    """Return sessions marked running/pending in ``evoflow_chat_sessions`` (no LangGraph scan)."""
    keys = _parse_active_session_keys(session_keys)
    if not keys:
        return _empty_active_sessions_response(langgraph_ready=True)

    cache_key = ",".join(keys)
    cached = _active_sessions_cache_get(cache_key)
    if cached is not None:
        return JSONResponse(content=cached)

    try:
        from evoflow.persistence.session_run_state import list_active_sessions_for_keys

        active_sessions = list_active_sessions_for_keys(keys)
        body = {
            "active_sessions": active_sessions,
            "count": len(active_sessions),
            "langgraph_ready": True,
        }
        _active_sessions_cache_put(cache_key, body)
        return JSONResponse(content=body)
    except Exception as e:
        logger.warning("active-sessions: sqlite read failed: %s", e, exc_info=True)
        return _empty_active_sessions_response(error=str(e)[:200], langgraph_ready=True)


def _fast_thread_state_enabled() -> bool:
    raw = (os.getenv("EVOFLOW_FAST_THREAD_STATE") or "1").strip().lower()
    return raw not in {"0", "false", "no", "off"}


# NOTE: The catch-all proxy route (@router.api_route("/{path:path}...)) has been removed
# for single-process mode.  In single-process mode, LangGraph is mounted in-process at
# /api/langgraph (see app.py), so all /runs/* requests are handled directly by the mount
# without an HTTPX reverse-proxy loopback.
#
# Remaining routes in this module:
#   - GET /threads/{thread_id}/runs/{run_id}/stream  (attach/refresh stream)
#   - GET /active-sessions  (active sessions list)
# Client-side trace endpoints moved to routers/client_trace.py at /api/trace/*

