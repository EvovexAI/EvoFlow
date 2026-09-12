"""web_fetch structured error hints."""

from __future__ import annotations

from evoflow.community.web_fetch_errors import format_web_fetch_http_error, format_web_fetch_url_error


def test_http_403_includes_hint():
    msg = format_web_fetch_http_error("https://openai.com/x", 403, "Forbidden")
    assert "403" in msg
    assert "Hint:" in msg
    assert "retry" in msg.lower()


def test_url_error_connection_hint():
    msg = format_web_fetch_url_error("https://example.com", "[WinError 10053] connection aborted")
    assert "Hint:" in msg
    assert "10053" in msg or "Connection" in msg or "connection" in msg
