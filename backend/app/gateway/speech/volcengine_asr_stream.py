from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import uuid

from fastapi import WebSocket, WebSocketDisconnect
from starlette.websockets import WebSocketState

from app.gateway.speech.volcengine_asr_ws import (
    _MSG_SERVER_ERROR,
    _build_audio_only_request,
    _build_full_client_request,
    _extract_utterances,
    _parse_server_frame,
)

logger = logging.getLogger(__name__)


async def run_asr_stream_proxy(
    browser_ws: WebSocket,
    *,
    api_key: str,
    resource_id: str,
    ws_url: str,
) -> None:
    headers = {
        "X-Api-Key": api_key,
        "X-Api-Resource-Id": resource_id,
        "X-Api-Connect-Id": str(uuid.uuid4()),
    }
    full_payload = {
        "user": {"uid": "evoflow-chat"},
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
        import websockets
    except ImportError as e:
        await browser_ws.send_json({"type": "error", "message": "websockets package missing"})
        raise RuntimeError("websockets package required for streaming ASR") from e

    queue: asyncio.Queue[tuple[str, bytes | None]] = asyncio.Queue()
    stop_event = asyncio.Event()

    async def browser_reader() -> None:
        try:
            while not stop_event.is_set():
                msg = await browser_ws.receive()
                if msg["type"] == "websocket.disconnect":
                    stop_event.set()
                    await queue.put(("stop", None))
                    return
                if msg["type"] != "websocket.receive":
                    continue
                chunk = msg.get("bytes")
                if chunk:
                    await queue.put(("audio", chunk))
                    continue
                text = msg.get("text")
                if text is None:
                    continue
                text = str(text).strip()
                if not text:
                    continue
                try:
                    data = json.loads(text)
                except json.JSONDecodeError:
                    logger.debug("ASR ignoring non-JSON browser text frame: %r", text[:80])
                    continue
                msg_type = str(data.get("type") or "").strip().lower()
                if msg_type in {"stop", "flush"}:
                    await queue.put(("stop", None))
                    if msg_type == "stop":
                        return
        except WebSocketDisconnect:
            stop_event.set()
            with contextlib.suppress(asyncio.QueueFull):
                await queue.put(("stop", None))
        except asyncio.CancelledError:
            raise
        except Exception as e:
            logger.warning("ASR browser read failed: %s", e)
            stop_event.set()
            if browser_ws.client_state == WebSocketState.CONNECTED:
                with contextlib.suppress(Exception):
                    await browser_ws.send_json(
                        {
                            "type": "error",
                            "message": "语音识别连接异常，请重试",
                            "code": "browser_read_failed",
                        }
                    )

    reader_task = asyncio.create_task(browser_reader())

    try:
        async with websockets.connect(ws_url, additional_headers=headers, open_timeout=20.0) as upstream:
            seq = 1
            await upstream.send(_build_full_client_request(seq, full_payload))
            seq = 2
            last_text = ""

            async def upstream_loop() -> None:
                nonlocal last_text
                try:
                    async for frame in upstream:
                        if stop_event.is_set():
                            return
                        if isinstance(frame, str):
                            continue
                        try:
                            parsed = _parse_server_frame(frame)
                        except Exception as parse_exc:
                            logger.warning("ASR skip malformed upstream frame: %s", parse_exc)
                            continue
                        if parsed.get("message_type") == _MSG_SERVER_ERROR:
                            detail = parsed.get("detail")
                            await browser_ws.send_json(
                                {"type": "error", "message": f"ASR protocol error: {detail}"}
                            )
                            stop_event.set()
                            return
                        utterances = _extract_utterances(parsed.get("payload"))
                        is_last = bool(parsed.get("is_last"))
                        if utterances:
                            for ut in utterances:
                                if ut["text"]:
                                    last_text = ut["text"]
                                await browser_ws.send_json({
                                    "type": "transcript",
                                    "text": ut["text"],
                                    "is_final": ut["is_final"],
                                    "seg": ut["seg"],
                                })
                        if is_last:
                            await browser_ws.send_json({
                                "type": "final",
                                "text": last_text,
                                "final": True,
                            })
                            stop_event.set()
                            return
                except asyncio.CancelledError:
                    raise
                except Exception as e:
                    logger.warning("ASR upstream read failed: %s", e)
                    if browser_ws.client_state == WebSocketState.CONNECTED:
                        with contextlib.suppress(Exception):
                            await browser_ws.send_json(
                                {
                                    "type": "error",
                                    "message": "语音识别连接异常，请重试",
                                    "code": "upstream_read_failed",
                                }
                            )
                    stop_event.set()

            upstream_task = asyncio.create_task(upstream_loop())
            final_sent = False

            async def _send_final_packet() -> None:
                nonlocal final_sent
                if final_sent:
                    return
                await upstream.send(_build_audio_only_request(seq, b"", is_last=True))
                final_sent = True

            try:
                while not stop_event.is_set():
                    kind, payload = await queue.get()
                    if kind == "audio" and payload:
                        if final_sent:
                            continue
                        await upstream.send(_build_audio_only_request(seq, payload, is_last=False))
                        seq += 1
                        continue
                    if kind == "stop":
                        await _send_final_packet()
                        break
            finally:
                if not final_sent:
                    with contextlib.suppress(Exception):
                        await _send_final_packet()
                with contextlib.suppress(asyncio.TimeoutError):
                    await asyncio.wait_for(upstream_task, timeout=15.0)
                if not upstream_task.done():
                    upstream_task.cancel()
                    with contextlib.suppress(asyncio.CancelledError):
                        await upstream_task
    finally:
        stop_event.set()
        reader_task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await reader_task
