"""Proxy agent-browser viewport WebSocket stream to EvoPanel clients."""

from __future__ import annotations

import asyncio
import contextlib
import logging

from fastapi import WebSocket, WebSocketDisconnect
from starlette.websockets import WebSocketState

logger = logging.getLogger(__name__)

_UPSTREAM_RETRY_DELAY_SEC = 0.45
_MAX_UPSTREAM_WAIT_ATTEMPTS = 30


async def run_browser_stream_proxy(client_ws: WebSocket, thread_id: str) -> None:
    from evoflow.tools.builtins.browser_stream import (
        ensure_browser_stream_port,
        invalidate_browser_stream_cache,
        restart_browser_stream,
    )

    await client_ws.accept()
    logger.info("browser stream ws client connected thread=%s", thread_id)

    try:
        import websockets
    except ImportError:
        await client_ws.send_json({"type": "error", "message": "websockets package missing"})
        await client_ws.close(code=1011)
        return

    stop_event = asyncio.Event()
    wait_attempts = 0

    async def relay_client_to_upstream(upstream) -> None:
        try:
            while not stop_event.is_set():
                msg = await client_ws.receive()
                if msg["type"] == "websocket.disconnect":
                    stop_event.set()
                    return
                if msg["type"] != "websocket.receive":
                    continue
                chunk = msg.get("bytes")
                if chunk is not None:
                    await upstream.send(chunk)
                    continue
                text = msg.get("text")
                if text is not None:
                    await upstream.send(text)
        except WebSocketDisconnect:
            stop_event.set()
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            logger.debug("browser stream client relay stopped: %s", exc)
            stop_event.set()

    async def relay_upstream_to_client(upstream) -> None:
        try:
            async for message in upstream:
                if stop_event.is_set():
                    return
                if client_ws.client_state != WebSocketState.CONNECTED:
                    stop_event.set()
                    return
                if isinstance(message, bytes):
                    await client_ws.send_bytes(message)
                else:
                    await client_ws.send_text(str(message))
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            logger.debug("browser stream upstream relay stopped thread=%s: %s", thread_id, exc)

    try:
        upstream_losses = 0
        while not stop_event.is_set():
            if client_ws.client_state != WebSocketState.CONNECTED:
                break

            port = await asyncio.to_thread(ensure_browser_stream_port, thread_id)
            if not port:
                wait_attempts += 1
                if wait_attempts == 1:
                    with contextlib.suppress(Exception):
                        await client_ws.send_json({"type": "status", "screencasting": False})
                if wait_attempts >= _MAX_UPSTREAM_WAIT_ATTEMPTS:
                    logger.warning("browser stream ws no port thread=%s", thread_id)
                    with contextlib.suppress(Exception):
                        await client_ws.send_json(
                            {
                                "type": "error",
                                "message": "No active browser stream for this session. Run browser(action='open', url=...).",
                            }
                        )
                    break
                await asyncio.sleep(_UPSTREAM_RETRY_DELAY_SEC)
                continue

            wait_attempts = 0
            upstream_url = f"ws://127.0.0.1:{port}"
            logger.info("browser stream ws upstream thread=%s port=%s", thread_id, port)
            try:
                async with websockets.connect(
                    upstream_url,
                    open_timeout=8.0,
                    close_timeout=3.0,
                ) as upstream:
                    upstream_losses = 0
                    client_task = asyncio.create_task(relay_client_to_upstream(upstream))
                    upstream_task = asyncio.create_task(relay_upstream_to_client(upstream))
                    done, pending = await asyncio.wait(
                        {client_task, upstream_task},
                        return_when=asyncio.FIRST_COMPLETED,
                    )
                    for task in pending:
                        task.cancel()
                    for task in done:
                        with contextlib.suppress(Exception):
                            await task
            except WebSocketDisconnect:
                stop_event.set()
                break
            except Exception as exc:
                logger.warning("browser stream upstream connect failed thread=%s: %s", thread_id, exc)

            if stop_event.is_set():
                break

            # Upstream dropped — re-resolve port; avoid restart loops (backend restores stream).
            upstream_losses += 1
            logger.info(
                "browser stream upstream lost, re-resolving thread=%s loss=%s",
                thread_id,
                upstream_losses,
            )
            invalidate_browser_stream_cache(thread_id)
            if upstream_losses >= 4:
                await asyncio.to_thread(restart_browser_stream, thread_id)
                upstream_losses = 0
            await asyncio.sleep(_UPSTREAM_RETRY_DELAY_SEC)
    except WebSocketDisconnect:
        return
    except Exception as exc:
        logger.warning("browser stream proxy failed thread=%s: %s", thread_id, exc)
        if client_ws.client_state == WebSocketState.CONNECTED:
            with contextlib.suppress(Exception):
                await client_ws.send_json(
                    {
                        "type": "error",
                        "message": "Failed to connect to browser stream",
                    }
                )
                await client_ws.close(code=1011)
