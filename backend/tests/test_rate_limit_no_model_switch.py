"""限流：同模型重试 3 次后回传错误，不轮换密钥、不切模型。"""

from __future__ import annotations

from types import SimpleNamespace

from langchain_core.messages import AIMessage

from evoflow.agents.middlewares.model_fallback_middleware import (
    ModelFallbackMiddleware,
    _MAX_RATE_LIMIT_RETRIES,
    _emit_model_retry_activity,
    _user_facing_error_message,
    _vendor_error_text,
)
from evoflow.error_classifier import FailoverReason, classify


class RateLimitError(Exception):
    """Named like openai.RateLimitError so _is_model_api_error accepts it."""

    status_code = 429

    def __init__(self, msg: str = "Rate limit exceeded", *, body=None, message=None):
        super().__init__(msg)
        if body is not None:
            self.body = body
        if message is not None:
            self.message = message


RateLimitError.__module__ = "openai"

_FREE_TIER_MSG = (
    "You've reached the API rate limit for free users. "
    "Upgrade to a Token Plan to unlock higher limits and continue using the API without interruption."
)


def test_classify_rate_limit_does_not_rotate_or_fallback():
    c = classify(RateLimitError())
    assert c.reason == FailoverReason.RATE_LIMIT
    assert c.retryable is True
    assert c.should_rotate_credential is False
    assert c.should_fallback_provider is False


def test_vendor_error_text_prefers_body_message():
    exc = RateLimitError(
        f"Error code: 429 - {{'error': {{'message': '{_FREE_TIER_MSG}'}}}}",
        body={"error": {"code": "", "message": _FREE_TIER_MSG, "type": "AgnesAI_error"}},
    )
    assert _vendor_error_text(exc) == _FREE_TIER_MSG
    assert _user_facing_error_message(exc) == _FREE_TIER_MSG


def test_retry_activity_detail_is_vendor_passthrough(monkeypatch):
    emitted: list[dict] = []

    def fake_emit(tid, *, kind, detail, force=False, **extra):
        emitted.append({"tid": tid, "kind": kind, "detail": detail, "force": force, **extra})

    monkeypatch.setattr(
        "evoflow.agents.middlewares.model_fallback_middleware._runtime_thread_id",
        lambda _rt: "thread-rl",
    )
    monkeypatch.setattr(
        "evoflow.observability.agent_activity_stream.emit_agent_activity",
        fake_emit,
    )
    exc = RateLimitError(
        "Error code: 429",
        body={"error": {"message": _FREE_TIER_MSG}},
    )
    _emit_model_retry_activity(
        None,
        attempt=1,
        max_attempts=3,
        reason=FailoverReason.RATE_LIMIT,
        wait_s=2.0,
        exc=exc,
    )
    assert emitted
    assert emitted[0]["kind"] == "retrying"
    assert emitted[0]["detail"] == _FREE_TIER_MSG
    assert emitted[0].get("attempt") == 1
    assert emitted[0].get("max_attempts") == 3
    assert emitted[0].get("reason") == "rate_limit"


def test_user_facing_error_passthrough_for_auth_and_billing():
    class AuthErr(Exception):
        status_code = 401

    AuthErr.__module__ = "openai"
    class BillErr(Exception):
        status_code = 402

        def __init__(self):
            super().__init__("insufficient_quota: monthly usage quota exceeded")
            self.body = {"error": {"message": "insufficient_quota: monthly usage quota exceeded"}}

    BillErr.__module__ = "openai"
    assert _user_facing_error_message(AuthErr("Invalid API key")) == "Invalid API key"
    assert "insufficient_quota" in _user_facing_error_message(BillErr())
    assert "额度已用尽" not in _user_facing_error_message(BillErr())


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
    monkeypatch.setattr(
        "evoflow.agents.middlewares.model_fallback_middleware._emit_model_error_notice_stream",
        lambda *_a, **_k: True,
    )

    calls = {"n": 0}
    vendor_msg = _FREE_TIER_MSG

    def handler(_req):
        calls["n"] += 1
        raise RateLimitError(
            f"Error code: 429 - {vendor_msg}",
            body={"error": {"message": vendor_msg}},
        )

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
    assert vendor_msg in str(out.content)
    assert "已自动重试" not in str(out.content)
    # initial + 3 retries
    assert calls["n"] == 1 + _MAX_RATE_LIMIT_RETRIES
    assert len(sleeps) == _MAX_RATE_LIMIT_RETRIES
