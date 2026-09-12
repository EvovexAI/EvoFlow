"""WebSocket session for collab workflow state, task progress, and agent stream events."""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
from typing import Any

from fastapi import WebSocket, WebSocketDisconnect

logger = logging.getLogger(__name__)

_WS_PING_SECONDS = 45


async def _cancel_tasks(*tasks: asyncio.Task) -> None:
    """Cancel and drain tasks so Queue.get() waiters are not left pending."""
    pending = [t for t in tasks if not t.done()]
    for task in pending:
        task.cancel()
    for task in pending:
        with contextlib.suppress(asyncio.CancelledError):
            await task


async def _send_event(ws: WebSocket, event: dict[str, Any]) -> bool:
    try:
        await ws.send_text(json.dumps(event, ensure_ascii=False))
        return True
    except Exception:
        return False


class _CollabWsSession:
    def __init__(self, ws: WebSocket, thread_id: str) -> None:
        self.ws = ws
        self.thread_id = thread_id
        self._channels: dict[str, asyncio.Queue[str]] = {}
        self._lock = asyncio.Lock()
        self._cancelled = False

    async def _add_channel(self, channel_id: str) -> None:
        from app.gateway.routers.events import broadcaster

        cid = str(channel_id or "").strip()
        if not cid:
            return
        async with self._lock:
            if cid in self._channels:
                return
            queue: asyncio.Queue[str] = asyncio.Queue()
            broadcaster.add_thread_observer(cid, queue)
            self._channels[cid] = queue

    async def _remove_all(self) -> None:
        from app.gateway.routers.events import broadcaster

        async with self._lock:
            for cid, queue in list(self._channels.items()):
                broadcaster.remove_thread_observer(cid, queue)
            self._channels.clear()

    async def _send_initial_snapshot(self) -> None:
        from evoflow.collab.task_progress_snapshot import build_task_progress_snapshot
        from evoflow.collab.thread_collab import load_thread_collab_state
        from evoflow.config.paths import get_paths
        from evoflow.timeutil import utc_now_iso_z

        paths = get_paths()
        try:
            snap = build_task_progress_snapshot(paths, self.thread_id)
            await _send_event(
                self.ws,
                {"type": "collab:snapshot", "data": snap, "timestamp": utc_now_iso_z()},
            )
        except Exception as e:
            logger.debug("collab ws initial snapshot failed thread=%s: %s", self.thread_id, e)

        try:
            collab = load_thread_collab_state(paths, self.thread_id)
            phase = collab.collab_phase.value if hasattr(collab.collab_phase, "value") else str(collab.collab_phase)
            await _send_event(
                self.ws,
                {
                    "type": "collab:state",
                    "data": {
                        "thread_id": self.thread_id,
                        "collab_phase": phase,
                        "bound_task_id": collab.bound_task_id,
                        "updated_at": collab.updated_at,
                    },
                    "timestamp": utc_now_iso_z(),
                },
            )
        except Exception:
            pass

    async def _reader(self) -> None:
        while not self._cancelled:
            try:
                raw = await self.ws.receive_text()
            except WebSocketDisconnect:
                self._cancelled = True
                return
            except Exception:
                self._cancelled = True
                return

            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                continue
            if not isinstance(msg, dict):
                continue

            mtype = str(msg.get("type") or "").strip().lower()
            if mtype == "ping":
                from evoflow.timeutil import utc_now_iso_z

                await _send_event(self.ws, {"type": "pong", "timestamp": utc_now_iso_z()})
                continue
            if mtype == "subscribe":
                mid = str(msg.get("main_task_id") or msg.get("task_id") or "").strip()
                if mid:
                    await self._add_channel(mid)
                    from evoflow.timeutil import utc_now_iso_z

                    await _send_event(
                        self.ws,
                        {
                            "type": "subscribed",
                            "data": {"channel": mid},
                            "timestamp": utc_now_iso_z(),
                        },
                    )

    async def _writer(self) -> None:
        from evoflow.timeutil import utc_now_iso_z

        while not self._cancelled:
            async with self._lock:
                queues = list(self._channels.items())

            if not queues:
                await asyncio.sleep(0.2)
                continue

            waiter_tasks = [
                asyncio.create_task(q.get(), name=f"collab_ws_qget_{cid}") for cid, q in queues
            ]
            waiters = {task: cid for task, (cid, _) in zip(waiter_tasks, queues, strict=True)}
            try:
                done, pending = await asyncio.wait(
                    waiter_tasks,
                    timeout=_WS_PING_SECONDS,
                    return_when=asyncio.FIRST_COMPLETED,
                )
                await _cancel_tasks(*pending)

                if not done:
                    await _send_event(self.ws, {"type": "ping", "timestamp": utc_now_iso_z()})
                    continue

                for task in done:
                    cid = waiters[task]
                    try:
                        raw = task.result()
                    except Exception:
                        continue
                    try:
                        event = json.loads(raw) if isinstance(raw, str) else raw
                    except json.JSONDecodeError:
                        continue
                    if not isinstance(event, dict):
                        continue
                    if not await _send_event(self.ws, event):
                        self._cancelled = True
                        return
                    logger.debug(
                        "collab ws forward channel=%s type=%s thread=%s",
                        cid,
                        event.get("type"),
                        self.thread_id,
                    )
            finally:
                await _cancel_tasks(*waiter_tasks)

    async def run(self) -> None:
        from evoflow.collab.thread_collab import load_thread_collab_state
        from evoflow.config.paths import get_paths
        from evoflow.timeutil import utc_now_iso_z

        await self._add_channel(self.thread_id)
        try:
            collab = load_thread_collab_state(get_paths(), self.thread_id)
            bound = str(collab.bound_task_id or "").strip()
            if bound:
                await self._add_channel(bound)
        except Exception:
            pass

        await self._send_initial_snapshot()
        await _send_event(
            self.ws,
            {
                "type": "connected",
                "data": {"thread_id": self.thread_id, "channels": list(self._channels.keys())},
                "timestamp": utc_now_iso_z(),
            },
        )

        reader = asyncio.create_task(self._reader(), name="collab_ws_reader")
        writer = asyncio.create_task(self._writer(), name="collab_ws_writer")
        try:
            await asyncio.wait({reader, writer}, return_when=asyncio.FIRST_COMPLETED)
        finally:
            self._cancelled = True
            await _cancel_tasks(reader, writer)
            await self._remove_all()


async def run_collab_thread_ws(ws: WebSocket, thread_id: str) -> None:
    tid = str(thread_id or "").strip()
    if not tid:
        await ws.close(code=1008, reason="thread_id required")
        return
    await ws.accept()
    session = _CollabWsSession(ws, tid)
    try:
        await session.run()
    except WebSocketDisconnect:
        pass
    except Exception as e:
        logger.debug("collab ws session ended thread=%s: %s", tid, e)
    finally:
        await session._remove_all()
