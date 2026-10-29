"""Host plugin kernels (mcp__node_repl__js) must not be gated by mcp_servers."""

from __future__ import annotations

from types import SimpleNamespace

from evoflow.mcp.binding import (
    filter_tools_by_mcp_servers,
    is_external_mcp_tool_name,
    is_host_plugin_kernel_tool,
)


def test_node_repl_is_host_kernel_not_external_mcp() -> None:
    assert is_host_plugin_kernel_tool("mcp__node_repl__js")
    assert not is_external_mcp_tool_name("mcp__node_repl__js")
    assert is_external_mcp_tool_name("mcp__ecommerce-shangce__health")


def test_filter_keeps_node_repl_when_mcp_servers_empty() -> None:
    tools = [
        SimpleNamespace(name="mcp__node_repl__js"),
        SimpleNamespace(name="mcp__ecommerce-shangce__health"),
        SimpleNamespace(name="bash"),
    ]
    kept = filter_tools_by_mcp_servers(tools, [])
    names = [t.name for t in kept]
    assert "mcp__node_repl__js" in names
    assert "bash" in names
    assert "mcp__ecommerce-shangce__health" not in names


def test_filter_none_keeps_all() -> None:
    tools = [
        SimpleNamespace(name="mcp__node_repl__js"),
        SimpleNamespace(name="mcp__ecommerce-shangce__health"),
    ]
    kept = filter_tools_by_mcp_servers(tools, None)
    assert len(kept) == 2
