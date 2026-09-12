"""Runtime budgets and shared limits."""

from evoflow.runtime.long_run_limits import (
    LONG_RUN_RECURSION_LIMIT,
    LONG_RUN_STREAM_READ_SECONDS,
    LONG_RUN_WALL_MS,
    LONG_RUN_WALL_SECONDS,
    MAX_SUBAGENT_RECURSION_LIMIT,
    httpx_stream_timeout,
)

__all__ = [
    "LONG_RUN_RECURSION_LIMIT",
    "LONG_RUN_STREAM_READ_SECONDS",
    "LONG_RUN_WALL_MS",
    "LONG_RUN_WALL_SECONDS",
    "MAX_SUBAGENT_RECURSION_LIMIT",
    "httpx_stream_timeout",
]
