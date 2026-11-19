"""转后台时把已产出内容直接回传，不必再 Read 一次。

【self-evolution-bot · 2026-11-19 · 第79轮 · 模型:deepseek-v4.1-flash-1017】

背景：命令超出前台预算转后台时，工具**早就拿到了**已产出的 partial 输出
（冷路径的 ``partial_stdout`` / 暖路径的 ``partial``），却只写进落盘文件、
返回值里一个字都不给，只说一句「To check interim output, use Read on that file path」。
现网近 24h **176 次转后台里有 45 次（25.6%）真的又去 Read 了一遍** —— 每次白烧一个
整轮，而读到的内容与工具本可直接返回的完全相同。

本测试钉住两条判据：
1. 转后台返回值必须含 ``partialOutput:`` 段（有已产出内容时）。
2. 该段内容必须真的就是那批已产出文本（不是空壳、不是别的字段）。

两条路径（冷 ``_promote_to_background`` / 暖 ``_promote_warm_to_background``）各测一次，
因为它们是两份独立实现，只测一边等于没测。
"""

from __future__ import annotations

import importlib
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

bt = importlib.import_module("evoflow.tools.zcode_port.bash_tool")

class _FakeTask:
    """字段齐全的替身：后台 pump 线程可能在 patch 作用域退出后才执行 mark()。

    【self-evolution-bot · 2026-11-19 · 第79轮】用 SimpleNamespace 时线程里
    ``mark()`` 撞 AttributeError: 'ended_at' —— 那不是被测代码的错，是替身不全，
    但它会以 PytestUnhandledThreadExceptionWarning 混进输出，掩盖真正的失败。
    """

    def __init__(self, task_id: str) -> None:
        self.task_id = task_id
        self.started_at = 0.0
        self.status = "running"
        self.ended_at = None
        self.exit_code = None
        self.error = ""


_PARTIAL = "line-one from the command\nline-two from the command\n"


def _assert_partial_block(out: str, expect: str) -> None:
    assert "partialOutput:" in out, f"返回值没有回传已产出内容:\n{out[:400]}"
    idx = out.index("partialOutput:")
    tail = out[idx:]
    assert expect.strip() in tail, f"partialOutput 里没有真实内容:\n{tail[:400]}"
    # 不许再无条件让 agent 去读文件
    assert "To check interim output, use Read on that file path" not in out


def test_cold_promote_returns_partial_output(tmp_path: Path) -> None:
    """冷路径：_promote_to_background 必须把 partial_stdout 带回返回值。"""
    out_path = tmp_path / "bg.output"

    class _FakeProc:
        returncode = 0

        def communicate(self):
            return ("", "")

    fake_task = SimpleNamespace(
        task_id="t1", started_at=0.0, status="running", ended_at=None
    )
    with patch.object(bt, "_output_file", return_value=out_path), \
            patch.object(bt, "register_task"), \
            patch.object(bt, "BackgroundBashTask", return_value=fake_task), \
            patch.object(bt, "mark"), \
            patch.object(bt, "_emit"):
        out = bt._promote_to_background(
            _FakeProc(),
            command="sleep 20",
            cwd=".",
            tool_call_id="call_1",
            description="bg",
            thread_id="th1",
            session_key="s1",
            partial_stdout=_PARTIAL,
            partial_stderr="",
            blocking_ms=15_000,
        )
    _assert_partial_block(out, "line-one from the command")


def test_warm_promote_returns_partial_output(tmp_path: Path) -> None:
    """暖路径：_promote_warm_to_background 是另一份实现，必须同样回传。"""
    out_path = tmp_path / "bg-warm.output"

    fake_session = SimpleNamespace(
        proc=SimpleNamespace(returncode=0),
        close=lambda **kw: None,
    )
    fake_task = SimpleNamespace(
        task_id="t2", started_at=0.0, status="running", ended_at=None
    )
    with patch.object(bt, "_output_file", return_value=out_path), \
            patch.object(bt, "register_task"), \
            patch.object(bt, "BackgroundBashTask", return_value=fake_task), \
            patch.object(bt, "mark"), \
            patch.object(bt, "_emit"), \
            patch.object(bt, "_capture_writer", return_value=None):
        import evoflow.tools.zcode_port.warm_bash as wb
        with patch.object(wb, "continue_drain", return_value=("", 0, True)), \
                patch.object(wb, "last_cwd", return_value=""):
            out = bt._promote_warm_to_background(
                fake_session,
                command="sleep 20",
                tool_call_id="call_2",
                description="bg-warm",
                thread_id="th2",
                session_key="s2",
                partial=_PARTIAL,
                blocking_ms=15_000,
                remaining_timeout_s=60.0,
            )
    _assert_partial_block(out, "line-one from the command")


def test_empty_partial_does_not_emit_empty_block(tmp_path: Path) -> None:
    """没有已产出内容时不该塞一个空的 partialOutput 段（避免噪声与误读）。"""

    class _FakeProc:
        returncode = 0

        def communicate(self):
            return ("", "")

    fake_task = _FakeTask("t3")
    with patch.object(bt, "_output_file", return_value=tmp_path / "x.output"), \
            patch.object(bt, "register_task"), \
            patch.object(bt, "BackgroundBashTask", return_value=fake_task), \
            patch.object(bt, "_emit"):
        out = bt._promote_to_background(
            _FakeProc(),
            command="sleep 20",
            cwd=".",
            tool_call_id="call_3",
            description="bg",
            thread_id="th3",
            session_key="s3",
            partial_stdout="",
            partial_stderr="",
            blocking_ms=15_000,
        )
    assert "partialOutput:" not in out
    assert "status: backgrounded" in out
