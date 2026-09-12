"""Guardrails when sync generate paths leak coroutines."""

from __future__ import annotations

import asyncio

import pytest
from langchain_core.outputs import ChatGeneration, ChatResult
from langchain_core.messages import AIMessage

from evoflow.models.vendor_roundtrip import _ensure_chat_result, _serialize_chat_result


async def _fake_chat_result_coro() -> ChatResult:
    return ChatResult(generations=[ChatGeneration(message=AIMessage(content="ok"))])


def test_ensure_chat_result_passes_through_chat_result() -> None:
    cr = ChatResult(generations=[ChatGeneration(message=AIMessage(content="ok"))])
    assert _ensure_chat_result(cr) is cr


def test_ensure_chat_result_resolves_coroutine_without_running_loop() -> None:
    out = _ensure_chat_result(_fake_chat_result_coro())
    assert out.generations[0].message.content == "ok"


def test_ensure_chat_result_rejects_coroutine_on_running_loop() -> None:
    async def _run() -> None:
        with pytest.raises(TypeError, match="ainvoke"):
            _ensure_chat_result(_fake_chat_result_coro())

    asyncio.run(_run())


def test_serialize_chat_result_rejects_coroutine() -> None:
    with pytest.raises(TypeError, match="ainvoke"):
        _serialize_chat_result(_fake_chat_result_coro())  # type: ignore[arg-type]
