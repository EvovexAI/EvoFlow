"""MCP stdio failure hints: buffer-detached ≠ missing executable."""

from __future__ import annotations

from evoflow.mcp.tools import _mcp_error_hint


def test_buffer_detached_hint_not_path():
    err = "underlying buffer has been detached"
    out = _mcp_error_hint(
        "ecommerce-shangce",
        {"transport": "stdio", "command": r"C:\Python312\python.exe"},
        err,
    )
    assert "buffer has been detached" in out.lower() or "stdout/stderr" in out.lower()
    assert "找不到可执行文件" not in out


def test_missing_executable_still_hinted():
    err = "WinError 2 The system cannot find the file specified"
    out = _mcp_error_hint(
        "foo",
        {"transport": "stdio", "command": "python"},
        err,
    )
    assert "找不到可执行文件" in out
