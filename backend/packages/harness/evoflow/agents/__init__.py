from evoflow.platform.asyncio_windows import apply_windows_langgraph_runtime_fixes

from .checkpointer import get_checkpointer, make_checkpointer, reset_checkpointer

apply_windows_langgraph_runtime_fixes()

from .thread_state import SandboxState, ThreadState  # noqa: E402

__all__ = [
    "make_claude_code_chat_graph",
    "make_goal_graph",
    "make_lead_agent",
    "SandboxState",
    "ThreadState",
    "get_checkpointer",
    "reset_checkpointer",
    "make_checkpointer",
]


def __getattr__(name: str):
    # LangGraph resolves graphs via module.__dict__ (not getattr), so langgraph.json
    # must reference submodule paths (evoflow.agents.lead_agent:make_lead_agent).
    if name == "make_lead_agent":
        from .lead_agent import make_lead_agent

        return make_lead_agent
    if name == "make_claude_code_chat_graph":
        from .claude_code_chat_graph import make_claude_code_chat_graph

        return make_claude_code_chat_graph
    if name == "make_goal_graph":
        from .goal.goal_graph import make_goal_graph

        return make_goal_graph
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
