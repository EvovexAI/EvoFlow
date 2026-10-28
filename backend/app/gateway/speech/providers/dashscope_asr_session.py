"""DashScope Paraformer realtime ASR (WebSocket duplex).

Protocol: https://help.aliyun.com/zh/model-studio/websocket-for-paraformer-real-time-service
Client events: run-task / binary PCM / finish-task
Server events: task-started / result-generated / task-finished / task-failed
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import uuid
from collections.abc import Awaitable, Callable

logger = logging.getLogger("evoflow.speech.dashscope_asr_session")

TranscriptCallback = Callable[[str, bool, str | None], Awaitable[None]]
ErrorCallback = Callable[[str], Awaitable[None]]

_DEFAULT_WS_URL = "wss://dashscope.aliyuncs.com/api-ws/v1/inference"
_DEFAULT_MODEL = "paraformer-realtime-v2"


def resolve_dashscope_asr_api_key() -> str:
    """API key from media.credentials or env (no enabledVendors gate)."""
    try:
        from evoflow.persistence.media_settings import get_media_credentials

        key = str(get_media_credentials().get("dashscopeApiKey") or "").strip()
        if key:
            return key
    except Exception:
        pass
    return (os.getenv("DASHSCOPE_API_KEY") or "").strip()


def dashscope_asr_available() -> bool:
    return bool(resolve_dashscope_asr_api_key())


def _ws_url() -> str:
    return (os.getenv("DASHSCOPE_ASR_WS_URL") or _DEFAULT_WS_URL).strip() or _DEFAULT_WS_URL


def _model() -> str:
    return (os.getenv("DASHSCOPE_ASR_MODEL") or _DEFAULT_MODEL).strip() or _DEFAULT_MODEL


class DashscopeAsrSession:
    """Streaming Paraformer session compatible with ``AsrSession`` protocol."""

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
        self._task = asyncio.create_task(self._run(), name="dashscope-asr-session")

    async def send_pcm(self, pcm: bytes) -> None:
        if self._closed or not pcm:
            return
        await self._queue.put(("audio", pcm))

    async def flush(self) -> None:
        # Paraformer VAD/sentence_end handles utterance boundaries; flush is a soft
        # no-op so we keep the duplex task alive across turns (unlike Volc is_last).
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

        api_key = resolve_dashscope_asr_api_key()
        if not api_key:
            if self._on_error:
                await self._on_error("DashScope API Key 未配置")
            return

        task_id = str(uuid.uuid4())
        headers = {
            "Authorization": f"Bearer {api_key}",
            "user-agent": "evoflow-xiaomi-voice/1.0",
        }
        run_task = {
            "header": {
                "action": "run-task",
                "task_id": task_id,
                "streaming": "duplex",
            },
            "payload": {
                "task_group": "audio",
                "task": "asr",
                "function": "recognition",
                "model": _model(),
                "parameters": {
                    "format": "pcm",
                    "sample_rate": 16000,
                    # Interactive: VAD segmentation, short silence → lower turn latency
                    "semantic_punctuation_enabled": False,
                    "max_sentence_silence": 800,
                    "punctuation_prediction_enabled": True,
                    # Keepalive silence from EvoSTTService must not kill the task
                    "heartbeat": True,
                    "language_hints": ["zh", "en"],
                },
                "input": {},
            },
        }
        finish_task = {
            "header": {
                "action": "finish-task",
                "task_id": task_id,
                "streaming": "duplex",
            },
            "payload": {"input": {}},
        }

        try:
            async with websockets.connect(
                _ws_url(),
                additional_headers=headers,
                open_timeout=20.0,
                max_size=8 * 1024 * 1024,
            ) as upstream:
                await upstream.send(json.dumps(run_task, ensure_ascii=False))
                started = asyncio.Event()
                stop = asyncio.Event()
                finished = False

                async def reader() -> None:
                    nonlocal finished
                    try:
                        async for raw in upstream:
                            if stop.is_set():
                                return
                            if isinstance(raw, bytes):
                                continue
                            try:
                                msg = json.loads(raw)
                            except Exception:
                                continue
                            header = msg.get("header") if isinstance(msg, dict) else None
                            if not isinstance(header, dict):
                                continue
                            event = str(header.get("event") or "")
                            if event == "task-started":
                                started.set()
                                continue
                            if event == "task-failed":
                                err = (
                                    header.get("error_message")
                                    or header.get("error_code")
                                    or "DashScope ASR task-failed"
                                )
                                if self._on_error:
                                    await self._on_error(str(err))
                                stop.set()
                                return
                            if event == "task-finished":
                                finished = True
                                stop.set()
                                return
                            if event != "result-generated":
                                continue
                            payload = msg.get("payload") if isinstance(msg, dict) else None
                            if not isinstance(payload, dict):
                                continue
                            output = payload.get("output") if isinstance(payload.get("output"), dict) else {}
                            sentence = output.get("sentence") if isinstance(output.get("sentence"), dict) else {}
                            if sentence.get("heartbeat"):
                                continue
                            text = str(sentence.get("text") or "").strip()
                            if not text:
                                continue
                            is_final = bool(sentence.get("sentence_end"))
                            await self._on_transcript(
                                text,
                                is_final,
                                "sentence-end" if is_final else "partial",
                            )
                    except asyncio.CancelledError:
                        raise
                    except Exception as e:
                        logger.warning("dashscope asr reader failed: %s", e)
                        if self._on_error:
                            await self._on_error(str(e))
                        stop.set()

                reader_task = asyncio.create_task(reader())
                try:
                    try:
                        await asyncio.wait_for(started.wait(), timeout=15.0)
                    except (TimeoutError, asyncio.TimeoutError):
                        if self._on_error:
                            await self._on_error("DashScope ASR task-started 超时")
                        stop.set()
                        return

                    while not stop.is_set() and not self._closed:
                        kind, payload = await self._queue.get()
                        if kind == "audio" and payload:
                            await upstream.send(payload)
                        elif kind == "flush":
                            # Soft boundary only — model emits sentence_end via VAD.
                            continue
                        elif kind == "stop":
                            if not finished:
                                try:
                                    await upstream.send(json.dumps(finish_task, ensure_ascii=False))
                                except Exception:
                                    pass
                            break
                finally:
                    stop.set()
                    reader_task.cancel()
                    try:
                        await reader_task
                    except (asyncio.CancelledError, Exception):
                        pass
        except Exception as e:
            logger.warning("dashscope asr session failed: %s", e)
            if self._on_error:
                await self._on_error(str(e))
