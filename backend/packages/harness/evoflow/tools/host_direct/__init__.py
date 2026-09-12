"""HostDirect tools: Zero-sandbox-overhead file operations for IDE-like experience.

These tools bypass the Sandbox abstraction layer entirely and operate directly
on the host filesystem. Designed to match 常见 IDE / Agent 宿主 UX.
"""

from evoflow.tools.host_direct.delete_file import delete_file_hd
from evoflow.tools.host_direct.find_file import find_file_hd
from evoflow.tools.host_direct.read_file import read_file_hd
from evoflow.tools.host_direct.rg import rg_hd
from evoflow.tools.host_direct.search_code_index import search_code_index_hd
from evoflow.tools.host_direct.str_replace import str_replace_hd
from evoflow.tools.host_direct.terminal_tool import terminal_tool
from evoflow.tools.host_direct.trace_call_chain import trace_call_chain_hd
from evoflow.tools.host_direct.write_file import write_file_hd

# Complete tool set — can be swapped with sandbox tools via config
HOST_DIRECT_TOOLS = [
    read_file_hd,
    write_file_hd,
    str_replace_hd,  # tool name: replace_in_file
    delete_file_hd,
    find_file_hd,
    rg_hd,
    search_code_index_hd,
    trace_call_chain_hd,
    terminal_tool,  # git/npm/tests/shell — not primary for file read/write/replace
]

__all__ = ["HOST_DIRECT_TOOLS"] + [t.name for t in HOST_DIRECT_TOOLS]
