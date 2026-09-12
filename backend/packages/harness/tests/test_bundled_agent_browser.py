"""Tests for bundled agent-browser CLI resolution."""

from __future__ import annotations

from pathlib import Path

from evoflow.utils import bundled_tools


def test_bundled_agent_browser_cli_finds_dev_packaging_bundle() -> None:
    backend_dir = bundled_tools._backend_dir_from_harness()
    assert backend_dir is not None
    bundle = backend_dir / "packaging" / "agent-browser-bundle"
    if not (bundle / "node_modules" / ".bin").is_dir():
        return
    cli = bundled_tools.bundled_agent_browser_cli()
    assert cli is not None
    assert Path(cli).is_file()


def test_find_bundled_chrome_executable_when_browsers_present() -> None:
    backend_dir = bundled_tools._backend_dir_from_harness()
    assert backend_dir is not None
    root = backend_dir / "packaging" / "agent-browser-bundle"
    if not (root / "browsers").is_dir():
        return
    chrome = bundled_tools.find_bundled_chrome_executable(root)
    assert chrome is not None
    assert Path(chrome).name.lower().startswith("chrome")
