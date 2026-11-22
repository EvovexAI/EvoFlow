"""同一任务刚等过就不再阻塞第二次（2026-11-22 第123轮）。

【self-evolution-bot · 2026-11-22 · 第123轮 · 模型:deepseek-v4.1-flash-1017】

## 现象（现网 obs 近 7 天，以 11-20 12:00 单次封顶 30s 上线为界）

    封顶前：398 次调用 / 362 个 task，被查 ≥2 次 20 个（6%），  重复部分平均 264s
    封顶后：139 次调用 /  76 个 task，被查 ≥2 次 26 个（34%），重复部分 646s

封顶后重复等待占该期总等待 **43.1%**（646s / 1501s）。典型：

    a5d15e50480c  8 次：30.0 → 30.0 → 30.0 → 0(block=false) → … → 0.1 → 0.1
    c71bb3713b79  6 次：0.1 → 0.1 → 0.1 → 0(block=false) → 30.0 → 30.3
    ffab83f5b803  4 次：30.1 → 30.0 → 30.4 → 30.3（全 timeout、无一次 success）

## 根因

单次被封顶到 30s 之后，「再查一次」变便宜了，于是查得更勤。真正该做的是
**停手等完成通知**，而不是换个更小的 timeout 继续轮。判据不是「查得太频繁」，
而是「刚阻塞等过、任务仍未结束、这中间没有新信息」。

## 判据

距上一次阻塞查询结束 < 本次 timeout（且 ≥3s，上限 30s）→ 不再阻塞，秒回状态。
拿掉这条，回执就会退化回「等满 30s → 立刻再等 30s」的形态。
"""

from __future__ import annotations

import time
from pathlib import Path

from evoflow.tools.zcode_port import background as BG


def _make_task(tmp_path: Path, *, task_id: str, output: bytes = b"") -> BG.BackgroundBashTask:
    out = tmp_path / f"{task_id}.output"
    out.write_bytes(output)
    task = BG.BackgroundBashTask(
        task_id=task_id,
        command="echo hi",
        description="probe",
        output_path=out,
    )
    BG.register_task(task)
    return task


def test_second_poll_does_not_block_after_recent_wait(tmp_path):
    """刚等过 30s 仍未结束 → 第二次查询必须秒回，不能再等 30s。"""
    task = _make_task(tmp_path, task_id="cool-yes", output=b"")
    task.last_wait_ended_mono = time.monotonic()  # 刚结束一次阻塞查询

    from evoflow.tools.zcode_port.task_tools import task_output_tool

    started = time.monotonic()
    text = str(task_output_tool.invoke({"task_id": "cool-yes", "timeout": 30_000}))
    elapsed = time.monotonic() - started

    assert elapsed < 2.0, f"仍然阻塞了 {elapsed:.1f}s，冷却判据没生效"
    assert "没有阻塞等待" in text, "秒回了但没说清为什么，调用方会以为工具坏了"


def test_poll_blocks_normally_after_cooldown_expires(tmp_path):
    """反证：冷却确实过去之后，必须恢复成正常阻塞查询。"""
    task = _make_task(tmp_path, task_id="cool-expired", output=b"")
    task.last_wait_ended_mono = time.monotonic() - 120  # 2 分钟前

    from evoflow.tools.zcode_port import task_tools

    seen: dict[str, int] = {}

    def _fake_wait(task_id, timeout_ms, idle_grace_ms=0):
        seen["timeout_ms"] = timeout_ms
        return task

    orig = task_tools.wait_task
    task_tools.wait_task = _fake_wait
    try:
        text = str(task_tools.task_output_tool.invoke({"task_id": "cool-expired", "timeout": 5_000}))
    finally:
        task_tools.wait_task = orig

    assert seen.get("timeout_ms") == 5_000, "冷却已过期却仍被跳过，判据写成了永久跳过"
    assert "没有阻塞等待" not in text


def test_first_poll_is_never_skipped(tmp_path):
    """反证：从未查询过的任务不许被冷却挡住（否则第一次就查不到东西）。"""
    task = _make_task(tmp_path, task_id="cool-first", output=b"")
    assert task.last_wait_ended_mono == 0.0

    from evoflow.tools.zcode_port import task_tools

    seen: dict[str, int] = {}

    def _fake_wait(task_id, timeout_ms, idle_grace_ms=0):
        seen["timeout_ms"] = timeout_ms
        return task

    orig = task_tools.wait_task
    task_tools.wait_task = _fake_wait
    try:
        task_tools.task_output_tool.invoke({"task_id": "cool-first", "timeout": 7_000})
    finally:
        task_tools.wait_task = orig

    assert seen.get("timeout_ms") == 7_000, "首次查询被冷却误挡"


def test_completed_task_ignores_cooldown(tmp_path):
    """反证：任务已完成必须立刻给结果，冷却不该影响已结束的任务。"""
    task = _make_task(tmp_path, task_id="cool-done", output=b"finished\n")
    task.status = "completed"
    task.exit_code = 0
    task.last_wait_ended_mono = time.monotonic()

    from evoflow.tools.zcode_port.task_tools import task_output_tool

    text = str(task_output_tool.invoke({"task_id": "cool-done"}))
    assert "success" in text and "finished" in text


def test_wait_task_records_wait_end_timestamp(tmp_path):
    """接线证真：wait_task 必须把结束时刻写回任务对象，否则冷却判据永远读到 0。"""
    task = _make_task(tmp_path, task_id="cool-stamp", output=b"")
    assert task.last_wait_ended_mono == 0.0

    BG.wait_task("cool-stamp", 300, idle_grace_ms=0)

    assert task.last_wait_ended_mono > 0.0, "wait_task 没回写时间戳 → 冷却判据是死代码"
