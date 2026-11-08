"""HostDirect tools: zero-sandbox-overhead file ops for IDE-like experience.

Importing this package used to eagerly pull bash/grep/read_file (hundreds of ms on
Windows). Submodules like ``workspace_context`` are imported from skills.list and
must stay cheap — tool lists are built lazily via ``__getattr__``.
"""

from __future__ import annotations

from typing import Any

__all__ = ["HOST_DIRECT_TOOLS", "get_host_direct_tools"]


def get_host_direct_tools() -> list[Any]:
    """Build the host-direct tool list (cached on first use)."""
    from evoflow.tools.host_direct.read_file import read_file_hd
    from evoflow.tools.host_direct.search_code_index import search_code_index_hd
    from evoflow.tools.host_direct.str_replace import str_replace_hd
    from evoflow.tools.host_direct.write_file import write_file_hd
    from evoflow.tools.zcode_port import zcode_shell_tools
    from evoflow.tools.zcode_port.glob_grep import grep_tool

    # find / rg / terminal / glob / delete 已撤除：实现文件保留但不注册。
    return [
        read_file_hd,
        write_file_hd,
        str_replace_hd,  # tool name: replace_in_file
        grep_tool,
        search_code_index_hd,
        *zcode_shell_tools(),
    ]


def __getattr__(name: str) -> Any:
    if name == "HOST_DIRECT_TOOLS":
        tools = get_host_direct_tools()
        globals()["HOST_DIRECT_TOOLS"] = tools
        return tools
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
