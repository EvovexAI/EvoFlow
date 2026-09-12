"""Tag LangChain summarization injections so UIs do not treat them as user turns.

SummarizationMiddleware replaces early history with a HumanMessage whose text
starts with LangChain's fixed prefix. That message has no ``name``, so clients
that map ``human`` -> user bubble show it as the user's last message after
reload. We assign ``name="conversation_summary"`` so the same message id is
updated via the graph ``add_messages`` reducer (replace-by-id).
"""

from __future__ import annotations

from typing import Any

try:
    from typing import override
except ImportError:
    from typing import override

from langchain.agents import AgentState
from langchain.agents.middleware import AgentMiddleware
from langchain_core.messages import HumanMessage
from langgraph.runtime import Runtime

_SUMMARY_PREFIXES = (
    "here is a summary of the conversation to date",
    "here's a summary of the conversation to date",
    "[context compaction",
)

_CONVERSATION_SUMMARY_NAME = "conversation_summary"


def _stringify_message_content(content: Any) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts: list[str] = []
        for block in content:
            if isinstance(block, str):
                parts.append(block)
            elif isinstance(block, dict) and isinstance(block.get("text"), str):
                parts.append(block["text"])
        return "".join(parts)
    return str(content or "")


def _is_conversation_summary_human(msg: HumanMessage) -> bool:
    name = getattr(msg, "name", None)
    if name is not None and str(name).strip():
        return False
    text = _stringify_message_content(msg.content).lstrip().lower()
    return any(text.startswith(p) for p in _SUMMARY_PREFIXES)


class ConversationSummaryTagMiddleware(AgentMiddleware[AgentState]):
    """Runs after SummarizationMiddleware; tags summary HumanMessages by name."""

    state_schema = AgentState

    @override
    def before_model(self, state: AgentState, runtime: Runtime) -> dict[str, Any] | None:  # noqa: ARG002
        messages = state.get("messages") or []
        tagged: list[HumanMessage] = []
        for msg in messages:
            if isinstance(msg, HumanMessage) and _is_conversation_summary_human(msg):
                tagged.append(msg.model_copy(update={"name": _CONVERSATION_SUMMARY_NAME}))
        if not tagged:
            return None
        return {"messages": tagged}

    @override
    async def abefore_model(self, state: AgentState, runtime: Runtime) -> dict[str, Any] | None:
        return self.before_model(state, runtime)
