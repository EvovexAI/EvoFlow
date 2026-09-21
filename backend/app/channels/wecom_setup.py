"""WeCom (Enterprise WeChat) QR setup helper.

Same interaction pattern as :mod:`app.channels.weixin_setup` (adapted from
hermes-agent's ``plugins/platforms/wecom/adapter.py`` ``qr_scan_for_bot_info``):

- ``get_wecom_qr()`` → fetch a QR code from WeCom's admin-console flow
- ``poll_wecom_qr(scode)`` → poll until the user scans / confirms
- ``save_wecom_credentials(bot_id, secret)`` → persist for WecomChannel restore

NOTE: the ``work.weixin.qq.com/ai/qc/{generate,query_result}`` endpoints used
here are not part of WeCom's public developer API — they back the admin-console
web UI's bot-creation flow and may change without notice.  The same pattern is
used by the feishu / dingtalk QR setup wizards.
"""

from __future__ import annotations

import json
import logging
import os
import time
from pathlib import Path
from typing import Any

import httpx

logger = logging.getLogger(__name__)

_QR_GENERATE_URL = "https://work.weixin.qq.com/ai/qc/generate"
_QR_QUERY_URL = "https://work.weixin.qq.com/ai/qc/query_result"
_QR_CODE_PAGE = "https://work.weixin.qq.com/ai/qc/gen?source=hermes&scode="
_QR_POLL_INTERVAL = 3
_QR_POLL_TIMEOUT = 300


def _wecom_home() -> Path:
    """Directory for persisted WeCom credentials (``{EVOFLOW_HOME}/wecom``)."""
    home = (os.getenv("EVOFLOW_HOME") or "").strip()
    if home:
        return Path(home) / "wecom"
    return Path(__file__).resolve().parent.parent.parent / ".evo-flow" / "wecom"


def save_wecom_credentials(bot_id: str, secret: str) -> Path:
    """Persist WeCom bot credentials to ``{EVOFLOW_HOME}/wecom/credentials.json``."""
    data_dir = _wecom_home()
    data_dir.mkdir(parents=True, exist_ok=True)
    path = data_dir / "credentials.json"
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps({"bot_id": bot_id, "secret": secret}, ensure_ascii=False), encoding="utf-8")
    tmp.replace(path)
    return path


def load_wecom_credentials() -> dict[str, str] | None:
    """Load persisted WeCom credentials, or ``None`` when absent/invalid."""
    path = _wecom_home() / "credentials.json"
    if not path.exists():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        if isinstance(data, dict) and str(data.get("bot_id") or "").strip() and str(data.get("secret") or "").strip():
            return {"bot_id": str(data["bot_id"]).strip(), "secret": str(data["secret"]).strip()}
    except Exception:
        logger.debug("Failed to read WeCom credentials from %s", path, exc_info=True)
    return None


def get_wecom_qr() -> dict[str, Any]:
    """Fetch a WeCom bot-creation QR code.

    Returns ``{"scode": ..., "auth_url": ...}`` on success.

    Raises:
        RuntimeError: when WeCom returns an unexpected response.
    """
    try:
        resp = httpx.get(f"{_QR_GENERATE_URL}?source=hermes", timeout=15.0, follow_redirects=True)
        resp.raise_for_status()
        raw = resp.json()
    except Exception as exc:
        raise RuntimeError(f"failed to fetch WeCom QR code: {exc}") from exc

    data = raw.get("data") or {}
    scode = str(data.get("scode") or "").strip()
    auth_url = str(data.get("auth_url") or "").strip()
    if not scode or not auth_url:
        raise RuntimeError("unexpected WeCom QR response format")
    return {"scode": scode, "auth_url": auth_url}


def poll_wecom_qr(scode: str, *, timeout_seconds: int = _QR_POLL_TIMEOUT) -> dict[str, str] | None:
    """Poll WeCom QR status until the user scans or timeout.

    Returns ``{"bot_id": ..., "secret": ...}`` on success, ``None`` on failure/timeout.
    """
    deadline = time.monotonic() + timeout_seconds
    query_url = f"{_QR_QUERY_URL}?scode={scode}"
    while time.monotonic() < deadline:
        try:
            resp = httpx.get(query_url, timeout=10.0, follow_redirects=True)
            resp.raise_for_status()
            result = resp.json()
        except Exception as exc:
            logger.debug("WeCom QR poll error: %s", exc)
            time.sleep(_QR_POLL_INTERVAL)
            continue

        result_data = result.get("data") or {}
        status = str(result_data.get("status") or "").lower()
        if status == "success":
            bot_info = result_data.get("bot_info") or {}
            bot_id = str(bot_info.get("botid") or bot_info.get("bot_id") or "").strip()
            secret = str(bot_info.get("secret") or "").strip()
            if bot_id and secret:
                return {"bot_id": bot_id, "secret": secret}
            logger.warning("WeCom QR: success but bot_info missing/incomplete: %s", result_data)
            return None
        time.sleep(_QR_POLL_INTERVAL)
    logger.warning("WeCom QR scan timed out after %ds", timeout_seconds)
    return None


def qr_page_url(scode: str) -> str:
    """Human-openable fallback URL for the QR scan flow."""
    return f"{_QR_CODE_PAGE}{scode}"
