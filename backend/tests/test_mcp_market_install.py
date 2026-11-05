"""MCP market one-click install must produce runnable stdio configs."""

from __future__ import annotations

from pathlib import Path

from evoflow.mcp.market import resolve_mcp_install_config


async def test_filesystem_hot_install_includes_allowed_dir() -> None:
    """官方 server-filesystem 启动必须有至少一个允许目录参数，否则进程即退。"""
    data = await resolve_mcp_install_config(slug="filesystem")
    cfg = data["config"]
    assert cfg["type"] == "stdio"
    non_flag = [a for a in (cfg.get("args") or []) if not str(a).startswith("-")]
    # 一个是包名，至少还要有一个允许访问的目录
    assert len(non_flag) >= 2, f"filesystem install args lack allowed dir: {cfg.get('args')}"
    assert Path(str(non_flag[-1])).exists() or non_flag[-1] not in ("", ".")


async def test_fetch_hot_install_uses_uvx() -> None:
    """@modelcontextprotocol/server-fetch 已从 npm 下架，Web Fetch 走 uvx mcp-server-fetch。"""
    data = await resolve_mcp_install_config(slug="fetch")
    cfg = data["config"]
    assert cfg["type"] == "stdio"
    assert cfg["command"] == "uvx"
    assert "mcp-server-fetch" in (cfg.get("args") or [])


async def test_sequential_thinking_hot_install_package_name() -> None:
    """npm 包名带连字符：server-sequential-thinking（错名已 404）。"""
    data = await resolve_mcp_install_config(slug="sequential-thinking")
    cfg = data["config"]
    assert cfg["type"] == "stdio"
    assert "@modelcontextprotocol/server-sequential-thinking" in (cfg.get("args") or [])


async def test_notion_hot_install_is_remote_mcp() -> None:
    """@mcp/notion-server 已从 npm 下架，Notion 走官方远程 MCP。"""
    data = await resolve_mcp_install_config(slug="notion")
    cfg = data["config"]
    assert cfg["type"] == "http"
    assert cfg["url"] == "https://mcp.notion.com/mcp"
