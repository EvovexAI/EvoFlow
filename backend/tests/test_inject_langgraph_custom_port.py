"""ports.inject_langgraph_custom must await the Gateway async adapter.

Regression: sync wrapper did ``bool(async_impl(...))`` → callers ``await True``
raised TypeError and flooded ``/api/events/internal/inject-custom`` with 500s
on packaged desktop (``EVOFLOW_GATEWAY_PROCESS=1``).
"""

from __future__ import annotations

import pytest


@pytest.mark.asyncio
async def test_inject_langgraph_custom_port_awaits_async_impl(monkeypatch: pytest.MonkeyPatch) -> None:
    from evoflow.runtime import ports

    called: list[tuple[str, dict]] = []

    async def _fake(thread_id: str, data: dict) -> bool:
        called.append((thread_id, data))
        return True

    ports.register("stream_inject.inject_langgraph_custom", _fake)
    try:
        ok = await ports.inject_langgraph_custom("tid-1", {"type": "task_running"})
        assert ok is True
        assert called == [("tid-1", {"type": "task_running"})]
    finally:
        ports.unregister("stream_inject.inject_langgraph_custom")


@pytest.mark.asyncio
async def test_inject_langgraph_custom_port_missing_impl() -> None:
    from evoflow.runtime import ports

    ports.unregister("stream_inject.inject_langgraph_custom")
    assert await ports.inject_langgraph_custom("tid", {"type": "x"}) is False


@pytest.mark.asyncio
async def test_inject_collab_subtask_no_http_recurse_on_gateway(monkeypatch: pytest.MonkeyPatch) -> None:
    """When already on Gateway, failure must not POST back to inject-custom."""
    from evoflow.collab import sse_notify

    monkeypatch.setenv("EVOFLOW_GATEWAY_PROCESS", "1")
    monkeypatch.setattr(sse_notify, "_resolve_lead_thread_id", lambda _mid: "lead-tid")

    async def _noop_broadcast(*_a, **_k):
        return None

    monkeypatch.setattr(
        "evoflow.collab.ws_notify.broadcast_subtask_stream_payload",
        _noop_broadcast,
        raising=False,
    )

    http_calls: list[object] = []

    class _BoomClient:
        def __init__(self, *a, **k):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

        async def post(self, *a, **k):
            http_calls.append((a, k))
            raise AssertionError("must not HTTP-recurse on gateway host")

    monkeypatch.setattr(sse_notify, "_internal_events_secret", lambda: "secret")

    async def _fail(_tid: str, _data: dict) -> bool:
        raise RuntimeError("inject boom")

    from evoflow.runtime import ports

    ports.register("stream_inject.inject_langgraph_custom", _fail)
    try:
        import httpx

        monkeypatch.setattr(httpx, "AsyncClient", _BoomClient)
        ok = await sse_notify.inject_collab_subtask_custom("main-1", {"type": "task_started"})
        assert ok is False
        assert http_calls == []
    finally:
        ports.unregister("stream_inject.inject_langgraph_custom")
