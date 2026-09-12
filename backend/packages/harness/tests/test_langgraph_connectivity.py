"""Tests for LangGraph HTTP connectivity helpers."""

from __future__ import annotations

import pytest

from evoflow.langgraph_connectivity import is_langgraph_connect_error


class _FakeHttpxConnectError(Exception):
    pass


_FakeHttpxConnectError.__module__ = "httpx"


def test_is_langgraph_connect_error_httpx():
    assert is_langgraph_connect_error(_FakeHttpxConnectError("All connection attempts failed"))


def test_is_langgraph_connect_error_message_tokens():
    assert is_langgraph_connect_error(ConnectionError("connection refused"))


def test_is_langgraph_connect_error_negative():
    assert not is_langgraph_connect_error(ValueError("bad request"))


@pytest.mark.asyncio
async def test_create_langgraph_thread_retries_on_connect_error(monkeypatch):
    from evoflow import langgraph_connectivity as mod

    calls = {"n": 0}

    class _Threads:
        async def create(self, *, metadata=None):
            calls["n"] += 1
            if calls["n"] < 2:
                raise _FakeHttpxConnectError("All connection attempts failed")
            return {"thread_id": "t-1", "metadata": metadata or {}}

    class _Client:
        threads = _Threads()

    async def _noop_sleep(*_a, **_k):
        return None

    monkeypatch.setattr(mod.asyncio, "sleep", _noop_sleep)
    out = await mod.create_langgraph_thread(_Client(), metadata={"source": "test"}, attempts=3)
    assert out["thread_id"] == "t-1"
    assert calls["n"] == 2
