"""Stream-layer retry must treat vendor-generic internal errors as retriable.

Regression: "An internal error occurred" used to skip ``_is_retriable_stream_error``
(only timeout/429 matched), bubble as RUN_ERROR, and force the user to resend.
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

from evoflow.models.vendor_roundtrip import (  # noqa: E402
    VendorRoundtripChatMixin,
    _is_retriable_stream_error,
)


def test_internal_error_message_is_retriable() -> None:
    assert _is_retriable_stream_error(RuntimeError("An internal error occurred"))
    assert _is_retriable_stream_error(Exception("Internal Server Error occurred"))
    assert _is_retriable_stream_error(TimeoutError("timed out"))


def test_schema_detail_internal_error_still_retriable_by_classify() -> None:
    # Has colon detail — still SERVER_ERROR via classifier patterns
    assert _is_retriable_stream_error(
        Exception("an internal error occurred: upstream 500")
    )


class _FailThenOkBase:
    """First attempt: raise before any chunk; second: yield content."""

    calls = 0

    async def _astream(self, messages, stop=None, run_manager=None, **kwargs):
        type(self).calls += 1
        if type(self).calls == 1:
            raise RuntimeError("An internal error occurred")
        yield ChatGenerationChunk(message=AIMessageChunk(content="ok"))


def test_astream_retries_zero_chunk_internal_error(monkeypatch) -> None:
    monkeypatch.setenv("EVOFLOW_MODEL_VENDOR_ROUNDTRIP", "0")
    monkeypatch.setenv("EVOFLOW_STREAM_RETRY_ATTEMPTS", "2")
    monkeypatch.setenv("EVOFLOW_STREAM_FIRST_TOKEN_TIMEOUT_S", "0")
    monkeypatch.setenv("EVOFLOW_STREAM_TOTAL_TIMEOUT_S", "30")
    _FailThenOkBase.calls = 0

    class _FakeModel(VendorRoundtripChatMixin, _FailThenOkBase):
        model_name = "fake-internal-retry"

    model = _FakeModel()
    chunks: list[object] = []

    async def _collect() -> None:
        async for chunk in model._astream([]):
            chunks.append(chunk)

    t0 = time.perf_counter()
    asyncio.run(_collect())
    elapsed = time.perf_counter() - t0
    assert [getattr(c.message, "content", "") for c in chunks] == ["ok"]
    assert _FailThenOkBase.calls == 2
    assert elapsed < 15.0
