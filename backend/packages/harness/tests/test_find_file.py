"""Tests for find_file host-direct tool."""

from __future__ import annotations

from pathlib import Path

from evoflow.tools.host_direct.find_file import (
    _iter_matches,
    find_workspace_files,
    query_to_glob_pattern,
)
from evoflow.tools.host_direct.workspace_path_guard import runtime_with_workspace


def test_iter_matches_finds_pattern(tmp_path: Path):
    (tmp_path / "evopanel").mkdir()
    (tmp_path / "evopanel" / "agent-trace.html").write_text("<html></html>", encoding="utf-8")
    (tmp_path / "evopanel" / "agent-trace.js").write_text("export {}", encoding="utf-8")
    hits = _iter_matches(tmp_path / "evopanel", "*agent-trace*", max_results=10)
    names = {Path(h).name for h in hits}
    assert "agent-trace.html" in names
    assert "agent-trace.js" in names


def test_find_file_wallclock_requires_workspace():
    from evoflow.tools.host_direct.find_file import find_file_wallclock

    class _Ctx:
        def get(self, key, default=None):
            return default

    class _Rt:
        context = _Ctx()

    out = find_file_wallclock(pattern="*agent-trace*", root=".", runtime=_Rt())
    assert out.startswith("Error:")


def test_find_file_wallclock_finds_under_root(tmp_path: Path):
    from evoflow.tools.host_direct.find_file import find_file_wallclock

    (tmp_path / "pages").mkdir()
    (tmp_path / "pages" / "agent-trace.js").write_text("// x", encoding="utf-8")
    rt = runtime_with_workspace(str(tmp_path), "test-thread")
    out = find_file_wallclock(pattern="*agent-trace*", root="pages", runtime=rt)
    assert "agent-trace.js" in out
    assert "Found" in out


def test_query_to_glob_pattern_escapes_wildcards():
    assert query_to_glob_pattern("ChatApp.tsx") == "*ChatApp.tsx*"
    assert query_to_glob_pattern("a*b") == "*a[*]b*"


def test_find_workspace_files_by_name(tmp_path: Path):
    (tmp_path / "src").mkdir()
    (tmp_path / "src" / "ChatApp.tsx").write_text("export {}", encoding="utf-8")
    (tmp_path / "src" / "Other.ts").write_text("export {}", encoding="utf-8")
    hits = find_workspace_files(tmp_path, "ChatApp", limit=10)
    paths = {h["path"] for h in hits}
    assert "src/ChatApp.tsx" in paths


def test_find_workspace_files_substring_fallback(tmp_path: Path):
    (tmp_path / "lib").mkdir()
    (tmp_path / "lib" / "MyWidget.js").write_text("", encoding="utf-8")
    hits = find_workspace_files(tmp_path, "widget", limit=10)
    assert any(h["path"] == "lib/MyWidget.js" for h in hits)
