"""Regression tests for ModelFallbackMiddleware overflow compression retry."""

from __future__ import annotations

import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

from langchain_core.messages import AIMessage, HumanMessage

from evoflow.agents.middlewares.model_fallback_middleware import (
    _RATE_LIMIT_USER_MESSAGE,
    ModelFallbackMiddleware,
    _user_friendly_message_for_error,
)
from evoflow.error_classifier import FailoverReason, classify


class _ModelApiError(Exception):
    __module__ = "openai"


class _Request:
    def __init__(self, messages: list | None = None) -> None:
        self.state = {"messages": messages or [HumanMessage(content="hi"), AIMessage(content="ok")]}
        self.runtime = SimpleNamespace(context={})

    def override(self, **kwargs):
        new = _Request(list(kwargs.get("messages") or self.state["messages"]))
        new.runtime = self.runtime
        return new


def test_is_model_api_error_recognizes_anthropic_module() -> None:
    from evoflow.agents.middlewares.model_fallback_middleware import _is_model_api_error

    class _AnthropicBadRequest(Exception):
        __module__ = "anthropic"

    assert _is_model_api_error(_AnthropicBadRequest("context length exceeded"))


def test_supervisor_phase_reraises_model_error() -> None:
    mw = ModelFallbackMiddleware()
    exc = Exception("upstream failed")
    runtime = SimpleNamespace(context={"is_task_execution": True})

    with patch(
        "evoflow.agents.middlewares.model_fallback_middleware._is_model_api_error",
        return_value=True,
    ), patch(
        "evoflow.agents.middlewares.model_fallback_middleware._should_reraise_for_supervisor",
        return_value=True,
    ):
        try:
            mw._handle_model_error(exc, runtime)
            assert False, "expected re-raise"
        except Exception as e:
            assert e is exc


def test_sync_unchanged_compression_falls_back_to_user_message() -> None:
    mw = ModelFallbackMiddleware()
    exc = _ModelApiError("context length exceeded")
    handler = MagicMock(side_effect=exc)

    with patch(
        "evoflow.agents.middlewares.model_fallback_middleware.classify",
        return_value=SimpleNamespace(
            should_compress=True,
            reason=FailoverReason.CONTEXT_OVERFLOW,
            should_rotate_credential=False,
            should_fallback_provider=False,
        ),
    ), patch(
        "evoflow.agents.middlewares.context_compaction_middleware.emergency_compress_messages",
        return_value=([HumanMessage(content="hi")], False),
    ):
        result = mw.wrap_model_call(_Request(), handler)

    assert handler.call_count == 1
    assert result.content


def test_sync_compression_retry_skips_second_compress() -> None:
    mw = ModelFallbackMiddleware()
    exc = _ModelApiError("context length exceeded")
    handler = MagicMock(side_effect=[exc, AIMessage(content="compressed ok")])

    with patch(
        "evoflow.agents.middlewares.model_fallback_middleware.classify",
        return_value=SimpleNamespace(
            should_compress=True,
            reason=FailoverReason.CONTEXT_OVERFLOW,
            should_rotate_credential=False,
            should_fallback_provider=False,
        ),
    ), patch(
        "evoflow.agents.middlewares.context_compaction_middleware.emergency_compress_messages",
        return_value=([HumanMessage(content="hi")], True),
    ) as compress_mock:
        result = mw.wrap_model_call(_Request(), handler)

    assert handler.call_count == 2
    assert compress_mock.call_count == 1
    assert result.content == "compressed ok"


def test_async_unchanged_compression_falls_back_to_user_message() -> None:
    async def _run():
        mw = ModelFallbackMiddleware()
        exc = _ModelApiError("context length exceeded")
        handler = AsyncMock(side_effect=exc)

        with patch(
            "evoflow.agents.middlewares.model_fallback_middleware.classify",
            return_value=SimpleNamespace(
            should_compress=True,
            reason=FailoverReason.CONTEXT_OVERFLOW,
            should_rotate_credential=False,
            should_fallback_provider=False,
        ),
        ), patch(
            "evoflow.agents.middlewares.context_compaction_middleware.emergency_compress_messages_async",
            new=AsyncMock(return_value=([HumanMessage(content="hi")], False)),
        ):
            return await mw.awrap_model_call(_Request(), handler)

    result = asyncio.run(_run())
    assert result.content


def test_async_compression_retry_skips_second_compress() -> None:
    async def _run():
        mw = ModelFallbackMiddleware()
        exc = _ModelApiError("context length exceeded")
        handler = AsyncMock(side_effect=[exc, AIMessage(content="compressed ok")])

        compress_mock = AsyncMock(return_value=([HumanMessage(content="hi")], True))
        with patch(
            "evoflow.agents.middlewares.model_fallback_middleware.classify",
            return_value=SimpleNamespace(
            should_compress=True,
            reason=FailoverReason.CONTEXT_OVERFLOW,
            should_rotate_credential=False,
            should_fallback_provider=False,
        ),
        ), patch(
            "evoflow.agents.middlewares.context_compaction_middleware.emergency_compress_messages_async",
            new=compress_mock,
        ):
            return await mw.awrap_model_call(_Request(), handler), handler, compress_mock

    result, handler, compress_mock = asyncio.run(_run())
    assert handler.await_count == 2
    assert compress_mock.await_count == 1
    assert result.content == "compressed ok"


class _RateLimitError(Exception):
    __module__ = "openai"

    def __init__(self, message: str = "429 rate limit") -> None:
        super().__init__(message)
        self.response = SimpleNamespace(headers={})


class _AccountQuotaError(Exception):
    __module__ = "openai"

    def __init__(self) -> None:
        super().__init__(
            "Error code: 429 - {'error': {'code': 'AccountQuotaExceeded', "
            "'message': 'You have exceeded the monthly usage quota. "
            "It will reset at 2026-07-11 23:59:59 +0800 CST. We recommend upgrading your plan.'}}"
        )
        self.response = SimpleNamespace(status_code=429, headers={})


def test_user_friendly_message_for_rate_limit() -> None:
    msg = _user_friendly_message_for_error(_RateLimitError())
    assert msg == _RATE_LIMIT_USER_MESSAGE


def test_user_friendly_message_for_account_quota() -> None:
    msg = _user_friendly_message_for_error(_AccountQuotaError())
    assert "月度额度已用尽" in msg
    assert "2026-07-11 23:59:59 +0800 CST" in msg


def test_user_friendly_message_for_five_hour_quota() -> None:
    exc = Exception(
        "Error code: 429 - {'error': {'code': 'AccountQuotaExceeded', "
        "'message': 'You have exceeded the 5-hour usage quota. "
        "It will reset at 2026-09-03 15:34:30 +0800 CST.'}}"
    )
    msg = _user_friendly_message_for_error(exc)
    assert "5小时额度已用尽" in msg
    assert "2026-09-03 15:34:30 +0800 CST" in msg


def test_handle_model_error_streams_user_notice() -> None:
    mw = ModelFallbackMiddleware()
    exc = _AccountQuotaError()
    runtime = SimpleNamespace(context={})

    with patch(
        "evoflow.agents.middlewares.model_fallback_middleware._should_reraise_for_supervisor",
        return_value=False,
    ), patch(
        "evoflow.agents.middlewares.model_fallback_middleware._emit_user_notice_stream",
    ) as stream_mock:
        result = mw._handle_model_error(exc, runtime)

    assert "月度额度已用尽" in str(result.content)
    stream_mock.assert_called_once()
    assert stream_mock.call_args[0][0] == result.content


def test_emit_user_notice_stream_prefers_gateway_inject() -> None:
    from evoflow.agents.middlewares.model_fallback_middleware import _emit_user_notice_stream

    runtime = SimpleNamespace(context={"thread_id": "thread-quota-1"})
    writer = MagicMock()
    with patch("langgraph.config.get_stream_writer", return_value=writer), patch(
        "evoflow.agents.middlewares.model_fallback_middleware._inject_user_notice_evf",
        return_value=True,
    ) as inject_mock:
        ok = _emit_user_notice_stream("当前模型 API 月度额度已用尽。", runtime)

    assert ok is True
    inject_mock.assert_called_once_with("thread-quota-1", "当前模型 API 月度额度已用尽。")
    writer.assert_not_called()


def test_emit_user_notice_stream_falls_back_to_writer_without_thread() -> None:
    from evoflow.agents.middlewares.model_fallback_middleware import _emit_user_notice_stream

    runtime = SimpleNamespace(context={})
    writer = MagicMock()
    with patch("langgraph.config.get_stream_writer", return_value=writer), patch(
        "evoflow.agents.middlewares.model_fallback_middleware._inject_user_notice_evf",
    ) as inject_mock:
        ok = _emit_user_notice_stream("当前模型 API 月度额度已用尽。", runtime)

    assert ok is True
    inject_mock.assert_not_called()
    writer.assert_called_once_with(
        {"type": "empty_response_fallback", "text": "当前模型 API 月度额度已用尽。"}
    )


def test_sync_rate_limit_retry_succeeds_on_second_attempt() -> None:
    mw = ModelFallbackMiddleware()
    exc = _RateLimitError()
    handler = MagicMock(side_effect=[exc, AIMessage(content="ok after retry")])

    rate_limit_cls = classify(exc)

    with patch(
        "evoflow.agents.middlewares.model_fallback_middleware.classify",
        return_value=rate_limit_cls,
    ), patch(
        "evoflow.agents.middlewares.model_fallback_middleware.time.sleep",
    ) as sleep_mock:
        result = mw.wrap_model_call(_Request(), handler)

    assert handler.call_count == 2
    assert sleep_mock.call_count == 1
    assert result.content == "ok after retry"


def test_sync_rate_limit_exhausted_returns_rate_limit_message() -> None:
    mw = ModelFallbackMiddleware()
    exc = _RateLimitError()
    handler = MagicMock(side_effect=exc)
    rate_limit_cls = classify(exc)

    with patch(
        "evoflow.agents.middlewares.model_fallback_middleware.classify",
        return_value=rate_limit_cls,
    ), patch(
        "evoflow.agents.middlewares.model_fallback_middleware.time.sleep",
    ), patch(
        "evoflow.agents.middlewares.model_fallback_middleware._should_reraise_for_supervisor",
        return_value=False,
    ):
        result = mw.wrap_model_call(_Request(), handler)

    assert handler.call_count == 4  # initial + 3 retries
    assert result.content == _RATE_LIMIT_USER_MESSAGE


def test_sync_overloaded_retries_three_times_and_emits_activity() -> None:
    from evoflow.agents.middlewares.model_fallback_middleware import _OVERLOADED_USER_MESSAGE

    class _OverloadedError(Exception):
        __module__ = "openai"

        def __init__(self) -> None:
            super().__init__("Our servers are currently overloaded. Please try again later.")

    mw = ModelFallbackMiddleware()
    exc = _OverloadedError()
    handler = MagicMock(side_effect=exc)
    req = _Request()
    req.runtime = SimpleNamespace(context={"thread_id": "thread-overload-1"})

    with patch(
        "evoflow.agents.middlewares.model_fallback_middleware.time.sleep",
    ) as sleep_mock, patch(
        "evoflow.agents.middlewares.model_fallback_middleware._should_reraise_for_supervisor",
        return_value=False,
    ), patch(
        "evoflow.agents.middlewares.model_fallback_middleware._emit_model_retry_activity",
    ) as retry_activity, patch(
        "evoflow.agents.middlewares.model_fallback_middleware._emit_user_notice_stream",
    ):
        result = mw.wrap_model_call(req, handler)

    assert handler.call_count == 4  # initial + 3 retries
    assert sleep_mock.call_count == 3
    assert retry_activity.call_count == 3
    assert result.content == _OVERLOADED_USER_MESSAGE


def test_sync_connection_drop_retries_three_times() -> None:
    class _RemoteProtocolError(Exception):
        __module__ = "httpx"

        def __init__(self) -> None:
            super().__init__("peer closed connection without sending complete message body")

    mw = ModelFallbackMiddleware()
    exc = _RemoteProtocolError()
    handler = MagicMock(side_effect=[exc, exc, AIMessage(content="ok after reconnect")])
    req = _Request()
    req.runtime = SimpleNamespace(context={"thread_id": "thread-relay-1"})

    with patch(
        "evoflow.agents.middlewares.model_fallback_middleware.time.sleep",
    ) as sleep_mock, patch(
        "evoflow.agents.middlewares.model_fallback_middleware._emit_model_retry_activity",
    ) as retry_activity:
        result = mw.wrap_model_call(req, handler)

    assert handler.call_count == 3
    assert sleep_mock.call_count == 2
    assert retry_activity.call_count == 2
    assert result.content == "ok after reconnect"


def test_sync_unknown_api_error_also_retries() -> None:
    """Opaque mid-proxy APIError should still get transient retries."""
    mw = ModelFallbackMiddleware()
    exc = _ModelApiError("upstream gateway glitch")
    handler = MagicMock(side_effect=[exc, AIMessage(content="recovered")])
    req = _Request()
    req.runtime = SimpleNamespace(context={"thread_id": "thread-unknown-1"})

    with patch(
        "evoflow.agents.middlewares.model_fallback_middleware.time.sleep",
    ), patch(
        "evoflow.agents.middlewares.model_fallback_middleware._emit_model_retry_activity",
    ) as retry_activity:
        result = mw.wrap_model_call(req, handler)

    assert handler.call_count == 2
    assert retry_activity.call_count == 1
    assert result.content == "recovered"


def test_ark_image_token_overflow_strips_vision_and_retries() -> None:
    """Single-turn multimodal overflow must strip images even when fold is a no-op."""
    mw = ModelFallbackMiddleware()
    exc = _ModelApiError(
        "Error code: 400 - {'error': {'code': 'InvalidParameter', 'message': "
        "'Total tokens of image and text exceed max message tokens.'}}"
    )
    huge_b64 = "A" * 8000
    vision_msg = HumanMessage(
        content=[
            {"type": "text", "text": "look"},
            {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{huge_b64}"}},
        ]
    )
    req = _Request(messages=[vision_msg])
    handler = MagicMock(side_effect=[exc, AIMessage(content="ok without image")])

    with patch(
        "evoflow.agents.middlewares.context_compaction_middleware.emergency_compress_messages",
        return_value=([vision_msg], False),
    ), patch(
        "evoflow.agents.middlewares.model_fallback_middleware._emit_model_retry_activity",
    ), patch(
        "evoflow.agents.middlewares.context_compaction_middleware.mark_skip_compaction_once",
    ) as skip_mock:
        result = mw.wrap_model_call(req, handler)

    assert handler.call_count == 2
    assert result.content == "ok without image"
    retry_req = handler.call_args_list[1].args[0]
    retry_msgs = retry_req.state["messages"] if not getattr(retry_req, "messages", None) else retry_req.messages
    # _Request.override puts messages into state; ensure image block was dropped.
    content = retry_msgs[0].content
    assert isinstance(content, list)
    assert not any(isinstance(b, dict) and b.get("type") == "image_url" for b in content)
    assert skip_mock.called


def test_truncate_overflow_short_thread_with_huge_tool_payload() -> None:
    from evoflow.agents.middlewares.model_fallback_middleware import _truncate_messages_for_overflow
    from langchain_core.messages import ToolMessage

    msgs = [
        HumanMessage(content="q"),
        AIMessage(content="thinking"),
        ToolMessage(content="X" * 50_000, tool_call_id="t1"),
    ]
    folded, changed = _truncate_messages_for_overflow(msgs, keep_tail=8)
    assert changed
    tool = next(m for m in folded if isinstance(m, ToolMessage))
    assert len(str(tool.content)) < 50_000


def test_messages_from_request_prefers_request_messages() -> None:
    mw = ModelFallbackMiddleware()
    state_msgs = [HumanMessage(content="state"), AIMessage(content="old")]
    req_msgs = [HumanMessage(content="bound"), AIMessage(content="fresh")]
    req = _Request(messages=state_msgs)
    req.messages = req_msgs
    assert [m.content for m in mw._messages_from_request(req)] == ["bound", "fresh"]


def test_context_window_overflow_message_triggers_compress_retry() -> None:
    mw = ModelFallbackMiddleware()
    exc = _ModelApiError(
        "Your input exceeds the context window of this model. Please adjust your input and try again."
    )
    handler = MagicMock(side_effect=[exc, AIMessage(content="ok after compress")])
    req = _Request()
    req.runtime = SimpleNamespace(context={"thread_id": "thread-overflow-1"})

    with patch(
        "evoflow.agents.middlewares.context_compaction_middleware.emergency_compress_messages",
        return_value=([HumanMessage(content="hi")], True),
    ) as compress_mock, patch(
        "evoflow.agents.middlewares.model_fallback_middleware._emit_model_retry_activity",
    ) as retry_activity:
        result = mw.wrap_model_call(req, handler)

    assert compress_mock.call_count == 1
    assert handler.call_count == 2
    assert retry_activity.call_count == 1
    assert result.content == "ok after compress"


def test_async_rate_limit_retry_succeeds_on_second_attempt() -> None:
    async def _run():
        mw = ModelFallbackMiddleware()
        exc = _RateLimitError()
        handler = AsyncMock(side_effect=[exc, AIMessage(content="ok after retry")])
        rate_limit_cls = classify(exc)

        with patch(
            "evoflow.agents.middlewares.model_fallback_middleware.classify",
            return_value=rate_limit_cls,
        ), patch(
            "evoflow.agents.middlewares.model_fallback_middleware.asyncio.sleep",
            new=AsyncMock(),
        ) as sleep_mock:
            return await mw.awrap_model_call(_Request(), handler), handler, sleep_mock

    result, handler, sleep_mock = asyncio.run(_run())
    assert handler.await_count == 2
    assert sleep_mock.await_count == 1
    assert result.content == "ok after retry"


def test_is_empty_ai_response_unwraps_model_response() -> None:
    from langchain.agents.middleware.types import ModelResponse

    from evoflow.agents.middlewares.model_fallback_middleware import _is_empty_ai_response

    assert _is_empty_ai_response(ModelResponse(result=[AIMessage(content="")]))
    assert not _is_empty_ai_response(ModelResponse(result=[AIMessage(content="hello")]))


def test_is_empty_ai_response_treats_reasoning_as_non_empty() -> None:
    from evoflow.agents.middlewares.model_fallback_middleware import _is_empty_ai_response

    msg = AIMessage(content="", additional_kwargs={"reasoning_content": "thinking step"})
    assert not _is_empty_ai_response(msg)


def test_empty_response_injects_fallback_after_internal_retry() -> None:
    from evoflow.agents.middlewares.model_fallback_middleware import (
        ModelFallbackMiddleware,
        _empty_response_user_fallback_message,
    )

    mw = ModelFallbackMiddleware()
    empty = AIMessage(content="")
    handler = MagicMock(return_value=empty)

    result = mw.wrap_model_call(_Request(), handler, empty_retry_attempt=0)

    assert handler.call_count == 2
    assert _empty_response_user_fallback_message() in str(getattr(result, "content", "") or "")


def test_thinking_truncated_injects_user_notice() -> None:
    from evoflow.agents.middlewares.model_fallback_middleware import (
        ModelFallbackMiddleware,
        _thinking_truncated_user_notice,
    )

    msg = AIMessage(
        content="",
        additional_kwargs={"reasoning_content": "planning the port..."},
        usage_metadata={"input_tokens": 1, "output_tokens": 16384, "total_tokens": 16385},
    )
    mw = ModelFallbackMiddleware()
    handler = MagicMock(return_value=msg)
    result = mw.wrap_model_call(_Request(), handler)
    assert handler.call_count == 1
    assert _thinking_truncated_user_notice() in str(getattr(result, "content", "") or "")


def test_empty_response_injects_fallback_after_retry() -> None:
    from langchain.agents.middleware.types import ModelResponse

    from evoflow.agents.middlewares.model_fallback_middleware import (
        ModelFallbackMiddleware,
        _empty_response_user_fallback_message,
    )

    mw = ModelFallbackMiddleware()
    empty = ModelResponse(result=[AIMessage(content="")])
    handler = MagicMock(return_value=empty)

    result = mw.wrap_model_call(_Request(), handler, empty_retry_attempt=1)

    assert handler.call_count == 1
    assert _empty_response_user_fallback_message() in str(getattr(result, "content", "") or "")
