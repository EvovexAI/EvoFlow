"""ZCode search + shell tools, reimplemented for the EvoFlow Python harness.

Grep 仍可注册；Glob 已撤除（按名查找走 Bash）。embedded search 开启时
也不再挂 Grep，由 Bash find/grep 接管。

【self-evolution-bot · 2026-11-19 · 第65轮 · 模型:deepseek-v4.1-flash-1017】

## 改了什么
原来这个 ``__init__`` 在**包导入期**就急切 ``from ...bash_tool import bash_tool``。
于是任何一句 ``import evoflow.tools.zcode_port.<任何子模块>``
（prelude / background / task_tools …）都会先把整条 shell 工具链拉起来，
连带 ``langchain.agents.middleware`` → ``langchain.tools``
→ ``langchain_core.language_models.base:42`` → ``from transformers import GPT2TokenizerFast``
—— **torch 的 715 个模块就是这么进来的**。

实测（2026-11-19，本机）：
- 改前 ``import evoflow.tools.zcode_port.prelude`` 会把 torch 拉进来，~2.5s；
- 改后同一条导入不再出现 torch。

## 为什么用模块级 ``__getattr__``（PEP 562）而不是删掉这些名字
``zcode_shell_tools()`` 与 ``evoflow.tools.zcode_port.bash_tool`` 这些入口
在别处仍按属性访问，删了会断。``__getattr__`` 保留原语义：**只有真要用那个属性时**
才付导入成本，``from ... import x`` 同样生效。

## 边界
- 本文件只延后**导入时机**，不改变任何工具对象本身（同一个 ``StructuredTool``）。
- ``zcode_shell_tools()`` 仍返回同样的列表，只是内部现取。
"""

from __future__ import annotations

from typing import Any

__all__ = ["bash_tool", "grep_tool", "task_output_tool", "task_stop_tool", "zcode_shell_tools"]


def __getattr__(name: str) -> Any:
    """按需解析工具对象，避免包导入期拉起整条 shell 工具链。"""
    if name == "bash_tool":
        from evoflow.tools.zcode_port.bash_tool import bash_tool

        return bash_tool
    if name == "grep_tool":
        from evoflow.tools.zcode_port.glob_grep import grep_tool

        return grep_tool
    if name == "task_output_tool":
        from evoflow.tools.zcode_port.task_tools import task_output_tool

        return task_output_tool
    if name == "task_stop_tool":
        from evoflow.tools.zcode_port.task_tools import task_stop_tool

        return task_stop_tool
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")


def __dir__() -> list[str]:
    return sorted(__all__)


def zcode_shell_tools() -> list:
    """Same list as before, resolved on demand."""
    from evoflow.tools.zcode_port.bash_tool import bash_tool, embedded_search_enabled
    from evoflow.tools.zcode_port.task_tools import task_output_tool, task_stop_tool

    tools = [bash_tool, task_output_tool, task_stop_tool]
    if not embedded_search_enabled():
        from evoflow.tools.zcode_port.glob_grep import grep_tool

        tools.append(grep_tool)
    return tools
