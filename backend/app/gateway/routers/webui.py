"""WebUI remote-access management endpoints.

Mounted at ``/api/webui``. Provides:
* ``GET  /status``             — WebUI status (enabled, admin_username, access_urls)
* ``POST /enable``             — Enable WebUI (creates admin + returns initial password once)
* ``POST /disable``            — Disable WebUI
* ``POST /login``              — Username + password login → JWT
* ``POST /qr-login``           — QR token login → JWT
* ``POST /change-password``    — Change admin password (local-only)
* ``POST /change-username``    — Change admin username (local-only)
* ``POST /reset-password``     — Reset to random password (local-only)
* ``POST /generate-qr-token``  — Generate QR login token (local-only)
* ``GET  /access-urls``        — List LAN access URLs (local-only)

Management endpoints (enable/disable/change-*/reset/generate-qr) require local
access (127.0.0.1). Login and QR-login are open to remote clients.
"""

from __future__ import annotations

import logging
import urllib.parse
from typing import Any

from fastapi import APIRouter, HTTPException, Query, Request, status
from fastapi.responses import RedirectResponse
from pydantic import BaseModel, Field

from evoflow.webui.auth import (
    change_password,
    change_username,
    gateway_serves_evopanel_webui,
    generate_jwt,
    generate_password,
    get_lan_access_urls,
    get_or_create_admin_user,
    get_webui_access_port,
    get_webui_secret,
    get_webui_status,
    is_local_request,
    is_password_set,
    is_webui_enabled,
    qr_token_store,
    reset_password,
    set_webui_enabled,
    set_webui_http_port,
    verify_admin_credentials,
    verify_password,
    verify_user_credentials,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/webui", tags=["webui"])


# ── Request / response models ────────────────────────────────


class LoginRequest(BaseModel):
    """Body for ``POST /api/webui/login``."""

    username: str = Field(..., description="Admin username")
    password: str = Field(..., description="Admin password")


class LoginResponse(BaseModel):
    """Response for ``POST /api/webui/login``."""

    token: str = Field(..., description="JWT token for subsequent requests")
    expires_in_days: int = Field(default=7, description="Token expiry in days")
    username: str = Field(..., description="The authenticated username")


class QrLoginRequest(BaseModel):
    """Body for ``POST /api/webui/qr-login``."""

    qr_token: str = Field(..., description="The QR login token from generate-qr-token")


class ChangePasswordRequest(BaseModel):
    """Body for ``POST /api/webui/change-password``."""

    new_password: str = Field(..., min_length=8, description="New password (min 8 chars)")


class ChangeUsernameRequest(BaseModel):
    """Body for ``POST /api/webui/change-username``."""

    new_username: str = Field(..., min_length=2, description="New username (min 2 chars)")


class QrTokenResponse(BaseModel):
    """Response for ``POST /api/webui/generate-qr-token``."""

    token: str = Field(..., description="The QR login token")
    expires_at_ms: int = Field(..., description="Expiry timestamp in milliseconds")


class EnableRequest(BaseModel):
    """Body for ``POST /api/webui/enable``."""

    username: str | None = Field(default=None, min_length=2, description="Admin username (optional)")
    password: str | None = Field(default=None, min_length=8, description="Admin password (optional, min 8 chars)")


class EnableResponse(BaseModel):
    """Response for ``POST /api/webui/enable``."""

    enabled: bool = Field(..., description="Whether WebUI is now enabled")
    initial_password: str | None = Field(
        default=None, description="One-time initial password (only on first enable)"
    )
    admin_username: str = Field(..., description="The admin username")
    access_urls: list[str] = Field(default_factory=list, description="LAN access URLs")


class StatusResponse(BaseModel):
    """Response for ``GET /api/webui/status``."""

    enabled: bool
    running: bool
    admin_username: str
    password_set: bool
    access_urls: list[str] = Field(default_factory=list)
    webui_http_port: int = Field(description="Web UI HTTP port (from env or settings)")
    gateway_port: int | None = Field(default=None, description="Gateway API port (reference)")
    lan_ip: str | None = None
    oidc_enabled: bool = False
    oidc_button_label: str = "企业 SSO 登录"
    password_login_enabled: bool = True


class AccessUrlsResponse(BaseModel):
    """Response for ``GET /api/webui/access-urls``."""

    urls: list[str]
    lan_ip: str | None = None


class ResetPasswordResponse(BaseModel):
    """Response for ``POST /api/webui/reset-password``."""

    new_password: str = Field(..., description="The new random password (shown once)")


class ChangeUsernameResponse(BaseModel):
    """Response for ``POST /api/webui/change-username``."""

    username: str = Field(..., description="The new username")


class OidcConfigUpdate(BaseModel):
    """Body for ``PUT /api/webui/oidc/config`` (local-only)."""

    enabled: bool | None = None
    issuer: str | None = None
    clientId: str | None = None
    clientSecret: str | None = None
    scopes: str | None = None
    emailClaim: str | None = None
    nameClaim: str | None = None
    subClaim: str | None = None
    allowedEmailDomain: str | None = None
    autoProvision: bool | None = None
    passwordLoginEnabled: bool | None = None
    buttonLabel: str | None = None
    redirectUri: str | None = None
    authorizationEndpoint: str | None = None
    tokenEndpoint: str | None = None
    userinfoEndpoint: str | None = None
    jwksUri: str | None = None


# ── Helpers ──────────────────────────────────────────────────


def _require_local(request: Request) -> None:
    """Raise 403 if the request is not from localhost.

    Args:
        request: The incoming FastAPI request.
    """
    client = request.client
    if not client or not is_local_request(client.host):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="This endpoint is only available from the local machine.",
        )


def _get_port(request: Request) -> int:
    """Extract the gateway port from the request's URL.

    Args:
        request: The incoming FastAPI request.

    Returns:
        The port number (default 8001).
    """
    try:
        return request.url.port or 8001
    except Exception:
        return 8001


def _request_base_url(request: Request) -> str:
    """Best-effort public origin for OIDC redirect URI construction."""
    origin = str(request.headers.get("origin") or "").strip().rstrip("/")
    if origin.startswith("http://") or origin.startswith("https://"):
        return origin
    try:
        return str(request.base_url).rstrip("/")
    except Exception:
        return ""


def _jwt_for_webui_user(user: dict[str, Any], *, auth_method: str = "password") -> str:
    from evoflow.authz.principals import ensure_webui_principal

    secret = get_webui_secret()
    principal_id: str | None = None
    try:
        p = ensure_webui_principal(
            webui_user_id=int(user["id"]),
            username=str(user.get("username") or "admin"),
            is_primary=int(user.get("is_primary") or 0) == 1,
        )
        principal_id = str(p["principal_id"])
    except Exception:
        logger.warning("ensure_webui_principal for JWT failed user_id=%s", user.get("id"), exc_info=True)
    return generate_jwt(
        int(user["id"]),
        str(user["username"]),
        secret,
        principal_id=principal_id,
        auth_method=auth_method,
    )


# ── Endpoints ────────────────────────────────────────────────


@router.get("/status", response_model=StatusResponse, summary="Get WebUI status")
async def get_status(request: Request) -> StatusResponse:
    """Return the current WebUI remote-access status.

    Public endpoint — no auth required (needed for the login page to check
    whether WebUI is enabled before showing the login form).
    """
    port = _get_port(request)
    s = get_webui_status(port)
    return StatusResponse(**s)


@router.post("/enable", response_model=EnableResponse, summary="Enable WebUI remote access")
async def enable_webui(request: Request, body: EnableRequest | None = None) -> EnableResponse:
    """Enable WebUI remote access.

    On first enable, creates the admin user. If ``username`` / ``password`` are
    provided in the body they are applied; otherwise a random password is
    generated and returned once.

    Local-only endpoint.
    """
    _require_local(request)
    body = body or EnableRequest()

    was_enabled = is_webui_enabled()
    password_was_set = is_password_set()

    set_webui_enabled(True)

    admin = get_or_create_admin_user()
    admin_id = int(admin["id"])
    admin_username = str(admin.get("username", "admin"))

    if body.username and body.username.strip() and body.username.strip() != admin_username:
        if change_username(admin_id, body.username.strip()):
            admin_username = body.username.strip()

    initial_password = None
    if body.password:
        change_password(admin_id, body.password)
    elif not was_enabled and not password_was_set:
        initial_password = reset_password(admin_id)

    gw_port = _get_port(request)
    access_port = get_webui_access_port(gw_port)
    if gateway_serves_evopanel_webui():
        set_webui_http_port(access_port)

    access_urls = get_lan_access_urls(access_port)

    return EnableResponse(
        enabled=True,
        initial_password=initial_password,
        admin_username=admin_username,
        access_urls=access_urls,
    )


@router.post("/disable", summary="Disable WebUI remote access")
async def disable_webui(request: Request) -> dict[str, bool]:
    """Disable WebUI remote access.

    Local-only endpoint. The admin user is retained so re-enabling does not
    require re-provisioning.
    """
    _require_local(request)
    set_webui_enabled(False)
    return {"disabled": True}


def _login_params_are_malformed(username: str, password: str) -> str | None:
    """Return an error detail string if the login params are malformed, else ``None``.

    Distinguishes *parameter-format* failures (→ 400) from *credential mismatch*
    (→ 401): an empty / whitespace-only username or password is a client-side
    parameter error, while a well-formed but incorrect credential pair is an
    authentication failure.

    Args:
        username: The submitted username.
        password: The submitted password.

    Returns:
        A 400-style detail message, or ``None`` if params are well-formed.
    """
    if not username or not username.strip():
        return "Username must not be empty."
    if not password or not password.strip():
        return "Password must not be empty."
    return None


@router.post("/login", response_model=LoginResponse, summary="Login with username + password")
async def login(body: LoginRequest) -> LoginResponse:
    """Authenticate with username + password and receive a JWT.

    Open to remote clients (the login page needs to be accessible from LAN).

    Error contract:
    * ``400`` — malformed parameters (empty / whitespace-only username or
      password). A malformed login body is a client error and must never
      surface as a 500.
    * ``401`` — well-formed but mismatched credentials (authentication failure).
    """
    malformed = _login_params_are_malformed(body.username, body.password)
    if malformed is not None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=malformed,
        )
    user = verify_user_credentials(body.username, body.password)
    if user is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid username or password.",
        )
    try:
        from evoflow.webui.oidc_config import get_oidc_config, is_oidc_enabled

        if is_oidc_enabled() and not get_oidc_config(include_secret=True).get("passwordLoginEnabled", True):
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Password login is disabled. Use enterprise SSO.",
            )
    except HTTPException:
        raise
    except Exception:
        logger.debug("password login policy check failed", exc_info=True)
    token = _jwt_for_webui_user(user, auth_method="password")
    return LoginResponse(token=token, username=str(user["username"]))


@router.post("/qr-login", response_model=LoginResponse, summary="Login with QR token")
async def qr_login(body: QrLoginRequest) -> LoginResponse:
    """Authenticate with a QR token and receive a JWT.

    Consumes the QR token (one-time use). Open to remote clients.
    """
    if not qr_token_store.validate_and_consume(body.qr_token):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or expired QR token.",
        )
    # QR login authenticates as the primary admin user
    admin = get_or_create_admin_user()
    token = _jwt_for_webui_user(admin, auth_method="qr")
    return LoginResponse(token=token, username=str(admin["username"]))


@router.post("/change-password", summary="Change admin password")
async def webui_change_password(request: Request, body: ChangePasswordRequest) -> dict[str, bool]:
    """Change the admin password.

    Local-only endpoint.
    """
    _require_local(request)
    admin = get_or_create_admin_user()
    ok = change_password(int(admin["id"]), body.new_password)
    if not ok:
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="Failed to change password.")
    return {"changed": True}


@router.post("/change-username", response_model=ChangeUsernameResponse, summary="Change admin username")
async def webui_change_username(request: Request, body: ChangeUsernameRequest) -> ChangeUsernameResponse:
    """Change the admin username.

    Local-only endpoint.
    """
    _require_local(request)
    admin = get_or_create_admin_user()
    ok = change_username(int(admin["id"]), body.new_username)
    if not ok:
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="Failed to change username.")
    return ChangeUsernameResponse(username=body.new_username)


@router.post("/reset-password", response_model=ResetPasswordResponse, summary="Reset admin password")
async def webui_reset_password(request: Request) -> ResetPasswordResponse:
    """Reset the admin password to a new random one.

    Local-only endpoint. Returns the new plaintext password once.
    """
    _require_local(request)
    admin = get_or_create_admin_user()
    new_password = reset_password(int(admin["id"]))
    return ResetPasswordResponse(new_password=new_password)


@router.post("/generate-qr-token", response_model=QrTokenResponse, summary="Generate QR login token")
async def webui_generate_qr_token(request: Request) -> QrTokenResponse:
    """Generate a one-time QR login token (5-minute TTL).

    Local-only endpoint. The token is embedded in a ``/qr-login?token=...`` URL
    that the frontend renders as a QR code.
    """
    _require_local(request)
    token, expires_at_ms = qr_token_store.generate_with_expiry()
    return QrTokenResponse(token=token, expires_at_ms=expires_at_ms)


@router.get("/access-urls", response_model=AccessUrlsResponse, summary="List LAN access URLs")
async def webui_access_urls(request: Request) -> AccessUrlsResponse:
    """List all LAN-accessible URLs for the WebUI.

    Local-only endpoint.
    """
    _require_local(request)
    gw_port = _get_port(request)
    urls = get_lan_access_urls(get_webui_access_port(gw_port))
    lan_ip = urls[1] if len(urls) > 1 else None
    return AccessUrlsResponse(urls=urls, lan_ip=lan_ip)


@router.get("/oidc/config", summary="Get OIDC / SSO configuration (public)")
async def oidc_get_config() -> dict[str, Any]:
    """Return OIDC settings for the login page and admin UI (secret masked)."""
    from evoflow.webui.oidc_config import get_oidc_config, is_oidc_enabled

    cfg = get_oidc_config(include_secret=False)
    cfg["configured"] = is_oidc_enabled()
    return cfg


@router.put("/oidc/config", summary="Update OIDC / SSO configuration")
async def oidc_put_config(request: Request, body: OidcConfigUpdate) -> dict[str, Any]:
    """Persist OIDC settings. Local-only."""
    _require_local(request)
    from evoflow.webui.oidc_config import set_oidc_config

    updates = body.model_dump(exclude_none=True)
    return set_oidc_config(updates)


@router.get("/oidc/login", summary="Start OIDC authorization redirect")
async def oidc_login(
    request: Request,
    redirect: str = Query(default="/chat", description="Post-login SPA hash path"),
) -> RedirectResponse:
    """Redirect browser to the IdP authorization endpoint (PKCE)."""
    from evoflow.webui.oidc import build_authorize_url
    from evoflow.webui.oidc_config import is_oidc_enabled

    if not is_oidc_enabled():
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="OIDC is not enabled")
    try:
        url = await build_authorize_url(
            redirect=redirect,
            return_origin=_request_base_url(request),
        )
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    return RedirectResponse(url=url, status_code=302)


@router.get("/oidc/callback", summary="OIDC authorization callback")
async def oidc_callback(
    request: Request,
    code: str = Query(default="", description="Authorization code"),
    state: str = Query(default="", description="CSRF state"),
    error: str = Query(default="", description="IdP error"),
    error_description: str = Query(default="", description="IdP error detail"),
) -> RedirectResponse:
    """Exchange OIDC code, provision principal, issue JWT, redirect to SPA."""
    from evoflow.authz.principals import resolve_or_provision_oidc_principal
    from evoflow.webui.oidc import build_post_login_redirect, exchange_code_and_fetch_claims
    from evoflow.webui.oidc_config import get_oidc_config

    base = _request_base_url(request)
    fail_path = "/#/login"

    if error:
        detail = error_description or error
        q = urllib.parse.urlencode({"error": detail})
        return RedirectResponse(url=f"{base}{fail_path}?{q}", status_code=302)

    if not code or not state:
        return RedirectResponse(url=f"{base}{fail_path}?error=missing_code", status_code=302)

    try:
        meta, claims = await exchange_code_and_fetch_claims(
            code=code,
            state=state,
            request_base_url=base,
        )
        cfg = get_oidc_config(include_secret=True)
        principal = resolve_or_provision_oidc_principal(
            oidc_sub=str(claims["sub"]),
            email=claims.get("email"),
            display_name=claims.get("name"),
            auto_provision=bool(cfg.get("autoProvision", True)),
        )
        username = str(principal.get("display_name") or claims.get("email") or claims["sub"])
        token = generate_jwt(
            None,
            username,
            get_webui_secret(),
            principal_id=str(principal["principal_id"]),
            auth_method="oidc",
        )
        location = build_post_login_redirect(token=token, meta=meta, request_base_url=base)
        return RedirectResponse(url=location, status_code=302)
    except Exception as exc:
        logger.warning("OIDC callback failed", exc_info=True)
        q = urllib.parse.urlencode({"error": str(exc) or "oidc_failed"})
        return RedirectResponse(url=f"{base}{fail_path}?{q}", status_code=302)

