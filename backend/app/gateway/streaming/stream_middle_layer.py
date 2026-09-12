"""Stream middle layer: owns LangGraph upstream, writes mirror DB, fans out to subscribers.

Architecture::

    LangGraph upstream ──► MiddleLayer (transform + DB)
                                ├──► Proxy / browser (POST SSE subscriber)
                                └──► stream-resume live subscriber

When the browser disconnects (F5), the proxy subscriber detaches; upstream keeps
running on the same middle layer until the LangGraph run finishes.
"""

from __future__ import annotations

import asyncio
import json
import logging
import threading
import time
from collections.abc import AsyncIterator, Awaitable, Callable
from typing import Any

from evoflow.agents.tool_approval_trace_log import log_tool_approval_trace

logger = logging.getLogger(__name__)

_SENTINEL = object()
_LOCK = threading.Lock()
_LAYERS: dict[str, StreamMiddleLayer] = {}

# Max wall-clock seconds to wait for a LangGraph resume run to finish.
# If exceeded, the resume is considered timed out and the stream falls back
# to background SSE mode.
_RESUME_TIMEOUT_S = 300.0  # 5 minutes

# Max wall-clock seconds to wait for the resume worker thread to start.
# If the thread doesn't begin producing output within this window, the
# resume is aborted and the caller falls back to background SSE.
_RESUME_STARTUP_TIMEOUT_S = 8.0

# Max wall-clock seconds _resume_in_flight may remain True before
# should_hold_stream_open() returns False (safety valve).
_RESUME_IN_FLIGHT_TIMEOUT_S = 600.0  # 10 minutes

# Max wall-clock seconds for the _await_run_completion defer loop before
# it forcibly exits to avoid permanent deadlock.
_DEFER_LOOP_MAX_S = 1800.0  # 30 minutes

# ── Upstream heartbeat detection ───────────────────────────────────────
# Timeout when upstream (LangGraph) sends no data for this many seconds.
# LLM thinking can take 60-90s for long prompts, so we use 120s as a
# conservative threshold.
_UPSTREAM_SILENCE_TIMEOUT_S = 120.0


def _reset_sse_starlette_app_status() -> None:
    """Reset sse_starlette global exit event so a new worker loop can stream safely."""
    try:
        from sse_starlette.sse import AppStatus

        AppStatus.should_exit = False
        AppStatus.should_exit_event = None
    except Exception:
        logger.debug("reset sse_starlette AppStatus failed", exc_info=True)


class _LayerLangGraphLoop:
    """Persistent asyncio loop per middle layer (initial run + resume share one thread)."""

    def __init__(self, *, thread_id: str = "") -> None:
        self._thread_id = str(thread_id or "").strip()
        self._loop: asyncio.AbstractEventLoop | None = None
        self._thread: threading.Thread | None = None
        self._ready = threading.Event()
        self._lock = threading.Lock()

    def _thread_main(self) -> None:
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        self._loop = loop
        self._ready.set()
        logger.info(
            "【LangGraph·worker】专用 loop 已启动 thread=%s loop_thread=%s",
            self._thread_id,
            threading.current_thread().name,
        )
        try:
            loop.run_forever()
        finally:
            try:
                loop.run_until_complete(loop.shutdown_asyncgens())
            except Exception:
                pass
            try:
                loop.close()
            except Exception:
                pass
            self._loop = None
            logger.info("【LangGraph·worker】专用 loop 已关闭 thread=%s", self._thread_id)

    def ensure(self) -> asyncio.AbstractEventLoop:
        with self._lock:
            if self._thread is None or not self._thread.is_alive():
                self._ready.clear()
                self._thread = threading.Thread(
                    target=self._thread_main,
                    name=f"evoflow-lg-{self._thread_id[:8] or 'layer'}",
                    daemon=True,
                )
                self._thread.start()
        if not self._ready.wait(timeout=30.0):
            raise RuntimeError(f"LangGraph worker loop start timeout thread={self._thread_id}")
        loop = self._loop
        if loop is None:
            raise RuntimeError(f"LangGraph worker loop missing thread={self._thread_id}")
        return loop

    def run(self, coro: Any) -> Any:
        loop = self.ensure()
        _reset_sse_starlette_app_status()
        future = asyncio.run_coroutine_threadsafe(coro, loop)
        try:
            return future.result()
        except Exception as exc:
            logger.error(
                "【LangGraph·worker】lg_app 执行异常 thread=%s err=%s",
                self._thread_id,
                exc,
            )
            raise

    async def run_async(self, coro: Any, *, timeout: float = 8.0) -> Any:
        """异步执行协程在 worker loop 上，带超时。

        与 ``run()`` 的区别：返回 awaitable，不会阻塞调用方的事件循环。
        超时后抛出 asyncio.TimeoutError。
        """
        loop = self.ensure()
        _reset_sse_starlette_app_status()
        future = asyncio.run_coroutine_threadsafe(coro, loop)
        wrapped = asyncio.wrap_future(future)  # type: ignore[arg-type]
        try:
            return await asyncio.wait_for(wrapped, timeout=timeout)
        except asyncio.TimeoutError:
            logger.warning(
                "【LangGraph·worker】lg_app 异步执行超时 thread=%s timeout=%.1fs",
                self._thread_id,
                timeout,
            )
            raise
        except Exception as exc:
            logger.error(
                "【LangGraph·worker】lg_app 异步执行异常 thread=%s err=%s",
                self._thread_id,
                exc,
            )
            raise

    def shutdown(self) -> None:
        loop = self._loop
        thread = self._thread
        if loop is None or thread is None:
            return
        try:
            loop.call_soon_threadsafe(loop.stop)
        except Exception:
            logger.debug("LangGraph worker loop stop failed thread=%s", self._thread_id, exc_info=True)
        thread.join(timeout=8.0)
        self._thread = None
        self._loop = None
        self._ready.clear()


def _tid_key(thread_id: str) -> str:
    return str(thread_id or "").strip()


def _signal_queue_end(queue: asyncio.Queue[Any], *, thread_id: str = "") -> None:
    """Deliver stream-end sentinel without raising QueueFull."""
    try:
        queue.put_nowait(_SENTINEL)
        return
    except asyncio.QueueFull:
        pass
    while True:
        try:
            queue.get_nowait()
        except asyncio.QueueEmpty:
            break
    try:
        queue.put_nowait(_SENTINEL)
    except asyncio.QueueFull:
        logger.warning(
            "middle layer could not deliver stream end sentinel thread=%s",
            thread_id or "?",
        )


class StreamMiddleLayer:
    """One upstream pump per thread; multiple downstream subscribers."""

    def __init__(
        self,
        *,
        thread_id: str,
        body: bytes = b"",
        stream_format: str = "agui",
        run_id: str | None = None,
    ) -> None:
        from app.gateway.streaming.post_stream_ui_normalize import PostStreamUiTransform

        self.thread_id = _tid_key(thread_id)
        # Best-effort resolve session_key at construction time (when the session
        # row is guaranteed to exist from the POST body) so _finish_layer can pass
        # it directly to force_end_session_turn. At finish time the 5s TTL cache
        # in find_session_key_by_thread_id may have expired AND the session row
        # lookup may race with other writes — passing the cached value avoids the
        # silent False-return path that leaves DB run_status stuck on "running".
        self.session_key: str | None = None
        try:
            from evoflow.persistence.session_repositories import find_session_key_by_thread_id

            sk = find_session_key_by_thread_id(self.thread_id)
            self.session_key = str(sk).strip() if sk else None
        except Exception:
            logger.debug("StreamMiddleLayer init: resolve session_key failed thread=%s", self.thread_id, exc_info=True)
        self._transform = PostStreamUiTransform(
            thread_id=self.thread_id,
            body=body,
            stream_format=stream_format if stream_format in {"agui", "openai"} else "agui",
            run_id=run_id,
            mirror_enabled=True,
            mirror_source="middle-layer",
            mirror_lane_owned=True,
        )
        self._asgi_subscribers: list[asyncio.Queue[Any]] = []
        self._wire_subscribers: list[asyncio.Queue[Any]] = []
        self._upstream_task: asyncio.Task[None] | None = None
        self._finished = asyncio.Event()
        self._started = False
        self._tool_pause = False
        self._stream_proxy_registered = False
        self._inject_wake = asyncio.Event()
        self._inject_pump_task: asyncio.Task[None] | None = None
        self._upstream_in_q: asyncio.Queue[Any] | None = None
        self._upstream_pump_task: asyncio.Task[None] | None = None
        self._resume_in_flight = False
        self._resume_start_time: float = 0.0
        self._resume_task: asyncio.Task[None] | None = None
        self._lg_loop = _LayerLangGraphLoop(thread_id=self.thread_id)

        # ── Upstream heartbeat detection state ─────────────────────────
        self._last_upstream_data_time: float = time.monotonic()
        self._is_proactive_run: bool = self._detect_proactive_from_body(body)

    @staticmethod
    def _detect_proactive_from_body(body: bytes) -> bool:
        """Detect if this run is a proactive (autonomous) run from POST body.

        Proactive runs set ``context.proactive_process`` or ``metadata.source == "proactive_execute"``
        in the LangGraph POST body (see execution_bridge.py).
        """
        if not body:
            return False
        try:
            raw = json.loads(body.decode("utf-8"))
        except Exception:
            return False
        if not isinstance(raw, dict):
            return False
        # Check context.proactive_process (primary signal)
        ctx = raw.get("context")
        if isinstance(ctx, dict):
            if ctx.get("proactive_process"):
                return True
            # Also check source field in context
            source = str(ctx.get("source") or "").strip().lower()
            if source == "proactive_execute":
                return True
        # Check metadata.source as fallback
        meta = raw.get("metadata")
        if isinstance(meta, dict):
            source = str(meta.get("source") or "").strip().lower()
            if source == "proactive_execute":
                return True
        return False

    @property
    def transform(self) -> Any:
        return self._transform

    @property
    def run_id(self) -> str | None:
        rid = getattr(self._transform, "run_id", None)
        return str(rid).strip() if rid else None

    @property
    def in_tool_pause(self) -> bool:
        return self._tool_pause

    def should_hold_stream_open(self) -> bool:
        """True while resume lg_app is still in flight.

        Safety valve: if ``_resume_in_flight`` has been True for longer than
        ``_RESUME_IN_FLIGHT_TIMEOUT_S``, returns False to prevent the defer
        loop from waiting forever.  This guards against a stuck resume where
        the LangGraph worker thread hangs or the background task is leaked.

        NOTE: ``_tool_pause`` is intentionally excluded — it is set to True
        inside ``_await_run_completion`` whose while-condition calls this
        method via ``_should_defer_run_finished_async``.  Including it would
        create a circular dependency that prevents the loop from ever exiting
        (the flag is only cleared in the finally block *after* the loop).
        """
        if not self._resume_in_flight:
            return False
        elapsed = time.monotonic() - self._resume_start_time
        if elapsed > _RESUME_IN_FLIGHT_TIMEOUT_S:
            log_tool_approval_trace("middle_layer·resume_in_flight超时", thread_id=self.thread_id, side="middle_layer",
                level=logging.WARNING, event_data={"elapsed_s": elapsed, "timeout_s": _RESUME_IN_FLIGHT_TIMEOUT_S})
            logger.warning(
                "【中间层】_resume_in_flight 超时释放 thread=%s elapsed=%.1fs > %.1fs",
                self.thread_id,
                elapsed,
                _RESUME_IN_FLIGHT_TIMEOUT_S,
            )
            self._resume_in_flight = False
            return False
        return True

    def is_active(self) -> bool:
        return self._started and not self._finished.is_set()

    def matches_run(self, run_id: str | None) -> bool:
        rid = str(run_id or "").strip()
        if not rid:
            return True
        layer_rid = self.run_id
        return not layer_rid or layer_rid == rid

    async def run_upstream(
        self,
        lg_app: Any,
        scope: dict[str, Any],
        *,
        request_body: bytes = b"",
    ) -> None:
        """Pump LangGraph ASGI; keep middle layer alive only while tool-approval / collab inject may resume."""
        from app.gateway.streaming.post_stream_ui_normalize import _should_defer_run_finished_async

        self._started = True
        self._inject_pump_task = asyncio.create_task(self._inject_pump_loop())
        await self._start_upstream_send_pump()
        try:
            await self._invoke_lg_app_on_worker(
                lg_app,
                scope,
                body=request_body,
                label="initial",
            )
            await self._wait_upstream_drained()
            if await _should_defer_run_finished_async(self.thread_id):
                await self._await_run_completion()
            else:
                async for out_msg in self._transform.close_stream():
                    await self._emit_asgi(out_msg)
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("middle layer upstream error thread=%s", self.thread_id)
            raise
        finally:
            await self._stop_upstream_send_pump()
            if self._inject_pump_task is not None and not self._inject_pump_task.done():
                self._inject_pump_task.cancel()
                try:
                    await self._inject_pump_task
                except asyncio.CancelledError:
                    pass
            await self._finish_layer()

    async def _await_run_completion(self) -> None:
        """Only while tool-approval or collab inject may resume on the same middle layer.

        Safety improvements over the original implementation:
        1. Hard timeout of ``_DEFER_LOOP_MAX_S`` (30 min) — exits forcibly to
           avoid permanent deadlock if the defer condition is stuck.
        2. Warning log every 30 seconds of waiting so operators can diagnose
           stalled tool-approval flows.
        3. Consecutive-stable-poll detection: if 10 polls in a row return the
           same defer=True result, force-invalidate the cache and re-check to
           break out of a stale-cache loop.
        """
        from app.gateway.streaming.post_stream_ui_normalize import (
            _should_defer_run_finished_async,
            defer_completion_poll_interval,
            invalidate_defer_run_finished_cache,
        )

        self._tool_pause = True
        poll_s = defer_completion_poll_interval(0)
        stable_timeouts = 0
        _loop_start = time.monotonic()
        _last_warn_log: float = 0.0
        _consecutive_stable = 0
        _CONSECUTIVE_STABLE_MAX = 10
        log_tool_approval_trace("middle_layer·进入defer循环", thread_id=self.thread_id, side="middle_layer",
            event_data={"reason": "等待工具授权/协作注入完成"})
        logger.info("【中间层】等待工具授权/协作注入完成 thread=%s", self.thread_id)
        try:
            while await _should_defer_run_finished_async(self.thread_id):
                # Hard timeout: if we've been waiting longer than the max,
                # exit the loop to avoid permanent deadlock.
                elapsed = time.monotonic() - _loop_start
                if elapsed > _DEFER_LOOP_MAX_S:
                    log_tool_approval_trace("middle_layer·defer循环超时退出", thread_id=self.thread_id, side="middle_layer",
                        level=logging.ERROR, event_data={"reason": "超过30分钟最大等待", "elapsed_s": elapsed})
                    logger.error(
                        "【中间层】defer 循环超时强制退出 thread=%s elapsed=%.1fs > %.1fs",
                        self.thread_id,
                        time.monotonic() - _loop_start,
                        _DEFER_LOOP_MAX_S,
                    )
                    break

                # Periodic warning log so operators can diagnose stalls.
                _now = time.monotonic()
                if _now - _last_warn_log > 30.0:
                    logger.warning(
                        "【中间层】工具审批仍在等待 thread=%s elapsed=%.1fs stable_timeouts=%s",
                        self.thread_id,
                        _now - _loop_start,
                        stable_timeouts,
                    )
                    _last_warn_log = _now

                # Clear the wake event before waiting so external wake_inject()
                # calls (from resume_command_upstream / inject side-channel) can
                # actually unblock us.  Calling wake_inject() here would set the
                # event, making wait() return instantly -> busy loop that starves
                # the SSE send pump.
                self._inject_wake.clear()
                try:
                    await asyncio.wait_for(self._inject_wake.wait(), timeout=poll_s)
                    invalidate_defer_run_finished_cache(self.thread_id)
                    stable_timeouts = 0
                    _consecutive_stable = 0
                    poll_s = defer_completion_poll_interval(0)
                except TimeoutError:
                    stable_timeouts += 1
                    _consecutive_stable += 1
                    poll_s = defer_completion_poll_interval(stable_timeouts)

                    # Self-heal: if many consecutive polls all timed out with
                    # defer still True, force-invalidate cache and re-check.
                    if _consecutive_stable >= _CONSECUTIVE_STABLE_MAX:
                        logger.warning(
                            "【中间层】连续 %s 次 poll 超时，触发强制重查 thread=%s",
                            _CONSECUTIVE_STABLE_MAX,
                            self.thread_id,
                        )
                        invalidate_defer_run_finished_cache(self.thread_id)
                        _consecutive_stable = 0
                        # Re-check immediately: if _should_defer returns False
                        # now, the while condition will exit.
                        continue

                await asyncio.sleep(0)
        finally:
            self._tool_pause = False
            invalidate_defer_run_finished_cache(self.thread_id)
            log_tool_approval_trace("middle_layer·defer循环退出", thread_id=self.thread_id, side="middle_layer",
                event_data={"reason": "should_defer返回False"})
            logger.info("【中间层】工具授权/协作等待结束 thread=%s", self.thread_id)
        await self._wait_upstream_drained()
        async for out_msg in self._transform.close_stream():
            await self._emit_asgi(out_msg)

    async def _start_upstream_send_pump(self) -> None:
        if self._upstream_pump_task is not None and not self._upstream_pump_task.done():
            return
        self._upstream_in_q = asyncio.Queue(maxsize=4096)
        self._upstream_pump_task = asyncio.create_task(self._upstream_send_pump_loop())

    async def _stop_upstream_send_pump(self) -> None:
        q = self._upstream_in_q
        task = self._upstream_pump_task
        if q is not None:
            try:
                q.put_nowait(_SENTINEL)
            except asyncio.QueueFull:
                while True:
                    try:
                        q.get_nowait()
                    except asyncio.QueueEmpty:
                        break
                try:
                    q.put_nowait(_SENTINEL)
                except asyncio.QueueFull:
                    pass
        if task is not None and not task.done():
            try:
                await task
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.exception("upstream send pump stop failed thread=%s", self.thread_id)
        self._upstream_pump_task = None
        self._upstream_in_q = None

    def _offer_upstream_send(self, message: dict[str, Any]) -> None:
        q = self._upstream_in_q
        if q is None:
            return
        try:
            q.put_nowait(message)
        except asyncio.QueueFull:
            logger.warning("upstream send queue full thread=%s", self.thread_id)

    async def _upstream_send_pump_loop(self) -> None:
        """Pump ASGI messages from upstream queue to subscribers with heartbeat detection.

        Adds timeout guard on queue reads to detect when LangGraph stops sending data
        (e.g., LLM API hangs without error). Proactive runs get a longer grace period
        since they have engine.py's 300s timeout as ultimate safety net.

        R2-1: Sends SSE ping comments (`: ping\\n\\n`) periodically to keep the
        connection alive through proxies/load balancers that may timeout on idle.
        """
        q = self._upstream_in_q
        if q is None:
            return
        _last_ping_time = time.monotonic()
        _PING_INTERVAL_S = 30.0  # Send ping every 30s of silence
        while True:
            # Wait for next message with timeout to detect upstream silence
            try:
                message = await asyncio.wait_for(
                    q.get(),
                    timeout=_UPSTREAM_SILENCE_TIMEOUT_S,
                )
                # Reset heartbeat timer on any received message
                self._last_upstream_data_time = time.monotonic()
                _last_ping_time = time.monotonic()  # Reset ping timer on data
            except asyncio.TimeoutError:
                elapsed = time.monotonic() - self._last_upstream_data_time
                logger.warning(
                    "middle_layer: upstream silent for %.0fs thread=%s proactive=%s",
                    elapsed,
                    self.thread_id,
                    self._is_proactive_run,
                )
                # R2-1: Send SSE ping to keep connection alive
                now = time.monotonic()
                if now - _last_ping_time >= _PING_INTERVAL_S:
                    try:
                        await self._emit_asgi({
                            "type": "http.response.body",
                            "body": b": ping\n\n",
                            "more_body": True,
                        })
                        _last_ping_time = now
                    except Exception:
                        logger.debug("SSE ping emit failed thread=%s", self.thread_id, exc_info=True)
                if self._is_proactive_run:
                    # Proactive run: has engine.py 300s timeout as ultimate safety net.
                    # Just log and reset timer to avoid repeated warnings.
                    self._last_upstream_data_time = time.monotonic()
                    continue
                else:
                    # User chat run: upstream likely dead, disconnect to allow reconnection
                    logger.error(
                        "middle_layer: upstream dead, disconnecting thread=%s",
                        self.thread_id,
                    )
                    break

            if message is _SENTINEL:
                break
            # Drain barrier: _wait_upstream_drained() enqueues this marker to
            # block until every preceding ASGI message has been transformed.
            if isinstance(message, dict) and message.get("__drain_barrier__"):
                fut = message.get("__future__")
                if fut is not None and not fut.done():
                    fut.set_result(None)
                continue
            if not isinstance(message, dict):
                continue
            try:
                async for out_msg in self._transform.process_asgi_message(message):
                    await self._emit_asgi(out_msg)
            except Exception:
                logger.exception("upstream send pump error thread=%s", self.thread_id)
            await asyncio.sleep(0)

    async def _wait_upstream_drained(self) -> None:
        """Block until the send pump has processed every queued ASGI message.

        Worker-thread ``_send`` uses ``call_soon_threadsafe`` to enqueue ASGI
        messages onto ``_upstream_in_q``.  When ``_invoke_lg_app_on_worker``
        returns, the callbacks have fired (messages are in the queue) but the
        pump may still be transforming them inside ``process_asgi_message``.

        Calling ``close_stream()`` before the pump finishes causes ``run_end``
        / ``TEXT_MESSAGE_END`` to precede the final content deltas, so the
        browser sees a truncated reply (text cuts off mid-sentence).
        """
        q = self._upstream_in_q
        pump = self._upstream_pump_task
        if q is None or pump is None or pump.done():
            return
        loop = asyncio.get_running_loop()
        done = loop.create_future()
        try:
            q.put_nowait({"__drain_barrier__": True, "__future__": done})
        except asyncio.QueueFull:
            while not q.empty():
                await asyncio.sleep(0.005)
            return
        try:
            await asyncio.wait_for(done, timeout=10.0)
        except (asyncio.TimeoutError, asyncio.CancelledError):
            pass

    async def _inject_pump_loop(self) -> None:
        """Unified inject side-channel: ag-ui → mirror DB + browser subscribers."""
        poll_s = 0.2
        while not self._finished.is_set():
            self._inject_wake.clear()
            try:
                await asyncio.wait_for(self._inject_wake.wait(), timeout=poll_s)
            except TimeoutError:
                pass
            await self._drain_inject_once()

    async def _invoke_lg_app_on_worker(
        self,
        lg_app: Any,
        scope: dict[str, Any],
        *,
        body: bytes = b"",
        label: str = "upstream",
        timeout: float | None = None,
    ) -> None:
        """Run in-process LangGraph ASGI on a worker thread so the gateway loop stays responsive.

        When *timeout* is set (seconds), the function will raise
        ``asyncio.TimeoutError`` if the LangGraph run exceeds that duration.
        Used by ``resume_command_upstream`` to avoid blocking the event loop
        indefinitely.
        """
        main_loop = asyncio.get_running_loop()
        tid = self.thread_id
        t0 = time.perf_counter()
        body_copy = bytes(body)
        logger.info(
            "middle layer lg_app start thread=%s label=%s body_bytes=%s",
            tid,
            label,
            len(body_copy),
        )
        if label == "tool_approval_resume":
            logger.info(
                "【工具授权·同SSE】LangGraph resume 开始 thread=%s body_bytes=%s",
                tid,
                len(body_copy),
            )

        def _run_on_layer_loop() -> None:
            body_delivered = False

            async def _receive() -> dict[str, Any]:
                nonlocal body_delivered
                if body_copy and not body_delivered:
                    body_delivered = True
                    return {"type": "http.request", "body": body_copy, "more_body": False}
                # Shield http.disconnect on worker loop (browser F5 must not kill upstream).
                await asyncio.Event().wait()
                return {"type": "http.disconnect"}  # pragma: no cover

            async def _send(message: dict[str, Any]) -> None:
                main_loop.call_soon_threadsafe(self._offer_upstream_send, message)

            async def _go() -> None:
                await lg_app(scope, _receive, _send)

            if timeout is not None:
                # Use run_async with timeout — non-blocking on the main loop.
                try:
                    self._lg_loop.run_async(_go(), timeout=timeout)
                except asyncio.TimeoutError:
                    # Re-raise on the calling thread so the outer try/except
                    # can distinguish timeout from other errors.
                    raise
            else:
                self._lg_loop.run(_go())

        try:
            await asyncio.to_thread(_run_on_layer_loop)
        except asyncio.TimeoutError:
            raise
        finally:
            _reset_sse_starlette_app_status()
            ms = (time.perf_counter() - t0) * 1000.0
            logger.info("middle layer lg_app done thread=%s label=%s ms=%.1f", tid, label, ms)
            if label == "tool_approval_resume":
                logger.info(
                    "【工具授权·同SSE】LangGraph resume 结束 thread=%s ms=%.1f",
                    tid,
                    ms,
                )

    async def resume_command_upstream(self, lg_app: Any, *, body: bytes) -> None:
        """Resume an interrupted run on the same middle layer (same browser SSE).

        This method dispatches the LangGraph resume to a background task and
        waits briefly (``_RESUME_STARTUP_TIMEOUT_S``) for the worker thread to
        start.  If the startup times out, the method raises ``TimeoutError``
        so the caller (``resume_middle_layer_tool_approval``) can fall back to
        background SSE mode.

        Once started, the LangGraph run flows asynchronously through the SSE
        stream — ``resume_command_upstream`` does *not* block for the full
        duration of the run.
        """
        self._resume_in_flight = True
        self._resume_start_time = time.monotonic()
        self.wake_inject()
        log_tool_approval_trace("middle_layer·resume后台任务启动", thread_id=self.thread_id, side="middle_layer",
            event_data={"run_id": self.run_id})
        logger.info(
            "【工具授权·同SSE】resume_command_upstream 开始 thread=%s body_bytes=%s pause=%s",
            self.thread_id,
            len(body),
            self._tool_pause,
        )
        try:
            path = f"/threads/{self.thread_id}/runs/stream"
            scope: dict[str, Any] = {
                "type": "http",
                "asgi": {"version": "3.0"},
                "http_version": "1.1",
                "method": "POST",
                "scheme": "http",
                "path": path,
                "raw_path": path.encode(),
                "query_string": b"",
                "headers": [(b"content-type", b"application/json")],
                "client": ("127.0.0.1", 0),
                "server": ("127.0.0.1", 8070),
            }
            # Fire-and-forget: run LangGraph on a background coroutine, don't
            # await the entire result here so the caller returns quickly.
            # The background task handles the full resume lifecycle including
            # cleanup (clear _resume_in_flight, push pending approvals, etc.)
            self._resume_task = asyncio.create_task(
                self._run_resume_background(lg_app, scope, body=body),
            )

            # Brief startup check: wait up to _RESUME_STARTUP_TIMEOUT_S for the
            # background task to confirm it has started producing output.  If the
            # worker thread fails to start within that window, raise TimeoutError
            # so the caller can fall back.
            _startup_deadline = time.monotonic() + _RESUME_STARTUP_TIMEOUT_S
            while time.monotonic() < _startup_deadline:
                if self._resume_task.done():
                    # Short-circuit: task finished (probably with an error).
                    exc = self._resume_task.exception()
                    if exc is not None:
                        raise exc
                    break
                # Wait a tiny bit for the worker thread to begin.
                await asyncio.sleep(0.05)
            if self._resume_task.done() and self._resume_task.exception() is not None:
                raise self._resume_task.exception()  # type: ignore[misc]
        except Exception:
            logger.exception(
                "【工具授权·同SSE】resume 启动失败 thread=%s",
                self.thread_id,
            )
            self._resume_in_flight = False
            self._resume_start_time = 0.0
            self._resume_task = None
            raise

    async def _run_resume_background(
        self,
        lg_app: Any,
        scope: dict[str, Any],
        *,
        body: bytes,
    ) -> None:
        """Background LangGraph resume run, called from ``resume_command_upstream``.

        This runs on the main event loop as a background task.  The actual
        LangGraph invocation is offloaded to the worker thread via
        ``_invoke_lg_app_on_worker`` with a timeout guard.
        """
        tid = self.thread_id
        try:
            await self._invoke_lg_app_on_worker(
                lg_app,
                scope,
                body=body,
                label="tool_approval_resume",
                timeout=_RESUME_TIMEOUT_S,
            )
        except asyncio.TimeoutError:
            logger.warning(
                "【工具授权·同SSE】LangGraph resume 超时 thread=%s timeout=%.1fs — 降级为后台流",
                tid,
                _RESUME_TIMEOUT_S,
            )
            # Timeout — the resume didn't complete in time.  The caller of
            # resume_middle_layer_tool_approval will get False from the
            # timeout check in resume_command_upstream's caller.  Clean up
            # gracefully.
        except Exception:
            logger.exception(
                "【工具授权·同SSE】LangGraph resume 后台异常 thread=%s",
                tid,
            )
        finally:
            self._resume_in_flight = False
            self._resume_start_time = 0.0
            self._resume_task = None
            try:
                from app.gateway.db_async import run_db
                from app.gateway.streaming.post_stream_ui_normalize import (
                    clear_thread_tool_approval_pause,
                    invalidate_defer_run_finished_cache,
                )
                from app.gateway.streaming.tool_approval_stream_push import push_pending_approvals_to_live_stream
                from evoflow.agents.tool_approval_service import thread_has_pending_approvals

                invalidate_defer_run_finished_cache(tid)
                still_pending = await run_db(thread_has_pending_approvals, tid)
                logger.info(
                    "【工具授权·同SSE】resume 收尾 thread=%s still_pending=%s",
                    tid,
                    still_pending,
                )
                if still_pending:
                    n = await push_pending_approvals_to_live_stream(
                        tid,
                        reason="resume_command_upstream_done",
                    )
                    logger.info(
                        "【工具授权·同SSE】resume 后补推 pending thread=%s count=%s",
                        tid,
                        n,
                    )
                if not still_pending:
                    clear_thread_tool_approval_pause(tid)
            except Exception:
                logger.exception(
                    "【工具授权·同SSE】resume 收尾失败 thread=%s",
                    tid,
                )
            self.wake_inject()
            logger.info(
                "【工具授权·同SSE】resume_command_upstream 结束 thread=%s",
                tid,
            )

    def wake_inject(self) -> None:
        self._inject_wake.set()

    async def _drain_inject_once(self) -> None:
        inject = self._transform.drain_inject_for_middle_layer()
        if not inject:
            return
        for frame in inject:
            for out_msg in self._transform._asgi_body_messages(frame, more_body=True):
                await self._emit_asgi(out_msg)

    def feed_wire_sync(self, wire: str, *, source: str = "model-bridge") -> None:
        """Sync entry for model-bridge / side-channel ag-ui frames."""
        text = str(wire or "")
        if not text.strip():
            return
        try:
            from app.gateway.streaming.stream_mirror import enqueue_wire_chunk_sync

            enqueue_wire_chunk_sync(
                self.thread_id,
                text,
                run_id=self.run_id,
                source=source,
            )
        except Exception:
            pass
        for queue in list(self._wire_subscribers):
            try:
                queue.put_nowait(text)
            except asyncio.QueueFull:
                pass
        for queue in list(self._asgi_subscribers):
            try:
                for out_msg in self._transform._asgi_body_messages(text.encode("utf-8"), more_body=True):
                    queue.put_nowait(out_msg)
            except asyncio.QueueFull:
                pass
        self.wake_inject()

    async def _dispatch_upstream_send(self, message: dict[str, Any]) -> None:
        async for out_msg in self._transform.process_asgi_message(message):
            await self._emit_asgi(out_msg)

    async def _emit_asgi(self, message: dict[str, Any]) -> None:
        if message.get("type") == "http.response.start":
            if self._stream_proxy_registered:
                # Resume run sends its own http.response.start, but the SSE
                # response has already started.  Forwarding it to uvicorn would
                # raise RuntimeError("Response already started") and kill the
                # consumer loop - silently skip instead.
                logger.info(
                    "【中间层】跳过重复 http.response.start thread=%s (resume run)",
                    self.thread_id,
                )
                return
            self._stream_proxy_registered = True
            try:
                from app.gateway.routers.langgraph_proxy import register_active_stream_proxy

                register_active_stream_proxy(self.thread_id, run_id=self.run_id)
            except Exception:
                pass
            # Defense: never forward Content-Length on transformed SSE streams.
            try:
                from app.gateway.streaming.post_stream_ui_normalize import (
                    _strip_fixed_length_response_headers,
                )

                headers = _strip_fixed_length_response_headers(list(message.get("headers") or []))
                message = {**message, "headers": headers}
            except Exception:
                pass

        for queue in list(self._asgi_subscribers):
            try:
                queue.put_nowait(message)
            except asyncio.QueueFull:
                pass

        if message.get("type") == "http.response.body":
            body = message.get("body") or b""
            if body:
                wire = bytes(body).decode("utf-8", errors="replace")
                for queue in list(self._wire_subscribers):
                    try:
                        queue.put_nowait(wire)
                    except asyncio.QueueFull:
                        pass

    async def _finish_layer(self) -> None:
        if self._finished.is_set():
            return
        self._finished.set()
        for queue in list(self._asgi_subscribers):
            _signal_queue_end(queue, thread_id=self.thread_id)
        for queue in list(self._wire_subscribers):
            _signal_queue_end(queue, thread_id=self.thread_id)
        self._asgi_subscribers.clear()
        self._wire_subscribers.clear()
        try:
            from app.gateway.streaming.session_stream_inject import end_thread_inject

            end_thread_inject(self.thread_id)
        except Exception:
            pass
        try:
            self._lg_loop.shutdown()
        except Exception:
            logger.debug("LangGraph worker loop shutdown failed thread=%s", self.thread_id, exc_info=True)
        # R2-2: Persist completion status for frontend reconnection
        # This allows frontend to detect completed runs when returning from background
        try:
            from evoflow.persistence.live_run_repositories import mark_run_completed

            mark_run_completed(
                thread_id=self.thread_id,
                run_id=self.run_id,
                status="success",
            )
        except Exception:
            logger.debug("mark_run_completed failed thread=%s", self.thread_id, exc_info=True)
        # LangGraph run 流已结束（await lg_app 已返回），直接 mark session idle。
        # 不走 schedule_end_session_turn → is_thread_run_active 外部探测：
        # 刷新后浏览器 SSE 断了，外部探测不可靠，session run_status 不会及时变 idle。
        # 无条件执行（不限定 _stream_proxy_registered）：
        #   broadcast 在条件外，若把 mark 也放条件内，会出现"前端收到 panel:run_ended
        #   但 DB 仍 running"的不一致。
        try:
            from app.gateway.routers.langgraph_proxy import unregister_active_stream_proxy

            unregister_active_stream_proxy(self.thread_id)
        except Exception:
            pass
        try:
            from evoflow.session_execution import force_end_session_turn

            force_end_session_turn(
                session_key=self.session_key,
                thread_id=self.thread_id,
                source="middle_layer_finish",
                reason="run_completed",
            )
        except Exception:
            pass
        try:
            from app.gateway.streaming.stream_mirror import flush_mirror_batch_for_thread

            await flush_mirror_batch_for_thread(self.thread_id, run_id=self.run_id)
        except Exception:
            logger.debug("stream mirror flush on finish failed thread=%s", self.thread_id, exc_info=True)
        # 先 mark idle 再广播：前端收到 panel:run_ended 时 DB 已是 idle
        await self._broadcast_run_ended()
        with _LOCK:
            if _LAYERS.get(self.thread_id) is self:
                _LAYERS.pop(self.thread_id, None)

    async def _broadcast_run_ended(self) -> None:
        """Push ``panel:run_ended`` via EventBroadcaster (keyed by thread_id).

        Called from ``_finish_layer`` — the point where ``await lg_app(...)``
        has returned, i.e. the LangGraph run stream itself signalled completion.
        This is the *internal* signal, not an external HTTP probe.
        """
        tid = str(self.thread_id or "").strip()
        if not tid:
            return
        try:
            from app.gateway.routers.events import broadcaster

            await broadcaster.broadcast(
                tid,
                "panel:run_ended",
                {
                    "thread_id": tid,
                    "run_id": self.run_id or "",
                    "reason": "langgraph_run_finished",
                },
            )
        except Exception:
            logger.debug(
                "broadcast panel:run_ended failed thread=%s",
                tid,
                exc_info=True,
            )

    def _add_asgi_subscriber(self) -> asyncio.Queue[Any]:
        queue: asyncio.Queue[Any] = asyncio.Queue(maxsize=2048)
        self._asgi_subscribers.append(queue)
        return queue

    def _remove_asgi_subscriber(self, queue: asyncio.Queue[Any]) -> None:
        try:
            self._asgi_subscribers.remove(queue)
        except ValueError:
            pass

    def _add_wire_subscriber(self) -> asyncio.Queue[Any]:
        queue: asyncio.Queue[Any] = asyncio.Queue(maxsize=2048)
        self._wire_subscribers.append(queue)
        return queue

    def _remove_wire_subscriber(self, queue: asyncio.Queue[Any]) -> None:
        try:
            self._wire_subscribers.remove(queue)
        except ValueError:
            pass

    async def subscribe_asgi(self) -> AsyncIterator[dict[str, Any]]:
        queue = self._add_asgi_subscriber()
        try:
            while True:
                item = await queue.get()
                if item is _SENTINEL:
                    break
                yield item
        finally:
            self._remove_asgi_subscriber(queue)

    def attach_wire_subscriber(self) -> asyncio.Queue[Any]:
        return self._add_wire_subscriber()

    def detach_wire_subscriber(self, queue: asyncio.Queue[Any]) -> None:
        self._remove_wire_subscriber(queue)

    async def subscribe_wire(self) -> AsyncIterator[str]:
        queue = self._add_wire_subscriber()
        try:
            while True:
                item = await queue.get()
                if item is _SENTINEL:
                    break
                yield str(item)
        finally:
            self._remove_wire_subscriber(queue)


def is_wire_sentinel(item: Any) -> bool:
    return item is _SENTINEL


def get_active_middle_layer(thread_id: str) -> StreamMiddleLayer | None:
    tid = _tid_key(thread_id)
    if not tid:
        return None
    with _LOCK:
        layer = _LAYERS.get(tid)
    if layer is None or not layer.is_active():
        return None
    return layer


async def resume_middle_layer_tool_approval(
    *,
    thread_id: str,
    resume_payload: dict[str, Any],
    session_key: str = "",
    workspace_root: str | None = None,
) -> bool:
    """Push Command(resume=…) into the active POST middle layer for this thread."""
    log_tool_approval_trace("middle_layer·resume入口", thread_id=thread_id, side="middle_layer",
        event_data={"layer_exists": get_active_middle_layer(thread_id) is not None, "resume_payload": resume_payload})
    layer = get_active_middle_layer(thread_id)
    if layer is None:
        log_tool_approval_trace("middle_layer·无活跃layer", thread_id=thread_id, side="middle_layer",
            level=logging.WARNING, event_data={"reason": "get_active_middle_layer returned None"})
        logger.warning(
            "【工具授权·同SSE】无活跃 middle layer，无法同 SSE resume thread=%s payload=%s",
            thread_id,
            resume_payload,
        )
        return False
    try:
        from app.gateway.db_async import run_db
        from app.gateway.streaming.stream_mirror_background import _get_inprocess_lg_app
        from evoflow.agents.tool_approval_resume import build_lead_run_config

        lg_app = _get_inprocess_lg_app()
        log_tool_approval_trace("middle_layer·lg_app检查", thread_id=thread_id, side="middle_layer",
            event_data={"lg_app_ready": lg_app is not None})
        if lg_app is None:
            logger.warning("【工具授权·同SSE】LangGraph 应用未就绪 thread=%s", thread_id)
            return False
        logger.info(
            "【工具授权·同SSE】注入 Command(resume) thread=%s run_id=%s payload=%s",
            thread_id,
            layer.run_id,
            resume_payload,
        )
        sk = str(session_key or "").strip()
        if not sk:
            from evoflow.persistence.session_repositories import find_session_key_by_thread_id

            sk = str(await run_db(find_session_key_by_thread_id, thread_id) or "").strip()
        run_config = await run_db(
            build_lead_run_config,
            session_key=sk,
            thread_id=thread_id,
            workspace_root=workspace_root,
        )
        from evoflow.agents.tool_approval_resume import _build_resume_stream_body

        body = json.dumps(
            _build_resume_stream_body(
                resume_payload=resume_payload or {},
                run_config=run_config,
                thread_id=thread_id,
            ),
            ensure_ascii=False,
        ).encode("utf-8")

        log_tool_approval_trace("middle_layer·调用resume_command_upstream", thread_id=thread_id, side="middle_layer",
            event_data={"run_id": layer.run_id})
        try:
            await layer.resume_command_upstream(lg_app, body=body)
        except asyncio.TimeoutError:
            log_tool_approval_trace("middle_layer·resume失败", thread_id=thread_id, side="middle_layer",
                level=logging.ERROR, event_data={"error": "resume_command_upstream TimeoutError"})
            logger.warning(
                "【工具授权·同SSE】resume 启动超时 thread=%s — 降级为后台流",
                thread_id,
            )
            return False
        except Exception as exc:
            log_tool_approval_trace("middle_layer·resume失败", thread_id=thread_id, side="middle_layer",
                level=logging.ERROR, event_data={"error": str(exc)})
            logger.exception("【工具授权·同SSE】Command(resume) 失败 thread=%s", thread_id)
            return False
        log_tool_approval_trace("middle_layer·resume成功", thread_id=thread_id, side="middle_layer",
            event_data={"run_id": layer.run_id})
        logger.info("【工具授权·同SSE】Command(resume) 执行完毕 thread=%s", thread_id)
        return True
    except Exception as exc:
        log_tool_approval_trace("middle_layer·resume失败", thread_id=thread_id, side="middle_layer",
            level=logging.ERROR, event_data={"error": str(exc)})
        logger.exception("【工具授权·同SSE】resume 失败 thread=%s", thread_id)
        return False


def wake_middle_layer_inject(thread_id: str) -> None:
    """Notify inject pump (inject queue / model-bridge side channels)."""
    tid = _tid_key(thread_id)
    if not tid:
        return
    log_tool_approval_trace("middle_layer·收到wake注入", thread_id=tid, side="middle_layer",
        event_data={"reason": "外部唤醒"})
    try:
        from app.gateway.streaming.post_stream_ui_normalize import invalidate_defer_run_finished_cache

        invalidate_defer_run_finished_cache(tid)
    except Exception:
        pass
    with _LOCK:
        layer = _LAYERS.get(tid)
    if layer is not None and layer.is_active():
        layer.wake_inject()


def try_feed_middle_layer_wire(
    thread_id: str,
    wire: str,
    *,
    run_id: str | None = None,
    source: str = "model-bridge",
) -> bool:
    """Route ag-ui wire into active middle layer → mirror DB + subscribers."""
    tid = _tid_key(thread_id)
    if not tid:
        return False
    with _LOCK:
        layer = _LAYERS.get(tid)
    if layer is None or not layer.is_active():
        return False
    if run_id and not layer.matches_run(run_id):
        return False
    layer.feed_wire_sync(wire, source=source)
    return True


def middle_layer_covers_thread(thread_id: str) -> bool:
    return get_active_middle_layer(thread_id) is not None


def start_post_middle_layer(
    *,
    thread_id: str,
    body: bytes = b"",
    stream_format: str = "agui",
    run_id: str | None = None,
) -> StreamMiddleLayer:
    """Create/replace the middle layer for a new POST /runs/stream."""
    tid = _tid_key(thread_id)
    layer = StreamMiddleLayer(
        thread_id=tid,
        body=body,
        stream_format=stream_format,
        run_id=run_id,
    )
    with _LOCK:
        prev = _LAYERS.get(tid)
        if prev is not None and prev._upstream_task is not None and not prev._upstream_task.done():
            prev._upstream_task.cancel()
        _LAYERS[tid] = layer
    return layer


def bind_upstream_task(thread_id: str, task: asyncio.Task[None]) -> None:
    tid = _tid_key(thread_id)
    with _LOCK:
        layer = _LAYERS.get(tid)
    if layer is not None:
        layer._upstream_task = task


async def pump_post_through_middle_layer(
    *,
    layer: StreamMiddleLayer,
    lg_app: Any,
    scope: dict[str, Any],
    request_body: bytes,
    deliver_asgi: Callable[[dict[str, Any]], Awaitable[None]],
    client_gone: Callable[[], bool],
) -> bool:
    """Run upstream on middle layer; deliver transformed SSE to proxy until client gone.

    Returns True when the browser detached while upstream is still running.

    ``request_body`` must be the full POST body captured on the gateway event loop
    before LangGraph starts. Do **not** bridge Starlette ``receive()`` into the
    worker thread — that re-enters ASGI middleware and deadlocks the main loop.
    """
    upstream_task = asyncio.create_task(
        layer.run_upstream(lg_app, scope, request_body=request_body),
    )
    bind_upstream_task(layer.thread_id, upstream_task)
    detached = False
    try:
        async for out_msg in layer.subscribe_asgi():
            if client_gone():
                detached = True
                break
            await deliver_asgi(out_msg)
    finally:
        if detached and not upstream_task.done():
            return True
        if not upstream_task.done():
            await upstream_task
        else:
            await upstream_task
    return False
