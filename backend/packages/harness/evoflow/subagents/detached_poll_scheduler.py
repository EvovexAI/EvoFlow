"""Persistent asyncio loop for detached task_tool poll runners.

Collab follow-up often schedules detached polls from a subagent's short-lived
``asyncio.run()`` loop. Those polls must outlive the caller loop.
"""

from __future__ import annotations

import asyncio
import logging
import threading
from collections.abc import Coroutine
from typing import Any, TypeVar

logger = logging.getLogger(__name__)

_T = TypeVar("_T")

_loop: asyncio.AbstractEventLoop | None = None
_thread: threading.Thread | None = None
_ready = threading.Event()
_lock = threading.Lock()
_tasks: set[asyncio.Task[Any]] = set()


def _loop_thread_main() -> None:
    global _loop
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    _loop = loop
    # 用 call_soon 确保 run_forever 启动后才发信号，
    # 避免 _ensure_loop 中 _loop.is_running() 在 run_forever 之前检查返回 False
    loop.call_soon(_ready.set)
    logger.info("[poll] detached_poll_scheduler 开始处理 loop")
    try:
        loop.run_forever()
    finally:
        try:
            loop.run_until_complete(loop.shutdown_asyncgens())
        except Exception:
            pass
        loop.close()
        logger.debug("detached_poll_scheduler: loop stopped")


def _ensure_loop() -> asyncio.AbstractEventLoop:
    global _thread
    with _lock:
        if _loop is not None and _loop.is_running():
            return _loop
        _ready.clear()
        _thread = threading.Thread(
            target=_loop_thread_main,
            name="task-tool-detached-poll",
            daemon=True,
        )
        _thread.start()
    if not _ready.wait(timeout=5.0):
        raise RuntimeError("detached_poll_scheduler: background loop failed to start")
    if _loop is None or not _loop.is_running():
        raise RuntimeError("detached_poll_scheduler: background loop not running")
    return _loop


def _task_done(task: asyncio.Task[Any]) -> None:
    _tasks.discard(task)
    if task.cancelled():
        return
    exc = task.exception()
    if exc is not None:
        logger.error("detached_poll_scheduler: task %s failed: %s", task.get_name(), exc)


def schedule_detached_poll(coro: Any, *, name: str | None = None) -> None:
    """Schedule a coroutine on the persistent detached-poll loop.

    Accepts a coroutine **or** an async function (zero-arg); never use the
    LangGraph job event loop for these fire-and-forget tasks.
    """
    if asyncio.iscoroutinefunction(coro):
        coro = coro()
    elif callable(coro) and not asyncio.iscoroutine(coro):
        try:
            maybe = coro()
        except TypeError:
            maybe = coro
        if asyncio.iscoroutine(maybe):
            coro = maybe
    if not asyncio.iscoroutine(coro):
        raise TypeError(
            f"schedule_detached_poll expected a coroutine, got {type(coro)!r}"
        )

    logger.info("[poll] detached_poll 开始处理 schedule name=%s", name or "detached-poll")
    loop = _ensure_loop()

    def _start() -> None:
        task = loop.create_task(coro, name=name or "detached-poll")
        _tasks.add(task)
        task.add_done_callback(_task_done)

    loop.call_soon_threadsafe(_start)
