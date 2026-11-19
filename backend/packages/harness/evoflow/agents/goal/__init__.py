"""Goal subsystem exports — resolved on demand.

【self-evolution-bot · 2026-11-19 · 第65轮 · 模型:deepseek-v4.1-flash-1017】

## 改了什么
原来是 6 行急切导入，其中 ``goal_auto_continue_middleware`` 顶层
``from langchain.agents import AgentState`` —— 这条链会经
``langchain_core.language_models.base:42`` 的 ``from transformers import GPT2TokenizerFast``
把 torch（715 模块）拉进进程。

**于是任何一句 ``import evoflow.agents.goal.<任意子模块>`` 都要白付约 2 秒**，
哪怕调用方只想用 ``goal_state`` 里的常量。

实测（2026-11-19，本机 2 次取快）：
- ``import evoflow.tools.builtins.assets_tool`` 改前 3656ms（拉 torch）/ 改后见提交说明。

## 边界
- 名字不变、语义不变：``from evoflow.agents.goal import make_goal_graph`` 依然可用。
- 这些名字都不与子模块同名，所以 ``__getattr__`` 不会被 ``sys.modules`` 的
  子模块属性遮蔽（不像 ``assets_tool`` 那样有歧义）。
"""

from __future__ import annotations

from typing import Any

__all__ = [
    "GoalContinuationAssemblerMiddleware",
    "GoalAutoContinueMiddleware",
    "GoalStatus",
    "GOAL_CONTROLLER_SOURCE",
    "GOAL_SYNTHETIC_USER_NAME",
    "GoalState",
    "goal_controller_node",
    "make_goal_graph",
    "new_goal_event",
]

_MODMAP = {
    "GoalAutoContinueMiddleware": "evoflow.agents.goal.goal_auto_continue_middleware",
    "GoalContinuationAssemblerMiddleware": "evoflow.agents.goal.goal_prompt_assembler",
    "goal_controller_node": "evoflow.agents.goal.goal_controller",
    "make_goal_graph": "evoflow.agents.goal.goal_graph",
    "new_goal_event": "evoflow.agents.goal.goal_events",
    "GOAL_CONTROLLER_SOURCE": "evoflow.agents.goal.goal_state",
    "GOAL_SYNTHETIC_USER_NAME": "evoflow.agents.goal.goal_state",
    "GoalState": "evoflow.agents.goal.goal_state",
    "GoalStatus": "evoflow.agents.goal.goal_state",
}


def __getattr__(name: str) -> Any:
    mod = _MODMAP.get(name)
    if mod is not None:
        from importlib import import_module

        return getattr(import_module(mod), name)
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")


def __dir__() -> list[str]:
    return sorted(__all__)
