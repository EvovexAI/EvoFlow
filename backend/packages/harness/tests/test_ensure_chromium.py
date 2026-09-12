"""Tests for Chromium on-demand resolution / install helpers."""

from __future__ import annotations

from pathlib import Path
from unittest.mock import MagicMock, patch

from evoflow.utils import bundled_tools


def test_find_chrome_executable_prefers_env(tmp_path: Path, monkeypatch) -> None:
    chrome = tmp_path / "chrome.exe"
    chrome.write_bytes(b"x")
    monkeypatch.setenv("AGENT_BROWSER_EXECUTABLE_PATH", str(chrome))
    assert bundled_tools.find_chrome_executable() == str(chrome)


def test_find_chrome_executable_user_cache(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.delenv("AGENT_BROWSER_EXECUTABLE_PATH", raising=False)
    browsers = tmp_path / "browsers" / "chrome-1.2.3"
    browsers.mkdir(parents=True)
    chrome = browsers / "chrome.exe"
    chrome.write_bytes(b"x")
    with patch.object(bundled_tools, "agent_browser_bundle_roots", return_value=[]):
        with patch.object(
            bundled_tools, "_user_agent_browser_roots", return_value=[tmp_path / "browsers"]
        ):
            assert bundled_tools.find_chrome_executable() == str(chrome)


def test_ensure_agent_browser_chromium_noop_when_present(
    tmp_path: Path, monkeypatch
) -> None:
    chrome = tmp_path / "chrome.exe"
    chrome.write_bytes(b"x")
    monkeypatch.setenv("AGENT_BROWSER_EXECUTABLE_PATH", str(chrome))
    ok, path = bundled_tools.ensure_agent_browser_chromium()
    assert ok is True
    assert path == str(chrome)


def test_ensure_agent_browser_chromium_runs_install(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.delenv("AGENT_BROWSER_EXECUTABLE_PATH", raising=False)
    cli = tmp_path / "agent-browser.cmd"
    cli.write_text("@echo off\n", encoding="utf-8")
    chrome_dir = tmp_path / "browsers" / "chrome-9.0.0"
    chrome_dir.mkdir(parents=True)
    chrome = chrome_dir / "chrome.exe"

    def _fake_run(cmd, **kwargs):
        chrome.write_bytes(b"chrome")
        return MagicMock(returncode=0, stdout="", stderr="")

    with patch.object(bundled_tools, "bundled_agent_browser_cli", return_value=str(cli)):
        with patch.object(bundled_tools, "agent_browser_bundle_roots", return_value=[]):
            with patch.object(
                bundled_tools,
                "_user_agent_browser_roots",
                return_value=[tmp_path / "browsers"],
            ):
                with patch.object(bundled_tools, "apply_agent_browser_to_path"):
                    with patch("subprocess.run", side_effect=_fake_run) as run:
                        ok, path = bundled_tools.ensure_agent_browser_chromium(timeout=30)
    assert ok is True
    assert path == str(chrome)
    assert run.called
    assert run.call_args.args[0] == [str(cli), "install"]
