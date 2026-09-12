"""ASGI middleware: log and transform /api/langgraph traffic."""

from __future__ import annotations

import asyncio
import json
import logging
import sys
import time as _lg_time

from fastapi import FastAPI

logger = logging.getLogger(__name__)


class LangGraphRouteLoggerMiddleware:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or not scope.get("path", "").startswith("/api/langgraph"):
            await self.app(scope, receive, send)
            return

        path = scope.get("path", "")
        method = scope.get("method", "")
        query = scope.get("query_string", b"").decode()
        qs = f"?{query}" if query else ""
        t0 = _lg_time.monotonic()
        t0_wall_ms = int(_lg_time.time() * 1000)
        from app.gateway.streaming.stream_mirror import langgraph_post_mirror_tee_enabled

        mirror_stream_resume = langgraph_post_mirror_tee_enabled(
            method=method,
            path=path,
            query=query,
            headers=scope.get("headers", []),
        )
        ui_transform = None
        middle_layer = None
        body_chunks: list[bytes] = []
        stream_fmt = "agui"
        print(f"[LG-ROUTE] >>> {method} {path}{qs}", file=sys.stderr, flush=True)
        logger.info("[LG-ROUTE] >>> %s %s%s", method, path, qs)

        # Extract thread_id / run_id from path for run stream requests
        lg_thread_id: str | None = None
        lg_run_id: str | None = None
        if "/runs/" in path and "stream" in path:
            parts = path.split("/")
            for i, p in enumerate(parts):
                if p == "threads" and i + 1 < len(parts):
                    lg_thread_id = parts[i + 1]
                if p == "runs" and i + 1 < len(parts) and parts[i + 1] != "stream":
                    lg_run_id = parts[i + 1]
                    break

        # Extract user_input_ts_ms from POST body (evf_user_input_ts_ms in runContext).
        # Must eagerly drain the body BEFORE Step 1 fires, then replay to LangGraph.
        user_input_ts_ms: int | None = None
        _client_send_prep: dict | None = None

        def _init_ui_sse_transform() -> None:
            nonlocal ui_transform, stream_fmt, middle_layer
            if not lg_thread_id:
                return
            is_post_run = method == "POST" and "/runs/stream" in path
            # GET /threads/{tid}/runs/{rid}/stream is handled by
            # langgraph_proxy.attach_run_stream which produces its own UI SSE —
            # do NOT apply middleware ui_transform (would double-transform).
            if not is_post_run:
                return
            try:
                from app.gateway.streaming.post_stream_ui_normalize import (
                    PostStreamUiTransform,
                    stream_format_from_query,
                    ui_sse_enabled_from_query,
                )
                from app.gateway.streaming.session_stream_inject import begin_thread_inject

                if not ui_sse_enabled_from_query(query):
                    return
                stream_fmt = stream_format_from_query(query)
                begin_thread_inject(lg_thread_id)
                route_kind = "POST /runs/stream"
                if mirror_stream_resume and is_post_run:
                    from app.gateway.streaming.stream_middle_layer import start_post_middle_layer

                    middle_layer = start_post_middle_layer(
                        thread_id=lg_thread_id,
                        body=b"".join(body_chunks),
                        stream_format=stream_fmt,
                        run_id=lg_run_id,
                    )
                else:
                    ui_transform = PostStreamUiTransform(
                        thread_id=lg_thread_id,
                        body=b"".join(body_chunks),
                        stream_format=stream_fmt,
                        run_id=lg_run_id,
                        mirror_enabled=False,
                    )
                tee_on = bool(mirror_stream_resume and is_post_run)
                print(
                    f"[LG-ROUTE] ui_sse transform=ON format={stream_fmt} thread={lg_thread_id} "
                    f"route={route_kind} middle_layer={tee_on}",
                    file=sys.stderr,
                    flush=True,
                )
            except Exception:
                logger.warning(
                    "ui sse transform init failed thread=%s method=%s path=%s",
                    lg_thread_id,
                    method,
                    path,
                    exc_info=True,
                )
                ui_transform = None
                middle_layer = None

        if method == "POST" and "/runs/stream" in path:
            body_chunks = []
            _orig_receive = receive
            # Phone photos / multi-image JSON can arrive as hundreds of small ASGI chunks.
            # Cap was 100 and truncated the body, then replay marked more_body=False →
            # LangGraph orjson: "Invalid JSON in request body".
            _BODY_DRAIN_MAX_CHUNKS = 100_000
            _BODY_DRAIN_MAX_BYTES = 300 * 1024 * 1024

            async def _capture_body():
                msg = await _orig_receive()
                if msg.get("type") == "http.request":
                    chunk = msg.get("body", b"")
                    if chunk:
                        body_chunks.append(chunk)
                return msg

            # Eagerly drain the full request body, then replay to LangGraph.
            receive = _capture_body
            _body_bytes = 0
            _body_incomplete = False
            for _ in range(_BODY_DRAIN_MAX_CHUNKS):
                msg = await receive()
                if msg.get("type") == "http.request":
                    _body_bytes += len(msg.get("body", b"") or b"")
                    if _body_bytes > _BODY_DRAIN_MAX_BYTES:
                        _body_incomplete = True
                        logger.warning(
                            "POST /runs/stream body exceeded %s bytes while draining",
                            _BODY_DRAIN_MAX_BYTES,
                        )
                        break
                if not msg.get("more_body", True):
                    break
            else:
                _body_incomplete = True
                logger.warning(
                    "POST /runs/stream body drain hit chunk cap (%s)",
                    _BODY_DRAIN_MAX_CHUNKS,
                )

            if _body_incomplete:
                # Drain remainder so the client connection stays healthy, then 413.
                while True:
                    try:
                        rest = await _orig_receive()
                    except Exception:
                        break
                    if rest.get("type") != "http.request" or not rest.get("more_body", True):
                        break
                err = b'{"detail":"Request body too large"}'
                await send(
                    {
                        "type": "http.response.start",
                        "status": 413,
                        "headers": [
                            (b"content-type", b"application/json"),
                            (b"content-length", str(len(err)).encode("ascii")),
                        ],
                    }
                )
                await send({"type": "http.response.body", "body": err, "more_body": False})
                return

            # Parse the captured body for user_input_ts_ms + interactive multitask fix.
            _multitask_meta: dict | None = None
            if body_chunks:
                try:
                    parsed = json.loads(b"".join(body_chunks))
                    if isinstance(parsed, dict):
                        # evf_user_input_ts_ms is nested inside body.context
                        ctx = parsed.get("context") or {}
                        if isinstance(ctx, dict):
                            raw = ctx.get("evf_user_input_ts_ms") or ctx.get("user_input_ts_ms")
                            if raw is not None:
                                user_input_ts_ms = int(raw)
                            _prep: dict = {}
                            for _ck, _alias in (
                                ("evf_client_ensure_thread_ms", "client_ensure_thread_ms"),
                                ("evf_client_ensure_cache_hit", "client_ensure_cache_hit"),
                                ("evf_client_prep_ms", "client_prep_ms"),
                                ("evf_client_fetch_start_ms", "client_fetch_start_ms"),
                            ):
                                if _ck in ctx and ctx.get(_ck) is not None:
                                    _prep[_alias] = ctx.get(_ck)
                            if _prep:
                                _client_send_prep = _prep
                        # Also check top-level configurable (LangGraph style)
                        if user_input_ts_ms is None:
                            cfg = parsed.get("config") or {}
                            if isinstance(cfg, dict):
                                cg = cfg.get("configurable") or {}
                                if isinstance(cg, dict):
                                    raw = cg.get("evf_user_input_ts_ms") or cg.get("user_input_ts_ms")
                                    if raw is not None:
                                        user_input_ts_ms = int(raw)
                        # Fallback: top-level direct keys
                        if user_input_ts_ms is None:
                            raw = parsed.get("evf_user_input_ts_ms") or parsed.get("user_input_ts_ms")
                            if raw is not None:
                                user_input_ts_ms = int(raw)

                        # Interactive UI / employee chat: interrupt prior run instead of
                        # enqueue (zombie HOL → UI stuck on bootstrap「准备中…」).
                        # ★ ui_stream 必须以 ui_sse 为准，不能用 mirror_stream_resume：
                        # 后者是 stream-resume/tee 开关；普通聊天 ui_sse=1 时若误传 False，
                        # multitask 会保持 enqueue，旧 run 占槽 → 永远不 claim。
                        from app.gateway.streaming.post_stream_ui_normalize import (
                            ui_sse_enabled_from_query,
                        )
                        from evoflow.langgraph_run_config import (
                            apply_interactive_chat_multitask_strategy,
                        )

                        _ui_stream = bool(ui_sse_enabled_from_query(query)) or bool(
                            mirror_stream_resume
                        )
                        parsed, _multitask_meta = apply_interactive_chat_multitask_strategy(
                            parsed,
                            ui_stream=_ui_stream,
                        )
                        if _multitask_meta.get("changed"):
                            body_chunks = [json.dumps(parsed, ensure_ascii=False).encode("utf-8")]
                            print(
                                f"[LG-ROUTE] multitask_strategy "
                                f"{_multitask_meta.get('before')!r} -> "
                                f"{_multitask_meta.get('after')!r} "
                                f"reason={_multitask_meta.get('reason')} "
                                f"thread={lg_thread_id}",
                                file=sys.stderr,
                                flush=True,
                            )
                        try:
                            from evoflow.observability.thread_run_queue_log import (
                                log_thread_run_queue,
                            )

                            _sk = ""
                            if isinstance(ctx, dict):
                                _sk = str(ctx.get("session_key") or "").strip()
                            log_thread_run_queue(
                                "stream_post_prep",
                                thread_id=lg_thread_id or "",
                                session_key=_sk,
                                multitask_before=_multitask_meta.get("before"),
                                multitask_after=_multitask_meta.get("after")
                                or parsed.get("multitask_strategy"),
                                multitask_changed=bool(_multitask_meta.get("changed")),
                                multitask_reason=_multitask_meta.get("reason"),
                                ui_stream=_ui_stream,
                                employee_talk_mode=_multitask_meta.get("employee_talk_mode"),
                                source=_multitask_meta.get("source"),
                                body_bytes=sum(len(c) for c in body_chunks),
                            )
                        except Exception:
                            logger.debug(
                                "thread-run-queue stream_post_prep log failed",
                                exc_info=True,
                            )
                except (ValueError, json.JSONDecodeError, TypeError):
                    pass
            if user_input_ts_ms is not None:
                print(f"[LG-ROUTE] user_input_ts_ms={user_input_ts_ms}", file=sys.stderr, flush=True)

            # Build replay deque and wire up replay receive
            import collections as _lg_collections
            _body_replay = _lg_collections.deque()
            for _i, _chunk in enumerate(body_chunks):
                _is_last = _i == len(body_chunks) - 1
                _body_replay.append(
                    {"type": "http.request", "body": _chunk, "more_body": not _is_last}
                )
            if not body_chunks:
                _body_replay.append(
                    {"type": "http.request", "body": b"", "more_body": False}
                )

            async def _replay_body():
                if _body_replay:
                    return _body_replay.popleft()
                # Body 已完整 drain+replay；之后必须把 receive 交还给上游，
                # 供 SSE listen_for_disconnect 收取 http.disconnect。
                # 若继续伪造 http.request，BaseHTTPMiddleware 会报
                # Unexpected message received: http.request。
                return await _orig_receive()

            receive = _replay_body

        _init_ui_sse_transform()

        # --- Step 1: gateway_stream_post (replaces deleted catch-all proxy event) ---
        if method == "POST" and lg_thread_id:
            try:
                from evoflow.observability.run_latency_trace import write_run_latency_event as _rl_write
                now_ms = int(_lg_time.time() * 1000)
                evt = {"gateway_stream_post_ms": now_ms}
                if user_input_ts_ms is not None:
                    evt["user_input_ts_ms"] = user_input_ts_ms
                if _client_send_prep:
                    evt.update(_client_send_prep)
                _rl_write(lg_thread_id, "gateway_stream_post", evt)
            except Exception:
                pass

        response_started = False
        response_status = 0
        response_headers = {}
        body_logged = False
        is_stream_response = False
        stream_proxy_registered = False
        obs_logged = False
        _gs_upstream_ready_ms: int | None = None
        _gs_thread_id = lg_thread_id  # capture for heartbeat

        def _record_langgraph_obs(*, stream_status: str | None = None) -> None:
            nonlocal obs_logged
            if obs_logged:
                return
            obs_logged = True
            try:
                from app.gateway.gateway_obs_record import build_gateway_obs_payload, schedule_gateway_observability_record

                elapsed_ms = (_lg_time.monotonic() - t0) * 1000
                meta: dict[str, object] = {"source": "langgraph_mount"}
                if stream_status:
                    meta["stream_status"] = stream_status
                if lg_thread_id:
                    meta["thread_id"] = lg_thread_id
                schedule_gateway_observability_record(
                    build_gateway_obs_payload(
                        method=method,
                        path=path,
                        status_code=int(response_status or 500),
                        duration_ms=elapsed_ms,
                        query_string=query or None,
                        metadata=meta,
                    )
                )
            except Exception:
                logger.debug("langgraph observability record failed path=%s", path, exc_info=True)

        client_gone = False
        mirror_tail_launched = False

        def _resolved_mirror_run_id() -> str | None:
            if middle_layer is not None and middle_layer.run_id:
                return middle_layer.run_id
            if ui_transform is not None and getattr(ui_transform, "run_id", None):
                return str(ui_transform.run_id).strip() or None
            return lg_run_id

        def _launch_background_mirror_if_needed(*, reason: str = "") -> None:
            """Tail/join disabled — mirror only from StreamMiddleLayer POST upstream."""
            return

        async def _launch_background_mirror_fallback_if_needed(
            upstream_task: asyncio.Task[None] | None,
        ) -> None:
            return

        async def _drain_upstream_for_mirror(upstream_task: asyncio.Task[None] | None) -> None:
            """Keep LangGraph upstream draining after client left so transform can mirror."""
            if middle_layer is not None:
                return
            is_post_run_stream = (
                method == "POST"
                and lg_thread_id
                and "/runs/" in path
                and "stream" in path
            )
            if (
                upstream_task is None
                or upstream_task.done()
                or not mirror_stream_resume
                or not is_post_run_stream
            ):
                return
            logger.info(
                "[LG-ROUTE] draining upstream for mirror after disconnect thread=%s",
                lg_thread_id,
            )
            try:
                await asyncio.shield(upstream_task)
            except (asyncio.CancelledError, Exception):
                logger.debug(
                    "upstream mirror drain ended thread=%s done=%s",
                    lg_thread_id,
                    upstream_task.done(),
                    exc_info=True,
                )

        async def _safe_send(message: dict) -> None:
            nonlocal client_gone
            if client_gone:
                return
            try:
                await send(message)
            except (ConnectionResetError, BrokenPipeError, OSError):
                client_gone = True
            except asyncio.CancelledError:
                client_gone = True
                raise

        async def _logging_send(message):
            nonlocal response_started, response_status, response_headers, body_logged, is_stream_response, stream_proxy_registered
            if message["type"] == "http.response.start":
                response_status = message.get("status", 0)
                response_headers = {k.decode(): v.decode() for k, v in message.get("headers", [])}
                response_started = True
                elapsed_ms = int((_lg_time.monotonic() - t0) * 1000)
                ct = response_headers.get("content-type", "")
                is_stream = "text/event-stream" in ct
                is_stream_response = is_stream
                print(f"[LG-ROUTE] <<< {method} {path} -> {response_status} in {elapsed_ms}ms ct={ct[:50]} stream={is_stream}", file=sys.stderr, flush=True)
                logger.info("[LG-ROUTE] <<< %s %s -> %s in %sms ct=%s stream=%s", method, path, response_status, elapsed_ms, ct[:50], is_stream)

                if is_stream and lg_thread_id and "/runs/" in path and "stream" in path:
                    try:
                        from app.gateway.routers.langgraph_proxy import _touch_session_run_started

                        _touch_session_run_started(lg_thread_id, run_id=lg_run_id)
                        stream_proxy_registered = True
                    except Exception:
                        logger.debug(
                            "active stream register failed thread=%s",
                            lg_thread_id,
                            exc_info=True,
                        )

                # --- Step 2: gateway_upstream_ready (SSE response started) ---
                if is_stream and lg_thread_id:
                    try:
                        from evoflow.observability.run_latency_trace import write_run_latency_event as _rl_write
                        now_ms = int(_lg_time.time() * 1000)
                        evt = {
                            "gateway_upstream_ready_ms": now_ms,
                            "upstream_status": response_status,
                        }
                        if user_input_ts_ms is not None:
                            evt["user_input_ts_ms"] = user_input_ts_ms
                        _rl_write(lg_thread_id, "gateway_upstream_ready", evt)
                        # Record for Step 2.5 delta
                        _gs_upstream_ready_ms = now_ms
                    except Exception:
                        pass

                await _safe_send(message)
            elif message["type"] == "http.response.body":
                more = message.get("more_body", False)
                raw_body = message.get("body", b"")
                # Mirror persistence: background writer when stream-resume header is set.
                if (
                    ui_transform is None
                    and not mirror_stream_resume
                    and is_stream_response
                    and lg_thread_id
                    and raw_body
                    and "/runs/" in path
                    and "stream" in path
                ):
                    try:
                        from app.gateway.streaming.stream_mirror import enqueue_wire_chunk_sync

                        enqueue_wire_chunk_sync(lg_thread_id, raw_body, run_id=lg_run_id)
                    except Exception:
                        pass
                if not body_logged:
                    body_logged = True
                    chunk_preview = ""
                    raw = message.get("body", b"")
                    if raw:
                        text = raw[:120].decode("utf-8", errors="replace")
                        chunk_preview = f" first={text!r}"
                    print(f"[LG-ROUTE] ~body~ {method} {path} more={more}{chunk_preview}", file=sys.stderr, flush=True)

                    # --- Step 4: gateway_first_token (first SSE data chunk) ---
                    if lg_thread_id:
                        try:
                            from evoflow.observability.run_latency_trace import write_run_latency_event as _rl_write
                            now_ms = int(_lg_time.time() * 1000)
                            evt = {"gateway_first_token_ts_ms": now_ms}
                            if user_input_ts_ms is not None:
                                evt["user_input_ts_ms"] = user_input_ts_ms
                            _rl_write(lg_thread_id, "gateway_first_token", evt)
                            # Step 2.5: show queue/processing wait time (Step 4 - Step 2)
                            if _gs_upstream_ready_ms is not None:
                                gap_ms = now_ms - _gs_upstream_ready_ms
                                total_ms = now_ms - t0_wall_ms
                                print(f"[LG-ROUTE] ⏱ Step2→Step4 gap={gap_ms}ms total={total_ms}ms", file=sys.stderr, flush=True)
                                _rl_write(lg_thread_id, "gateway_upstream_processing", {
                                    "gateway_upstream_processing_ms": now_ms,
                                    "user_input_ts_ms": _gs_upstream_ready_ms,
                                })
                        except Exception:
                            pass
                elif not more and lg_thread_id:
                    # --- Step 6: gateway_stream_end (SSE stream finished) ---
                    try:
                        from evoflow.observability.run_latency_trace import write_run_latency_event as _rl_write
                        now_ms = int(_lg_time.time() * 1000)
                        evt = {"gateway_stream_end_ms": now_ms}
                        if user_input_ts_ms is not None:
                            evt["user_input_ts_ms"] = user_input_ts_ms
                        _rl_write(lg_thread_id, "gateway_stream_end", evt)
                    except Exception:
                        pass
                    try:
                        from evoflow.observability.thread_run_queue_log import (
                            log_thread_run_queue,
                        )

                        _dur_ms = int((_lg_time.monotonic() - t0) * 1000)
                        log_thread_run_queue(
                            "gateway_stream_end",
                            level=logging.WARNING if _dur_ms >= 30_000 else logging.INFO,
                            thread_id=lg_thread_id or "",
                            duration_ms=_dur_ms,
                            client_stream_resume=bool(mirror_stream_resume),
                            note=(
                                "if stuck on 准备中 with no lg_queue_claim above, "
                                "prior run likely held the thread (enqueue HOL)"
                                if _dur_ms >= 5_000
                                else None
                            ),
                        )
                    except Exception:
                        pass
                    try:
                        from evoflow.observability.run_latency_trace import clear_live_progress
                        clear_live_progress(lg_thread_id)
                    except Exception:
                        pass
                    if is_stream_response and not mirror_stream_resume:
                        try:
                            from app.gateway.streaming.stream_mirror import shrink_mirror_for_thread

                            shrink_mirror_for_thread(lg_thread_id)
                        except Exception:
                            pass
                    if stream_proxy_registered and lg_thread_id:
                        try:
                            from app.gateway.routers.langgraph_proxy import unregister_active_stream_proxy

                            unregister_active_stream_proxy(lg_thread_id)
                            stream_proxy_registered = False
                        except Exception:
                            logger.debug(
                                "active stream unregister failed thread=%s",
                                lg_thread_id,
                                exc_info=True,
                            )

                if not more:
                    _record_langgraph_obs(
                        stream_status="completed" if is_stream_response else None,
                    )

                await _safe_send(message)

        async def _dispatch_send(message):
            nonlocal ui_transform
            if ui_transform is not None:
                if message.get("type") == "http.response.start":
                    hdrs = {
                        k.decode("latin-1"): v.decode("latin-1")
                        for k, v in message.get("headers", [])
                    }
                    ct = str(hdrs.get("content-type") or "")
                    status = int(message.get("status") or 200)
                    is_ui_sse_stream = (
                        method == "POST" and "/runs/stream" in path
                    )
                    if status >= 400 or (
                        not is_ui_sse_stream and "text/event-stream" not in ct.lower()
                    ):
                        print(
                            f"[LG-ROUTE] ui_sse transform=OFF passthrough status={status} ct={ct!r}",
                            file=sys.stderr,
                            flush=True,
                        )
                        ui_transform = None
                        await _logging_send(message)
                        return
                if ui_transform is not None:
                    async for out_msg in ui_transform.process_asgi_message(message):
                        await _logging_send(out_msg)
                    return
            await _logging_send(message)

        # Heartbeat: report waiting state on stderr every 10s
        heartbeat_task = None

        def _read_progress(tid: str | None) -> str:
            if not tid:
                return ""
            try:
                from evoflow.observability.run_latency_trace import get_live_progress
                p = get_live_progress(tid)
                return f" [{p}]" if p else ""
            except Exception:
                return ""

        async def _heartbeat():
            try:
                while True:
                    await asyncio.sleep(2)
                    elapsed_s = int(_lg_time.monotonic() - t0)
                    if not response_started:
                        progress = _read_progress(_gs_thread_id)
                        print(f"[LG-ROUTE] ...等待 LangGraph 接受请求 ({elapsed_s}s){progress}", file=sys.stderr, flush=True)
                    elif not body_logged:
                        progress = _read_progress(_gs_thread_id)
                        print(f"[LG-ROUTE] ...SSE 已开启,等待第一个 token ({elapsed_s}s){progress}", file=sys.stderr, flush=True)
                    else:
                        break
            except asyncio.CancelledError:
                pass

        # --- Step 1.5: gateway_pre_dispatch (after body captured, before calling LangGraph) ---
        if method == "POST" and lg_thread_id:
            try:
                from evoflow.observability.run_latency_trace import write_run_latency_event as _rl_write
                _rl_write(lg_thread_id, "gateway_pre_dispatch", {
                    "gateway_pre_dispatch_ms": int(_lg_time.time() * 1000),
                    "user_input_ts_ms": user_input_ts_ms,
                })
            except Exception:
                pass

        # Optional emergency only (EVOFLOW_CHAT_PREEMPT_PROACTIVE=1). Default:
        # multi-session — never cancel other threads for chat.
        if (
            method == "POST"
            and lg_thread_id
            and "/runs/" in path
            and "stream" in path
        ):
            try:
                from app.gateway.interactive_run_preempt import (
                    chat_preempt_proactive_enabled,
                    preempt_background_runs_for_chat,
                )

                if chat_preempt_proactive_enabled():
                    await asyncio.wait_for(
                        preempt_background_runs_for_chat(
                            chat_thread_id=lg_thread_id,
                            reason="chat_runs_stream",
                        ),
                        timeout=3.0,
                    )
            except Exception:
                logger.debug("interactive preempt before chat stream failed", exc_info=True)

        is_post_run_stream = (
            method == "POST"
            and lg_thread_id
            and "/runs/" in path
            and "stream" in path
        )

        upstream_task: asyncio.Task[None] | None = None
        try:
            heartbeat_task = asyncio.create_task(_heartbeat())
            if middle_layer is not None:
                from app.gateway.streaming.stream_middle_layer import pump_post_through_middle_layer

                await pump_post_through_middle_layer(
                    layer=middle_layer,
                    lg_app=self.app,
                    scope=scope,
                    request_body=b"".join(body_chunks) if body_chunks else b"",
                    deliver_asgi=_logging_send,
                    client_gone=lambda: client_gone,
                )
            else:
                upstream_task = asyncio.create_task(self.app(scope, receive, _dispatch_send))
                await upstream_task
        except asyncio.CancelledError:
            client_gone = True
            if middle_layer is None:
                await _drain_upstream_for_mirror(upstream_task)
                await _launch_background_mirror_fallback_if_needed(upstream_task)
            return
        except Exception as e:
            elapsed_ms = int((_lg_time.monotonic() - t0) * 1000)
            print(f"[LG-ROUTE] !!! {method} {path} EXCEPTION after {elapsed_ms}ms: {type(e).__name__}: {e}", file=sys.stderr, flush=True)
            logger.error("[LG-ROUTE] !!! %s %s EXCEPTION after %sms: %s: %s", method, path, elapsed_ms, type(e).__name__, e)
            raise
        finally:
            is_post_run_stream = (
                method == "POST"
                and lg_thread_id
                and "/runs/" in path
                and "stream" in path
            )
            should_launch_bg = False
            launch_reason = ""
            if mirror_stream_resume and is_post_run_stream and not mirror_tail_launched and middle_layer is None:
                if client_gone:
                    should_launch_bg = True
                    launch_reason = "client_gone"
                elif lg_thread_id:
                    try:
                        from app.gateway.streaming.stream_mirror_background import is_run_still_active

                        still = await is_run_still_active(
                            thread_id=lg_thread_id,
                            run_id=_resolved_mirror_run_id(),
                        )
                        if still:
                            should_launch_bg = True
                            launch_reason = "post_stream_ended_run_still_active"
                    except Exception:
                        logger.debug(
                            "mirror finally probe failed thread=%s",
                            lg_thread_id,
                            exc_info=True,
                        )
            if should_launch_bg:
                _launch_background_mirror_if_needed(reason=launch_reason)
            elif mirror_stream_resume and is_post_run_stream:
                pass
            if ui_transform is not None and lg_thread_id:
                try:
                    async for out_msg in ui_transform.close_stream():
                        await _logging_send(out_msg)
                except Exception:
                    logger.debug(
                        "post stream ui transform close failed thread=%s",
                        lg_thread_id,
                        exc_info=True,
                    )
                try:
                    from app.gateway.streaming.session_stream_inject import end_thread_inject

                    end_thread_inject(lg_thread_id)
                except Exception:
                    logger.debug(
                        "post stream inject end failed thread=%s",
                        lg_thread_id,
                        exc_info=True,
                    )
            if stream_proxy_registered and lg_thread_id and middle_layer is None:
                try:
                    from app.gateway.routers.langgraph_proxy import unregister_active_stream_proxy

                    unregister_active_stream_proxy(lg_thread_id)
                except Exception:
                    logger.debug(
                        "active stream unregister failed in finally thread=%s",
                        lg_thread_id,
                        exc_info=True,
                    )
            if heartbeat_task:
                heartbeat_task.cancel()
                try:
                    await heartbeat_task
                except asyncio.CancelledError:
                    pass
            if not obs_logged and response_started:
                _record_langgraph_obs(
                    stream_status="cancelled" if client_gone and is_stream_response else None,
                )

        if not response_started:
            elapsed_ms = int((_lg_time.monotonic() - t0) * 1000)
            print(f"[LG-ROUTE] !!! {method} {path} NO RESPONSE sent in {elapsed_ms}ms (handler returned without sending any response)", file=sys.stderr, flush=True)
            logger.warning("[LG-ROUTE] !!! %s %s NO RESPONSE in %sms", method, path, elapsed_ms)


def install_langgraph_route_logger(app: FastAPI) -> None:
    """Register LangGraph route logger (must run before uvicorn startup)."""
    app.add_middleware(LangGraphRouteLoggerMiddleware)
