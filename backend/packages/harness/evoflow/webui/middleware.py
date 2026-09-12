"""JWT authentication middleware for WebUI remote access.

When WebUI is enabled, this middleware gates remote requests except a whitelist
of public paths (login, status, health, docs, static assets). Requests from
the local machine (127.0.0.1 / ::1) always pass through so the desktop client
is unaffected. Valid JWT tokens are accepted from either
``Authorization: Bearer <token>`` or the ``evoflow_webui_token`` cookie. When
WebUI is disabled, all requests pass through unchanged.
"""

from __future__ import annotations

import logging
from typing import Any

from starlette.middleware.base import BaseHTTPMiddleware, RequestResponseEndpoint
from starlette.requests import Request
from starlette.responses import JSONResponse, RedirectResponse, Response

from evoflow.webui.auth import get_webui_secret, is_local_request, is_webui_enabled, verify_jwt

logger = logging.getLogger(__name__)

# Paths that never require WebUI auth (even when WebUI is enabled).
_PUBLIC_PATH_PREFIXES = (
    "/api/webui/login",
    "/api/webui/qr-login",
    "/api/webui/oidc/login",
    "/api/webui/oidc/callback",
    "/api/webui/oidc/config",
    "/api/webui/status",
    "/api/auth/",
    "/health",
    "/health/liveness",
    "/docs",
    "/openapi.json",
    "/redoc",
    "/favicon",
    "/assets/",
    "/src/",
    "/@vite",
    "/node_modules/",
)

# File extensions that are treated as static assets.
_STATIC_EXTENSIONS = (
    ".js", ".css", ".ico", ".png", ".jpg", ".jpeg", ".svg",
    ".woff", ".woff2", ".ttf", ".map", ".webp",
)


def _is_public_share_get(path: str, method: str) -> bool:
    """Allow unauthenticated GET of a share snapshot by token only."""
    if str(method or "").upper() != "GET":
        return False
    p = str(path or "")
    if not p.startswith("/api/share/"):
        return False
    # Exclude management helpers under /api/share/by-session/...
    rest = p[len("/api/share/") :].strip("/")
    if not rest or rest.startswith("by-session"):
        return False
    # Single token segment (no further path)
    return "/" not in rest


def _is_public_path(path: str, method: str = "GET") -> bool:
    """Check whether a request path is in the public whitelist.

    Args:
        path: The URL path (e.g. ``/api/webui/login``).
        method: HTTP method (share snapshots are GET-only public).

    Returns:
        ``True`` if the path does not require WebUI auth.
    """
    if any(path.startswith(prefix) for prefix in _PUBLIC_PATH_PREFIXES):
        return True
    if _is_public_share_get(path, method):
        return True
    # Static file extensions
    if any(path.endswith(ext) for ext in _STATIC_EXTENSIONS):
        return True
    # Root and login page
    if path in ("/", "/login", "/qr-login"):
        return True
    if path.startswith("/auth/callback"):
        return True
    return False


def _extract_token(request: Request) -> str | None:
    """Extract a JWT token from the request.

    Checks the ``Authorization: Bearer <token>`` header first, then the
    ``evoflow_webui_token`` cookie.

    Args:
        request: The incoming request.

    Returns:
        The token string, or ``None`` if not present.
    """
    # Authorization header
    auth = request.headers.get("authorization", "")
    if auth.startswith("Bearer "):
        return auth[7:].strip()
    # Cookie
    token = request.cookies.get("evoflow_webui_token")
    if token:
        return token
    return None


def _is_api_request(path: str) -> bool:
    """Check whether a request is an API call (vs a page load).

    Args:
        path: The URL path.

    Returns:
        ``True`` if the path looks like an API call.
    """
    return path.startswith("/api/") or path.startswith("/v1/") or path.startswith("/mcp")


def create_webui_auth_middleware() -> type[BaseHTTPMiddleware]:
    """Create a Starlette middleware class that enforces WebUI JWT auth.

    When WebUI is disabled, the middleware is a pass-through. When enabled,
    requests without a valid JWT are rejected (401 JSON for API calls,
    302 redirect to ``/login`` for page loads).

    Returns:
        A ``BaseHTTPMiddleware`` subclass.
    """

    class WebuiAuthMiddleware(BaseHTTPMiddleware):
        """JWT auth middleware for WebUI remote access."""

        async def dispatch(
            self, request: Request, call_next: RequestResponseEndpoint
        ) -> Response:
            path = request.url.path

            # Always attach a valid JWT when present (desktop switch-user /
            # identity resolution). Enforcement below still respects localhost
            # bypass and WebUI enabled flag.
            token = _extract_token(request)
            if token:
                secret = get_webui_secret()
                payload = verify_jwt(token, secret)
                if payload is not None:
                    request.state.webui_user = payload

            # If WebUI is not enabled, pass through (JWT still attached above).
            if not is_webui_enabled():
                return await call_next(request)

            # Local requests (desktop client / localhost browser) bypass WebUI
            # gate — remote LAN access still requires login below.
            client_host = request.client.host if request.client else ""
            if is_local_request(client_host):
                return await call_next(request)

            # Public paths always pass.
            if _is_public_path(path, request.method):
                return await call_next(request)

            if getattr(request.state, "webui_user", None) is not None:
                return await call_next(request)

            # No valid token — reject.
            if _is_api_request(path):
                return JSONResponse(
                    status_code=401,
                    content={"detail": "Authentication required. Please log in."},
                    headers={"WWW-Authenticate": "Bearer"},
                )
            # Page load — redirect to SPA root; client boot checks WebUI auth.
            return RedirectResponse(url="/", status_code=302)

    return WebuiAuthMiddleware
