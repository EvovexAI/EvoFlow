"""ASR auth fatal: stop rebuild storm + surface friendly error."""

from __future__ import annotations

from app.gateway.speech.runtime.asr_errors import (
    asr_auth_error_user_message,
    is_asr_auth_error,
)


def test_is_asr_auth_error_detects_volc_401():
    msg = (
        "ASR protocol error: {'error': 'acquire failed err:call ark get status code:401 "
        "code:AuthenticationError message:The API key or AK/SK in the request is missing or invalid.'}"
    )
    assert is_asr_auth_error(msg) is True


def test_is_asr_auth_error_ignores_transient():
    assert is_asr_auth_error("no running event loop") is False
    assert is_asr_auth_error("timeout waiting for transcript") is False
    assert is_asr_auth_error("") is False


def test_asr_auth_error_user_message_points_to_settings():
    text = asr_auth_error_user_message()
    assert "401" in text
    assert "设置" in text
