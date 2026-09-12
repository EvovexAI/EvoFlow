"""Subprocess encoding helpers (Windows console)."""

from __future__ import annotations

import os
import subprocess

from evoflow.utils.subprocess_platform import (
    prepare_shell_command,
    subprocess_text_encoding,
    subprocess_text_io_kwargs,
)


def test_subprocess_text_io_kwargs_uses_replace() -> None:
    kw = subprocess_text_io_kwargs()
    assert kw["errors"] == "replace"
    assert isinstance(kw["encoding"], str) and kw["encoding"]


def test_subprocess_text_io_decodes_non_utf8_bytes() -> None:
    """GBK-ish bytes must not crash the stdlib reader thread."""
    kw = subprocess_text_io_kwargs()
    enc = kw["encoding"]
    payload = "中文".encode(enc, errors="replace")
    proc = subprocess.run(
        ["python", "-c", f"import sys; sys.stdout.buffer.write({payload!r})"],
        capture_output=True,
        text=True,
        **kw,
    )
    assert proc.returncode == 0
    assert proc.stdout is not None


def test_windows_subprocess_text_encoding_defaults_utf8() -> None:
    if os.name != "nt":
        return
    assert subprocess_text_encoding() == "utf-8"


def test_prepare_shell_command_powershell_bootstraps_utf8() -> None:
    if os.name != "nt":
        return
    out = prepare_shell_command('echo "ok"', "powershell.exe")
    assert "[Console]::OutputEncoding" in out
    assert "echo" in out
    again = prepare_shell_command(out, "powershell.exe")
    assert again == out
