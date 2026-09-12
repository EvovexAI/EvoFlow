"""Startup gate must cover every prefix mounted by ``register_extended_routers``.

Regression guard for the "加载失败：Not Found" bug: ``/api/platform`` (settings
panel) is mounted by a deferred background task, but was missing from
``_EXTENDED_ROUTE_PREFIXES``. While extended routers were loading, the middleware
let the request through and Starlette answered a bare ``{"detail": "Not Found"}``
404 — surfaced in EvoPanel as an opaque failure instead of the retryable 503
(``code="loading_extended"``) that the frontend retry loop understands.
"""

from __future__ import annotations

from app.gateway.startup_gate import _needs_extended_routers

# Deferred (extended) prefixes that MUST be gated while extended routers load.
_DEFERRED_PREFIXES = (
    "/api/platform",
    "/api/config",
    "/api/stage/news",
    "/api/meetings",
    "/api/organizations",
    "/api/task-detail",
    "/api/runtime",
    "/api/debug",
    "/api/diagnostics",
    "/api/trace",
    "/api/client",
    "/api/a2a",
    "/v1",
)

# Prefixes served by core routers as well (routers/threads.py) — gating them
# would 503 working core routes during the extended-loading window.
_CORE_SHARED_PREFIXES = ("/api/threads",)


def test_deferred_prefixes_are_gated():
    for prefix in _DEFERRED_PREFIXES:
        assert _needs_extended_routers(prefix), f"{prefix} must be gated"
        assert _needs_extended_routers(f"{prefix}/probe"), f"{prefix}/probe must be gated"


def test_core_shared_prefixes_are_not_gated():
    for prefix in _CORE_SHARED_PREFIXES:
        assert not _needs_extended_routers(f"{prefix}/probe"), (
            f"{prefix} is served by core routers and must not be gated"
        )


def test_settings_panel_platform_action_is_gated():
    """The EvoPanel 联网搜索 panel posts to /api/platform."""
    assert _needs_extended_routers("/api/platform")
