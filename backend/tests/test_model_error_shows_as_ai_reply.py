"""模型调用失败必须以 AI 回复正文推到前端（delta），不能只发 RUN_ERROR。"""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import patch

from langchain_core.messages import AIMessage

from evoflow.agents.middlewares.model_fallback_middleware import (
    ModelFallbackMiddleware,
    _emit_model_error_notice_stream,
    _inject_model_error_evf,
)
from evoflow.error_classifier import FailoverReason, classify


class AuthenticationError(Exception):
    status_code = 401

    def __init__(self, msg: str = "Invalid API key"):
        super().__init__(msg)


AuthenticationError.__module__ = "openai"


def test_inject_model_error_uses_delta_not_error_frame():
    captured: list[dict] = []

    def fake_schedule(tid: str, payload: dict) -> None:
        captured.append(dict(payload))

    with (
        patch(
            "evoflow.runtime.ports.middle_layer_covers_thread",
            return_value=True,
        ),
        patch(
            "evoflow.runtime.ports.schedule_inject_evf_frame",
            side_effect=fake_schedule,
        ),
    ):
        ok = _inject_model_error_evf("thread-abc", "模型 API 认证失败", reason="auth")
    assert ok is True
    types = [p.get("type") for p in captured]
    assert "delta" in types
    assert "block_close" in types
    assert "error" not in types
    delta = next(p for p in captured if p.get("type") == "delta")
    assert delta.get("text") == "模型 API 认证失败"
    assert delta.get("block_kind") == "body_text"


def test_handle_model_error_returns_aimessage_even_for_supervisor():
    mw = ModelFallbackMiddleware()
    with (
        patch(
            "evoflow.agents.middlewares.model_fallback_middleware._log_model_error",
        ),
        patch(
            "evoflow.agents.middlewares.model_fallback_middleware._should_reraise_for_supervisor",
            return_value=True,
        ),
        patch(
            "evoflow.agents.middlewares.model_fallback_middleware._resolve_failed_model_name",
            return_value="gpt-test",
        ),
        patch(
            "evoflow.agents.middlewares.model_fallback_middleware._mark_model_unavailable_for_error",
        ),
        patch(
            "evoflow.agents.middlewares.model_fallback_middleware._emit_model_error_notice_stream",
            return_value=True,
        ) as emit,
        patch(
            "evoflow.agents.middlewares.model_fallback_middleware.register_model_error_turn",
        ),
    ):
        out = mw._handle_model_error(AuthenticationError(), runtime=None)
    assert isinstance(out, AIMessage)
    assert "认证" in str(out.content) or "失败" in str(out.content)
    assert out.response_metadata.get("evoflow_error", {}).get("reason") == FailoverReason.AUTH.value
    emit.assert_called_once()


def test_emit_notice_falls_back_to_empty_response_writer():
    written: list[dict] = []

    class _W:
        def __call__(self, payload):
            written.append(payload)

    with (
        patch(
            "evoflow.agents.middlewares.model_fallback_middleware._runtime_thread_id",
            return_value=None,
        ),
        patch("langgraph.config.get_stream_writer", return_value=_W()),
    ):
        ok = _emit_model_error_notice_stream("限流失败文案", runtime=None, reason="rate_limit")
    assert ok is True
    assert written and written[0].get("type") == "empty_response_fallback"
    assert written[0].get("text") == "限流失败文案"


def test_auth_classify_reason():
    c = classify(AuthenticationError())
    assert c.reason == FailoverReason.AUTH
