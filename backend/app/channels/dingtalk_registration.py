"""DingTalk (钉钉) device-flow QR registration sessions for Control UI / EvoPanel.

Same interaction pattern as :mod:`app.channels.wecom_registration`:
``begin`` → ``poll`` (client polls) → ``apply`` (persist ``config.yaml``).

Protocol mirrors hermes-agent's ``hermes_cli/dingtalk_auth.py`` (the 3-step
OpenClaw device-flow bridge):

    1. POST /app/registration/init   → nonce
    2. POST /app/registration/begin  → device_code + verification_uri_complete
    3. POST /app/registration/poll   → WAITING / SUCCESS → client_id + client_secret

The ``verification_uri_complete`` is rendered as a QR code in EvoPanel so the
user can scan it with DingTalk to authorize, yielding Client ID (AppKey) +
Client Secret (AppSecret) automatically.

NOTE: this onboarding bridge is branded "OpenClaw" on DingTalk's side (a
third-party ecosystem onboarding endpoint, not DingTalk's official enterprise
bot-creation page) and may change without notice — same caveat as the WeCom
QR flow.
"""

from __future__ import annotations

import logging
import os
import time
import uuid
from dataclasses import dataclass, field
from typing import Any, Literal

import httpx

logger = logging.getLogger(__name__)

SESSION_TTL_SECONDS = 600
POLL_INTERVAL_SECONDS = 3

REGISTRATION_BASE_URL = os.environ.get(
    "DINGTALK_REGISTRATION_BASE_URL", "https://oapi.dingtalk.com"
).rstrip("/")
REGISTRATION_SOURCE = os.environ.get("DINGTALK_REGISTRATION_SOURCE", "openClaw")

DingtalkRegistrationStatus = Literal["pending", "scanning", "completed", "failed", "expired"]


class DingtalkRegistrationError(Exception):
    def __init__(self, code: str, message: str = "") -> None:
        self.code = code
        self.message = message
        super().__init__(f"{code}: {message}" if message else code)


async def _api_post(path: str, payload: dict[str, Any]) -> dict[str, Any]:
    """POST to the DingTalk registration API."""
    url = f"{REGISTRATION_BASE_URL}{path}"
    async with httpx.AsyncClient(timeout=15.0) as client:
        resp = await client.post(url, json=payload)
        resp.raise_for_status()
        data = resp.json()
    errcode = data.get("errcode", -1)
    if errcode != 0:
        raise DingtalkRegistrationError(
            "api_error", f"API error [{path}]: {data.get('errmsg', 'unknown error')} (errcode={errcode})"
        )
    return data


async def begin_device_flow() -> dict[str, Any]:
    """Start a DingTalk device-flow registration.

    Returns ``{"device_code", "verification_uri_complete", "expires_in", "interval"}``.
    """
    init_data = await _api_post("/app/registration/init", {"source": REGISTRATION_SOURCE})
    nonce = str(init_data.get("nonce", "")).strip()
    if not nonce:
        raise DingtalkRegistrationError("missing_nonce", "init response missing nonce")

    begin_data = await _api_post("/app/registration/begin", {"nonce": nonce})
    device_code = str(begin_data.get("device_code", "")).strip()
    verification_uri_complete = str(begin_data.get("verification_uri_complete", "")).strip()
    if not device_code:
        raise DingtalkRegistrationError("missing_device_code", "begin response missing device_code")
    if not verification_uri_complete:
        raise DingtalkRegistrationError("missing_qr", "begin response missing verification_uri_complete")

    return {
        "device_code": device_code,
        "verification_uri_complete": verification_uri_complete,
        "expires_in": int(begin_data.get("expires_in", 7200)),
        "interval": max(int(begin_data.get("interval", 3)), 2),
    }


async def poll_device_flow(device_code: str) -> dict[str, Any]:
    """Poll the DingTalk registration status once.

    Returns ``{"status", "client_id"?, "client_secret"?, "fail_reason"?}`` where
    ``status`` is one of ``WAITING`` / ``SUCCESS`` / ``FAIL`` / ``EXPIRED``.
    """
    data = await _api_post("/app/registration/poll", {"device_code": device_code})
    status_raw = str(data.get("status", "")).strip().upper()
    if status_raw not in {"WAITING", "SUCCESS", "FAIL", "EXPIRED"}:
        status_raw = "UNKNOWN"
    return {
        "status": status_raw,
        "client_id": str(data.get("client_id", "")).strip() or None,
        "client_secret": str(data.get("client_secret", "")).strip() or None,
        "fail_reason": str(data.get("fail_reason", "")).strip() or None,
    }


@dataclass
class DingtalkRegistrationSession:
    session_id: str
    status: DingtalkRegistrationStatus = "pending"
    qr_url: str = ""
    device_code: str = ""
    client_id: str | None = None
    client_secret: str | None = None
    error: str | None = None
    created_at: float = field(default_factory=time.time)
    expires_at: float = field(default_factory=lambda: time.time() + SESSION_TTL_SECONDS)

    @property
    def is_expired(self) -> bool:
        return time.time() >= self.expires_at


class DingtalkRegistrationClient:
    """In-memory DingTalk device-flow sessions for HTTP onboarding."""

    def __init__(self) -> None:
        self._sessions: dict[str, DingtalkRegistrationSession] = {}

    def _cleanup_expired(self) -> None:
        now = time.time()
        for sid, s in list(self._sessions.items()):
            if now >= s.expires_at and s.status not in ("completed", "failed"):
                s.status = "expired"
                s.error = "Session timed out"

    def cleanup_expired(self) -> int:
        before = len(self._sessions)
        self._sessions = {sid: s for sid, s in self._sessions.items() if not s.is_expired or s.status in ("completed", "failed")}
        return before - len(self._sessions)

    async def begin(self) -> DingtalkRegistrationSession:
        """Start a new DingTalk device-flow registration. Returns a session with ``qr_url`` populated."""
        self._cleanup_expired()
        session_id = uuid.uuid4().hex[:16]
        sess = DingtalkRegistrationSession(session_id=session_id)
        self._sessions[session_id] = sess

        try:
            flow = await begin_device_flow()
        except Exception as exc:
            del self._sessions[session_id]
            logger.exception("DingTalk registration begin failed")
            if isinstance(exc, DingtalkRegistrationError):
                raise exc
            raise DingtalkRegistrationError("device_flow_error", (str(exc) or type(exc).__name__)[:800]) from exc

        sess.device_code = flow["device_code"]
        sess.qr_url = flow["verification_uri_complete"]
        sess.status = "pending"
        logger.info("DingTalk registration session %s created", session_id)
        return sess

    async def poll(self, session_id: str) -> DingtalkRegistrationSession:
        """Poll DingTalk device-flow status. Call every ~3s after ``begin``."""
        sess = self._sessions.get(session_id)
        if sess is None:
            raise DingtalkRegistrationError("session_not_found", f"Session {session_id} not found")
        if sess.is_expired and sess.status not in ("completed", "failed"):
            sess.status = "expired"
            sess.error = sess.error or "Session timed out"
            return sess

        try:
            result = await poll_device_flow(sess.device_code)
        except Exception as exc:
            logger.warning("DingTalk registration poll error: %s", exc)
            return sess

        status = result["status"]
        if status == "WAITING":
            return sess
        if status == "SUCCESS":
            cid = result["client_id"]
            csecret = result["client_secret"]
            if not cid or not csecret:
                sess.status = "failed"
                sess.error = "authorization succeeded but credentials are missing"
                return sess
            sess.client_id = cid
            sess.client_secret = csecret
            sess.status = "completed"
            logger.info("DingTalk registration session %s completed", session_id)
            return sess
        # FAIL / EXPIRED / UNKNOWN
        sess.status = "failed"
        sess.error = result.get("fail_reason") or status
        return sess

    def get_session(self, session_id: str) -> DingtalkRegistrationSession | None:
        sess = self._sessions.get(session_id)
        if sess and sess.is_expired and sess.status not in ("completed", "failed"):
            sess.status = "expired"
            sess.error = sess.error or "Session timed out"
        return sess


_client: DingtalkRegistrationClient | None = None


def get_dingtalk_registration_client() -> DingtalkRegistrationClient:
    global _client
    if _client is None:
        _client = DingtalkRegistrationClient()
    return _client
