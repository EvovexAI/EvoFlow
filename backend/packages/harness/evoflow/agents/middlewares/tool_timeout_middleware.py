"""Tool timeout middleware — enforces per-tool execution time limits.

Some tools (terminal, web_fetch, browser) can hang indefinitely on slow
operations. This middleware wraps tool handlers with a configurable timeout
and raises a clear error when exceeded.
"""

import asyncio
import logging
import signal
import threading
import time
from collections.abc import Awaitable, Callable
from typing import Any

from langchain.agents.middleware import AgentMiddleware
from langchain_core.messages import ToolMessage
from langgraph.errors import GraphBubbleUp
from langgraph.prebuilt.tool_node import ToolCallRequest
from langgraph.types import Command

logger = logging.getLogger(__name__)

# Default timeout per tool (seconds). Tools not listed use DEFAULT_TIMEOUT.
_TOOL_TIMEOUTS: dict[str, int] = {
    "terminal": 600,  # replaces execute_command (superset)
    "web_fetch": 60,
    "web_extract": 60,
    "web_search": 30,
    "read_lints": 90,
    "view_image": 120,
}

_DEFAULT_TIMEOUT = 300


class ToolTimeoutError(TimeoutError):
    """Raised when a tool execution exceeds its allowed timeout."""

    def __init__(self, tool_name: str, timeout: int):
        self.tool_name = tool_name
        self.timeout = timeout
        super().__init__(f"Tool '{tool_name}' timed out after {timeout}s")


def _timeout_for_tool(tool_name: str) -> int:
    """Get timeout for a tool, with env var override support."""
    env_key = f"EVOFLOW_TIMEOUT_{tool_name.upper()}"
    env_val = __import__("os").environ.get(env_key, "").strip()
    if env_val:
        try:
            return int(env_val)
        except ValueError:
            pass
    return _TOOL_TIMEOUTS.get(tool_name, _DEFAULT_TIMEOUT)


def _run_with_timeout(fn: Callable[[], Any], timeout: int) -> Any:
    """Run *fn* in a thread with a timeout.

    Falls back to thread-based timeout on Windows (signal.SIGALRM unavailable).
    """
    if hasattr(signal, "SIGALRM"):
        # Unix: use SIGALRM (more responsive)
        class _TimeoutError(Exception):
            pass

        def _handler(_sig, _frame):
            raise _TimeoutError()

        old_handler = signal.signal(signal.SIGALRM, _handler)
        signal.alarm(timeout)
        try:
            result = fn()
            signal.alarm(0)
            return result
        except _TimeoutError:
            raise TimeoutError(f"Timed out after {timeout}s")
        finally:
            signal.alarm(0)
            signal.signal(signal.SIGALRM, old_handler)
    else:
        # Windows / fallback: thread-based timeout
        result_box: list[Any] = []
        exc_box: list[Exception] = []

        def _target():
            try:
                result_box.append(fn())
            except Exception as e:
                exc_box.append(e)

        thread = threading.Thread(target=_target, daemon=True)
        thread.start()
        thread.join(timeout)
        if thread.is_alive():
            raise TimeoutError(f"Timed out after {timeout}s")
        if exc_box:
            raise exc_box[0]
        return result_box[0]


class ToolTimeoutMiddleware(AgentMiddleware):
    """Middleware that enforces per-tool execution timeouts.

    Usage — add to the middleware chain in agent.py:
        middlewares.append(ToolTimeoutMiddleware())
    """

    def wrap_tool_call(
        self,
        request: ToolCallRequest,
        handler: Callable[[ToolCallRequest], ToolMessage | Command],
    ) -> ToolMessage | Command:
        """Wrap sync tool call with timeout."""
        tool_name = str(request.tool_call.get("name") or "unknown")
        timeout = _timeout_for_tool(tool_name)

        start = time.time()
        try:
            result = _run_with_timeout(lambda: handler(request), timeout)
            elapsed = time.time() - start
            if elapsed > timeout * 0.8:
                logger.warning("Tool '%s' ran near timeout (%.1fs/%ds)", tool_name, elapsed, timeout)
            return result
        except TimeoutError:
            elapsed = time.time() - start
            logger.error("Tool '%s' timed out after %.1fs (limit=%ds)", tool_name, elapsed, timeout)
            msg = f"Error: Tool '{tool_name}' timed out after {timeout}s. Try a simpler operation or split into smaller steps."
            return ToolMessage(content=msg, tool_call_id=request.tool_call.get("id", ""), status="error")
        except GraphBubbleUp:
            raise
        except Exception:
            raise

    async def awrap_tool_call(
        self,
        request: ToolCallRequest,
        handler: Callable[[ToolCallRequest], Awaitable[ToolMessage | Command]],
    ) -> ToolMessage | Command:
        """Wrap async tool call with timeout."""
        tool_name = str(request.tool_call.get("name") or "unknown")
        timeout = _timeout_for_tool(tool_name)

        try:
            result = await asyncio.wait_for(handler(request), timeout=timeout)
            return result
        except TimeoutError:
            logger.error("Tool '%s' timed out after %ds (async)", tool_name, timeout)
            msg = f"Error: Tool '{tool_name}' timed out after {timeout}s. Try a simpler operation."
            return ToolMessage(content=msg, tool_call_id=request.tool_call.get("id", ""), status="error")
