"""Offload sync SQLite repository work from the Gateway asyncio event loop.

FastAPI handlers must not call ``get_db()`` / repository helpers directly: a single
shared SQLite connection plus ``RLock`` means any slow or lock-contended read on the
event loop thread stalls **all** HTTP endpoints (including ``/health/liveness``).
"""

from __future__ import annotations

import asyncio
import concurrent.futures
import os
from collections.abc import Callable
from typing import TypeVar

T = TypeVar("T")

_DB_POOL_SIZE = max(4, min(16, int(os.getenv("EVOFLOW_DB_THREAD_POOL_SIZE", "8") or "8")))
_DB_EXECUTOR = concurrent.futures.ThreadPoolExecutor(
    max_workers=_DB_POOL_SIZE,
    thread_name_prefix="evoflow-db",
)


async def run_db(fn: Callable[..., T], /, *args, **kwargs) -> T:
    """Run a blocking DB/repository callable on a dedicated thread pool."""
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(_DB_EXECUTOR, lambda: fn(*args, **kwargs))
