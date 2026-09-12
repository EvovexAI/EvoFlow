"""terminal shell code-search intercept → fast redirect."""

from __future__ import annotations

import tempfile
from pathlib import Path
from unittest.mock import MagicMock

from evoflow.tools.host_direct.terminal_code_search_redirect import (
    is_code_search_terminal_command,
    parse_code_search_command,
    try_terminal_code_search_redirect,
)


def test_detects_select_string():
    cmd = (
        'Select-String -Pattern "MessageVirtualList|VirtualList" '
        '-Path "D:\\repo\\src\\Foo.tsx" | Select-Object -First 5'
    )
    assert is_code_search_terminal_command(cmd)


def test_parse_select_string():
    cmd = (
        'Select-String -Pattern "foo|bar" '
        '-Path "D:\\repo\\src\\Foo.tsx" | Select-Object -First 3'
    )
    parsed = parse_code_search_command(cmd)
    assert parsed == ("foo|bar", ["D:\\repo\\src\\Foo.tsx"])


def test_redirect_single_file_without_subprocess():
    import os

    with tempfile.TemporaryDirectory() as tmp:
        f = Path(tmp) / "Foo.tsx"
        f.write_text(
            "export function MessageVirtualList() {}\nconst x = VirtualList;\n",
            encoding="utf-8",
        )
        cmd = f'Select-String -Pattern "MessageVirtualList|VirtualList" -Path "{f}" | Select-Object -First 5'
        runtime = MagicMock()
        runtime.context = {}
        prev = os.environ.get("TERMINAL_BLOCK_CODE_SEARCH")
        os.environ["TERMINAL_BLOCK_CODE_SEARCH"] = "1"
        try:
            out = try_terminal_code_search_redirect(command=cmd, runtime=runtime)
            assert out is not None
            assert "terminal → code search" in out
            assert "MessageVirtualList" in out
            assert "timed out" not in out.lower()
        finally:
            if prev is None:
                os.environ.pop("TERMINAL_BLOCK_CODE_SEARCH", None)
            else:
                os.environ["TERMINAL_BLOCK_CODE_SEARCH"] = prev


def test_blocks_unparsed_grep_without_workspace():
    import os

    runtime = MagicMock()
    runtime.context = {}
    runtime.configurable = {}
    prev = os.environ.get("TERMINAL_BLOCK_CODE_SEARCH")
    os.environ["TERMINAL_BLOCK_CODE_SEARCH"] = "1"
    try:
        out = try_terminal_code_search_redirect(command="grep -r foo .", runtime=runtime)
        # No hard block — fall through to real terminal when redirect unavailable
        assert out is None
    finally:
        if prev is None:
            os.environ.pop("TERMINAL_BLOCK_CODE_SEARCH", None)
        else:
            os.environ["TERMINAL_BLOCK_CODE_SEARCH"] = prev


def test_allows_dir_recursive_file_locate():
    cmd = r"cd D:\github\turbopush-website; dir data\turbopush.db /s /b"
    assert not is_code_search_terminal_command(cmd)


def test_allows_disk_folder_size_powershell():
    cmd = (
        "powershell -Command \"Get-ChildItem -Path 'C:\\\\' -Directory | ForEach-Object { "
        "$size = (Get-ChildItem -Path $_.FullName -Recurse -File -ErrorAction SilentlyContinue "
        "| Measure-Object -Property Length -Sum).Sum; Write-Output $size }\""
    )
    assert not is_code_search_terminal_command(cmd)


def test_allows_measure_object_recurse_pipeline():
    cmd = (
        "powershell -NoProfile -Command \"$f='C:\\\\Windows'; "
        "(Get-ChildItem $f -Recurse -File -ErrorAction SilentlyContinue "
        "| Measure-Object -Property Length -Sum).Sum\""
    )
    assert not is_code_search_terminal_command(cmd)


def test_blocks_gci_recurse_with_source_filter():
    cmd = "Get-ChildItem -Recurse -Filter *.tsx | Select-String -Pattern 'foo'"
    assert is_code_search_terminal_command(cmd)
