"""MCP system prompt injection is disabled — tools are normal function tools only."""

from __future__ import annotations

from evoflow.mcp.native_prompt import (
    build_mcp_native_prompt_section,
    build_mcp_native_prompt_section_safe,
)


def test_native_prompt_always_empty() -> None:
    assert (
        build_mcp_native_prompt_section(
            ["ecommerce-shangce"],
            bound_tool_names=["mcp__ecommerce-shangce__health"],
            prompt_language="zh",
        )
        == ""
    )
    assert build_mcp_native_prompt_section_safe(["ecommerce-shangce"]) == ""
    assert build_mcp_native_prompt_section(None) == ""
    assert build_mcp_native_prompt_section([]) == ""
