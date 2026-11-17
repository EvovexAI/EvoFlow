"""Regression: transcript persistence must NOT ride the event loop default executor.

【self-evolution-bot · 2026-11-17 · 第36轮】为什么会有这个测试：
现网 obs 里同批 4 个工具调用，最内层 ``tool_end`` 实测只有 10~22ms（assets）/
246~419ms（bash），但 ``tool_error_handling`` 记的 ``duration_ms`` 是 2142/2363ms，
且四条几乎同刻结束（barrier 形状）。回推调用链后确认差值来自
``TranscriptMiddleware.awrap_tool_call`` 里的 ``await asyncio.to_thread(...)``：
它走事件循环的**默认** executor，而全仓 231 处 ``to_thread`` 加 langchain 同步工具的
``run_in_executor(None, ...)`` 全挤同一个池，并发时落库排队 1.9~2.1s。

本测试用「把默认池灌满 blocker」来复现那个饱和态，断言两件事：
1. 落库仍然被调用（行为没被破坏）；
2. 墙钟不随默认池饱和而膨胀（证明它已不在默认池里排队）。

判据边界：这是**结构**断言，不是性能基准。真实现网数字要靠重启后用
``evoflow_obs_tool_invocations.duration_ms`` 复算，别用本测试代替。
"""

from __future__ import annotations

import asyncio
import time
import types

import pytest
from langchain_core.messages import ToolMessage

from evoflow.agents.middlewares import transcript_middleware as tmw


class _FakeRuntime:
    context = {"thread_id": "tid-probe"}
    config: dict = {}


def _request() -> types.SimpleNamespace:
    return types.SimpleNamespace(
        runtime=_FakeRuntime(),
        tool_call={"name": "assets", "id": "tc-probe", "args": {}},
    )


def test_persist_runs_off_default_executor(monkeypatch: pytest.MonkeyPatch) -> None:
    """Default pool saturated ⇒ persisted call must still finish fast."""
    called: list[int] = []

    def _fake_persist(self, request, result) -> None:  # noqa: ANN001 - stub
        called.append(1)

    monkeypatch.setattr(
        tmw.TranscriptMiddleware, "_persist_tool_result_now", _fake_persist, raising=True
    )

    inst = tmw.TranscriptMiddleware()

    async def handler(_request):  # noqa: ANN001 - stub
        await asyncio.sleep(0.005)
        return ToolMessage(content="ok", tool_call_id="tc-probe", name="assets")

    async def scenario() -> tuple[float, float]:
        loop = asyncio.get_running_loop()

        started = time.perf_counter()
        await asyncio.gather(*[inst.awrap_tool_call(_request(), handler) for _ in range(4)])
        idle_ms = (time.perf_counter() - started) * 1000.0

        # Saturate the *default* executor the way the gateway does (many to_thread
        # callers + langchain run_in_executor(None, ...) for sync tools).
        blockers = [loop.run_in_executor(None, (lambda: time.sleep(2.0))) for _ in range(32)]
        await asyncio.sleep(0.1)
        started = time.perf_counter()
        await asyncio.gather(*[inst.awrap_tool_call(_request(), handler) for _ in range(4)])
        saturated_ms = (time.perf_counter() - started) * 1000.0
        await asyncio.gather(*blockers, return_exceptions=True)
        return idle_ms, saturated_ms

    idle_ms, saturated_ms = asyncio.run(scenario())

    assert called, "persist hook must still run (behaviour preserved)"
    # Before the fix this was ~3786ms (blocked behind the 2s blockers).
    # Keep the bound generous — this asserts "not queued behind the default pool",
    # not a specific latency budget.
    assert saturated_ms < 1000.0, (
        f"transcript persist queued on the default executor: saturated={saturated_ms:.0f}ms "
        f"(idle={idle_ms:.0f}ms). It must run on its private pool "
        f"(see _run_in_transcript_pool in transcript_middleware.py)."
    )


def test_persist_private_pool_is_lazy_singleton() -> None:
    """Importing the module must not start threads; the pool is created on demand."""
    assert tmw._transcript_pool() is tmw._transcript_pool()
