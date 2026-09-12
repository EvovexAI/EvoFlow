"""Experience Middleware — prompts the LLM to save experiences after complex tasks.

Triggers when:
  1. A task involved 5+ tool calls (complex enough to be worth remembering)
  2. The agent recovered from an error (tricky bug fix)
  3. The user explicitly asked to "remember" or "save"

The middleware does NOT auto-save. It adds a system-level reminder in the
conversation context, leaving the decision to the LLM.
"""

import logging
from collections.abc import Awaitable, Callable

from langchain.agents.middleware import AgentMiddleware
from langchain_core.messages import ToolMessage
from langgraph.prebuilt.tool_node import ToolCallRequest
from langgraph.types import Command

logger = logging.getLogger(__name__)

# Threshold: after this many tool calls, remind the LLM to consider saving
_TOOL_CALL_THRESHOLD = 5


class ExperienceMiddleware(AgentMiddleware):
    """Reminds the LLM to save experiences after complex tasks.

    This middleware tracks tool call counts and injects a reminder
    message after the task completes. The LLM makes the final decision.
    """

    def __init__(self):
        self._tool_call_count = 0
        self._had_error = False
        self._recovery_count = 0
        self._reminder_injected = False

    def reset(self):
        """Reset counters for a new task."""
        self._tool_call_count = 0
        self._had_error = False
        self._recovery_count = 0
        self._reminder_injected = False

    def wrap_tool_call(
        self,
        request: ToolCallRequest,
        handler: Callable[[ToolCallRequest], ToolMessage | Command],
    ) -> ToolMessage | Command:
        result = handler(request)
        self._tool_call_count += 1

        if isinstance(result, ToolMessage):
            content = str(getattr(result, "content", "") or "")
            if content.startswith("Error:"):
                self._had_error = True
            if "Error:" in content and self._had_error:
                self._recovery_count += 1

        return result

    async def awrap_tool_call(
        self,
        request: ToolCallRequest,
        handler: Callable[[ToolCallRequest], Awaitable[ToolMessage | Command]],
    ) -> ToolMessage | Command:
        result = await handler(request)
        self._tool_call_count += 1

        if isinstance(result, ToolMessage):
            content = str(getattr(result, "content", "") or "")
            if content.startswith("Error:"):
                self._had_error = True
            if "Error:" in content and self._had_error:
                self._recovery_count += 1

        return result

    def should_remind(self) -> bool:
        """Check if the LLM should be reminded to save an experience."""
        return (self._tool_call_count >= _TOOL_CALL_THRESHOLD or self._recovery_count >= 2) and not self._reminder_injected

    def mark_reminded(self):
        """Mark that the reminder has been injected."""
        self._reminder_injected = True
