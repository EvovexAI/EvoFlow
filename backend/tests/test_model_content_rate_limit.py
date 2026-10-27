"""Content-as-200 rate limit: treat vendor error bodies as failures, not success."""

from __future__ import annotations

from types import SimpleNamespace

from langchain_core.messages import AIMessage

from evoflow.agents.middlewares.model_fallback_middleware import (
    ModelFallbackMiddleware,
    _MAX_RATE_LIMIT_RETRIES,
)
from evoflow.error_classifier import FailoverReason, classify_model_response_content
from evoflow.proactive.engine import ProactiveEngine
from evoflow.proactive.models import ThinkResult


_VENDOR_RATE_LIMIT = (
    "Requests are too frequent. Please reduce your request frequency, "
    "wait a short moment, and retry your request. "
    "Request id: 02179308197030591be90b70b1bfc3059428bd07e108b7e363c0f"
)


def test_classify_content_rate_limit_as_failure():
    cls = classify_model_response_content(_VENDOR_RATE_LIMIT, has_tool_calls=False)
    assert cls is not None
    assert cls.reason == FailoverReason.RATE_LIMIT
    assert cls.retryable is True


def test_classify_content_rate_limit_blocks_with_tool_calls():
    assert (
        classify_model_response_content(_VENDOR_RATE_LIMIT, has_tool_calls=True) is None
    )


def test_classify_content_does_not_false_positive_on_business_discussion():
    # Long business text that merely mentions "rate limit" must stay success.
    body = (
        "我们讨论一下客户反馈里的 rate limit 投诉：上线后要把重试间隔写成配置项，"
        "并且在任务中心展示失败原因，方便运营同学排查。另外还要补齐文档和验收用例。"
        "这一段足够长，避免被当成短错误体。"
    )
    assert classify_model_response_content(body, has_tool_calls=False) is None


def test_classify_content_accepts_list_blocks():
    cls = classify_model_response_content(
        [{"type": "text", "text": _VENDOR_RATE_LIMIT}],
        has_tool_calls=False,
    )
    assert cls is not None
    assert cls.reason == FailoverReason.RATE_LIMIT


def test_middleware_content_rate_limit_retries_then_registers_error(monkeypatch):
    mw = ModelFallbackMiddleware()
    sleeps: list[float] = []
    monkeypatch.setattr(
        "evoflow.agents.middlewares.model_fallback_middleware.time.sleep",
        lambda s: sleeps.append(s),
    )
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
    registered: list[dict] = []
    monkeypatch.setattr(
        "evoflow.agents.middlewares.model_fallback_middleware.register_model_error_turn",
        lambda tid, *, reason="", message="": registered.append(
            {"tid": tid, "reason": reason, "message": message}
        ),
    )
    monkeypatch.setattr(
        "evoflow.agents.middlewares.model_fallback_middleware._runtime_thread_id",
        lambda _rt: "thread-content-rl",
    )

    calls = {"n": 0}

    def handler(_req):
        calls["n"] += 1
        return AIMessage(content=_VENDOR_RATE_LIMIT)

    req = SimpleNamespace(runtime=None, messages=[], state={})
    out = mw.wrap_model_call(req, handler)
    assert isinstance(out, AIMessage)
    assert "too frequent" in str(out.content).lower() or "rate" in str(
        getattr(out, "response_metadata", {}).get("evoflow_error", {})
    ).lower() or registered
    # initial + 3 retries of content-as-rate-limit
    assert calls["n"] == 1 + _MAX_RATE_LIMIT_RETRIES
    assert len(sleeps) == _MAX_RATE_LIMIT_RETRIES
    assert sleeps[0] >= 25.0  # content path uses 30s base
    assert registered
    assert registered[-1]["reason"] == "rate_limit"


def test_engine_detect_provider_error_after_run_from_final_state():
    eng = ProactiveEngine.__new__(ProactiveEngine)
    err = eng._detect_provider_error_after_run(
        session_key="",
        thread_id="t-1",
        run_result={"messages": [{"role": "assistant", "content": _VENDOR_RATE_LIMIT}]},
        role_code="reviewer",
    )
    assert err is not None
    assert "rate_limit" in err


def test_think_result_carries_run_error_for_duty_finish():
    r = ThinkResult(run_error="rate_limit: Requests are too frequent")
    assert r.run_error.startswith("rate_limit")
