"""Cache for MCP tools to avoid repeated loading."""

from __future__ import annotations

import asyncio
import contextlib
import logging
import os
import threading
from typing import Any

from langchain_core.tools import BaseTool

logger = logging.getLogger(__name__)

_mcp_tools_cache: list[BaseTool] | None = None
_cache_initialized = False
_config_fingerprint: str | None = None
_mcp_server_status: dict[str, dict[str, Any]] = {}
_mcp_init_error: str | None = None
_thread_init_lock = threading.Lock()
_async_init_lock: asyncio.Lock | None = None
_registered_init_loop: asyncio.AbstractEventLoop | None = None


def _get_async_init_lock() -> asyncio.Lock:
    """Create the asyncio lock on the active loop (never at import time).

    If a previous lock was bound to a closed / different loop, recreate it.
    """
    global _async_init_lock
    loop = asyncio.get_running_loop()
    if _async_init_lock is not None:
        bound_id = getattr(_async_init_lock, "_evoflow_loop_id", None)
        if bound_id is not None and bound_id != id(loop):
            _async_init_lock = None
    if _async_init_lock is None:
        lock = asyncio.Lock()
        setattr(lock, "_evoflow_loop_id", id(loop))
        _async_init_lock = lock
    return _async_init_lock


def _init_timeout_sec() -> float:
    timeout_raw = os.environ.get("EVOFLOW_MCP_INIT_TIMEOUT_SEC", "120").strip()
    try:
        return float(timeout_raw)
    except ValueError:
        return 120.0


def _get_config_fingerprint() -> str:
    from evoflow.mcp.tools import mcp_config_fingerprint

    return mcp_config_fingerprint()


def set_mcp_server_load_status(status: dict[str, dict[str, Any]]) -> None:
    """Persist per-server MCP load outcome (ready / error) after initialization."""
    global _mcp_server_status
    _mcp_server_status = dict(status)


def get_mcp_server_load_status() -> dict[str, dict[str, Any]]:
    return dict(_mcp_server_status)


def mcp_cache_config_mtime() -> str | None:
    """Config fingerprint when cache was last built (legacy name kept for API compat)."""
    return _config_fingerprint


def mcp_init_error() -> str | None:
    return _mcp_init_error


def _is_cache_stale() -> bool:
    global _config_fingerprint

    if not _cache_initialized:
        return False

    current = _get_config_fingerprint()
    if _config_fingerprint is None or not current:
        return False

    if current != _config_fingerprint:
        logger.info("MCP config changed since cache was built, cache is stale")
        return True

    return False


def register_mcp_init_loop(loop: asyncio.AbstractEventLoop) -> None:
    """Register the Gateway/LangGraph asyncio loop for off-thread lazy MCP init."""
    global _registered_init_loop
    _registered_init_loop = loop


def _on_asyncio_loop_thread() -> bool:
    """True when called from a coroutine running on an event-loop thread."""
    try:
        asyncio.get_running_loop()
        return True
    except RuntimeError:
        return False


def schedule_mcp_tools_warmup() -> asyncio.Task[list[BaseTool]] | None:
    """Schedule non-blocking MCP init on the registered loop (safe at Gateway startup)."""
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        return None
    return loop.create_task(initialize_mcp_tools(), name="mcp-tools-warmup")


@contextlib.contextmanager
def _suppress_mcp_stdio_parse_noise():
    """browser-tools-mcp prints port-scan lines to stdout; SDK logs benign JSON parse errors."""
    log = logging.getLogger("mcp.client.stdio")
    prev = log.level
    log.setLevel(logging.CRITICAL)
    try:
        yield
    finally:
        log.setLevel(prev)


async def initialize_mcp_tools() -> list[BaseTool]:
    """Initialize and cache MCP tools on the **current running** event loop."""
    global _mcp_tools_cache, _cache_initialized, _config_fingerprint, _mcp_init_error, _mcp_server_status

    async with _get_async_init_lock():
        if _cache_initialized:
            logger.info("MCP tools already initialized")
            return _mcp_tools_cache or []

        from evoflow.mcp.tools import get_mcp_tools

        logger.info("Initializing MCP tools...")
        timeout_sec = _init_timeout_sec()
        _mcp_init_error = None
        _mcp_server_status = {}

        try:
            with _suppress_mcp_stdio_parse_noise():
                if timeout_sec > 0:
                    _mcp_tools_cache = await asyncio.wait_for(get_mcp_tools(), timeout=timeout_sec)
                else:
                    _mcp_tools_cache = await get_mcp_tools()
        except TimeoutError:
            _mcp_init_error = (
                f"MCP initialization timed out after {timeout_sec:.0f}s "
                "(stdio/network MCP server may be hung)"
            )
            logger.error(
                "%s. Continuing with partial/zero MCP tools. "
                "Fix or disable servers in mcp.json, or set EVOFLOW_MCP_INIT_TIMEOUT_SEC.",
                _mcp_init_error,
            )
            _mcp_tools_cache = _mcp_tools_cache or []
        except Exception as exc:
            _mcp_init_error = str(exc)[:500]
            logger.error("MCP tools initialization failed: %s", exc, exc_info=True)
            _mcp_tools_cache = []

        _cache_initialized = True
        _config_fingerprint = _get_config_fingerprint()
        logger.info(
            "MCP tools initialized: %d tool(s) loaded (config fingerprint: %s…)",
            len(_mcp_tools_cache or []),
            (_config_fingerprint or "")[:12],
        )

        # Invalidate the LRU cache on get_available_tools() so that subsequent
        # agent builds pick up the freshly loaded MCP tools. Without this, the
        # stale cache (populated before MCP warmup completed, returning 0 MCP
        # tools) would persist for the entire process lifetime.
        try:
            from evoflow.tools.tools import _cached_resolve_tools
            _cached_resolve_tools.cache_clear()
            logger.info("Cleared _cached_resolve_tools LRU cache after MCP init (%d tools)", len(_mcp_tools_cache or []))
        except Exception:
            logger.debug("Could not clear _cached_resolve_tools LRU cache", exc_info=True)

        # Also clear the lead-agent graph cache: graphs built before MCP warmup
        # completed may have been compiled without MCP tools, and the graph cache
        # key does not distinguish "has MCP tools" vs "MCP tools not yet loaded".
        try:
            from evoflow.agents.lead_agent.graph_cache import clear_lead_agent_graph_cache
            clear_lead_agent_graph_cache()
            logger.info("Cleared lead-agent graph cache after MCP init (%d tools)", len(_mcp_tools_cache or []))
        except Exception:
            logger.debug("Could not clear lead-agent graph cache", exc_info=True)

        return _mcp_tools_cache or []


def _sync_initialize_on_loop(loop: asyncio.AbstractEventLoop, timeout_sec: float) -> None:
    """Block until MCP init completes on ``loop`` (must be the LangGraph worker loop)."""
    fut = asyncio.run_coroutine_threadsafe(initialize_mcp_tools(), loop)
    if timeout_sec > 0:
        fut.result(timeout=timeout_sec + 5.0)
    else:
        fut.result()


def peek_cached_mcp_tools() -> list[BaseTool]:
    """Return cached MCP tools when init already completed; otherwise ``[]``.

    Unlike :func:`get_cached_mcp_tools`, this never blocks or triggers lazy init —
    safe for Gateway HTTP handlers that run on the asyncio event loop.
    """
    if not _cache_initialized:
        return []
    return _mcp_tools_cache or []


def mcp_cache_initialized() -> bool:
    """Whether MCP tools have been loaded at least once in this process."""
    return _cache_initialized


def get_cached_mcp_tools() -> list[BaseTool]:
    """Return cached MCP tools; lazy-init from a worker thread when possible.

    Never blocks the asyncio event loop: calling this from an ``async`` HTTP handler
    (or any coroutine on the loop thread) returns ``[]`` while the cache is cold.
    Gateway startup should call :func:`schedule_mcp_tools_warmup` instead.
    """
    global _cache_initialized

    if _is_cache_stale():
        logger.info("MCP cache is stale, resetting for re-initialization...")
        reset_mcp_tools_cache()

    if _cache_initialized:
        return _mcp_tools_cache or []

    # NON-BLOCKING: return early on the event loop thread BEFORE acquiring
    # _thread_init_lock. If we waited for the lock here, a worker thread
    # holding it while waiting for this loop (via _sync_initialize_on_loop)
    # would deadlock — see hang-diagnostics/gateway-hang-*.json.
    if not _cache_initialized and _on_asyncio_loop_thread():
        logger.debug(
            "get_cached_mcp_tools: cache cold inside asyncio task; returning []. "
            "Use schedule_mcp_tools_warmup() / await initialize_mcp_tools()."
        )
        return []

    with _thread_init_lock:
        if _cache_initialized:
            return _mcp_tools_cache or []

        loop = _registered_init_loop
        if loop is None or not loop.is_running():
            logger.warning(
                "get_cached_mcp_tools: cache cold and no registered init loop. "
                "Call register_mcp_init_loop() at gateway startup."
            )
            return []

        timeout_sec = _init_timeout_sec()
        try:
            _sync_initialize_on_loop(loop, timeout_sec)
        except Exception as e:
            logger.error("Failed to lazy-initialize MCP tools on registered loop: %s", e, exc_info=True)
            return []

    return _mcp_tools_cache or []


def reset_mcp_tools_cache() -> None:
    """Reset the MCP tools cache."""
    global _mcp_tools_cache, _cache_initialized, _config_fingerprint, _async_init_lock
    global _mcp_server_status, _mcp_init_error
    _mcp_tools_cache = None
    _cache_initialized = False
    _config_fingerprint = None
    _mcp_server_status = {}
    _mcp_init_error = None
    # Do not unconditionally null ``_async_init_lock``: concurrent
    # ``initialize_mcp_tools`` on the same loop must keep sharing one lock.
    # Cross-loop staleness is handled lazily in ``_get_async_init_lock``.
    try:
        loop = asyncio.get_running_loop()
        lock = _async_init_lock
        if lock is not None and getattr(lock, "_evoflow_loop_id", None) != id(loop):
            _async_init_lock = None
    except RuntimeError:
        # No running loop — safe to drop the lock so the next loop recreates it.
        _async_init_lock = None
    logger.info("MCP tools cache reset")
    # Invalidate LRU cache so get_available_tools() rebuilds with fresh MCP tools
    try:
        from evoflow.tools.tools import _cached_resolve_tools
        _cached_resolve_tools.cache_clear()
        logger.info("Cleared _cached_resolve_tools LRU cache on MCP reset")
    except Exception:
        logger.debug("Could not clear _cached_resolve_tools LRU cache on reset", exc_info=True)
    try:
        from evoflow.agents.lead_agent.graph_cache import clear_lead_agent_graph_cache
        clear_lead_agent_graph_cache()
        logger.info("Cleared lead-agent graph cache on MCP reset")
    except Exception:
        logger.debug("Could not clear lead-agent graph cache on reset", exc_info=True)
    try:
        schedule_mcp_tools_warmup()
    except Exception:
        logger.debug("MCP warmup reschedule skipped after cache reset", exc_info=True)
