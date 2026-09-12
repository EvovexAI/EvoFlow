"""Tests for code_lint helpers."""

from __future__ import annotations

from pathlib import Path
from unittest.mock import patch

from evoflow.tools.code_lint import (
    append_post_edit_lint,
    is_lintable_code_path,
    language_for_path,
    lint_path,
)


def test_is_lintable_code_path():
    assert is_lintable_code_path("foo.py")
    assert is_lintable_code_path("bar.tsx")
    assert is_lintable_code_path("Baz.java")
    assert not is_lintable_code_path("readme.md")


def test_language_for_path():
    assert language_for_path("x.py") == "python"
    assert language_for_path("x.ts") == "typescript"
    assert language_for_path("x.jsx") == "javascript"
    assert language_for_path("x.java") == "java"


def test_append_post_edit_lint_skips_non_code():
    assert append_post_edit_lint("notes.md", "OK: wrote") == "OK: wrote"


def test_append_post_edit_lint_appends_block():
    with (
        patch("evoflow.tools.code_lint._AUTO_AFTER_EDIT", True),
        patch(
            "evoflow.scheduler.post_edit_lint.follow_lint_after_edit",
            return_value="<post_edit_lints>\npython (ruff): ok\n</post_edit_lints>",
        ),
    ):
        out = append_post_edit_lint("src/a.py", "OK: wrote 10 bytes")
    assert "<post_edit_lints>" in out


def test_lint_python_ruff(tmp_path: Path):
    f = tmp_path / "bad.py"
    f.write_text("x=1\n", encoding="utf-8")
    with (
        patch("evoflow.tools.code_lint._which", return_value="/usr/bin/ruff"),
        patch(
            "evoflow.tools.code_lint._run",
            return_value=(1, "bad.py:1:1: E702 Multiple statements on one line"),
        ),
    ):
        out = lint_path(f)
    assert "ruff" in out
    assert "E702" in out
