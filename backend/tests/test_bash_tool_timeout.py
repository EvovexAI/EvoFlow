"""Bash tool timeout / probe soft-cap / Windows tree-kill helpers."""

from __future__ import annotations

import importlib
import sys
from pathlib import Path
from unittest.mock import patch

import pytest

# ``zcode_port.__init__`` re-exports ``bash_tool`` (StructuredTool), which shadows
# ``import evoflow.tools.zcode_port.bash_tool`` attribute lookup on some paths.
bt = importlib.import_module("evoflow.tools.zcode_port.bash_tool")


@pytest.mark.parametrize(
    ("command", "expect_probe"),
    [
        ("git status --short", True),
        ("git -C 'D:/repo' log --oneline -5", True),
        ("cd D:/dev/github/EvoFlow && ls -la", True),
        ("cd D:/repo && git status --short | head -30", True),
        ("npm install", False),
        ("pytest -q", False),
    ],
)
def test_probe_command_detection(command: str, expect_probe: bool) -> None:
    matched = bt._PROBE_COMMAND_RE.search(command) is not None
    assert matched is expect_probe


def test_effective_timeout_soft_caps_probes_when_implicit() -> None:
    assert bt._effective_timeout_ms("git status", 120_000, explicit=False) == min(
        120_000, bt.PROBE_TIMEOUT_MS
    )
    assert bt._effective_timeout_ms("git status", 120_000, explicit=True) == 120_000
    assert bt._effective_timeout_ms("npm install", 120_000, explicit=False) == 120_000


def test_blocking_budget_backgrounds_implicit_long_commands() -> None:
    assert bt._blocking_budget_ms(120_000, explicit=False) == bt.ASSISTANT_BLOCKING_BUDGET_MS
    assert bt._blocking_budget_ms(5_000, explicit=False) == 5_000


def test_blocking_budget_caps_explicit_foreground_and_keeps_lo_full() -> None:
    """显式 timeout 只买到封顶内的前台时间，超出转后台（2026-11-07 生产数据回归：
    显式 timeout=600s 的 pnpm install 前台占住线程通道，并行批次排队 237s）。"""
    assert bt._blocking_budget_ms(600_000, explicit=True) == bt.FOREGROUND_BLOCKING_CEILING_MS
    assert bt._blocking_budget_ms(90_000, explicit=True) == bt.FOREGROUND_BLOCKING_CEILING_MS
    # 封顶以内的显式 timeout 照常生效（到点强杀语义不变）
    assert bt._blocking_budget_ms(30_000, explicit=True) == 30_000
    # LibreOffice 风险命令不可安全后台化 → 保留完整显式超时
    assert bt._blocking_budget_ms(600_000, explicit=True, promotable=False) == 600_000
    # 非显式不受 promotable 影响（15s 助手预算不变）
    assert bt._blocking_budget_ms(600_000, explicit=False, promotable=False) == bt.ASSISTANT_BLOCKING_BUDGET_MS


def test_bash_max_concurrent_default_and_env_override(monkeypatch) -> None:
    monkeypatch.delenv("EVOFLOW_BASH_MAX_CONCURRENT", raising=False)
    assert bt._bash_max_concurrent() == 4
    monkeypatch.setenv("EVOFLOW_BASH_MAX_CONCURRENT", "2")
    assert bt._bash_max_concurrent() == 2
    monkeypatch.setenv("EVOFLOW_BASH_MAX_CONCURRENT", "bogus")
    assert bt._bash_max_concurrent() == 4


def test_queue_wait_registry_roundtrip() -> None:
    from evoflow.observability.tool_timing import note_tool_queue_wait, pop_tool_queue_wait

    note_tool_queue_wait("call-q1", 123.4)
    assert pop_tool_queue_wait("call-q1") == pytest.approx(123.4)
    assert pop_tool_queue_wait("call-q1") is None  # consumed once
    note_tool_queue_wait("", 50.0)  # no tool_call_id → ignored
    note_tool_queue_wait("call-q2", 0.0)  # non-positive → ignored
    assert pop_tool_queue_wait("call-q2") is None
    assert pop_tool_queue_wait("") is None


def test_large_stdout_is_persisted_with_short_preview(tmp_path, monkeypatch) -> None:
    monkeypatch.setattr(bt, "_output_file", lambda task_id: tmp_path / f"{task_id}.output")
    text = "x" * (bt.MAX_INLINE_BYTES + 50)
    shown, truncated = bt._model_stream(text)
    assert truncated is True
    assert "<persisted-output>" in shown
    assert "Full output saved to:" in shown
    assert len(shown) < bt.MAX_INLINE_BYTES
    saved = list(tmp_path.glob("*.output"))
    assert saved and saved[0].read_text(encoding="utf-8") == text


def test_stale_read_hint_after_mtime_change(tmp_path) -> None:
    from evoflow.tools.zcode_port.read_file_state import (
        note_read,
        reset_read_state,
        stale_read_hint,
    )

    # 全局注册表被其它测试（host-direct 文件用例的已读记录）污染会让断言不稳定
    reset_read_state()
    target = tmp_path / "watched.txt"
    import os
    import time

    target.write_text("a", encoding="utf-8")
    note_read(str(target))
    assert stale_read_hint() == ""
    later = time.time() + 5
    os.utime(target, (later, later))
    hint = stale_read_hint()
    assert "changed on disk" in hint
    assert str(target.resolve()) in hint


def test_small_stdout_stays_inline() -> None:
    shown, truncated = bt._model_stream("git status ok")
    assert truncated is False
    assert shown == "git status ok"


def test_timeout_was_explicit() -> None:
    assert bt._timeout_was_explicit(None) is False
    assert bt._timeout_was_explicit("") is False
    assert bt._timeout_was_explicit(15000) is True
    assert bt._timeout_was_explicit("15000") is True


@pytest.mark.parametrize(
    ("command", "expect_lo"),
    [
        ("python xlsx.py recalc report.xlsx", True),
        ("python skills/.../xlsx.py chart-verify a.xlsx", True),
        ("soffice --headless macro:///Standard.Module1.RecalculateAndSave()", True),
        ("git status --short", False),
        ("npm install", False),
    ],
)
def test_libreoffice_risk_command_detection(command: str, expect_lo: bool) -> None:
    assert bt._is_libreoffice_risk_command(command) is expect_lo


def test_force_kill_active_bash_sweeps_lo_only_for_risk_commands(monkeypatch) -> None:
    sweeps: list[bool] = []
    monkeypatch.setattr(bt, "_kill_libreoffice_orphans", lambda: sweeps.append(True))
    monkeypatch.setattr(bt, "_kill_process_tree", lambda *_a, **_k: None)

    class _FakeProc:
        pid = 99

        def poll(self):
            return None

    bt._ACTIVE_BASH_PROCS.clear()
    bt._register_active_bash("t1", _FakeProc(), "git status")
    assert bt.force_kill_active_bash(tool_call_id="t1") == 1
    assert sweeps == []

    bt._register_active_bash("t2", _FakeProc(), "python xlsx.py recalc a.xlsx")
    assert bt.force_kill_active_bash(tool_call_id="t2") == 1
    assert sweeps == [True]


@pytest.mark.skipif(sys.platform != "win32", reason="Windows tree-kill path")
def test_kill_process_tree_invokes_taskkill() -> None:
    with patch("evoflow.tools.zcode_port.bash_tool.subprocess.run") as run:
        run.return_value = None
        bt._kill_process_tree(4242)
    assert run.called
    args = run.call_args[0][0]
    assert args[:4] == ["taskkill", "/PID", "4242", "/F"]
    assert "/T" in args


def test_rejects_wsl_and_store_bash_stubs() -> None:
    assert bt._is_windows_wsl_or_store_bash(r"C:\Windows\System32\bash.exe") is True
    assert bt._is_windows_wsl_or_store_bash(r"C:\Windows\SysWOW64\bash.exe") is True
    assert (
        bt._is_windows_wsl_or_store_bash(
            r"C:\Users\x\AppData\Local\Microsoft\WindowsApps\bash.exe"
        )
        is True
    )
    assert (
        bt._is_windows_wsl_or_store_bash(r"C:\Program Files\Git\bin\bash.exe") is False
    )


def test_bash_shell_win32_ignores_path_bash_prefers_git(tmp_path, monkeypatch) -> None:
    """ZCode parity: never take System32/WSL bash from PATH; use Git Bash only."""
    git_bash = tmp_path / "Git" / "bin" / "bash.exe"
    git_bash.parent.mkdir(parents=True)
    git_bash.write_bytes(b"")
    git_exe = tmp_path / "Git" / "cmd" / "git.exe"
    git_exe.parent.mkdir(parents=True)
    git_exe.write_bytes(b"")
    wsl_bash = tmp_path / "System32" / "bash.exe"
    wsl_bash.parent.mkdir(parents=True)
    wsl_bash.write_bytes(b"")

    monkeypatch.setattr(bt.sys, "platform", "win32")
    monkeypatch.setenv("ProgramFiles", str(tmp_path))
    monkeypatch.delenv("ProgramFiles(x86)", raising=False)
    monkeypatch.delenv("LOCALAPPDATA", raising=False)

    def fake_which(name: str):
        if name == "bash":
            return str(wsl_bash)  # would poison old which()-first logic
        if name == "git":
            return str(git_exe)
        return None

    monkeypatch.setattr(bt.shutil, "which", fake_which)
    shell = bt.bash_shell()
    assert shell is not None
    assert Path(shell[0]) == git_bash
    assert "System32" not in shell[0]


def test_bash_shell_win32_no_git_returns_none(monkeypatch, tmp_path) -> None:
    monkeypatch.setattr(bt.sys, "platform", "win32")
    monkeypatch.setenv("ProgramFiles", str(tmp_path / "empty-pf"))
    monkeypatch.delenv("ProgramFiles(x86)", raising=False)
    monkeypatch.delenv("LOCALAPPDATA", raising=False)
    monkeypatch.setattr(bt.shutil, "which", lambda _name: None)
    assert bt.bash_shell() is None


def test_script_falls_back_to_powershell_without_git_bash(monkeypatch) -> None:
    monkeypatch.setattr(bt.sys, "platform", "win32")
    monkeypatch.setattr(bt, "bash_shell", lambda: None)
    monkeypatch.setattr(bt, "_powershell_executable", lambda: "powershell.exe")
    argv, dialect = bt._script("echo hello", cwd=r"D:\work")
    assert dialect == "powershell"
    assert argv[0] == "powershell.exe"
    assert "echo hello" in argv[-1]
