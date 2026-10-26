"""Volcengine streaming ASR session usable inside AsrProcessor."""

from __future__ import annotations

import asyncio
import logging
import uuid
from collections.abc import Awaitable, Callable

logger = logging.getLogger("evoflow.speech.volc_asr_session")

TranscriptCallback = Callable[[str, bool, str | None], Awaitable[None]]
ErrorCallback = Callable[[str], Awaitable[None]]


class VolcengineAsrSession:
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
        self._closed = False
        self._task = asyncio.create_task(self._run(), name="volc-asr-session")

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
        from app.gateway.speech.volcengine_asr_ws import (
            _MSG_SERVER_ERROR,
            _build_audio_only_request,
            _build_full_client_request,
            _extract_utterances,
            _parse_server_frame,
        )
        from app.gateway.speech.volcengine_speech import get_asr_stream_credentials

        try:
            import websockets
        except ImportError as e:
            if self._on_error:
                await self._on_error("websockets package missing")
            raise RuntimeError("websockets required") from e

        try:
            api_key, resource_id, ws_url = get_asr_stream_credentials()
        except Exception as e:
            if self._on_error:
                await self._on_error(str(e))
            return

        headers = {
            "X-Api-Key": api_key,
            "X-Api-Resource-Id": resource_id,
            "X-Api-Connect-Id": str(uuid.uuid4()),
        }
        full_payload = {
            "user": {"uid": "evoflow-xiaomi-voice"},
            "audio": {
                "format": "pcm",
                "codec": "raw",
                "rate": 16000,
                "bits": 16,
                "channel": 1,
            },
            "request": {
                "model_name": "bigmodel",
                "enable_itn": True,
                "enable_punc": True,
                "result_type": "full",
            },
        }

        try:
            async with websockets.connect(
                ws_url, additional_headers=headers, open_timeout=20.0
            ) as upstream:
                seq = 1
                await upstream.send(_build_full_client_request(seq, full_payload))
                seq = 2
                stop = asyncio.Event()
                final_sent = False

                async def reader() -> None:
                    try:
                        async for frame in upstream:
                            if stop.is_set():
                                return
                            if isinstance(frame, str):
                                continue
                            try:
                                parsed = _parse_server_frame(frame)
                            except Exception:
                                continue
                            if parsed.get("message_type") == _MSG_SERVER_ERROR:
                                detail = parsed.get("detail")
                                if self._on_error:
                                    await self._on_error(f"ASR protocol error: {detail}")
                                stop.set()
                                return
                            for ut in _extract_utterances(parsed.get("payload")):
                                if ut.get("text"):
                                    await self._on_transcript(
                                        ut["text"], bool(ut.get("is_final")), ut.get("seg")
                                    )
                            if parsed.get("is_last"):
                                stop.set()
                                return
                    except asyncio.CancelledError:
                        raise
                    except Exception as e:
                        logger.warning("volc asr reader failed: %s", e)
                        if self._on_error:
                            await self._on_error(str(e))
                        stop.set()

                reader_task = asyncio.create_task(reader())
                try:
                    while not stop.is_set() and not self._closed:
                        kind, payload = await self._queue.get()
                        if kind == "audio" and payload and not final_sent:
                            await upstream.send(
                                _build_audio_only_request(seq, payload, is_last=False)
                            )
                            seq += 1
                        elif kind in {"flush", "stop"}:
                            if not final_sent:
                                await upstream.send(
                                    _build_audio_only_request(seq, b"", is_last=True)
                                )
                                final_sent = True
                            if kind == "stop":
                                break
                finally:
                    stop.set()
                    reader_task.cancel()
                    try:
                        await reader_task
                    except (asyncio.CancelledError, Exception):
                        pass
        except Exception as e:
            logger.warning("volc asr session failed: %s", e)
            if self._on_error:
                await self._on_error(str(e))
