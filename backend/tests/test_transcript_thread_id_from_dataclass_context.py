"""Regression: assistant/tool persist must resolve thread_id from LeadAgentRuntimeContext.

2026-11-17 第36轮 transcript 专用池丢掉 contextvars 后，``_thread_id_from_runtime``
只认 dict context，活跑 dataclass 在 worker 里拿不到 thread_id → 全仓 AI/tool
停写，仅 user HTTP 仍入库。本文件钉死 dataclass 路径 + 池内 contextvars 拷贝。
"""

from __future__ import annotations

import asyncio
import contextvars
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest
from langchain_core.messages import AIMessage, ToolMessage

from evoflow.agents.lead_agent.runtime_context import LeadAgentRuntimeContext
from evoflow.agents.middlewares import transcript_middleware as tmw


def test_thread_id_from_lead_agent_dataclass_context() -> None:
    runtime = SimpleNamespace(
        context=LeadAgentRuntimeContext(
            thread_id="tid-dataclass-1",
            parent_thread_id="tid-parent",
            session_key="sk-1",
        )
    )
    assert tmw._thread_id_from_runtime(runtime) == "tid-dataclass-1"  # noqa: SLF001
    assert tmw._parent_thread_id_from_runtime(runtime) == "tid-parent"  # noqa: SLF001


def test_thread_id_without_get_config_still_reads_dataclass(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Pool worker may see empty langgraph config — dataclass must still win."""

    def _boom():
        raise RuntimeError("get_config must not be required")

    monkeypatch.setattr(
        "langgraph.config.get_config",
        _boom,
        raising=False,
    )
    # Also patch import path used inside helper if already imported
    import langgraph.config as lg_config

    monkeypatch.setattr(lg_config, "get_config", _boom, raising=True)

    runtime = SimpleNamespace(context=LeadAgentRuntimeContext(thread_id="tid-no-config"))
    assert tmw._thread_id_from_runtime(runtime) == "tid-no-config"  # noqa: SLF001


def test_private_pool_propagates_contextvars(monkeypatch: pytest.MonkeyPatch) -> None:
    """``_run_in_transcript_pool`` must copy contextvars like asyncio.to_thread."""
    var: contextvars.ContextVar[str] = contextvars.ContextVar("probe_tid")
    seen: list[str] = []

    def _worker() -> None:
        seen.append(var.get("MISSING"))

    async def _run() -> None:
        token = var.set("from-event-loop")
        try:
            await tmw._run_in_transcript_pool(_worker)  # noqa: SLF001
        finally:
            var.reset(token)

    asyncio.run(_run())
    assert seen == ["from-event-loop"]


def test_persist_messages_with_dataclass_context_calls_append(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    batches: list[tuple] = []

    monkeypatch.setattr(
        tmw,
        "_session_key_for_thread",
        lambda tid: "agent:main:probe" if tid == "tid-live" else "",
    )
    monkeypatch.setattr(
        tmw.TranscriptMiddleware,
        "_append_transcript_batch",
        staticmethod(
            lambda session_key, messages, **kwargs: batches.append(
                (session_key, messages, kwargs)
            )
        ),
    )

    runtime = SimpleNamespace(
        context=LeadAgentRuntimeContext(thread_id="tid-live", session_key="agent:main:probe")
    )
    state = {
        "messages": [
            AIMessage(content="hello from model", id="ai-1"),
        ]
    }
    tmw.TranscriptMiddleware()._persist_messages(state, runtime)  # noqa: SLF001
    assert len(batches) == 1
    assert batches[0][0] == "agent:main:probe"
    assert batches[0][1][0]["role"] == "assistant"
    assert batches[0][2].get("thread_id") == "tid-live"


def test_persist_tool_with_dataclass_context_calls_append(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    batches: list[tuple] = []
    monkeypatch.setattr(
        tmw,
        "_session_key_for_thread",
        lambda tid: "agent:main:probe" if tid == "tid-tool" else "",
    )
    monkeypatch.setattr(
        tmw.TranscriptMiddleware,
        "_append_transcript_batch",
        staticmethod(
            lambda session_key, messages, **kwargs: batches.append(
                (session_key, messages, kwargs)
            )
        ),
    )
    monkeypatch.setattr(
        tmw,
        "_persist_platform_artifact_from_tool",
        lambda *a, **k: None,
        raising=False,
    )

    runtime = SimpleNamespace(context=LeadAgentRuntimeContext(thread_id="tid-tool"))
    request = SimpleNamespace(
        runtime=runtime,
        tool_call={"name": "bash", "id": "tc-1", "args": {}},
    )
    result = ToolMessage(content="ok", tool_call_id="tc-1", name="bash", id="tool-1")
    tmw.TranscriptMiddleware()._persist_one_tool_message(request, result)  # noqa: SLF001
    assert len(batches) == 1
    assert batches[0][1][0]["role"] == "tool"
