"""Persistent terminal session — cd/env carry over within a thread."""

from __future__ import annotations

import os
import tempfile
from types import SimpleNamespace

import pytest

from evoflow.tools.host_direct.terminal_session import (
    close_session,
    run_in_persistent_session,
)
from evoflow.utils.subprocess_platform import detect_shell


def _runtime(tid: str) -> SimpleNamespace:
    return SimpleNamespace(context={"thread_id": tid})


def _pwd_command() -> str:
    shell_path, _, _ = detect_shell()
    base = os.path.basename(shell_path).lower()
    if "powershell" in base or base == "pwsh.exe":
        return "(Get-Location).Path"
    return "cd"


@pytest.fixture
def isolated_thread() -> str:
    tid = "test-terminal-session"
    close_session(tid)
    yield tid
    close_session(tid)


def test_persistent_session_echo(isolated_thread: str) -> None:
    rt = _runtime(isolated_thread)
    out1 = run_in_persistent_session(
        runtime=rt,
        command='echo "hello-persist"',
        cwd=None,
        timeout=15,
        tool_call_id="tc1",
        stream_writer=None,
    )
    assert "hello-persist" in out1
    out2 = run_in_persistent_session(
        runtime=rt,
        command='echo "hello-again"',
        cwd=None,
        timeout=15,
        tool_call_id="tc2",
        stream_writer=None,
    )
    assert "hello-again" in out2


def test_persistent_session_cd_carries_over(isolated_thread: str) -> None:
    rt = _runtime(isolated_thread)
    with tempfile.TemporaryDirectory() as td:
        run_in_persistent_session(
            runtime=rt,
            command=f'cd "{td}"',
            cwd=None,
            timeout=15,
            tool_call_id="tc-cd",
            stream_writer=None,
        )
        pwd_out = run_in_persistent_session(
            runtime=rt,
            command=_pwd_command(),
            cwd=None,
            timeout=15,
            tool_call_id="tc-pwd",
            stream_writer=None,
        )
        norm_td = td.replace("\\", "/").lower()
        norm_out = pwd_out.replace("\\", "/").lower()
        assert norm_td in norm_out


def test_new_session_resets_shell(isolated_thread: str) -> None:
    rt = _runtime(isolated_thread)
    out = run_in_persistent_session(
        runtime=rt,
        command='echo "after-reset"',
        cwd=None,
        timeout=15,
        tool_call_id="tc-b",
        stream_writer=None,
        new_session=True,
    )
    assert "after-reset" in out
