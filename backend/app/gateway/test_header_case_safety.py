"""Regression for EvovexAI/EvoFlow#93: Title-Case ASGI header keys.

``dict(Headers(...))`` / ``Headers.__getitem__`` KeyError when raw keys are
Title-Case (e.g. ``Content-Type``), which crashed every ``/runs/stream``.
"""

from __future__ import annotations

import pytest
from starlette.datastructures import Headers

from app.gateway.middleware import (
    Utf8CharsetMiddleware,
    _content_length,
    _header_get,
    _redact_headers,
    _skip_response_body,
)


def _title_case_headers() -> Headers:
    return Headers(
        raw=[
            (b"Content-Type", b"text/event-stream"),
            (b"Content-Length", b"42"),
            (b"Access-Control-Expose-Headers", b"x-request-id"),
            (b"Authorization", b"Bearer secret-token"),
            (b"Content-Disposition", b"inline"),
        ]
    )


def test_dict_headers_raises_on_title_case() -> None:
    """Document the Starlette pitfall this middleware must avoid."""
    headers = _title_case_headers()
    with pytest.raises(KeyError):
        dict(headers)


def test_header_get_title_case() -> None:
    headers = _title_case_headers()
    assert _header_get(headers, "content-type") == "text/event-stream"
    assert _header_get(headers, "Content-Length") == "42"
    assert _header_get(headers, "missing") is None


def test_content_length_title_case() -> None:
    assert _content_length(_title_case_headers()) == 42


def test_redact_headers_title_case() -> None:
    out = _redact_headers(_title_case_headers())
    assert out["Content-Type"] == "text/event-stream"
    assert out["Access-Control-Expose-Headers"] == "x-request-id"
    assert out["Authorization"] == "[REDACTED]"


def test_skip_response_body_title_case_disposition() -> None:
    headers = Headers(raw=[(b"Content-Disposition", b"attachment; filename=a.bin")])
    assert _skip_response_body("application/octet-stream", headers) is True


@pytest.mark.asyncio
async def test_utf8_charset_middleware_lowercases_keys() -> None:
    captured: dict[str, object] = {}

    async def inner(scope, receive, send):  # noqa: ANN001
        await send(
            {
                "type": "http.response.start",
                "status": 200,
                "headers": [
                    (b"Content-Type", b"application/json"),
                    (b"X-Request-Id", b"abc"),
                ],
            }
        )
        await send({"type": "http.response.body", "body": b"{}", "more_body": False})

    async def capture_send(message: dict) -> None:
        if message.get("type") == "http.response.start":
            captured["headers"] = list(message.get("headers") or [])

    mw = Utf8CharsetMiddleware(inner)
    await mw({"type": "http"}, lambda: None, capture_send)  # type: ignore[arg-type]

    headers = captured["headers"]
    assert isinstance(headers, list)
    assert headers == [
        (b"content-type", b"application/json; charset=utf-8"),
        (b"x-request-id", b"abc"),
    ]
