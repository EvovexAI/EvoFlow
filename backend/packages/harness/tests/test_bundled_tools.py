"""Tests for bundled CLI / ripgrep resolution."""

from __future__ import annotations

import os
import sys

from evoflow.utils import bundled_tools as bt


def test_apply_evoflow_cli_to_path_prepends_search_dirs(monkeypatch) -> None:
    monkeypatch.setenv("PATH", "C:\\existing")
    monkeypatch.setattr(bt, "evoflow_cli_search_dirs", lambda: ["C:\\bundled\\evoflow", "C:\\venv\\Scripts"])
    bt.apply_evoflow_cli_to_path()
    parts = os.environ["PATH"].split(os.pathsep)
    assert parts[0] == "C:\\bundled\\evoflow"
    assert parts[1] == "C:\\venv\\Scripts"
    assert "C:\\existing" in parts
    assert os.environ["EVOFLOW_CLI_DIR"] == "C:\\bundled\\evoflow"


def test_gateway_cli_argv_includes_mode_cli() -> None:
    argv = bt.gateway_cli_argv(["agents", "list"])
    assert "agents" in argv
    assert "list" in argv
    if getattr(sys, "frozen", False):
        assert argv[1:4] == ["--mode", "cli", "agents"]
    else:
        assert argv[-2:] == ["agents", "list"]
        assert argv[0].endswith(("evoflow.exe", "evoflow", "python.exe")) or "evoflow" in argv[1]
