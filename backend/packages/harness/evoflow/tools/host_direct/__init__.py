"""HostDirect tools: Zero-sandbox-overhead file operations for IDE-like experience.

These tools bypass the Sandbox abstraction layer entirely and operate directly
on the host filesystem. Designed to match 常见 IDE / Agent 宿主 UX.
"""

from evoflow.tools.host_direct.read_file import read_file_hd
from evoflow.tools.host_direct.search_code_index import search_code_index_hd
from evoflow.tools.host_direct.str_replace import str_replace_hd
from evoflow.tools.host_direct.write_file import write_file_hd
from evoflow.tools.zcode_port import zcode_shell_tools
from evoflow.tools.zcode_port.glob_grep import glob_tool, grep_tool

# find / rg / terminal 已由 ZCode Bash（embedded search）取代，实现文件保留但不注册。
# from evoflow.tools.host_direct.find_file import find_file_hd
# from evoflow.tools.host_direct.rg import rg_hd
# from evoflow.tools.host_direct.terminal_tool import terminal_tool
# delete 已撤除（对齐 ZCode）：删除走 Bash `rm`，由 terminal 审批策略兜底
# （_DESTRUCTIVE_CMD_RE 挡 allow_prefix 绕过 + 每次调用确认）；实现文件保留。
# from evoflow.tools.host_direct.delete_file import delete_file_hd

# Complete tool set — can be swapped with sandbox tools via config
HOST_DIRECT_TOOLS = [
    read_file_hd,
    write_file_hd,
    str_replace_hd,  # tool name: replace_in_file
    # delete_file_hd,
    # find_file_hd,
    # rg_hd,
    glob_tool,
    grep_tool,
    search_code_index_hd,
    # terminal_tool,
    *zcode_shell_tools(),
]

__all__ = ["HOST_DIRECT_TOOLS"] + [t.name for t in HOST_DIRECT_TOOLS]
