"""ThinkingContextGuardMiddleware disables thinking on large contexts."""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import MagicMock

from langchain_core.messages import HumanMessage

from evoflow.agents.middlewares.thinking_context_guard_middleware import (
    ThinkingContextGuardMiddleware,
    _maybe_guard_request,
    thinking_disable_gate_tokens,
)


class _Request:
    def __init__(self, messages: list | None = None, *, thinking_enabled: bool = True) -> None:
        self.state = {"messages": messages or [HumanMessage(content="hi")]}
        self.messages = None
        self.model = MagicMock()
        self.model.bind = MagicMock(side_effect=lambda **kw: MagicMock(name="bound"))
        self.runtime = SimpleNamespace(
            context={
                "thinking_enabled": thinking_enabled,
                "model_name": "glm-5.2",
                "thread_id": "t-test",
            }
        )

    def override(self, **kwargs):
        new = _Request(list(self.state["messages"]))
        new.runtime = self.runtime
        if "model" in kwargs:
            new.model = kwargs["model"]
        return new


def test_guard_skips_when_thinking_disabled() -> None:
    req = _Request(thinking_enabled=False)
    out = _maybe_guard_request(req)
    assert out is req
    req.model.bind.assert_not_called()


def test_guard_binds_when_gate_exceeds_threshold(monkeypatch) -> None:
    monkeypatch.setenv("EVOFLOW_THINKING_DISABLE_GATE_TOKENS", "1000")
    assert thinking_disable_gate_tokens() == 1000
    long_text = "word " * 5000
    req = _Request([HumanMessage(content=long_text)])
    out = _maybe_guard_request(req)
    assert out is not req
    req.model.bind.assert_called_once()


def test_middleware_delegates_to_handler() -> None:
    mw = ThinkingContextGuardMiddleware()
    req = _Request(thinking_enabled=False)
    handler = MagicMock(return_value="ok")
    assert mw.wrap_model_call(req, handler) == "ok"
    handler.assert_called_once()
