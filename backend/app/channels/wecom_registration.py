"""WeCom (Enterprise WeChat) QR registration sessions for Control UI / EvoPanel.

Same interaction pattern as :mod:`app.channels.weixin_registration`:
``begin`` → ``poll`` (client polls) → ``apply`` (persist ``config.yaml`` + credential file).

The QR flow uses WeCom's admin-console bot-creation endpoints (same as
hermes-agent's ``qr_scan_for_bot_info``).  These endpoints may change without
notice — they are not part of WeCom's public developer API.
"""

from __future__ import annotations

import logging
import time
import uuid
from dataclasses import dataclass, field
from typing import Literal

from app.channels.wecom_setup import get_wecom_qr, poll_wecom_qr, qr_page_url

logger = logging.getLogger(__name__)

SESSION_TTL_SECONDS = 600
POLL_INTERVAL_SECONDS = 3
MAX_QR_REFRESH = 3

WecomRegistrationStatus = Literal["pending", "scanning", "completed", "failed", "expired"]


@dataclass
class WecomRegistrationSession:
    session_id: str
    status: WecomRegistrationStatus = "pending"
    qr_url: str = ""
    scode: str = ""
    bot_id: str | None = None
    secret: str | None = None
    error: str | None = None
    refresh_count: int = 0
    created_at: float = field(default_factory=time.time)
    expires_at: float = field(default_factory=lambda: time.time() + SESSION_TTL_SECONDS)

    @property
    def is_expired(self) -> bool:
        return time.time() >= self.expires_at


class WecomRegistrationClient:
    """In-memory WeCom QR sessions for HTTP onboarding."""

    def __init__(self) -> None:
        self._sessions: dict[str, WecomRegistrationSession] = {}

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

    async def begin(self) -> WecomRegistrationSession:
        """Start a new WeCom QR registration flow. Returns a session with ``qr_url`` populated."""
        self._cleanup_expired()
        session_id = uuid.uuid4().hex[:16]
        sess = WecomRegistrationSession(session_id=session_id)
        self._sessions[session_id] = sess

        try:
            qr = get_wecom_qr()
        except Exception as exc:
            del self._sessions[session_id]
            logger.exception("WeCom registration begin failed")
            raise WecomRegistrationError("wecom_qr_error", (str(exc) or type(exc).__name__)[:800]) from exc

        sess.scode = qr["scode"]
        sess.qr_url = qr_page_url(qr["scode"])
        sess.status = "pending"
        logger.info("WeCom registration session %s created", session_id)
        return sess

    async def poll(self, session_id: str) -> WecomRegistrationSession:
        """Poll WeCom QR status. Call every ~3s after ``begin``."""
        sess = self._sessions.get(session_id)
        if sess is None:
            raise WecomRegistrationError("session_not_found", f"Session {session_id} not found")
        if sess.is_expired and sess.status not in ("completed", "failed"):
            sess.status = "expired"
            sess.error = sess.error or "Session timed out"
            return sess

        try:
            creds = poll_wecom_qr(sess.scode, timeout_seconds=POLL_INTERVAL_SECONDS + 1)
        except Exception as exc:
            logger.warning("WeCom registration poll error: %s", exc)
            return sess

        if creds is None:
            # poll_wecom_qr returns None on timeout within its window; keep pending.
            sess.refresh_count += 1
            if sess.refresh_count > MAX_QR_REFRESH * 10:
                sess.status = "expired"
                sess.error = "QR scan timed out; please start again"
            return sess

        sess.bot_id = creds["bot_id"]
        sess.secret = creds["secret"]
        sess.status = "completed"
        logger.info("WeCom registration session %s completed", session_id)
        return sess

    def get_session(self, session_id: str) -> WecomRegistrationSession | None:
        sess = self._sessions.get(session_id)
        if sess and sess.is_expired and sess.status not in ("completed", "failed"):
            sess.status = "expired"
            sess.error = sess.error or "Session timed out"
        return sess


class WecomRegistrationError(Exception):
    def __init__(self, code: str, message: str = "") -> None:
        self.code = code
        self.message = message
        super().__init__(f"{code}: {message}" if message else code)


_client: WecomRegistrationClient | None = None


def get_wecom_registration_client() -> WecomRegistrationClient:
    global _client
    if _client is None:
        _client = WecomRegistrationClient()
    return _client
