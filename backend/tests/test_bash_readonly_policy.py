"""Tests for the ZCode-style read-only shell policy + read file_unchanged + glob/grep registration."""

from __future__ import annotations

import io
import tempfile
import time
from pathlib import Path

import pytest
from PIL import Image


# ── Read-only shell classification ──────────────────────────────────────────


@pytest.mark.parametrize(
    "command",
    [
        "cat foo.txt",
        "ls -la",
        "rg pattern src/",
        'rg "foo|bar" .',  # pipe inside quotes is not a shell pipe
        "rg -i --files | wc -l",  # read-only pipeline
        "git status",
        "git log --oneline -5",
        "git diff HEAD~1",
        "git show abc123",
        "git branch --list",
        "git tag -l",
        "git config --get user.email",
        "git stash list",
        "pyright --outputjson src",
        "ruff check .",
        "eslint src/",
        "tsc --noEmit",
        "time rg foo",
        "FOO=1 rg foo",
        "find . -name '*.py'",
    ],
)
def test_readonly_commands(command: str) -> None:
    from evoflow.tools.zcode_port.bash_readonly_policy import is_readonly_shell_command

    assert is_readonly_shell_command(command), command


@pytest.mark.parametrize(
    "command",
    [
        "rm -rf x",
        "echo hi > f.txt",
        "cat a && cat b",
        "cat a; cat b",
        "echo `rm x`",
        "echo $(rm x)",
        "git push",
        "git commit -m x",
        "git branch -D feature",
        "git branch new-branch",
        "git tag v1.0",
        "git config user.email a@b.c",
        "git remote add origin url",
        "git stash drop",
        "find . -delete",
        "find . -exec rm {} ;",
        "pyright --watch",
        "ruff check --fix .",
        "eslint --fix src/",
        "tsc",
        "python -c 'print(1)'",
        "node -e 'console.log(1)'",
        "pip install requests",
        "npm install",
        "curl http://example.com",
        "bash -c 'rm x'",
        "sed -i 's/a/b/' f.txt",
        "cat f | tee out.txt",
    ],
)
def test_not_readonly_commands(command: str) -> None:
    from evoflow.tools.zcode_port.bash_readonly_policy import is_readonly_shell_command

    assert not is_readonly_shell_command(command), command


def test_tool_risk_level_readonly_bypass() -> None:
    from evoflow.agents.tool_approval_config import RISK_AUTO, RISK_CONFIRM, tool_risk_level

    assert tool_risk_level("bash", {"command": "cat foo.txt"}) == RISK_AUTO
    assert tool_risk_level("bash", {"command": "rg pattern src/"}) == RISK_AUTO
    assert tool_risk_level("bash", {"command": "rm -rf x"}) == RISK_CONFIRM
    assert tool_risk_level("bash", {"command": ""}) == RISK_CONFIRM


# ── Read file_unchanged short-circuit ───────────────────────────────────────


def test_read_unchanged_short_circuit() -> None:
    from unittest.mock import MagicMock

    from evoflow.tools.host_direct.read_file import read_file_hd
    from evoflow.tools.zcode_port import read_file_state

    tmp = Path(tempfile.mkdtemp())
    txt = tmp / "main.py"
    txt.write_text("def main():\n    pass\n", encoding="utf-8")

    rt = MagicMock()
    rt.state = {}
    rt.context = {}

    # First read: full content.
    out1 = read_file_hd.func(path=str(txt), runtime=rt)
    assert "def main()" in out1

    # Immediate re-read: unchanged marker, no content.
    out2 = read_file_hd.func(path=str(txt), runtime=rt)
    assert "file unchanged" in out2
    assert "def main()" not in out2

    # offset/limit re-read bypasses the marker.
    out3 = read_file_hd.func(path=str(txt), offset=1, limit=5, runtime=rt)
    assert "def main()" in out3

    # After the file changes on disk: full content again.
    time.sleep(0.02)
    txt.write_text("def main():\n    return 1\n", encoding="utf-8")
    out4 = read_file_hd.func(path=str(txt), runtime=rt)
    assert "return 1" in out4


def test_read_state_stale_hint_still_works() -> None:
    from evoflow.tools.zcode_port import read_file_state

    tmp = Path(tempfile.mkdtemp())
    txt = tmp / "a.txt"
    txt.write_text("hello", encoding="utf-8")
    read_file_state.note_read(str(txt))
    assert read_file_state.stale_read_hint() == ""
    time.sleep(0.02)
    txt.write_text("world!", encoding="utf-8")
    hint = read_file_state.stale_read_hint()
    assert "a.txt" in hint


# ── glob/grep registration ──────────────────────────────────────────────────


def test_glob_grep_registered_in_host_direct_catalog() -> None:
    from evoflow.tools.host_direct import HOST_DIRECT_TOOLS

    names = [getattr(t, "name", "") for t in HOST_DIRECT_TOOLS]
    assert "glob" in names and "grep" in names


def test_glob_grep_args_fields_match_read_convention() -> None:
    # Raw ``model_json_schema()`` raises for ALL host-direct tools carrying
    # ``runtime: ToolRuntime`` (read/write/replace included) — langchain strips
    # injected args at bind_tools time. Asserting field shape instead.
    from evoflow.tools.host_direct.read_file import read_file_hd
    from evoflow.tools.zcode_port.glob_grep import glob_tool, grep_tool

    for tool_obj in (glob_tool, grep_tool, read_file_hd):
        fields = tool_obj.args_schema.model_fields
        assert "runtime" in fields  # injected at graph runtime, stripped on bind
    assert "pattern" in glob_tool.args_schema.model_fields
    assert "pattern" in grep_tool.args_schema.model_fields


def test_glob_grep_auto_risk_and_aliases() -> None:
    from evoflow.agents.tool_approval_config import RISK_AUTO, tool_risk_level
    from evoflow.tools.tool_aliases import canonical_tool_name

    assert tool_risk_level("glob", {}) == RISK_AUTO
    assert tool_risk_level("grep", {}) == RISK_AUTO
    assert canonical_tool_name("rg") == "grep"
    assert canonical_tool_name("find") == "glob"
    assert canonical_tool_name("grep") == "grep"
