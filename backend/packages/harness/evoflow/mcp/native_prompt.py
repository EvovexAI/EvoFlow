"""MCP prompt helpers (deprecated — no system-prompt injection).

MCP tools are mounted as normal ``mcp__<server>__<tool>`` function tools.
Call sites may still import these builders; they always return ``""``.
"""

from __future__ import annotations


def build_mcp_native_prompt_section(
    mcp_servers: list[str] | None,
    *,
    bound_tool_names: list[str] | None = None,
    prompt_language: str | None = None,
) -> str:
    """No-op: MCP needs no special system prompt."""
    _ = (mcp_servers, bound_tool_names, prompt_language)
    return ""


def build_mcp_native_prompt_section_safe(
    mcp_servers: list[str] | None,
    *,
    bound_tool_names: list[str] | None = None,
    prompt_language: str | None = None,
) -> str:
    return build_mcp_native_prompt_section(
        mcp_servers,
        bound_tool_names=bound_tool_names,
        prompt_language=prompt_language,
    )


def mcp_native_prompt_fingerprint(mcp_servers: list[str] | None) -> str:
    """Fingerprint MCP *binding config* for dynamic prompt cache (tools still remount)."""
    from evoflow.mcp.prompt_section import mcp_prompt_fingerprint

    return mcp_prompt_fingerprint(mcp_servers)
