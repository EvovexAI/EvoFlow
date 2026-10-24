"""限流：同模型重试 3 次后回传错误，不轮换密钥、不切模型。"""

from __future__ import annotations

from types import SimpleNamespace

from langchain_core.messages import AIMessage

from evoflow.agents.middlewares.model_fallback_middleware import (
    ModelFallbackMiddleware,
    _MAX_RATE_LIMIT_RETRIES,
    _RATE_LIMIT_USER_MESSAGE,
)
from evoflow.error_classifier import FailoverReason, classify


class RateLimitError(Exception):
    """Named like openai.RateLimitError so _is_model_api_error accepts it."""

    status_code = 429

    def __init__(self, msg: str = "Rate limit exceeded"):
        super().__init__(msg)


RateLimitError.__module__ = "openai"


def test_classify_rate_limit_does_not_rotate_or_fallback():
    c = classify(RateLimitError())
    assert c.reason == FailoverReason.RATE_LIMIT
    assert c.retryable is True
    assert c.should_rotate_credential is False
    assert c.should_fallback_provider is False


def test_rate_limit_retries_then_returns_user_message(monkeypatch):
    mw = ModelFallbackMiddleware()
    sleeps: list[float] = []
    monkeypatch.setattr(
        "evoflow.agents.middlewares.model_fallback_middleware.time.sleep",
        lambda s: sleeps.append(s),
    )
    # Avoid side-channel inject noise in unit test.
    monkeypatch.setattr(
        "evoflow.agents.middlewares.model_fallback_middleware._emit_user_notice_stream",
        lambda *_a, **_k: True,
    )
    monkeypatch.setattr(
        "evoflow.agents.middlewares.model_fallback_middleware._emit_model_retry_activity",
        lambda *_a, **_k: None,
    )
    monkeypatch.setattr(
        "evoflow.agents.middlewares.model_fallback_middleware._log_model_error",
        lambda *_a, **_k: None,
    )
    monkeypatch.setattr(
        "evoflow.agents.middlewares.model_fallback_middleware._should_reraise_for_supervisor",
        lambda *_a, **_k: False,
    )
    monkeypatch.setattr(
        "evoflow.agents.middlewares.model_fallback_middleware._resolve_failed_model_name",
        lambda *_a, **_k: "test-model",
    )
    monkeypatch.setattr(
        "evoflow.agents.middlewares.model_fallback_middleware._mark_model_unavailable_for_error",
        lambda *_a, **_k: None,
    )

    calls = {"n": 0}

    def handler(_req):
        calls["n"] += 1
        raise RateLimitError()

    req = SimpleNamespace(runtime=None, messages=[], state={})
    # Credential/fallback path must not be entered — patch to explode if called.
    monkeypatch.setattr(
        mw,
        "_try_credential_rotation_or_fallback",
        lambda *_a, **_k: (_ for _ in ()).throw(AssertionError("must not switch on rate limit")),
    )
    monkeypatch.setattr(
        mw,
        "_try_server_error_retry",
        lambda *_a, **_k: (_ for _ in ()).throw(AssertionError("must not server-retry rate limit")),
    )

    out = mw.wrap_model_call(req, handler)
    assert isinstance(out, AIMessage)
    assert "限流" in str(out.content)
    assert _RATE_LIMIT_USER_MESSAGE.split("。")[0] in str(out.content) or "已自动重试" in str(out.content)
    # initial + 3 retries
    assert calls["n"] == 1 + _MAX_RATE_LIMIT_RETRIES
    assert len(sleeps) == _MAX_RATE_LIMIT_RETRIES
