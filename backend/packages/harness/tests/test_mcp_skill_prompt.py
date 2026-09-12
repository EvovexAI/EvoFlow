"""Tests for legacy MCP prompt redirects (runtime native only)."""

from __future__ import annotations

from unittest.mock import patch

from evoflow.mcp.prompt_section import (
    build_mcp_skill_prompt_section,
    build_mcp_skill_prompt_section_safe,
    mcp_prompt_fingerprint,
    resolve_mcp_server_names,
)


def test_resolve_mcp_server_names_null_means_all_enabled() -> None:
    raw = {"a": {"enabled": True}, "b": {"enabled": False}, "c": {}}
    assert resolve_mcp_server_names(None, raw) == ["a", "c"]


def test_build_mcp_skill_prompt_section_redirects_native() -> None:
    fake_cfg = {"Playwright": {"enabled": True}}
    with patch("evoflow.mcp.tools.load_mcp_config", return_value=fake_cfg):
        text = build_mcp_skill_prompt_section(["Playwright"])
    assert "<mcp_system>" in text
    assert "mcp-terminal" not in text.lower() or "do **not**" in text.lower() or "禁止" in text


def test_build_mcp_skill_prompt_section_safe_on_error() -> None:
    with patch(
        "evoflow.mcp.native_prompt.build_mcp_native_prompt_section",
        side_effect=RuntimeError("db down"),
    ):
        text = build_mcp_skill_prompt_section_safe(["Playwright"])
    assert "<mcp_system>" in text
    assert "db down" in text


def test_mcp_prompt_fingerprint_stable() -> None:
    fake_cfg = {"Playwright": {"enabled": True}}
    with patch("evoflow.mcp.prompt_section.load_mcp_config", return_value=fake_cfg):
        with patch("evoflow.mcp.tools.mcp_config_fingerprint", return_value="abc123def456"):
            fp = mcp_prompt_fingerprint(["Playwright"])
    assert fp == "cfg:abc123def456|names:Playwright"
