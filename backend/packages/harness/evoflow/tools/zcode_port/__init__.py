"""ZCode search + shell tools, reimplemented for the EvoFlow Python harness.

Grep 仍可注册；Glob 已撤除（按名查找走 Bash）。embedded search 开启时
也不再挂 Grep，由 Bash find/grep 接管。
"""

from evoflow.tools.zcode_port.bash_tool import bash_tool, embedded_search_enabled
from evoflow.tools.zcode_port.glob_grep import grep_tool
from evoflow.tools.zcode_port.task_tools import task_output_tool, task_stop_tool

def zcode_shell_tools() -> list:
    tools = [bash_tool, task_output_tool, task_stop_tool]
    if not embedded_search_enabled():
        tools.append(grep_tool)
    return tools


__all__ = ["bash_tool", "grep_tool", "task_output_tool", "task_stop_tool", "zcode_shell_tools"]
