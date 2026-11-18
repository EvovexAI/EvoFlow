"""Regression: the ``assets`` tool must not ride the event loop default executor.

【self-evolution-bot · 2026-11-17 · 第36轮】为什么会有这个测试：

现网连续几轮报「assets 删除/写入 2 秒级」，而工具函数体实测只有 0.23ms（真 vault，
not_found 路径）。定位到两类同源排队：

1. ``StructuredTool`` 在没有 ``coroutine`` 时，``ainvoke`` 走
   ``run_in_executor(None, ...)`` —— 事件循环的**默认** executor。
2. ``TranscriptMiddleware`` 落库同样用 ``asyncio.to_thread``（也是默认 executor）。

默认池被全仓 231 处 ``to_thread`` + langchain 同步工具的 ``run_in_executor(None, …)``
共用。并发工具调用一多就排队，``duration_ms`` 被撑到 2s 级（实测 2142ms，而内层
``tool_end`` 只有 10~22ms）。

**本测试的判据**：把默认池灌满 blocker 模拟那个饱和态，断言 assets 仍能在几十毫秒内完成。
- 挂专用池 coroutine：实测 ~16ms
- 不挂（回退成默认池）：实测 ~2793ms

注意：这是**结构**断言，不是性能预算。真实现网数字要靠重启后复算
``evoflow_obs_tool_invocations.duration_ms``，别拿本测试当验收。
"""

from __future__ import annotations

import asyncio
import time

import pytest

from evoflow.tools.builtins.assets_tool import ToolRuntime, assets_tool


def _runtime(i: int) -> ToolRuntime:
    return ToolRuntime(
        state=None,
        context={},
        config={},
        stream_writer=None,
        tool_call_id=f"tc-{i}",
        store=None,
    )


def _tool_call(i: int) -> dict:
    return {
        "args": {
            "action": "delete",
            "path": "memory/journal/__regression_absent_probe.md",
            "runtime": _runtime(i),
        },
        "name": "assets",
        "type": "tool_call",
        "id": f"tc-{i}",
    }


def test_assets_tool_has_coroutine() -> None:
    """Guard the mount itself — losing it silently re-opens the 2s queue."""
    assert getattr(assets_tool, "coroutine", None) is not None, (
        "assets_tool.coroutine is missing: ainvoke will fall back to the event loop "
        "default executor and queue behind every other to_thread caller."
    )


def test_assets_ainvoke_not_blocked_by_default_executor_saturation() -> None:
    """Saturated default pool must not inflate assets latency."""
    config = {"configurable": {"thread_id": "tid-assets-pool-probe"}}

    async def scenario() -> float:
        loop = asyncio.get_running_loop()
        # Occupy the default executor exactly like a busy gateway does.
        blockers = [loop.run_in_executor(None, (lambda: time.sleep(2.0))) for _ in range(32)]
        await asyncio.sleep(0.1)
        started = time.perf_counter()
        await asyncio.gather(*[assets_tool.ainvoke(_tool_call(i), config) for i in range(4)])
        elapsed_ms = (time.perf_counter() - started) * 1000.0
        await asyncio.gather(*blockers, return_exceptions=True)
        return elapsed_ms

    elapsed_ms = asyncio.run(scenario())

    # Before the coroutine mount this was ~2793ms (queued behind 2s blockers).
    assert elapsed_ms < 800.0, (
        f"assets ainvoke queued on the default executor: {elapsed_ms:.0f}ms for 4 concurrent "
        f"no-op deletes. It must run on its dedicated pool "
        f"(see _assets_tool_coroutine in assets_tool.py)."
    )


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(pytest.main([__file__, "-q"]))
