"""`taskoutput` 不许把对话按满 30 秒（2026-11-19 第67轮）。

【self-evolution-bot · 2026-11-19 · 第67轮 · 模型:deepseek-v4.1-flash-1017】

## 现象（现网 obs，近 7 天）

`taskoutput` 543 次调用的耗时分布：

    <1s      167 次   平均   105ms
    1-3s      31 次   平均  2008ms
    3-10s     75 次   平均  6005ms
    10-30s   130 次   平均 19237ms
    >=30s    140 次   平均 137723ms   ← 累计约 5.4 小时

`taskoutput` 占总工具耗时 **21.4%**，仅次于 bash；对话里表现为
「正在获取任务输出」假死（这是用户明确抱怨过的形态）。

## 根因

`task_output_tool(block=True, timeout=30_000)` + `wait_task()` 纯阻塞轮询：
任务还在跑就一直 `sleep(0.1)` 到 deadline，**一分钟产出的内容也照等满 30 秒**。

## 修法

1. 默认 timeout 30000 → **5000**；
2. `wait_task` 新增 `idle_grace_ms`：一旦**已产出输出**且连续静默够久，立即返回。
   还没任何输出时照旧等满 timeout（否则会把「刚启动还没打印」误判成「可以了」）。

语义不变：任务仍在跑照样返回 `<retrieval_status>not_ready/timeout</retrieval_status>`，
调用方可以稍后再查；只是不再为「多等一会也许就完了」白付 25 秒。

## 这两条测试怎么才算真守住

- 正向：有输出且静默 → 必须在**远小于 timeout** 的时间内返回；
- 反证：**还没任何输出**时不许提前返回（负向判据，防止我把宽限做成"立刻返回"）。
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
        command="sleep 999",
        description="probe",
        output_path=out,
    )
    BG.register_task(task)
    return task


def test_wait_task_returns_early_after_output_goes_quiet(tmp_path):
    """已有输出 + 静默超过宽限 → 提前返回，不等满 30 秒。"""
    _make_task(tmp_path, task_id="probe-quiet", output=b"partial output\n")

    started = time.time()
    got = BG.wait_task("probe-quiet", 30_000, idle_grace_ms=300)
    elapsed = time.time() - started

    assert got is not None
    assert elapsed < 5.0, f"仍然等了 {elapsed:.1f}s，宽限没生效"
    # 提前返回不代表任务完成：状态仍是 running，调用方据此知道可以稍后再查
    assert got.status == "running"


def test_wait_task_does_not_return_before_any_output(tmp_path):
    """反证：没有任何输出时不许提前返回（否则等于没等）。"""
    _make_task(tmp_path, task_id="probe-silent", output=b"")

    started = time.time()
    BG.wait_task("probe-silent", 1_200, idle_grace_ms=300)
    elapsed = time.time() - started

    assert elapsed >= 1.0, f"无输出也提前返回了（{elapsed:.1f}s），宽限判据写错"


def test_task_output_default_timeout_is_short():
    """默认不能再是 30000：否则一次查询就能按满半分钟。

    ``@tool`` 装饰后拿到的 ``StructuredTool`` 不可直接调用，参数 schema 在
    ``args_schema`` 上；这里读真实 schema 的默认值，而不是读函数签名。
    """
    from evoflow.tools.zcode_port.task_tools import task_output_tool

    fields = task_output_tool.args_schema.model_fields
    default = fields["timeout"].default
    assert default <= 10_000, f"默认 timeout 仍是 {default}ms，没降到短等待"


def test_completed_task_reads_output_immediately(tmp_path):
    """已完成的任务必须立刻返回内容，不受宽限影响。"""
    task = _make_task(tmp_path, task_id="probe-done", output=b"done!\n")
    task.status = "completed"
    task.exit_code = 0

    from evoflow.tools.zcode_port.task_tools import task_output_tool

    started = time.time()
    text = str(task_output_tool.invoke({"task_id": "probe-done"}))
    elapsed = time.time() - started

    assert elapsed < 2.0, f"已完成任务仍等了 {elapsed:.1f}s"
    assert "success" in text
    assert "done!" in text
