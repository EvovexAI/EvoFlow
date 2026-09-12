"""LangGraph HTTP reachability helpers (shared by proactive, gateway, channels)."""

from __future__ import annotations

import asyncio
import logging
import os
from typing import Any

import httpx

from evoflow.langgraph_run_config import resolve_langgraph_base_url

logger = logging.getLogger(__name__)


def is_langgraph_connect_error(exc: BaseException | None) -> bool:
    """True when LangGraph SDK/HTTP could not establish a TCP connection."""
    if exc is None:
        return False
    name = type(exc).__name__
    mod = type(exc).__module__
    msg = str(exc).lower()
    if name == "ConnectError" and ("httpx" in mod or "httpcore" in mod):
        return True
    if name in {"ConnectError", "ConnectionError", "ConnectTimeout", "PoolTimeout"}:
        return True
    return any(
        token in msg
        for token in (
            "connection attempts failed",
            "connection refused",
            "connecterror",
            "all connection attempts failed",
            "name or service not known",
            "getaddrinfo failed",
            "network is unreachable",
        )
    )


async def wait_langgraph_ready(
    *,
    base_url: str | None = None,
    attempts: int = 15,
    delay_seconds: float = 0.4,
) -> bool:
    """Poll ``GET {base_url}/ok`` until LangGraph answers or attempts exhaust."""
    ok_url = f"{(base_url or resolve_langgraph_base_url()).rstrip('/')}/ok"
    timeout = httpx.Timeout(connect=2.0, read=2.0, write=2.0, pool=2.0)
    tries = max(1, int(attempts))
    pause = max(0.05, float(delay_seconds))
    async with httpx.AsyncClient(timeout=timeout) as client:
        for attempt in range(tries):
            try:
                resp = await client.get(ok_url)
                if resp.status_code == 200:
                    return True
            except Exception:
                if attempt == tries - 1:
                    logger.debug("langgraph ready probe failed url=%s", ok_url, exc_info=True)
            if attempt + 1 < tries:
                await asyncio.sleep(pause)
    return False


async def create_langgraph_thread(
    client: Any,
    *,
    metadata: dict[str, Any] | None = None,
    attempts: int | None = None,
    retry_delay_seconds: float | None = None,
) -> dict[str, Any]:
    """Create a LangGraph thread with short retries on transient connect failures."""
    max_attempts = max(
        1,
        int(
            attempts
            if attempts is not None
            else os.getenv("EVOFLOW_LANGGRAPH_CREATE_RETRIES", "3")
        ),
    )
    delay = max(
        0.1,
        float(
            retry_delay_seconds
            if retry_delay_seconds is not None
            else os.getenv("EVOFLOW_LANGGRAPH_CREATE_RETRY_DELAY", "1.0")
        ),
    )
    body = dict(metadata or {})
    last_exc: BaseException | None = None
    for attempt in range(max_attempts):
        try:
            return await client.threads.create(metadata=body)
        except Exception as exc:
            last_exc = exc
            if not is_langgraph_connect_error(exc) or attempt + 1 >= max_attempts:
                raise
            logger.warning(
                "langgraph threads.create connect failed (attempt %d/%d), retry in %.1fs",
                attempt + 1,
                max_attempts,
                delay,
            )
            await asyncio.sleep(delay * (attempt + 1))
    if last_exc is not None:
        raise last_exc
    raise RuntimeError("langgraph threads.create failed without exception")
