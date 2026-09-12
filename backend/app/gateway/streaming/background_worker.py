"""Background stream worker for persistent stream output.

Provides a unified background task manager that decouples stream writing
from frontend connections. Works for both:
1. LangGraph proxy streams (user-AI chat)
2. Task execution streams (task start/restart/resume)

Features:
- Decoupled from frontend connections
- Dual write: persistent file + memory broadcast
- Prevents duplicate workers (one per thread_id)
- Auto-cleanup of finished workers
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
from collections.abc import AsyncGenerator
from typing import Any

import httpx

from evoflow.agents.tool_approval_trace_log import log_tool_approval_trace

from .persistent_writer import get_persistent_stream_writer, stream_storage

logger = logging.getLogger(__name__)

LANGGRAPH_BASE_URL = os.getenv("EVOFLOW_LANGGRAPH_URL", "http://127.0.0.1:8070/api/langgraph").rstrip("/")

# Lead-agent chunk persistence: batched JSONL writes (broadcast always on).
PERSIST_LEAD_AGENT_CHUNKS = os.getenv("EVOFLOW_PERSIST_LEAD_AGENT_CHUNKS", "1").strip().lower() in (
    "1",
    "true",
    "yes",
)
PERSIST_CHUNK_BATCH_SIZE = max(1, int(os.getenv("EVOFLOW_PERSIST_CHUNK_BATCH_SIZE", "50") or 50))
PERSIST_CHUNK_FLUSH_SECONDS = max(0.5, float(os.getenv("EVOFLOW_PERSIST_CHUNK_FLUSH_SECONDS", "5") or 5))

# 已禁用：实时流调试日志写入 temp 文件（避免 IO/磁盘噪音）
DISABLE_STREAM_DEBUG_FILE_LOGS = True


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


class StreamBackgroundWorker:
    """Background worker that reads from a stream source and writes to persistent storage.

    This worker runs independently of frontend connections, ensuring that
    stream output is always written to disk even if the client disconnects.

    Usage:
        # For task execution (LangGraph SDK)
        worker, is_new = await StreamBackgroundWorker.get_or_create(
            thread_id="thread-123",
            stream_source=client.runs.stream(...),
            source_type="task_execution",
        )
        if is_new:
            await worker.start()

        # For proxy (direct LangGraph connection)
        worker, is_new = await StreamBackgroundWorker.get_or_create_with_langgraph(
            thread_id="thread-123",
            langgraph_path="threads/xxx/runs/stream",
            request_method="POST",
            request_body=body,
            request_headers=headers,
        )
        if is_new:
            await worker.start()
    """

    # Class-level registry of all workers
    _workers: dict[str, StreamBackgroundWorker] = {}
    _lock = asyncio.Lock()

    def __init__(
        self,
        thread_id: str,
        stream_source: AsyncGenerator | None = None,
        source_type: str = "proxy",
        *,
        # For lazy LangGraph connection
        langgraph_path: str | None = None,
        request_method: str | None = None,
        request_body: bytes | None = None,
        request_headers: dict | None = None,
    ):
        """Initialize background worker.

        Args:
            thread_id: Thread ID for stream output storage
            stream_source: Async generator yielding stream chunks (for task_execution)
            source_type: Type of stream source ("proxy" or "task_execution")
            langgraph_path: LangGraph API path (for proxy source, lazy connection)
            request_method: HTTP method for LangGraph request
            request_body: Request body to forward to LangGraph
            request_headers: Headers to forward to LangGraph
        """
        self.thread_id = thread_id
        self.stream_source = stream_source
        self.source_type = source_type
        self._running = False
        self._starting = False
        self._task: asyncio.Task | None = None
        self._writer = None

        # For lazy LangGraph connection
        self.langgraph_path = langgraph_path
        self.request_method = request_method
        self.request_body = request_body
        self.request_headers = request_headers

        self._persist_buffer: list[dict[str, Any]] = []
        self._last_persist_flush = 0.0

        logger.info(f"StreamBackgroundWorker created for thread {thread_id} (source: {source_type})")

    def _is_replaceable(self) -> bool:
        """True when this worker finished and a new one may take its registry slot."""
        if self._running or self._starting:
            return False
        if self._task is None:
            return False
        return self._task.done()

    @classmethod
    async def pop_stale_worker(cls, thread_id: str) -> StreamBackgroundWorker | None:
        """Atomically remove and return a finished/replaceable worker for ``thread_id``.

        Returns ``None`` if no worker exists or the worker is still running.
        Safe alternative to directly accessing ``cls._lock`` / ``cls._workers``.
        """
        async with cls._lock:
            existing = cls._workers.get(thread_id)
            if existing is None:
                return None
            if existing._is_replaceable():
                del cls._workers[thread_id]
                return existing
            return None

    @classmethod
    def _resolve_existing_worker(cls, thread_id: str) -> StreamBackgroundWorker | None:
        existing = cls._workers.get(thread_id)
        if existing is None:
            return None
        if existing._is_replaceable():
            del cls._workers[thread_id]
            return None
        logger.debug("Reusing existing worker for thread %s", thread_id)
        return existing

    @classmethod
    async def get_or_create(
        cls,
        thread_id: str,
        stream_source: AsyncGenerator,
        *,
        source_type: str = "task_execution",
    ) -> tuple[StreamBackgroundWorker, bool]:
        """Get existing worker or create a new one (for task execution).

        This prevents duplicate workers for the same thread_id.

        Args:
            thread_id: Thread ID
            stream_source: Async generator yielding stream chunks
            source_type: Type of stream source

        Returns:
            (worker, is_new): Worker instance and whether it's newly created
        """
        async with cls._lock:
            existing = cls._resolve_existing_worker(thread_id)
            if existing is not None:
                return existing, False

            worker = cls(thread_id, stream_source, source_type)
            cls._workers[thread_id] = worker
            return worker, True

    @classmethod
    async def get_or_create_with_langgraph(
        cls,
        thread_id: str,
        *,
        langgraph_path: str,
        request_method: str = "POST",
        request_body: bytes | None = None,
        request_headers: dict | None = None,
    ) -> tuple[StreamBackgroundWorker, bool]:
        """Get existing worker or create a new one with lazy LangGraph connection.

        This is for proxy streams where the worker needs to connect directly
        to LangGraph (not through the proxy response which gets closed on disconnect).

        Args:
            thread_id: Thread ID
            langgraph_path: LangGraph API path (e.g., "threads/xxx/runs/stream")
            request_method: HTTP method
            request_body: Request body to forward
            request_headers: Headers to forward

        Returns:
            (worker, is_new): Worker instance and whether it's newly created
        """
        # 文件调试日志已禁用

        logger.info("get_or_create_with_langgraph called: thread_id=%s", thread_id)

        async with cls._lock:
            existing = cls._resolve_existing_worker(thread_id)
            if existing is not None:
                return existing, False

            logger.info("Creating new worker for thread %s", thread_id)
            worker = cls(
                thread_id,
                source_type="proxy",
                langgraph_path=langgraph_path,
                request_method=request_method,
                request_body=request_body,
                request_headers=request_headers,
            )
            cls._workers[thread_id] = worker
            return worker, True

    async def start(self) -> None:
        """Start the background worker task."""
        if self._running or self._starting:
            logger.warning("Worker for thread %s is already running or starting", self.thread_id)
            return

        self._starting = True
        try:
            self._running = True
            self._task = asyncio.create_task(self._stream_worker())
            logger.info("Background worker started for thread %s", self.thread_id)
        finally:
            self._starting = False

    async def _stream_worker(self) -> None:
        """Core worker logic: read from stream and write to storage."""
        logger.info(f"🎬 _stream_worker STARTED for thread {self.thread_id}")
        try:
            from evoflow.session_execution.lifecycle import start_session_turn

            start_session_turn(thread_id=self.thread_id, source="background_worker")
        except Exception:
            logger.debug("mark session run started failed thread_id=%s", self.thread_id, exc_info=True)

        try:
            if PERSIST_LEAD_AGENT_CHUNKS:
                # Create persistent writer
                self._writer = get_persistent_stream_writer(self.thread_id)
                logger.info("✅ Persistent writer created")
            else:
                self._writer = None

            # Process stream based on source type
            if self.source_type == "proxy" and self.langgraph_path:
                # Direct connect to LangGraph and process
                logger.info(f"📡 Connecting to LangGraph: {self.langgraph_path}")
                await self._connect_and_process_langgraph()
            elif self.stream_source:
                # Task execution source: read from provided stream
                write_count = 0
                broadcast_count = 0
                async for chunk in self.stream_source:
                    try:
                        chunk_data = self._chunk_to_dict(chunk)
                        await self._write_and_broadcast(chunk_data)
                        write_count += 1
                        broadcast_count += 1
                    except Exception as e:
                        logger.warning(f"Failed to process chunk: {e}")

                logger.info(f"Task stream completed: write_count={write_count}")
            else:
                logger.error(f"No stream source for thread {self.thread_id}")
                return

            # Close writer (flush pending batch first)
            if self._writer:
                self._flush_persist_buffer(force=True)
                self._writer.close()
                logger.info("✅ Writer closed")

        except Exception as e:
            logger.exception(f"❌ Worker failed with error: {e}")
            # Broadcast error to SSE subscribers so frontend knows the stream died
            try:
                await stream_storage.broadcast(
                    thread_id=self.thread_id,
                    event_type="error",
                    data={"type": "stream_worker_error", "error": f"{type(e).__name__}: {str(e)[:200]}"},
                )
            except Exception:
                logger.debug("Failed to broadcast worker error for thread_id=%s", self.thread_id, exc_info=True)
        finally:
            self._running = False
            try:
                from evoflow.session_execution.lifecycle import schedule_end_session_turn

                schedule_end_session_turn(thread_id=self.thread_id, reason="background_worker_end")
            except Exception:
                logger.debug(
                    "schedule end_session_turn failed thread_id=%s",
                    self.thread_id,
                    exc_info=True,
                )
            async with self.__class__._lock:
                if self.thread_id in self.__class__._workers:
                    del self.__class__._workers[self.thread_id]
            logger.info("🏁 _stream_worker ENDED")

    async def _connect_and_process_langgraph(self) -> None:
        """Connect directly to LangGraph API and process stream chunks."""
        # 诊断：记录连接目标和请求体预览（仅当是审批恢复流时）
        try:
            body_preview = ""
            if self.request_body:
                try:
                    body_preview = self.request_body.decode("utf-8", errors="ignore")[:300]
                except Exception:
                    body_preview = f"<{len(self.request_body)} bytes>"
            log_tool_approval_trace(
                "后台流·开始连接LangGraph",
                thread_id=self.thread_id, side="resume",
                event_data={
                    "target_path": self.langgraph_path,
                    "method": self.request_method,
                    "base_url": LANGGRAPH_BASE_URL,
                    "body_preview": body_preview,
                    "has_stream_resume_header": bool(
                        (self.request_headers or {}).get("x-evoflow-stream-resume")
                    ),
                },
            )
        except Exception:
            pass

        if logger.isEnabledFor(logging.DEBUG):
            body_preview = (
                self.request_body.decode("utf-8", errors="ignore")[:500]
                if self.request_body
                else "<empty>"
            )
            logger.debug(
                "Connecting to LangGraph path=%s method=%s body_preview=%s",
                self.langgraph_path,
                self.request_method,
                body_preview,
            )

        target = f"{LANGGRAPH_BASE_URL}/{self.langgraph_path.lstrip('/')}"

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
        upstream_headers = {k: v for k, v in (self.request_headers or {}).items() if k.lower() not in HOP_BY_HOP_HEADERS}

        from evoflow.runtime.long_run_limits import httpx_stream_timeout

        timeout = httpx_stream_timeout()

        async with httpx.AsyncClient(timeout=timeout) as client:
            async with client.stream(
                self.request_method or "POST",
                target,
                headers=upstream_headers,
                content=self.request_body,
            ) as resp:
                if resp.status_code >= 400:
                    body_text = ""
                    try:
                        body_text = (await resp.aread()).decode("utf-8", errors="ignore")[:500]
                    except Exception:
                        pass
                    logger.warning(
                        "LangGraph stream error status=%s path=%s body=%s",
                        resp.status_code,
                        self.langgraph_path,
                        body_text,
                    )
                    log_tool_approval_trace(
                        "后台流·LangGraph返回错误",
                        thread_id=self.thread_id,
                        side="resume",
                        level=logging.ERROR,
                        event_data={
                            "status_code": resp.status_code,
                            "path": self.langgraph_path,
                            "response_body": body_text,
                        },
                    )
                    # 通过 SSE 推送错误通知
                    try:
                        from app.gateway.streaming.post_stream_ui_normalize import (
                            clear_thread_tool_approval_pause,
                        )
                        from app.gateway.streaming.stream_middle_layer import (
                            wake_middle_layer_inject,
                        )
                        from app.gateway.streaming.tool_approval_stream_push import (
                            push_tool_approval_decision,
                        )

                        await push_tool_approval_decision(
                            self.thread_id,
                            tool_call_id="_langgraph_error",
                            tool_name="",
                            status="error",
                            message=f"LangGraph 返回错误 {resp.status_code}，工具执行恢复失败。请重新发送消息。",
                            reason="langgraph_stream_error",
                        )
                        clear_thread_tool_approval_pause(self.thread_id)
                        wake_middle_layer_inject(self.thread_id)
                    except Exception:
                        logger.debug("push error SSE failed thread=%s", self.thread_id, exc_info=True)
                    return

                buffer = ""
                write_count = 0
                chunk_count = 0
                heartbeat_count = 0
                event_count = 0
                stream_debug = logger.isEnabledFor(logging.DEBUG)

                async for chunk in resp.aiter_raw():
                    chunk_count += 1

                    if isinstance(chunk, bytes):
                        text = chunk.decode("utf-8", errors="ignore")

                        if stream_debug:
                            logger.debug("LangGraph chunk #%s (%s bytes): %r", chunk_count, len(text), text)

                        buffer += text

                        # 统计心跳
                        if ": heartbeat" in text:
                            heartbeat_count += 1

                        # 尝试多种分隔符
                        separator = None
                        if "\n\n" in buffer:
                            separator = "\n\n"
                        elif "\r\n\r\n" in buffer:
                            separator = "\r\n\r\n"

                        if separator:
                            while separator in buffer:
                                event, buffer = buffer.split(separator, 1)
                                event_count += 1

                                if ": heartbeat" in event:
                                    continue

                                if stream_debug:
                                    logger.debug("LangGraph event #%s raw: %r", event_count, event)

                                event_type = ""
                                data_str = ""
                                for line in event.split("\n"):
                                    line = line.strip()
                                    if line.startswith("event:"):
                                        event_type = line[6:].strip()
                                    elif line.startswith("data:"):
                                        data_str = line[5:].strip()

                                if data_str and data_str != "[DONE]":
                                    try:
                                        data_json = json.loads(data_str)

                                        if stream_debug:
                                            logger.debug(
                                                "LangGraph event #%s type=%s data=%s",
                                                event_count,
                                                event_type,
                                                json.dumps(data_json, ensure_ascii=False),
                                            )

                                        inferred_event_type = _infer_sse_event_name(event_type, data_json)
                                        await self._write_and_broadcast(data_json, inferred_event_type)
                                        write_count += 1

                                    except json.JSONDecodeError as e:
                                        if stream_debug:
                                            logger.debug("LangGraph JSON decode failed: %s data=%s", e, data_str)

                logger.info(
                    "LangGraph stream ended: chunks=%s heartbeats=%s events=%s written=%s",
                    chunk_count,
                    heartbeat_count,
                    event_count,
                    write_count,
                )
                # 诊断：记录 stream 结束时的关键统计，用于判断 replay run 是否真正执行了工具
                try:
                    log_tool_approval_trace(
                        "后台流·LangGraph流结束统计",
                        thread_id=self.thread_id, side="resume",
                        event_data={
                            "chunks": chunk_count,
                            "heartbeats": heartbeat_count,
                            "events": event_count,
                            "written_events": write_count,
                            "langgraph_path": self.langgraph_path,
                        },
                    )
                except Exception:
                    pass
                # Tool-approval resume keeps pause until stream finishes; clear so UI/idle can settle.
                if str((self.request_headers or {}).get("x-evoflow-stream-resume") or "").strip():
                    try:
                        from app.gateway.streaming.post_stream_ui_normalize import (
                            clear_thread_tool_approval_pause,
                        )

                        clear_thread_tool_approval_pause(self.thread_id)
                    except Exception:
                        logger.debug(
                            "clear tool approval pause after resume stream failed thread=%s",
                            self.thread_id,
                            exc_info=True,
                        )

    def _flush_persist_buffer(self, *, force: bool = False) -> None:
        """Flush buffered chunks to disk (batched to avoid per-chunk IO)."""
        if not self._writer or not self._persist_buffer:
            return
        import time

        now = time.time()
        if not force:
            if len(self._persist_buffer) < PERSIST_CHUNK_BATCH_SIZE:
                if self._last_persist_flush and (now - self._last_persist_flush) < PERSIST_CHUNK_FLUSH_SECONDS:
                    return
        for item in self._persist_buffer:
            try:
                self._writer(item)
            except Exception as e:
                logger.error("Failed to write buffered chunk for thread %s: %s", self.thread_id, e)
        self._persist_buffer.clear()
        self._last_persist_flush = now

    async def _write_and_broadcast(self, data: dict[str, Any] | list, event_type: str = "") -> None:
        """Write to persistent storage and broadcast to memory."""
        # writer 可选：当关闭持久化时，仅广播

        # Extract pure text content or tool call JSON (for quick preview / search)
        extracted_content = self._extract_content(data) if isinstance(data, dict) or isinstance(data, list) else None

        # 1. Write to persistent file (optional, batched)
        if self._writer:
            try:
                self._persist_buffer.append(
                    {
                        "type": "lead_agent:chunk",
                        "data": data,
                        "content": extracted_content,
                        "event_type": event_type,
                    }
                )
                self._flush_persist_buffer()
            except Exception as e:
                logger.error(f"Failed to queue persistent storage write: {e}")

        # 2. Broadcast to memory queue (full data)
        try:
            await stream_storage.broadcast(
                thread_id=self.thread_id,
                event_type=(event_type or "message"),
                data=data,
            )
        except Exception as e:
            logger.error(f"Failed to broadcast to memory: {e}")

    def _extract_content(self, data: dict[str, Any]) -> str | None:
        """Extract pure text content or tool call JSON from stream data.

        Args:
            data: Stream chunk data (LangGraph SSE format)

        Returns:
            Extracted text content or tool call JSON, or None
        """
        try:
            # LangGraph messages-tuple format: [event_type, message_data]
            if isinstance(data, list) and len(data) >= 2:
                msg_data = data[1]
                if isinstance(msg_data, dict):
                    # AI message chunk with text content
                    if msg_data.get("type") == "AIMessageChunk":
                        content = msg_data.get("content", "")
                        if content and isinstance(content, str):
                            return content

                    # Tool calls: do not treat as user-visible chat text (avoids raw JSON in transcript).
                    # Full chunk remains in `data` for subscribers that need structured events.
                    if "tool_calls" in msg_data and msg_data["tool_calls"]:
                        return None

            # Direct content field
            if isinstance(data, dict):
                content = data.get("content", "")
                if content and isinstance(content, str):
                    return content

                # Check for chunk field
                chunk = data.get("chunk")
                if chunk:
                    return self._extract_content(chunk)

            return None
        except Exception as e:
            logger.debug(f"Failed to extract content: {e}")
            return None

    @staticmethod
    def _chunk_to_dict(chunk: Any) -> dict:
        """Convert LangGraph stream chunk to serializable dict.

        Args:
            chunk: LangGraph stream chunk object

        Returns:
            Serializable dict representation
        """
        result = {
            "event": getattr(chunk, "event", "unknown"),
            "data": {},
        }

        data = getattr(chunk, "data", None)
        if data is not None:
            if isinstance(data, dict):
                result["data"] = data
            else:
                try:
                    result["data"] = dict(data) if hasattr(data, "__dict__") else {"value": str(data)}
                except Exception:
                    result["data"] = {"value": str(data)}

        return result

    def is_running(self) -> bool:
        """Check if worker is still running."""
        return self._running

    async def cancel(self) -> None:
        """Cancel the background worker task."""
        if self._task and not self._task.done():
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass

        if self._writer:
            self._writer.close()

        self._running = False
        logger.info(f"Worker for thread {self.thread_id} cancelled")

    @classmethod
    async def cleanup_finished(cls) -> None:
        """Remove finished workers from registry."""
        async with cls._lock:
            finished = [tid for tid, worker in cls._workers.items() if not worker._running]
            for tid in finished:
                del cls._workers[tid]

            if finished:
                logger.debug(f"Cleaned up {len(finished)} finished workers")

    @classmethod
    def is_worker_running(cls, thread_id: str) -> bool:
        """Check if a worker is running for the given thread."""
        worker = cls._workers.get(thread_id)
        return worker is not None and worker._running


# Convenience functions
async def get_or_create_worker(
    thread_id: str,
    stream_source: AsyncGenerator,
    *,
    source_type: str = "task_execution",
) -> tuple[StreamBackgroundWorker, bool]:
    """Get or create a background worker.

    Convenience wrapper for StreamBackgroundWorker.get_or_create.
    """
    return await StreamBackgroundWorker.get_or_create(thread_id, stream_source, source_type=source_type)


def is_worker_running(thread_id: str) -> bool:
    """Check if a background worker is running for the given thread.

    Convenience wrapper for StreamBackgroundWorker.is_worker_running.
    """
    return StreamBackgroundWorker.is_worker_running(thread_id)
