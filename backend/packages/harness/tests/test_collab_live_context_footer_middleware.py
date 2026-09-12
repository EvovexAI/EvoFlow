"""Tests for CollabThreadLiveContextFooterMiddleware (message-tail injection)."""

from __future__ import annotations

from unittest.mock import MagicMock, patch

from langchain.agents.middleware.types import ModelRequest
from langchain_core.messages import HumanMessage, SystemMessage

from evoflow.agents.middlewares.collab_thread_live_context_footer_middleware import (
    CollabThreadLiveContextFooterMiddleware,
)


def _minimal_request(*, thread_id: str = "t-live", messages: list | None = None) -> ModelRequest:
    runtime = MagicMock()
    runtime.context = {"thread_id": thread_id, "collab_phase": "executing"}
    msgs = messages or [HumanMessage(content="go")]
    return ModelRequest(
        model=MagicMock(),
        messages=msgs,
        system_message=SystemMessage(content="base\n<evoflow_live_collab_meta>x</evoflow_live_collab_meta>"),
        tool_choice=None,
        tools=[],
        response_format=None,
        state={"messages": msgs},
        runtime=runtime,
        model_settings={},
    )


@patch(
    "evoflow.agents.middlewares.collab_thread_live_context_footer_middleware._should_append_live_collab_footer",
    return_value=True,
)
@patch(
    "evoflow.agents.lead_agent.prompt.build_thread_live_context_appendix",
    return_value="<evoflow_live_collab_meta>live</evoflow_live_collab_meta>",
)
def test_injects_human_message_at_tail(_appendix: MagicMock, _should: MagicMock) -> None:
    mw = CollabThreadLiveContextFooterMiddleware()
    req = _minimal_request()
    out = mw._patch_request(req)
    msgs = list(out.messages or [])
    assert len(msgs) == 2
    assert isinstance(msgs[-1], HumanMessage)
    assert getattr(msgs[-1], "name", None) == "session_collab_live"
    assert "<evoflow_live_collab_meta>" in str(msgs[-1].content)
    sm = out.system_message
    assert sm is not None
    assert "<evoflow_live_collab_meta>" not in str(sm.content)


@patch(
    "evoflow.agents.middlewares.collab_thread_live_context_footer_middleware._should_append_live_collab_footer",
    return_value=False,
)
def test_chat_mode_strips_stale_footer_only(_should: MagicMock) -> None:
    mw = CollabThreadLiveContextFooterMiddleware()
    req = _minimal_request()
    out = mw._patch_request(req)
    sm = out.system_message
    assert sm is not None
    assert "<evoflow_live_collab_meta>" not in str(sm.content)
    assert len(list(out.messages or [])) == 1
