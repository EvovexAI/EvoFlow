"""Utf8CharsetMiddleware / ensure_content_type_charset_utf8."""

from __future__ import annotations

from app.gateway.middleware import ensure_content_type_charset_utf8


def test_json_gets_charset() -> None:
    assert ensure_content_type_charset_utf8(b"application/json") == b"application/json; charset=utf-8"


def test_event_stream_gets_charset() -> None:
    assert (
        ensure_content_type_charset_utf8(b"text/event-stream")
        == b"text/event-stream; charset=utf-8"
    )


def test_existing_charset_preserved() -> None:
    assert (
        ensure_content_type_charset_utf8(b"application/json; charset=utf-8")
        == b"application/json; charset=utf-8"
    )


def test_binary_unchanged() -> None:
    assert ensure_content_type_charset_utf8(b"application/octet-stream") == b"application/octet-stream"


def test_problem_json_and_plus_json() -> None:
    assert (
        ensure_content_type_charset_utf8(b"application/problem+json")
        == b"application/problem+json; charset=utf-8"
    )
    assert (
        ensure_content_type_charset_utf8(b"application/vnd.api+json")
        == b"application/vnd.api+json; charset=utf-8"
    )
