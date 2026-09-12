"""Weixin (iLink) QR login sessions for Control UI / EvoPanel.

Same interaction pattern as :mod:`app.channels.feishu_registration`:
``begin`` → ``poll`` (client polls) → ``apply`` (persist ``config.yaml`` + credential file).
"""

from __future__ import annotations

import logging
import time
import uuid
from dataclasses import dataclass, field
from typing import Literal
from urllib.parse import quote

from app.channels.weixin_setup import (
    EP_GET_BOT_QR,
    EP_GET_QR_STATUS,
    ILINK_BASE_URL,
    QR_TIMEOUT_MS,
    api_get_ilink_with_connect_retry,
)

logger = logging.getLogger(__name__)

SESSION_TTL_SECONDS = 600
MAX_QR_REFRESH = 3

WeixinRegistrationStatus = Literal["pending", "scanning", "completed", "failed", "expired"]


@dataclass
class WeixinRegistrationSession:
    session_id: str
    status: WeixinRegistrationStatus = "pending"
    qr_scan_url: str = ""
    qrcode_value: str = ""
    base_url: str = field(default_factory=lambda: ILINK_BASE_URL)
    init_base_url: str = field(default_factory=lambda: ILINK_BASE_URL.rstrip("/"))
    bot_type: str = "3"
    account_id: str | None = None
    token: str | None = None
    user_id: str | None = None
    confirmed_base_url: str | None = None
    error: str | None = None
    refresh_count: int = 0
    created_at: float = field(default_factory=time.time)
    expires_at: float = field(default_factory=lambda: time.time() + SESSION_TTL_SECONDS)

    @property
    def is_expired(self) -> bool:
        return time.time() >= self.expires_at


class WeixinRegistrationClient:
    """In-memory iLink QR sessions for HTTP onboarding."""

    def __init__(self) -> None:
        self._sessions: dict[str, WeixinRegistrationSession] = {}

    def _cleanup_expired(self) -> None:
        now = time.time()
        expired_ids = [sid for sid, s in self._sessions.items() if now >= s.expires_at and s.status not in ("completed", "failed")]
        for sid in expired_ids:
            s = self._sessions.get(sid)
            if s and s.status not in ("completed", "failed"):
                s.status = "expired"
                s.error = "Session timed out"

    def cleanup_expired(self) -> int:
        before = len(self._sessions)
        self._sessions = {sid: s for sid, s in self._sessions.items() if not s.is_expired or s.status in ("completed", "failed")}
        return before - len(self._sessions)

    async def begin(self, *, base_url: str | None = None, bot_type: str = "3") -> WeixinRegistrationSession:
        init_base = (base_url or ILINK_BASE_URL).rstrip("/")
        session_id = uuid.uuid4().hex[:16]
        sess = WeixinRegistrationSession(session_id=session_id, init_base_url=init_base, base_url=init_base, bot_type=bot_type)
        self._sessions[session_id] = sess

        try:
            qr_resp = await api_get_ilink_with_connect_retry(
                base_url=init_base,
                endpoint=f"{EP_GET_BOT_QR}?bot_type={bot_type}",
                timeout_ms=QR_TIMEOUT_MS,
            )
        except Exception as exc:
            del self._sessions[session_id]
            logger.exception("Weixin registration begin failed")
            raise WeixinRegistrationError("ilink_error", (str(exc) or type(exc).__name__)[:800]) from exc

        qrcode_value = str(qr_resp.get("qrcode") or "")
        qrcode_url = str(qr_resp.get("qrcode_img_content") or "")
        if not qrcode_value:
            del self._sessions[session_id]
            raise WeixinRegistrationError("invalid_response", "iLink returned no qrcode")

        sess.qrcode_value = qrcode_value
        sess.qr_scan_url = qrcode_url if qrcode_url else qrcode_value
        sess.status = "pending"
        logger.info("Weixin registration session %s created", session_id)
        return sess

    async def poll(self, session_id: str) -> WeixinRegistrationSession:
        sess = self._sessions.get(session_id)
        if sess is None:
            raise WeixinRegistrationError("session_not_found", f"Session {session_id} not found")
        if sess.is_expired and sess.status not in ("completed", "failed"):
            sess.status = "expired"
            sess.error = sess.error or "Session timed out"
            return sess

        try:
            import aiohttp  # noqa: F401
        except ImportError as e:
            raise WeixinRegistrationError("missing_dependency", "aiohttp is required") from e

        try:
            status_resp = await api_get_ilink_with_connect_retry(
                base_url=sess.base_url,
                endpoint=f"{EP_GET_QR_STATUS}?qrcode={quote(sess.qrcode_value, safe='')}",
                timeout_ms=QR_TIMEOUT_MS,
            )
        except TimeoutError:
            return sess
        except Exception as exc:
            logger.warning("Weixin registration poll error: %s", exc)
            return sess

        raw_status = str(status_resp.get("status") or "wait")

        if raw_status == "wait":
            return sess
        if raw_status == "scaned":
            sess.status = "scanning"
            return sess
        if raw_status == "scaned_but_redirect":
            redirect_host = str(status_resp.get("redirect_host") or "").strip()
            if redirect_host:
                sess.base_url = f"https://{redirect_host}".rstrip("/")
            return sess
        if raw_status == "expired":
            sess.refresh_count += 1
            if sess.refresh_count > MAX_QR_REFRESH:
                sess.status = "failed"
                sess.error = "QR code expired too many times; please start again"
                return sess
            try:
                qr_resp = await api_get_ilink_with_connect_retry(
                    base_url=sess.init_base_url,
                    endpoint=f"{EP_GET_BOT_QR}?bot_type={sess.bot_type}",
                    timeout_ms=QR_TIMEOUT_MS,
                )
            except Exception as exc:
                sess.status = "failed"
                sess.error = (str(exc) or type(exc).__name__)[:800]
                return sess
            qrcode_value = str(qr_resp.get("qrcode") or "")
            qrcode_url = str(qr_resp.get("qrcode_img_content") or "")
            if not qrcode_value:
                sess.status = "failed"
                sess.error = "QR refresh returned empty qrcode"
                return sess
            sess.qrcode_value = qrcode_value
            sess.qr_scan_url = qrcode_url if qrcode_url else qrcode_value
            sess.status = "pending"
            return sess
        if raw_status == "confirmed":
            account_id = str(status_resp.get("ilink_bot_id") or "")
            token = str(status_resp.get("bot_token") or "")
            confirmed_base = str(status_resp.get("baseurl") or sess.base_url)
            user_id = str(status_resp.get("ilink_user_id") or "")
            if not account_id or not token:
                sess.status = "failed"
                sess.error = "Login confirmed but credential payload was incomplete"
                return sess
            sess.account_id = account_id
            sess.token = token
            sess.user_id = user_id or None
            sess.confirmed_base_url = confirmed_base.rstrip("/")
            sess.status = "completed"
            logger.info("Weixin registration session %s completed (account_id=%s)", session_id, account_id)
            return sess

        logger.debug("Weixin registration unknown status %r for session %s", raw_status, session_id)
        return sess

    def get_session(self, session_id: str) -> WeixinRegistrationSession | None:
        sess = self._sessions.get(session_id)
        if sess and sess.is_expired and sess.status not in ("completed", "failed"):
            sess.status = "expired"
            sess.error = sess.error or "Session timed out"
        return sess


class WeixinRegistrationError(Exception):
    def __init__(self, code: str, message: str = "") -> None:
        self.code = code
        self.message = message
        super().__init__(f"{code}: {message}" if message else code)


_client: WeixinRegistrationClient | None = None


def get_weixin_registration_client() -> WeixinRegistrationClient:
    global _client
    if _client is None:
        _client = WeixinRegistrationClient()
    return _client
