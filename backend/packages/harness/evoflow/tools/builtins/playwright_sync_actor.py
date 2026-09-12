"""Run Playwright sync API on a single dedicated thread per actor instance.

Hermes-agent avoids ``NotImplementedError`` from Playwright's greenlet-based sync
legacy helper; browser tools now use the ``agent-browser`` CLI exclusively. LangGraph
runs sync tools on a thread pool; marshalling onto **one worker thread per graph
``thread_id``** (see :mod:`browser_tools`) keeps each ``sync_playwright`` driver
isolated — no shared greenlet stack across conversations.
"""

from __future__ import annotations

import logging
import queue
import sys
import threading
from collections.abc import Callable
from typing import Any, TypeVar

logger = logging.getLogger(__name__)

T = TypeVar("T")


def playwright_browser_missing_hint(exc: BaseException) -> str | None:
    """Return install instructions when Chromium binaries are missing."""
    msg = f"{exc}".lower()
    if "executable doesn't exist" not in msg and "playwright install" not in msg:
        return None
    return "Chromium 浏览器未安装。请在 EvoFlow 后端目录执行：`.venv\\Scripts\\python.exe -m playwright install chromium`（Windows）或 `python -m playwright install chromium`（约 300MB，需联网），完成后重试。"


def init_playwright_worker_thread() -> None:
    """Prepare the current OS thread for Playwright sync (subprocess spawn on Windows).

    ``run_langgraph_cli`` sets ``WindowsSelectorEventLoopPolicy`` globally on Windows so
    httpx/OpenAI streaming does not hit "Event loop is closed". Selector loops cannot
    run ``asyncio.create_subprocess_exec``, which Playwright uses to launch Chromium.
    Worker threads inherit that policy unless we switch to Proactor here.
    """
    if sys.platform != "win32":
        return
    import asyncio

    try:
        asyncio.set_event_loop_policy(asyncio.WindowsProactorEventLoopPolicy())
    except AttributeError:
        return
    except Exception:
        logger.debug("init_playwright_worker_thread: set_event_loop_policy failed", exc_info=True)
        return
    try:
        loop = asyncio.get_event_loop()
        if loop.is_closed():
            asyncio.set_event_loop(asyncio.new_event_loop())
    except RuntimeError:
        try:
            asyncio.set_event_loop(asyncio.new_event_loop())
        except Exception:
            logger.debug("init_playwright_worker_thread: set_event_loop failed", exc_info=True)


class PlaywrightSyncActor:
    """Single-thread queue executor for blocking Playwright sync work."""

    __slots__ = ("_q", "_worker", "_start_lock", "_thread_name")

    def __init__(self, thread_name: str = "evoflow-playwright-sync") -> None:
        self._q: queue.Queue[Any] = queue.Queue()
        self._worker: threading.Thread | None = None
        self._start_lock = threading.Lock()
        self._thread_name = (thread_name or "evoflow-playwright-sync")[:48]

    def _loop(self) -> None:
        init_playwright_worker_thread()
        while True:
            item = self._q.get()
            if item is None:
                break
            fn, ev, box = item  # type: ignore[misc]
            try:
                box.append(("ok", fn()))
            except Exception as e:
                logger.debug("playwright_sync_actor: task failed", exc_info=True)
                box.append(("err", e))
            finally:
                ev.set()

    def _ensure_worker(self) -> None:
        with self._start_lock:
            if self._worker is not None and self._worker.is_alive():
                return
            self._worker = threading.Thread(
                target=self._loop,
                name=self._thread_name,
                daemon=True,
            )
            self._worker.start()

    def run(self, fn: Callable[[], T]) -> T:
        """Run ``fn`` on the Playwright worker thread and return its result."""
        if self._worker is not None and threading.current_thread() is self._worker:
            return fn()
        self._ensure_worker()
        ev = threading.Event()
        box: list[tuple[str, object]] = []
        self._q.put((fn, ev, box))
        ev.wait()
        kind, payload = box[0]
        if kind == "err":
            raise payload  # type: ignore[misc]
        return payload  # type: ignore[return-value]

    def shutdown(self, join_timeout: float = 20.0) -> None:
        """Ask the worker to exit. Does not block on ``join()`` (avoids Windows native crashes during driver teardown)."""
        del join_timeout  # reserved for API stability
        try:
            self._q.put_nowait(None)
        except Exception:
            try:
                self._q.put(None, timeout=0.5)
            except Exception:
                pass
        with self._start_lock:
            self._worker = None


playwright_sync_actor = PlaywrightSyncActor()


def run_on_playwright_thread[T](fn: Callable[[], T]) -> T:
    """Default shared actor (legacy / tests). Prefer per-``thread_id`` actors in browser_tools."""
    return playwright_sync_actor.run(fn)
