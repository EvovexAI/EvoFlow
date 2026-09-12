"""Desktop ~/.evoflow/config.yaml should default to host_direct when tools_mode is missing."""

from pathlib import Path

from evoflow.config.app_config import _ensure_desktop_tools_mode_defaults


def test_desktop_minimal_config_gets_host_direct():
    data: dict = {"models": [], "tools": []}
    path = Path.home() / ".evoflow" / "config.yaml"
    _ensure_desktop_tools_mode_defaults(data, path)
    assert data.get("tools_mode") == "host_direct"


def test_non_desktop_path_unchanged():
    data: dict = {"models": []}
    _ensure_desktop_tools_mode_defaults(data, Path("/etc/evoflow/config.yaml"))
    assert "tools_mode" not in data


def test_explicit_tools_mode_preserved():
    data: dict = {"tools_mode": "sandbox", "tools": []}
    path = Path.home() / ".evoflow" / "config.yaml"
    _ensure_desktop_tools_mode_defaults(data, path)
    assert data["tools_mode"] == "sandbox"
