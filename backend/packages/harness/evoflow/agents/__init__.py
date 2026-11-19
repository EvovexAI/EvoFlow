from evoflow.platform.asyncio_windows import apply_windows_langgraph_runtime_fixes

apply_windows_langgraph_runtime_fixes()

# 【self-evolution-bot · 2026-11-19 · 第67轮 · 模型:deepseek-v4.1-flash-1017】
# 改了什么：`checkpointer` 三个名字（get/make/reset_checkpointer）从包导入期急切重导出
#           改成懒式，与下方 thread_state / lead_agent / goal 走同一个 __getattr__。
# 为什么：`evoflow.agents` 是**所有** agents 子模块的必经父包。实测 `import evoflow.agents`
#         = 709ms，其中 checkpointer 链占 439ms（async_provider → langchain_core.tracers
#         .log_stream → callbacks.manager），而平台修复本身只需 130ms。即任何人只要
#         import 一个 agents 子模块，就白付这 439ms；而生产代码唯一取用 checkpointer 的
#         地方（client.py:281）本来就是函数内 `from evoflow.agents.checkpointer import …`。
# 边界：三个名字仍可 `from evoflow.agents import get_checkpointer`（走 __getattr__）。
#       副作用 `apply_windows_langgraph_runtime_fixes()` 必须留在导入期执行，**不可懒化**。

# 【self-evolution-bot · 2026-11-19 · 第65轮 · 模型:deepseek-v4.1-flash-1017】
# 改了什么：`thread_state` 从包导入期急切导入改成懒式。
# 为什么：`thread_state` 顶层 `from langchain.agents import AgentState`会拉 torch（715 模块）。
# 于是任何 `import evoflow.agents.<任意子模块>` 都会白付 2 秒。
# 实测：`import evoflow.agents.thread_state` 改前 2603ms（拉 torch），改后不拉。
# 边界：`SandboxState`/`ThreadState` 仍可 `from evoflow.agents import ThreadState`（走 __getattr__）。

_THREAD_STATE_NAMES = ("SandboxState", "ThreadState")
_CHECKPOINTER_NAMES = ("get_checkpointer", "reset_checkpointer", "make_checkpointer")


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
    # 【self-evolution-bot · 2026-11-19 · 第67轮 · 模型:deepseek-v4.1-flash-1017】
    # 解析出值后写回 globals() 缓存（二次取用不再走 __getattr__），并补 `__dir__`。
    # 为什么：原实现既不缓存也不定义 `__dir__`，实测 `dir(evoflow.agents)` 漏掉
    # `__all__` 里 7 个名字（取用前后都查不到），`from evoflow.agents import *`
    # 与一切基于 dir() 的自省（IDE 补全、pydoc、属性嗅探中间件）都看不到它们。
    value = _resolve_lazy(name)
    globals()[name] = value
    return value


def _resolve_lazy(name: str):
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
    if name in _CHECKPOINTER_NAMES:
        from .checkpointer import get_checkpointer, make_checkpointer, reset_checkpointer

        return {
            "get_checkpointer": get_checkpointer,
            "reset_checkpointer": reset_checkpointer,
            "make_checkpointer": make_checkpointer,
        }[name]
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")


def __dir__() -> list[str]:
    return sorted(set(globals()) | set(__all__))
