"""Feishu app self-registration via QR code.

Wraps ``accounts.feishu.cn/oauth/v1/app/registration`` so users can scan a QR
code in the Feishu mobile app to automatically create a bot and receive
``app_id`` / ``app_secret``, instead of manually filling them in ``config.yaml``.

⚠️ COMPLIANCE NOTICE
This integration uses the official Feishu Open Platform API. Use only with
authorized Feishu app credentials and in compliance with the Feishu Developer
Agreement (https://open.feishu.cn/). Not for unauthorized data collection or
bulk messaging without user consent.

Based on the same flow used by cc-connect::

    init  →  begin (returns QR URL)  →  poll (returns client_id / client_secret)
"""

from __future__ import annotations

import logging
import time
import uuid
from dataclasses import dataclass, field
from typing import Literal
from urllib.parse import parse_qsl, urlencode, urlparse, urlunparse

import httpx

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

ACCOUNTS_FEISHU_BASE = "https://accounts.feishu.cn"
ACCOUNTS_LARK_BASE = "https://accounts.larksuite.com"
OPEN_FEISHU_BASE = "https://open.feishu.cn"
OPEN_LARK_BASE = "https://open.larksuite.com"

REGISTRATION_PATH = "/oauth/v1/app/registration"
REGISTRATION_TP = "ob_cli_app"

SESSION_TTL_SECONDS = 600  # 10 minutes
POLL_INTERVAL_SECONDS = 5


def _accounts_base(platform: str) -> str:
    return ACCOUNTS_LARK_BASE if platform == "lark" else ACCOUNTS_FEISHU_BASE


def _decorate_qr_url(verification_uri: str) -> str:
    """Append CLI onboarding params so poll can match the scanned registration flow."""
    parsed = urlparse(verification_uri)
    query = dict(parse_qsl(parsed.query, keep_blank_values=True))
    query.setdefault("from", "oc_onboard")
    query.setdefault("tp", REGISTRATION_TP)
    return urlunparse(parsed._replace(query=urlencode(query)))


# ---------------------------------------------------------------------------
# Session model
# ---------------------------------------------------------------------------

RegistrationStatus = Literal["pending", "scanning", "completed", "failed", "expired"]


@dataclass
class RegistrationSession:
    """Short-lived state for one QR onboarding attempt."""

    session_id: str
    status: RegistrationStatus = "pending"
    qr_url: str | None = None
    app_id: str | None = None
    app_secret: str | None = None
    open_id: str | None = None
    platform: str = "feishu"  # feishu or lark
    device_code: str | None = None
    error: str | None = None
    created_at: float = field(default_factory=time.time)
    expires_at: float = field(default_factory=lambda: time.time() + SESSION_TTL_SECONDS)

    @property
    def is_expired(self) -> bool:
        return time.time() >= self.expires_at


# ---------------------------------------------------------------------------
# Registration client
# ---------------------------------------------------------------------------


class FeishuRegistrationClient:
    """HTTP client for the Feishu app self-registration API."""

    def __init__(self, http_client: httpx.AsyncClient | None = None) -> None:
        self._http = http_client or httpx.AsyncClient(timeout=30.0)
        self._sessions: dict[str, RegistrationSession] = {}

    # -- public API ---------------------------------------------------------

    async def begin(self) -> RegistrationSession:
        """Start a new registration flow.

        Calls ``init`` to verify the environment, then ``begin`` to get the QR
        verification URL.  Returns a session with ``session_id`` and ``qr_url``
        populated.
        """
        self._cleanup_expired()

        session_id = uuid.uuid4().hex[:16]
        session = RegistrationSession(session_id=session_id)
        self._sessions[session_id] = session

        # Step 1: init
        init_data = await self._registration_call("init", {})
        if init_data.get("error"):
            raise FeishuRegistrationError(init_data["error"], init_data.get("error_description", ""))

        # Step 2: begin
        begin_params: dict[str, str] = {
            "archetype": "PersonalAgent",
            "auth_method": "client_secret",
            "request_user_info": "open_id",
        }
        begin_data = await self._registration_call("begin", begin_params)
        if begin_data.get("error"):
            raise FeishuRegistrationError(begin_data["error"], begin_data.get("error_description", ""))

        device_code = begin_data.get("device_code")
        verification_uri = begin_data.get("verification_uri_complete")
        if not device_code or not verification_uri:
            raise FeishuRegistrationError("invalid_response", "Feishu registration begin returned incomplete data")

        session.device_code = device_code
        session.qr_url = _decorate_qr_url(verification_uri)
        session.status = "pending"

        # Detect lark vs feishu from tenant_brand if present
        tenant_brand = (begin_data.get("user_info", {}) or {}).get("tenant_brand", "")
        if tenant_brand.lower() == "lark":
            session.platform = "lark"

        logger.info(
            "Feishu registration session %s created (platform=%s)",
            session_id,
            session.platform,
        )
        return session

    async def poll(self, session_id: str) -> RegistrationSession:
        """Poll for registration completion.

        Returns the updated session.  Status transitions:
        - ``pending``: waiting for user to scan / authorize (Feishu ``authorization_pending``)
        - ``scanning``: reserved for a distinct “scanned, confirm on phone” signal (not used for Feishu
          PersonalAgent registration — that API only exposes pending until completed)
        - ``completed``: ``app_id`` / ``app_secret`` are populated
        - ``expired``: session timed out
        - ``failed``: user denied or other error
        """
        session = self._sessions.get(session_id)
        if session is None:
            raise FeishuRegistrationError("session_not_found", f"Session {session_id} not found")
        if session.is_expired:
            session.status = "expired"
            return session

        data = await self._registration_call(
            "poll",
            {
                "device_code": session.device_code or "",
                "tp": REGISTRATION_TP,
            },
            platform=session.platform,
        )

        # Lark tenants may only complete on accounts.larksuite.com.
        user_info = data.get("user_info") or {}
        tenant_brand = str(user_info.get("tenant_brand", "") or "").lower()
        if tenant_brand == "lark" and session.platform != "lark":
            session.platform = "lark"
            data = await self._registration_call(
                "poll",
                {
                    "device_code": session.device_code or "",
                    "tp": REGISTRATION_TP,
                },
                platform="lark",
            )
            user_info = data.get("user_info") or user_info

        error = data.get("error", "")
        if error == "authorization_pending":
            # Still waiting — do NOT mark as "scanning". Feishu returns this both before
            # and after the user opens the QR; flipping to scanning made the UI say
            # 「已扫码」 on the first poll before anyone scanned.
            session.status = "pending"
            return session

        if error == "slow_down":
            return session

        if error == "access_denied":
            session.status = "failed"
            session.error = data.get("error_description", "Authorization denied")
            return session

        if error == "expired_token":
            session.status = "expired"
            session.error = "Registration session expired"
            return session

        if error:
            session.status = "failed"
            session.error = data.get("error_description", error)
            return session

        # Success — credentials returned
        client_id = data.get("client_id")
        client_secret = data.get("client_secret")
        if client_id and client_secret:
            session.app_id = client_id
            session.app_secret = client_secret
            session.status = "completed"

            session.open_id = user_info.get("open_id")

            if tenant_brand == "lark":
                session.platform = "lark"

            logger.info(
                "Feishu registration session %s completed (app_id=%s, platform=%s)",
                session_id,
                client_id,
                session.platform,
            )

        return session

    def get_session(self, session_id: str) -> RegistrationSession | None:
        """Look up a session by ID."""
        session = self._sessions.get(session_id)
        if session and session.is_expired:
            session.status = "expired"
        return session

    def cleanup_expired(self) -> int:
        """Remove expired sessions.  Returns number of sessions removed."""
        before = len(self._sessions)
        self._sessions = {sid: s for sid, s in self._sessions.items() if not s.is_expired}
        removed = before - len(self._sessions)
        if removed:
            logger.debug("Cleaned up %d expired registration sessions", removed)
        return removed

    # -- internal helpers ---------------------------------------------------

    async def _registration_call(
        self,
        action: str,
        params: dict[str, str],
        *,
        platform: str = "feishu",
    ) -> dict:
        """POST to the registration endpoint with form-encoded data."""
        base = _accounts_base(platform)
        form = {"action": action, **params}

        resp = await self._http.post(
            f"{base}{REGISTRATION_PATH}",
            data=form,
            headers={"Content-Type": "application/x-www-form-urlencoded"},
        )
        # Poll often returns HTTP 400 with a JSON body (authorization_pending, etc.).
        if action == "poll":
            try:
                data = resp.json()
            except Exception:
                resp.raise_for_status()
                raise
            if isinstance(data, dict):
                return data
            resp.raise_for_status()
            return data

        resp.raise_for_status()
        return resp.json()

    def _cleanup_expired(self) -> None:
        self.cleanup_expired()

    async def close(self) -> None:
        await self._http.aclose()


# ---------------------------------------------------------------------------
# Exception
# ---------------------------------------------------------------------------


class FeishuRegistrationError(Exception):
    """Raised when the Feishu registration API returns an error."""

    def __init__(self, code: str, message: str = "") -> None:
        self.code = code
        self.message = message
        super().__init__(f"{code}: {message}" if message else code)


# ---------------------------------------------------------------------------
# Singleton
# ---------------------------------------------------------------------------

_client: FeishuRegistrationClient | None = None


def get_registration_client() -> FeishuRegistrationClient:
    """Get (or create) the module-level singleton registration client."""
    global _client
    if _client is None:
        _client = FeishuRegistrationClient()
    return _client


async def close_registration_client() -> None:
    """Close the singleton client's HTTP connection pool."""
    global _client
    if _client is not None:
        await _client.close()
        _client = None
