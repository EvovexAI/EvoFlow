"""Tests for gateway --mode cli argv helpers (packaging/windows/cli_argv.py)."""

from __future__ import annotations

import importlib.util
from pathlib import Path


def _load_cli_argv():
    path = (
        Path(__file__).resolve().parents[3]
        / "packaging"
        / "windows"
        / "cli_argv.py"
    )
    spec = importlib.util.spec_from_file_location("evoflow_packaging_cli_argv", path)
    assert spec is not None and spec.loader is not None
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def test_is_cli_mode_space_and_equals() -> None:
    m = _load_cli_argv()
    assert m.is_cli_mode(["--mode", "cli", "automation", "list"]) is True
    assert m.is_cli_mode(["--mode=cli", "agents", "list"]) is True
    assert m.is_cli_mode(["--mode", "gateway"]) is False
    assert m.is_cli_mode(["--host", "0.0.0.0"]) is False


def test_cli_argv_strips_mode_keeps_subcommands() -> None:
    m = _load_cli_argv()
    assert m.cli_argv_without_mode(["--mode", "cli", "automation", "list"]) == [
        "automation",
        "list",
    ]
    assert m.cli_argv_without_mode(["--mode=cli", "models", "list", "--compact"]) == [
        "models",
        "list",
        "--compact",
    ]
    # Non-cli --mode must be left alone (gateway path handles it)
    assert m.cli_argv_without_mode(["--mode", "gateway", "--port", "8012"]) == [
        "--mode",
        "gateway",
        "--port",
        "8012",
    ]
