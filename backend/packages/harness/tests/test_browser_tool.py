"""Tests for unified browser tool (deferred under agent mode)."""

from __future__ import annotations

import json
from types import SimpleNamespace
from unittest.mock import patch

import pytest

from evoflow.agents.lead_agent.intent_tool_profile import (
    resolve_deferred_tool_names_for_scenarios,
    resolve_eager_tool_names_for_scenarios,
)
from evoflow.tools.builtins.browser_tool import (
    _action_screenshot,
    _format_cli_result,
    _session_name,
    browser_tool,
)


def test_browser_not_eager_on_agent_activate() -> None:
    eager = set(resolve_eager_tool_names_for_scenarios(["agent"]))
    deferred = set(resolve_deferred_tool_names_for_scenarios(["agent"]))
    assert "browser" not in eager
    assert "browser" in deferred


def test_session_name_stable() -> None:
    assert _session_name("default") == "evoflow"
    assert _session_name("thread-abc").startswith("evoflow-")


def test_format_cli_result_success() -> None:
    assert _format_cli_result(0, "hello", "") == "hello"


def test_format_cli_result_error() -> None:
    assert _format_cli_result(1, "", "boom").startswith("Error:")


def test_browser_tool_open_requires_url() -> None:
    runtime = SimpleNamespace(context={"thread_id": "t1"})
    out = browser_tool.func(runtime=runtime, action="open")
    assert "requires url" in out.lower()


@patch("evoflow.tools.builtins.browser_tool._run_browser_cli")
def test_browser_tool_snapshot(mock_run: pytest.Mock) -> None:
    mock_run.return_value = "@e1 button Submit"
    runtime = SimpleNamespace(context={"thread_id": "t1"})
    out = browser_tool.func(runtime=runtime, action="snapshot")
    assert "@e1" in out
    mock_run.assert_called_once()


@patch("evoflow.tools.builtins.browser_tool.save_screenshot_png")
@patch("evoflow.tools.builtins.browser_tool._run_browser_cli")
def test_browser_tool_screenshot_returns_json(mock_run: pytest.Mock, mock_save: pytest.Mock) -> None:
    mock_run.return_value = "saved"
    mock_save.return_value = {
        "screenshot_id": "abc123",
        "image_url": "/api/threads/t1/browser-snapshots/abc123",
        "page_url": "https://example.com",
        "full_page": False,
        "width": 100,
        "height": 100,
        "size_kb": 1,
    }

    png = b"\x89PNG\r\n\x1a\n"
    with patch("pathlib.Path.is_file", return_value=True), patch("pathlib.Path.read_bytes", return_value=png):
        out = _action_screenshot("t1", full_page=False)

    payload = json.loads(out)
    assert payload["type"] == "browser_screenshot"
    assert payload["image_url"].endswith("abc123")
