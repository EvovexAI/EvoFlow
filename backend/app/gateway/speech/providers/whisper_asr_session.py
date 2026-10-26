"""Local Whisper ASR session (WS to whisper_server on :3723)."""

from __future__ import annotations

import asyncio
import json
import logging
from collections.abc import Awaitable, Callable

from app.gateway.speech.whisper_manager import WHISPER_WS_URL, is_available, start_whisper

logger = logging.getLogger("evoflow.speech.whisper_asr_session")

TranscriptCallback = Callable[[str, bool, str | None], Awaitable[None]]
ErrorCallback = Callable[[str], Awaitable[None]]


class WhisperAsrSession:
    def __init__(
        self,
        *,
        on_transcript: TranscriptCallback,
        on_error: ErrorCallback | None = None,
    ) -> None:
        self._on_transcript = on_transcript
        self._on_error = on_error
        self._queue: asyncio.Queue[tuple[str, bytes | None]] = asyncio.Queue()
        self._task: asyncio.Task[None] | None = None
        self._closed = False

    async def start(self) -> None:
        if self._task:
            return
        if not is_available():
            start_whisper()
        if not is_available():
            if self._on_error:
                await self._on_error("local Whisper unavailable")
            raise RuntimeError("local Whisper unavailable")
        self._closed = False
        self._task = asyncio.create_task(self._run(), name="whisper-asr-session")

    async def send_pcm(self, pcm: bytes) -> None:
        if self._closed or not pcm:
            return
        await self._queue.put(("audio", pcm))

    async def flush(self) -> None:
        if self._closed:
            return
        await self._queue.put(("flush", None))

    async def close(self) -> None:
        self._closed = True
        await self._queue.put(("stop", None))
        if self._task:
            try:
                await asyncio.wait_for(self._task, timeout=5.0)
            except (TimeoutError, asyncio.TimeoutError, asyncio.CancelledError):
                self._task.cancel()
            self._task = None

    async def _run(self) -> None:
        try:
            import websockets
        except ImportError as e:
            if self._on_error:
                await self._on_error("websockets package missing")
            raise RuntimeError("websockets required") from e

        try:
            async with websockets.connect(WHISPER_WS_URL, open_timeout=10.0) as ws:
                await ws.send(json.dumps({"type": "config", "sample_rate": 16000}))

                async def reader() -> None:
                    try:
                        async for raw in ws:
                            if isinstance(raw, bytes):
                                continue
                            try:
                                msg = json.loads(raw)
                            except Exception:
                                continue
                            if msg.get("type") == "transcript":
                                await self._on_transcript(
                                    str(msg.get("text") or ""),
                                    bool(msg.get("is_final")),
                                    msg.get("seg"),
                                )
                            elif msg.get("type") == "error" and self._on_error:
                                await self._on_error(str(msg.get("message") or "whisper error"))
                    except asyncio.CancelledError:
                        raise
                    except Exception as e:
                        logger.warning("whisper reader failed: %s", e)

                reader_task = asyncio.create_task(reader())
                try:
                    while not self._closed:
                        kind, payload = await self._queue.get()
                        if kind == "audio" and payload:
                            await ws.send(payload)
                        elif kind == "flush":
                            await ws.send(json.dumps({"type": "flush"}))
                        elif kind == "stop":
                            await ws.send(json.dumps({"type": "stop"}))
                            break
                finally:
                    reader_task.cancel()
                    try:
                        await reader_task
                    except (asyncio.CancelledError, Exception):
                        pass
        except Exception as e:
            logger.warning("whisper asr session failed: %s", e)
            if self._on_error:
                await self._on_error(str(e))
