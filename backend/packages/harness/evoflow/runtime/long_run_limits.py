"""Shared wall-clock and LangGraph budgets for long Plan / supervisor runs."""

from __future__ import annotations

import os

# Default 4h — align project crew, gateway stream proxy, guardian hold, panel chat.
LONG_RUN_WALL_SECONDS = max(3600, int(os.getenv("EVOFLOW_LONG_RUN_WALL_SECONDS", "14400")))

LONG_RUN_WALL_MS = LONG_RUN_WALL_SECONDS * 1000

LONG_RUN_STREAM_READ_SECONDS = float(
    os.getenv("EVOFLOW_LONG_RUN_STREAM_READ_SECONDS", str(LONG_RUN_WALL_SECONDS))
)

# Lead / Plan main graph super-step cap (not LLM turn count).
LONG_RUN_RECURSION_LIMIT = max(500, int(os.getenv("EVOFLOW_LONG_RUN_RECURSION_LIMIT", "7500")))

# Subagent graphs: derived from max_turns unless explicit; ceiling for long project roles.
MAX_SUBAGENT_RECURSION_LIMIT = max(
    1500,
    int(os.getenv("EVOFLOW_SUBAGENT_RECURSION_LIMIT_MAX", "9000")),
)


def httpx_stream_timeout():
    """httpx client for LangGraph ``/runs/stream`` (read must cover full Plan execution)."""
    import httpx

    read_s = LONG_RUN_STREAM_READ_SECONDS
    write_s = min(read_s, max(600.0, read_s / 2.0))
    return httpx.Timeout(connect=10.0, read=read_s, write=write_s, pool=120.0)
