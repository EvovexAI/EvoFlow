"""CORS must expose Content-Range so desktop PreviewPane.stat can size files."""

from __future__ import annotations

from fastapi import FastAPI
from starlette.middleware.cors import CORSMiddleware

from app.gateway.middleware import setup_middleware


def test_setup_middleware_exposes_range_stat_headers() -> None:
    app = FastAPI()
    setup_middleware(app)
    cors = next(m for m in app.user_middleware if m.cls is CORSMiddleware)
    exposed = {str(h).lower() for h in (cors.kwargs.get("expose_headers") or [])}
    assert "content-range" in exposed
    assert "accept-ranges" in exposed
    assert "content-length" in exposed
