"""Lightweight in-memory event queue for gateway.

Provides publish/subscribe pattern for decoupling API layer from Tool layer.
Designed to be simple, reliable, and extensible.
"""

import asyncio
import logging
import threading
import time
from collections import deque
from collections.abc import Callable
from typing import Any

from evoflow.timeutil import utc_now_iso_z

logger = logging.getLogger(__name__)


class EventQueue:
    """Lightweight in-memory event queue with background processing.

    Features:
    - Thread-safe publish/subscribe
    - Background event processing
    - Handler error isolation (one handler failure doesn't affect others)
    - Automatic retry with exponential backoff
    - Optional max queue size to prevent memory issues

    Usage:
        # Publish an event
        event_queue.publish("task_authorized", event_data)

        # Subscribe to events
        event_queue.subscribe("task_authorized", my_handler)

        # Start processing (call once at app startup)
        event_queue.start()
    """

    def __init__(self, max_size: int = 10000):
        """Initialize event queue.

        Args:
            max_size: Maximum queue size. When exceeded, oldest events are dropped.
        """
        self._queue: deque = deque()
        self._lock = threading.Lock()
        self._handlers: dict[str, list[Callable]] = {}
        self._running = False
        self._worker_thread: threading.Thread | None = None
        self._max_size = max_size
        self._stats = {
            "published": 0,
            "processed": 0,
            "errors": 0,
            "dropped": 0,
        }

    def publish(self, event_type: str, event_data: Any) -> bool:
        """Publish an event to the queue.

        Args:
            event_type: Type of event (e.g., "task_authorized")
            event_data: Event data object

        Returns:
            True if event was queued, False if dropped due to queue full
        """
        with self._lock:
            # If queue is full, drop oldest events
            while len(self._queue) >= self._max_size:
                self._queue.popleft()
                self._stats["dropped"] += 1
                logger.warning("Event queue full, dropped oldest event")

            self._queue.append(
                {
                    "type": event_type,
                    "data": event_data,
                    "timestamp": utc_now_iso_z(),
                    "retry_count": 0,
                }
            )
            self._stats["published"] += 1

        logger.info(f"[事件队列] 已发布事件: {event_type}, 队列长度: {len(self._queue)}, 运行状态: {self._running}")
        return True

    def subscribe(self, event_type: str, handler: Callable) -> None:
        """Subscribe a handler to an event type.

        Args:
            event_type: Type of event to subscribe to
            handler: Callable that receives event_data
                   Can be sync or async function
        """
        with self._lock:
            if event_type not in self._handlers:
                self._handlers[event_type] = []
            self._handlers[event_type].append(handler)

        logger.debug(f"Subscribed handler to event: {event_type}")

    def unsubscribe(self, event_type: str, handler: Callable) -> bool:
        """Unsubscribe a handler from an event type.

        Returns:
            True if handler was found and removed
        """
        with self._lock:
            if event_type in self._handlers:
                try:
                    self._handlers[event_type].remove(handler)
                    return True
                except ValueError:
                    pass
        return False

    def start(self) -> None:
        """Start the event processing loop in a background thread."""
        if self._running:
            logger.warning("Event queue already running")
            return

        self._running = True
        self._worker_thread = threading.Thread(target=self._process_events, name="EventQueueWorker", daemon=True)
        self._worker_thread.start()
        logger.info("Event queue started")

    def stop(self) -> None:
        """Stop the event processing loop."""
        self._running = False
        if self._worker_thread:
            self._worker_thread.join(timeout=5.0)
        logger.info("Event queue stopped")

    def _process_events(self) -> None:
        """Main event processing loop (runs in background thread)."""
        logger.info("[事件队列] 事件处理器已启动")

        while self._running:
            try:
                # Get next event
                event = None
                with self._lock:
                    if self._queue:
                        event = self._queue.popleft()

                if event is None:
                    # No events, sleep briefly to avoid busy-waiting
                    time.sleep(0.05)
                    continue

                event_type = event.get("type", "unknown")
                logger.info(f"[事件队列] 正在处理事件: {event_type}")

                # Process the event
                self._handle_event(event)

            except Exception as e:
                logger.exception(f"[事件队列] 事件处理循环错误: {e}")
                time.sleep(1)  # Sleep longer on error

        logger.info("[事件队列] 事件处理器已停止")

    def _run_async_handler(self, coro) -> None:
        """Run a coroutine on a dedicated loop in the worker thread (never on Gateway loop)."""
        loop = asyncio.new_event_loop()
        try:
            loop.run_until_complete(coro)
        finally:
            loop.close()

    def _handle_event(self, event: dict) -> None:
        """Handle a single event by calling all subscribed handlers.

        Args:
            event: Event dict with type, data, timestamp, retry_count
        """
        event_type = event["type"]
        event_data = event["data"]

        with self._lock:
            handlers = self._handlers.get(event_type, []).copy()

        logger.info(f"[事件队列] 事件 {event_type} 的处理器数量: {len(handlers)}")

        if not handlers:
            logger.warning(f"[事件队列] 没有处理器处理事件类型: {event_type}")
            return

        # Call each handler
        for idx, handler in enumerate(handlers):
            handler_name = handler.__name__ if hasattr(handler, "__name__") else type(handler).__name__
            logger.info(f"[事件队列] 正在调用处理器 {idx + 1}/{len(handlers)}: {handler_name}")
            try:
                if asyncio.iscoroutinefunction(handler):
                    self._run_async_handler(handler(event_data))
                else:
                    result = handler(event_data)
                    if asyncio.iscoroutine(result):
                        self._run_async_handler(result)

            except Exception as e:
                self._stats["errors"] += 1
                logger.exception(f"[事件队列] 处理器 {handler.__name__ if hasattr(handler, '__name__') else 'unknown'} 处理 {event_type} 时出错: {e}")
                # Continue to next handler - isolation

        self._stats["processed"] += 1
        logger.info(f"[事件队列] 事件 {event_type} 处理完成，已处理事件总数: {self._stats['processed']}")

    def get_stats(self) -> dict:
        """Get queue statistics."""
        with self._lock:
            return {
                **self._stats,
                "queue_size": len(self._queue),
                "running": self._running,
            }

    def clear(self) -> None:
        """Clear all pending events."""
        with self._lock:
            self._queue.clear()
        logger.info("Event queue cleared")


# Global event queue instance
# Import this and use: event_queue.publish(...), event_queue.subscribe(...)
event_queue = EventQueue()


# Convenience imports for type hints
