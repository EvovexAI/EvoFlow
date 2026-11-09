"""模型流首帧（TTFT）看门狗：上游连上但零字节时的断开重试。

生产事故（2026-11-07 桌面端）：run 正常起跑后模型请求发出，上游 104s 零首帧，
总时长看门狗（300s）与客户端读超时（120s）都来不及救，用户手动停止。
修复：首帧前用短预算（默认 60s）断开；看门狗只在零 chunk 时触发，
重试不存在重复输出风险。
"""

from __future__ import annotations

import asyncio
import sys
import time
from pathlib import Path

_BACKEND_ROOT = Path(__file__).resolve().parents[1]
for p in (str(_BACKEND_ROOT), str(_BACKEND_ROOT / "packages" / "harness")):
    if p not in sys.path:
        sys.path.insert(0, p)

from langchain_core.messages import AIMessageChunk  # noqa: E402
from langchain_core.outputs import ChatGenerationChunk  # noqa: E402

from evoflow.models.vendor_roundtrip import VendorRoundtripChatMixin  # noqa: E402


class _HangingZeroByteBase:
    """模拟上游已连上但一个 chunk 都不吐。"""

    async def _astream(self, messages, stop=None, run_manager=None, **kwargs):
        await asyncio.sleep(30)
        yield ChatGenerationChunk(message=AIMessageChunk(content="never"))  # pragma: no cover


class _FastBase:
    async def _astream(self, messages, stop=None, run_manager=None, **kwargs):
        for i in range(3):
            yield ChatGenerationChunk(message=AIMessageChunk(content=f"c{i}"))


def _make_model(base_cls):
    class _FakeModel(VendorRoundtripChatMixin, base_cls):
        model_name = "fake-watchdog-model"

    return _FakeModel()


def test_first_token_watchdog_aborts_and_retries(monkeypatch):
    monkeypatch.setenv("EVOFLOW_MODEL_VENDOR_ROUNDTRIP", "0")
    monkeypatch.setenv("EVOFLOW_STREAM_FIRST_TOKEN_TIMEOUT_S", "0.15")
    monkeypatch.setenv("EVOFLOW_STREAM_RETRY_ATTEMPTS", "2")
    monkeypatch.setenv("EVOFLOW_STREAM_TOTAL_TIMEOUT_S", "300")

    model = _make_model(_HangingZeroByteBase)
    chunks: list[object] = []
    t0 = time.perf_counter()
    try:
        asyncio.run(_collect(model, chunks))
        raised = None
    except TimeoutError as e:  # asyncio.run 透传
        raised = e
    elapsed = time.perf_counter() - t0

    assert raised is not None, "零字节挂住的流应最终抛 TimeoutError"
    assert not chunks, "TTFT 看门狗路径下不应有任何 chunk 下发"
    # 两次 0.15s 预算 + 一次 2s backoff ≈ 2.3s；若看门狗未生效则会挂满 30s×2
    assert 1.0 < elapsed < 10.0, f"watchdog 应在秒级止损，实测 {elapsed:.2f}s"


def test_first_token_watchdog_does_not_fire_when_chunks_flow(monkeypatch):
    monkeypatch.setenv("EVOFLOW_MODEL_VENDOR_ROUNDTRIP", "0")
    monkeypatch.setenv("EVOFLOW_STREAM_FIRST_TOKEN_TIMEOUT_S", "0.1")
    monkeypatch.setenv("EVOFLOW_STREAM_TOTAL_TIMEOUT_S", "30")

    model = _make_model(_FastBase)
    chunks: list[object] = []
    asyncio.run(_collect(model, chunks))
    assert [getattr(c.message, "content", "") for c in chunks] == ["c0", "c1", "c2"]


async def _collect(model, chunks: list) -> None:
    async for chunk in model._astream([]):
        chunks.append(chunk)
