from evoflow.platform.asyncio_windows import apply_windows_langgraph_runtime_fixes

from .checkpointer import get_checkpointer, make_checkpointer, reset_checkpointer

apply_windows_langgraph_runtime_fixes()

# 【self-evolution-bot · 2026-11-19 · 第65轮 · 模型:deepseek-v4.1-flash-1017】
# 改了什么：`thread_state` 从包导入期急切导入改成懒式。
# 为什么：`thread_state` 顶层 `from langchain.agents import AgentState`会拉 torch（715 模块）。
# 于是任何 `import evoflow.agents.<任意子模块>` 都会白付 2 秒。
# 实测：`import evoflow.agents.thread_state` 改前 2603ms（拉 torch），改后不拉。
# 边界：`SandboxState`/`ThreadState` 仍可 `from evoflow.agents import ThreadState`（走 __getattr__）。

_THREAD_STATE_NAMES = ("SandboxState", "ThreadState")


__all__ = [
    "make_goal_graph",
    "make_lead_agent",
    "SandboxState",
    "ThreadState",
    "get_checkpointer",
    "reset_checkpointer",
    "make_checkpointer",
]


def __getattr__(name: str):
    if name in _THREAD_STATE_NAMES:
        from .thread_state import SandboxState, ThreadState

        return {"SandboxState": SandboxState, "ThreadState": ThreadState}[name]
    # LangGraph resolves graphs via module.__dict__ (not getattr), so langgraph.json
    # must reference submodule paths (evoflow.agents.lead_agent:make_lead_agent).
    if name == "make_lead_agent":
        from .lead_agent import make_lead_agent

        return make_lead_agent
    if name == "make_goal_graph":
        from .goal.goal_graph import make_goal_graph

        return make_goal_graph
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
