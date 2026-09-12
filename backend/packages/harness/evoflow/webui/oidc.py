"""OIDC authorization-code flow with PKCE for enterprise SSO."""

from __future__ import annotations

import base64
import hashlib
import logging
import secrets
import threading
import time
import urllib.parse
from typing import Any

import httpx

from evoflow.webui.oidc_config import get_oidc_client_secret, get_oidc_config, is_oidc_enabled

logger = logging.getLogger(__name__)

_STATE_TTL_S = 600
_DISCOVERY_TTL_S = 3600

_discovery_cache: dict[str, tuple[float, dict[str, Any]]] = {}
_discovery_lock = threading.Lock()


class OidcStateStore:
    """One-time PKCE/state store (in-process, like QR login tokens)."""

    def __init__(self) -> None:
        self._items: dict[str, dict[str, Any]] = {}
        self._lock = threading.Lock()

    def _purge(self) -> None:
        now = time.time()
        dead = [k for k, v in self._items.items() if float(v.get("exp") or 0) <= now]
        for k in dead:
            self._items.pop(k, None)

    def create(self, *, redirect: str, return_origin: str) -> tuple[str, str, str]:
        """Return (state, code_verifier, nonce)."""
        self._purge()
        state = secrets.token_urlsafe(24)
        code_verifier = secrets.token_urlsafe(48)
        nonce = secrets.token_urlsafe(16)
        with self._lock:
            self._items[state] = {
                "code_verifier": code_verifier,
                "nonce": nonce,
                "redirect": redirect,
                "return_origin": return_origin,
                "exp": time.time() + _STATE_TTL_S,
            }
        return state, code_verifier, nonce

    def consume(self, state: str) -> dict[str, Any] | None:
        self._purge()
        with self._lock:
            item = self._items.pop(state, None)
        if not item:
            return None
        if time.time() >= float(item.get("exp") or 0):
            return None
        return item


oidc_state_store = OidcStateStore()


def _b64url_no_pad(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode("ascii").rstrip("=")


def pkce_challenge(verifier: str) -> str:
    digest = hashlib.sha256(verifier.encode("utf-8")).digest()
    return _b64url_no_pad(digest)


async def _fetch_discovery(issuer: str) -> dict[str, Any]:
    base = issuer.rstrip("/")
    cached = _discovery_cache.get(base)
    now = time.time()
    if cached and now - cached[0] < _DISCOVERY_TTL_S:
        return cached[1]
    url = f"{base}/.well-known/openid-configuration"
    async with httpx.AsyncClient(timeout=15.0) as client:
        resp = await client.get(url)
        resp.raise_for_status()
        data = resp.json()
    if not isinstance(data, dict):
        raise ValueError("invalid OIDC discovery document")
    with _discovery_lock:
        _discovery_cache[base] = (now, data)
    return data


async def _resolve_endpoints(cfg: dict[str, Any]) -> dict[str, str]:
    issuer = str(cfg.get("issuer") or "").strip().rstrip("/")
    if not issuer:
        raise ValueError("OIDC issuer is required")
    auth = str(cfg.get("authorizationEndpoint") or "").strip()
    token = str(cfg.get("tokenEndpoint") or "").strip()
    userinfo = str(cfg.get("userinfoEndpoint") or "").strip()
    if not (auth and token):
        doc = await _fetch_discovery(issuer)
        auth = auth or str(doc.get("authorization_endpoint") or "")
        token = token or str(doc.get("token_endpoint") or "")
        userinfo = userinfo or str(doc.get("userinfo_endpoint") or "")
    if not auth or not token:
        raise ValueError("OIDC authorization/token endpoints not configured")
    return {"authorization": auth, "token": token, "userinfo": userinfo, "issuer": issuer}


def _sanitize_redirect(path: str) -> str:
    p = str(path or "").strip()
    if not p or not p.startswith("/") or p.startswith("//"):
        return "/chat"
    if "://" in p:
        return "/chat"
    return p.split("#")[0] or "/chat"


def _sanitize_return_origin(origin: str) -> str:
    o = str(origin or "").strip().rstrip("/")
    if not o:
        return ""
    if not (o.startswith("http://") or o.startswith("https://")):
        return ""
    return o


async def build_authorize_url(*, redirect: str, return_origin: str) -> str:
    if not is_oidc_enabled():
        raise ValueError("OIDC is not enabled")
    cfg = get_oidc_config(include_secret=True)
    endpoints = await _resolve_endpoints(cfg)
    state, _verifier, nonce = oidc_state_store.create(
        redirect=_sanitize_redirect(redirect),
        return_origin=_sanitize_return_origin(return_origin),
    )
    challenge = pkce_challenge(_verifier)
    # Re-store with verifier keyed by state (create already stored verifier)
    params = {
        "response_type": "code",
        "client_id": str(cfg.get("clientId") or ""),
        "redirect_uri": _callback_redirect_uri(return_origin),
        "scope": str(cfg.get("scopes") or "openid email profile"),
        "state": state,
        "nonce": nonce,
        "code_challenge": challenge,
        "code_challenge_method": "S256",
    }
    return f"{endpoints['authorization']}?{urllib.parse.urlencode(params)}"


def _callback_redirect_uri(return_origin: str) -> str:
    """OIDC redirect URI must match IdP registration — always Gateway callback."""
    # return_origin is used after login to jump back to SPA; callback URL is fixed per deploy.
    from evoflow.webui.oidc_config import get_oidc_config  # noqa: PLC0415

    cfg = get_oidc_config(include_secret=True)
    override = str(cfg.get("redirectUri") or "").strip()
    if override:
        return override
    base = _sanitize_return_origin(return_origin)
    if base:
        return f"{base}/api/webui/oidc/callback"
    return "/api/webui/oidc/callback"


async def exchange_code_and_fetch_claims(
    *,
    code: str,
    state: str,
    request_base_url: str,
) -> tuple[dict[str, Any], dict[str, Any]]:
    """Exchange auth code; return (state_meta, claims dict)."""
    if not is_oidc_enabled():
        raise ValueError("OIDC is not enabled")
    meta = oidc_state_store.consume(state)
    if not meta:
        raise ValueError("invalid or expired OIDC state")
    cfg = get_oidc_config(include_secret=True)
    secret = get_oidc_client_secret()
    if not secret:
        raise ValueError("OIDC client secret is not configured")
    endpoints = await _resolve_endpoints(cfg)
    return_origin = str(meta.get("return_origin") or request_base_url).strip().rstrip("/")
    redirect_uri = _callback_redirect_uri(return_origin)
    if redirect_uri.startswith("/"):
        redirect_uri = f"{return_origin}{redirect_uri}"

    token_body = {
        "grant_type": "authorization_code",
        "code": code,
        "redirect_uri": redirect_uri,
        "client_id": str(cfg.get("clientId") or ""),
        "client_secret": secret,
        "code_verifier": str(meta.get("code_verifier") or ""),
    }
    async with httpx.AsyncClient(timeout=20.0) as client:
        tok_resp = await client.post(
            endpoints["token"],
            data=token_body,
            headers={"Accept": "application/json"},
        )
        tok_resp.raise_for_status()
        tokens = tok_resp.json()
        if not isinstance(tokens, dict):
            raise ValueError("invalid token response")

        claims: dict[str, Any] = {}
        if tokens.get("id_token"):
            # MVP: rely on userinfo; id_token signature verify can be added later
            pass
        access = str(tokens.get("access_token") or "")
        if access and endpoints.get("userinfo"):
            ui_resp = await client.get(
                endpoints["userinfo"],
                headers={"Authorization": f"Bearer {access}", "Accept": "application/json"},
            )
            ui_resp.raise_for_status()
            userinfo = ui_resp.json()
            if isinstance(userinfo, dict):
                claims.update(userinfo)

    sub_claim = str(cfg.get("subClaim") or "sub")
    email_claim = str(cfg.get("emailClaim") or "email")
    name_claim = str(cfg.get("nameClaim") or "name")

    oidc_sub = str(claims.get(sub_claim) or claims.get("sub") or "").strip()
    if not oidc_sub:
        raise ValueError("OIDC userinfo missing subject")

    email = str(claims.get(email_claim) or claims.get("email") or "").strip().lower() or None
    name = str(claims.get(name_claim) or claims.get("name") or email or oidc_sub).strip()

    allowed_domain = str(cfg.get("allowedEmailDomain") or "").strip().lower()
    if allowed_domain and email:
        if not email.endswith(f"@{allowed_domain}") and email.split("@")[-1] != allowed_domain:
            raise ValueError(f"email domain must be {allowed_domain}")

    if claims.get("email_verified") is False and email:
        raise ValueError("email not verified by identity provider")

    normalized = {
        "sub": oidc_sub,
        "email": email,
        "name": name,
        "raw": claims,
    }
    return meta, normalized


def build_post_login_redirect(
    *,
    token: str,
    meta: dict[str, Any],
    request_base_url: str,
) -> str:
    """Redirect to SPA hash route with token (saved by auth-callback page)."""
    redirect_path = _sanitize_redirect(str(meta.get("redirect") or "/chat"))
    origin = _sanitize_return_origin(str(meta.get("return_origin") or request_base_url))
    if not origin:
        origin = request_base_url.rstrip("/")
    q = urllib.parse.urlencode({"token": token, "redirect": redirect_path})
    return f"{origin}/#/auth/callback?{q}"
