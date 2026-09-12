"""Run coroutines on a dedicated short-lived event loop (thread-pool safe)."""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable
from typing import TypeVar

from evoflow.platform.asyncio_windows import apply_windows_langgraph_runtime_fixes

_T = TypeVar("_T")


def run_coroutine_on_fresh_loop[T](coro: Awaitable[_T]) -> _T:
    """Execute *coro* on a new event loop and tear it down cleanly.

    Used by subagent thread-pool workers so httpx/OpenAI clients never reuse
    asyncio primitives from a prior ``asyncio.run()`` on the same thread.
    """
    apply_windows_langgraph_runtime_fixes()
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    try:
        return loop.run_until_complete(coro)
    finally:
        try:
            loop.run_until_complete(loop.shutdown_asyncgens())
        except Exception:
            pass
        try:
            loop.run_until_complete(loop.shutdown_default_executor())
        except Exception:
            pass
        loop.close()
        asyncio.set_event_loop(None)
