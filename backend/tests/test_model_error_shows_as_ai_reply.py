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


def test_emit_notice_prefers_stream_writer_model_error():
    """wrap_model_call 内必须走 writer；inject 假成功会导致只有活动条、无正文。"""
    written: list[dict] = []

    class _W:
        def __call__(self, payload):
            written.append(payload)

    with (
        patch(
            "evoflow.agents.middlewares.model_fallback_middleware._runtime_thread_id",
            return_value="thread-live",
        ),
        patch(
            "evoflow.agents.middlewares.model_fallback_middleware._inject_model_error_evf",
            return_value=True,
        ) as inject,
        patch("langgraph.config.get_stream_writer", return_value=_W()),
    ):
        ok = _emit_model_error_notice_stream("限流失败文案", runtime=None, reason="rate_limit")
    assert ok is True
    assert written and written[0].get("type") == "model_error"
    assert written[0].get("text") == "限流失败文案"
    inject.assert_not_called()


def test_emit_notice_falls_back_to_inject_when_no_writer():
    with (
        patch(
            "evoflow.agents.middlewares.model_fallback_middleware._runtime_thread_id",
            return_value="thread-live",
        ),
        patch("langgraph.config.get_stream_writer", return_value=None),
        patch(
            "evoflow.agents.middlewares.model_fallback_middleware._inject_model_error_evf",
            return_value=True,
        ) as inject,
        patch(
            "evoflow.observability.agent_activity_stream.emit_agent_activity",
        ) as activity,
    ):
        ok = _emit_model_error_notice_stream("鉴权失败文案", runtime=None, reason="auth")
    assert ok is True
    inject.assert_called_once()
    activity.assert_called_once()


def test_auth_classify_reason():
    c = classify(AuthenticationError())
    assert c.reason == FailoverReason.AUTH


def test_model_error_custom_emits_body_text_not_plan_text():
    """writer model_error 必须落 body_text，避免被标成 plan_text 后前端当规划块丢掉。"""
    from app.gateway.sse_ui_normalize import UiStreamNormalizer

    norm = UiStreamNormalizer(thread_id="thread-test", anchored=True)
    out = norm._on_custom(
        {
            "type": "model_error",
            "text": "当前模型 API 额度已用尽",
            "error": "当前模型 API 额度已用尽",
            "reason": "billing",
        }
    )
    deltas = [x for x in out if isinstance(x, dict) and x.get("type") == "delta"]
    assert deltas, out
    assert deltas[0].get("block_kind") == "body_text"
    assert "额度" in str(deltas[0].get("text") or "")
    acts = [x for x in out if isinstance(x, dict) and x.get("type") == "activity"]
    assert any(a.get("kind") == "model_error" for a in acts)
    # 失败正文必须立刻 block_close，否则 TEXT_MESSAGE_END 拖到 RUN_FINISHED
    closes = [x for x in out if isinstance(x, dict) and x.get("type") == "block_close"]
    assert closes, out


def test_billing_quota_does_not_rotate_or_fallback():
    """月度额度用尽不得轮换密钥/切模型（否则空转重试，面板假死）。"""
    exc = Exception(
        "当前模型 API 月度额度已用尽，无法继续生成回复。"
        " We recommend upgrading your plan for more quota"
    )
    c = classify(exc)
    assert c.reason == FailoverReason.BILLING
    assert c.retryable is False
    assert c.should_rotate_credential is False
    assert c.should_fallback_provider is False
