"""Regression tests for API error classification."""

from __future__ import annotations

from evoflow.error_classifier import FailoverReason, classify


class _StatusError(Exception):
    def __init__(self, message: str, status_code: int) -> None:
        super().__init__(message)
        self.status_code = status_code


def test_404_endpoint_not_found_is_not_model_not_found() -> None:
    result = classify(_StatusError("endpoint not found", 404))
    assert result.reason != FailoverReason.MODEL_NOT_FOUND
    assert result.should_fallback_provider is False


def test_404_model_not_found_triggers_provider_fallback() -> None:
    result = classify(_StatusError("model foo not found", 404))
    assert result.reason == FailoverReason.MODEL_NOT_FOUND
    assert result.should_fallback_provider is True


def test_model_not_found_pattern_without_status_code() -> None:
    result = classify(Exception("The requested model gpt-5 does not exist"))
    assert result.reason == FailoverReason.MODEL_NOT_FOUND
    assert result.should_fallback_provider is True


def test_context_overflow_without_status_code_triggers_compress() -> None:
    result = classify(Exception("context length exceeded: reduce your prompt"))
    assert result.should_compress is True
    assert result.reason.name == "CONTEXT_OVERFLOW"


def test_context_window_exceeded_message_triggers_compress() -> None:
    """OpenAI-style wording used by several gateways (not 'context length')."""
    result = classify(
        Exception(
            "Your input exceeds the context window of this model. "
            "Please adjust your input and try again."
        )
    )
    assert result.should_compress is True
    assert result.reason == FailoverReason.CONTEXT_OVERFLOW


def test_overloaded_message_is_retryable() -> None:
    result = classify(Exception("Our servers are currently overloaded. Please try again later."))
    assert result.reason == FailoverReason.OVERLOADED
    assert result.retryable is True


def test_relay_disconnect_patterns_are_connection_errors() -> None:
    samples = [
        Exception("peer closed connection without sending complete message body"),
        Exception("RemoteProtocolError: incomplete chunked read"),
        Exception("Server disconnected without sending a response."),
        Exception("SSL: UNEXPECTED_EOF while reading"),
        Exception("Error communicating with OpenAI: Connection reset by peer"),
        Exception("网络连接中断，请稍后重试"),
    ]
    for exc in samples:
        result = classify(exc)
        assert result.reason == FailoverReason.CONNECTION_ERROR, exc
        assert result.retryable is True


def test_httpx_remote_protocol_error_class_is_connection() -> None:
    class RemoteProtocolError(Exception):
        pass

    result = classify(RemoteProtocolError("stream ended"))
    assert result.reason == FailoverReason.CONNECTION_ERROR


def test_context_overflow_with_400_still_classifies() -> None:
    result = classify(_StatusError("maximum context length exceeded", 400))
    assert result.should_compress is True


def test_max_bytes_request_body_triggers_payload_compress() -> None:
    """Provider 6MB body limit must compress+retry, not hard-fail as unknown 400."""
    msg = (
        "Error code: 400 - {'error': {'message': "
        "'Exceeded limit on max bytes to request body : 6291456', "
        "'type': 'invalid_request_error'}}"
    )
    result = classify(_StatusError(msg, 400))
    assert result.should_compress is True
    assert result.reason == FailoverReason.PAYLOAD_TOO_LARGE
    assert result.retryable is True


def test_v1404beta_does_not_trigger_model_not_found() -> None:
    result = classify(Exception("Using v1.404beta preview endpoint"))
    assert result.reason != FailoverReason.MODEL_NOT_FOUND


def test_httpx_read_timeout_classified_as_timeout() -> None:
    import httpx

    result = classify(httpx.ReadTimeout(""))
    assert result.reason == FailoverReason.TIMEOUT
    assert result.retryable is True


def test_account_quota_exceeded_is_billing_not_rate_limit() -> None:
    exc = Exception(
        "Error code: 429 - {'error': {'code': 'AccountQuotaExceeded', "
        "'message': 'You have exceeded the monthly usage quota. "
        "It will reset at 2026-07-11 23:59:59 +0800 CST.'}}"
    )
    result = classify(exc)
    assert result.reason == FailoverReason.BILLING
    assert result.retryable is False
    assert result.should_rotate_credential is False
    assert result.should_fallback_provider is True


def test_set_limit_exceeded_is_rate_limit_retryable() -> None:
    exc = Exception(
        "Error code: 429 - {'error': {'code': 'SetLimitExceeded', "
        "'message': 'Your account [2130697331] has reached the set inference "
        "limit for the [deepseek-v4-flash] model, and the model service "
        "is temporarily unavailable.'}}"
    )
    result = classify(exc)
    assert result.reason == FailoverReason.RATE_LIMIT
    assert result.retryable is True


def test_ark_image_text_token_exceed_is_overflow_not_auth() -> None:
    """Volcengine Ark 400 InvalidParameter + tokens must compress, not exhaust API key."""
    msg = (
        "Error code: 400 - {'error': {'code': 'InvalidParameter', 'message': "
        "'Total tokens of image and text exceed max message tokens. "
        "Request id: 021786237984403c14bc3c844fed6d85948b6b35dcf073d2d8cf0', "
        "'param': '', 'type': 'BadRequest'}}"
    )
    result = classify(_StatusError(msg, 400))
    assert result.reason == FailoverReason.CONTEXT_OVERFLOW
    assert result.should_compress is True
    assert result.should_rotate_credential is False
