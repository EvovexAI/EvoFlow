"""Weixin (WeChat personal) QR login helper.

Scans QR code via Tencent iLink Bot API, polls for confirmation, and persists
credentials so the WeixinChannel can restore them on startup.

Adapted from hermes-agent's gateway/platforms/weixin.py qr_login flow.
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
from collections.abc import Callable
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

ILINK_BASE_URL = "https://ilinkai.weixin.qq.com"
# Must match Tencent iLink Bot API (same path as hermes-agent gateway/platforms/weixin.py).
EP_GET_BOT_QR = "ilink/bot/get_bot_qrcode"
EP_GET_QR_STATUS = "ilink/bot/get_qrcode_status"

QR_TIMEOUT_MS = 35_000

# After a dual-stack connect failure (common on Windows + aiohttp), use IPv4-only
# for the rest of the process unless EVOFLOW_ILINK_IPV4_ONLY=0 is set to opt out.
_ILINK_AUTO_IPV4: bool = False


def ilink_ipv4_only_preferred() -> bool:
    """Return True only when ``EVOFLOW_ILINK_IPV4_ONLY`` is set to enable (1/true/on).

    Default is **dual-stack** (no ``family=AF_INET`` on the connector).
    """
    import os

    v = (os.getenv("EVOFLOW_ILINK_IPV4_ONLY") or "").strip().lower()
    return v in ("1", "true", "yes", "on")


def ilink_ipv4_auto_disabled() -> bool:
    """Explicit ``EVOFLOW_ILINK_IPV4_ONLY=0`` disables automatic IPv4 fallback as well."""
    import os

    v = (os.getenv("EVOFLOW_ILINK_IPV4_ONLY") or "").strip().lower()
    return v in ("0", "false", "no", "off")


def _ilink_transport_error_may_benefit_ipv4(exc: BaseException) -> bool:
    """Heuristic: TCP/TLS failed before HTTP (often broken IPv6 / Schannel on Windows)."""
    try:
        import aiohttp

        if isinstance(exc, aiohttp.ClientConnectorError):
            return True
        if type(exc).__name__ == "ClientSSLError" and getattr(aiohttp, "ClientSSLError", None) is not None:
            if isinstance(exc, aiohttp.ClientSSLError):
                return True
    except ImportError:
        pass
    if isinstance(exc, (TimeoutError, asyncio.TimeoutError)):
        return False
    if isinstance(exc, OSError):
        we = getattr(exc, "winerror", None)
        if we in (64, 121, 1231, 10051, 10050):
            return True
    msg = str(exc).lower()
    if "cannot connect to host" in msg or "connection reset" in msg or "connection aborted" in msg:
        return True
    if "ssl:" in msg and "ilinkai" in msg:
        return True
    if "指定的网络名" in str(exc):
        return True
    return False


def enable_ilink_ipv4_fallback() -> bool:
    """Enable IPv4-only iLink connector for this process. Returns True if newly enabled."""
    global _ILINK_AUTO_IPV4
    if ilink_ipv4_auto_disabled():
        return False
    if ilink_ipv4_only_preferred():
        return False
    if _ILINK_AUTO_IPV4:
        return False
    _ILINK_AUTO_IPV4 = True
    logger.warning("iLink: switched to IPv4-only TCP connector (automatic fallback after connect error)")
    return True


def ilink_connect_failed_try_ipv4(exc: BaseException) -> bool:
    """If *exc* looks like a transport-layer failure, enable IPv4-only and return True to retry once."""
    if not _ilink_transport_error_may_benefit_ipv4(exc):
        return False
    return enable_ilink_ipv4_fallback()


def _certifi_cafile() -> str | None:
    """Resolve CA bundle path (PyInstaller frozen builds may not ship certifi.where() as a file)."""
    import os
    import sys

    try:
        import certifi
    except ImportError:
        return None
    cafile = certifi.where()
    if os.path.isfile(cafile):
        return cafile
    if getattr(sys, "frozen", False):
        meipass = getattr(sys, "_MEIPASS", None)
        if meipass:
            bundled = Path(meipass) / "certifi" / "cacert.pem"
            if bundled.is_file():
                return str(bundled)
    return None


def make_ilink_aiohttp_connector() -> Any:
    """``aiohttp.TCPConnector`` for Tencent iLink (TLS via certifi; optional IPv4-only via env)."""
    import socket
    import ssl

    import aiohttp

    kwargs: dict[str, Any] = {}
    if ilink_ipv4_only_preferred() or _ILINK_AUTO_IPV4:
        kwargs["family"] = socket.AF_INET
    cafile = _certifi_cafile()
    if cafile:
        kwargs["ssl"] = ssl.create_default_context(cafile=cafile)
    return aiohttp.TCPConnector(**kwargs)


def _weixin_home() -> Path:
    """Return the directory for storing weixin credentials."""
    import os

    home = (os.getenv("EVOFLOW_HOME") or "").strip()
    if home:
        return Path(home) / "weixin" / "accounts"
    # Fallback: use backend/.evo-flow (EvoFlow dev default)
    return Path(__file__).resolve().parent.parent.parent / ".evo-flow" / "weixin" / "accounts"


def _atomic_json_write(path: Path, payload: dict[str, Any]) -> None:
    """Write JSON atomically via temp file + rename."""
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(path)


async def _api_get(
    session: Any,
    *,
    base_url: str,
    endpoint: str,
    timeout_ms: int,
) -> dict[str, Any]:
    """HTTP GET to iLink API."""
    import aiohttp

    url = f"{base_url.rstrip('/')}/{endpoint}"
    headers = {
        "iLink-App-Id": "bot",
        "iLink-App-ClientVersion": str((2 << 16) | (2 << 8) | 0),
    }
    timeout = aiohttp.ClientTimeout(total=timeout_ms / 1000)
    async with session.get(url, headers=headers, timeout=timeout) as response:
        raw = await response.text()
        if not response.ok:
            raise RuntimeError(f"iLink GET {endpoint} HTTP {response.status}: {raw[:200]}")
        return json.loads(raw)


async def api_get_ilink_with_connect_retry(
    *,
    base_url: str,
    endpoint: str,
    timeout_ms: int,
) -> dict[str, Any]:
    """GET iLink URL; on transport failure retry once after enabling IPv4-only connector."""
    import aiohttp

    last_exc: BaseException | None = None
    for attempt in range(2):
        try:
            connector = make_ilink_aiohttp_connector()
            async with aiohttp.ClientSession(trust_env=True, connector=connector) as session:
                return await _api_get(session, base_url=base_url, endpoint=endpoint, timeout_ms=timeout_ms)
        except Exception as exc:
            last_exc = exc
            if attempt == 0 and _ilink_transport_error_may_benefit_ipv4(exc) and enable_ilink_ipv4_fallback():
                logger.warning("iLink GET retrying after: %s", exc)
                continue
            raise
    assert last_exc is not None
    raise last_exc


def print_qr_ascii(qr_data: str) -> None:
    """Render a QR code in the terminal using ASCII characters."""
    try:
        import qrcode as _qrcode

        qr = _qrcode.QRCode()
        qr.add_data(qr_data)
        qr.make(fit=True)
        qr.print_ascii(invert=True)
    except ImportError:
        pass
    except Exception:
        pass


def save_weixin_credentials(
    *,
    account_id: str,
    token: str,
    base_url: str,
    user_id: str = "",
) -> Path:
    """Persist weixin account credentials to disk."""
    home = _weixin_home()
    home.mkdir(parents=True, exist_ok=True)
    payload = {
        "token": token,
        "base_url": base_url,
        "user_id": user_id,
        "saved_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    path = home / f"{account_id}.json"
    _atomic_json_write(path, payload)
    try:
        path.chmod(0o600)
    except OSError:
        pass
    return path


def load_weixin_credentials(account_id: str) -> dict[str, Any] | None:
    """Load persisted weixin account credentials."""
    home = _weixin_home()
    path = home / f"{account_id}.json"
    if not path.exists():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return None


def load_first_weixin_credentials() -> dict[str, Any] | None:
    """Load credentials from the first available weixin account file."""
    home = _weixin_home()
    if not home.exists():
        return None
    for path in sorted(home.glob("*.json")):
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            if data.get("token"):
                return data
        except Exception:
            continue
    return None


async def qr_login(
    *,
    base_url: str = ILINK_BASE_URL,
    bot_type: str = "3",
    timeout_seconds: int = 480,
    on_qr: Callable[[str, str], None] | None = None,
) -> dict[str, str] | None:
    """
    Run the interactive iLink QR login flow.

    Args:
        base_url: iLink API base URL.
        bot_type: Bot type identifier (default "3").
        timeout_seconds: Max wait time for user to scan and confirm.
        on_qr: Optional callback invoked when QR code is generated.
               Receives (qr_url, qr_ascii_string).

    Returns:
        Credential dict on success: {account_id, token, base_url, user_id}.
        None if login fails or times out.
    """
    try:
        import aiohttp
    except ImportError:
        raise RuntimeError("aiohttp is required for Weixin QR login. Install: uv add aiohttp")

    try:
        qr_resp = await api_get_ilink_with_connect_retry(
            base_url=base_url,
            endpoint=f"{EP_GET_BOT_QR}?bot_type={bot_type}",
            timeout_ms=QR_TIMEOUT_MS,
        )
    except Exception as exc:
        logger.error("weixin: failed to fetch QR code: %s", exc)
        return None

    qrcode_value = str(qr_resp.get("qrcode") or "")
    qrcode_url = str(qr_resp.get("qrcode_img_content") or "")
    if not qrcode_value:
        logger.error("weixin: QR response missing qrcode")
        return None

    # The full URL is what WeChat needs to scan
    qr_scan_data = qrcode_url if qrcode_url else qrcode_value

    # Step 2: Display QR code
    print("\n" + "=" * 50)
    print("请使用微信扫描以下二维码：")
    print("Please scan the QR code with WeChat:")
    print("=" * 50)
    if qrcode_url:
        print(f"\n二维码链接 / QR URL: {qrcode_url}\n")

    qr_text = ""
    try:
        qr_text_list = []

        def _capture_ascii(text: str) -> None:
            qr_text_list.append(text)

        # Monkey-patch print to capture ASCII output
        import io
        import sys

        old_stdout = sys.stdout
        sys.stdout = io.StringIO()
        try:
            print_qr_ascii(qr_scan_data)
        finally:
            qr_text = sys.stdout.getvalue()
            sys.stdout = old_stdout

        if qr_text:
            print(qr_text)
        else:
            print("（终端二维码渲染失败，请打开上面的二维码链接）")
    except Exception:
        print("（请使用上面的二维码链接）")

    if on_qr:
        on_qr(qrcode_url, qr_text)

    connector = make_ilink_aiohttp_connector()
    async with aiohttp.ClientSession(trust_env=True, connector=connector) as session:
        # Step 3: Poll for QR status
        deadline = time.monotonic() + timeout_seconds
        current_base_url = base_url
        refresh_count = 0

        while time.monotonic() < deadline:
            try:
                status_resp = await _api_get(
                    session,
                    base_url=current_base_url,
                    endpoint=f"{EP_GET_QR_STATUS}?qrcode={qrcode_value}",
                    timeout_ms=QR_TIMEOUT_MS,
                )
            except TimeoutError:
                await asyncio.sleep(1)
                continue
            except Exception as exc:
                logger.warning("weixin: QR poll error: %s", exc)
                await asyncio.sleep(1)
                continue

            status = str(status_resp.get("status") or "wait")
            if status == "wait":
                print(".", end="", flush=True)
            elif status == "scaned":
                print("\n✓ 已扫码，请在微信里确认登录...")
                print("  Scanned. Please confirm login in WeChat...")
            elif status == "scaned_but_redirect":
                redirect_host = str(status_resp.get("redirect_host") or "")
                if redirect_host:
                    current_base_url = f"https://{redirect_host}"
            elif status == "expired":
                refresh_count += 1
                if refresh_count > 3:
                    print("\n✗ 二维码多次过期，请重新执行登录。")
                    print("  QR code expired too many times. Please run login again.")
                    return None
                print(f"\n二维码已过期，正在刷新... ({refresh_count}/3)")
                print("  QR expired, refreshing...")
                try:
                    qr_resp = await api_get_ilink_with_connect_retry(
                        base_url=base_url,
                        endpoint=f"{EP_GET_BOT_QR}?bot_type={bot_type}",
                        timeout_ms=QR_TIMEOUT_MS,
                    )
                    qrcode_value = str(qr_resp.get("qrcode") or "")
                    qrcode_url = str(qr_resp.get("qrcode_img_content") or "")
                    qr_scan_data = qrcode_url if qrcode_url else qrcode_value
                    if qrcode_url:
                        print(f"\n新二维码链接 / New QR URL: {qrcode_url}\n")
                    qr_text = ""
                    import io
                    import sys

                    old_stdout = sys.stdout
                    sys.stdout = io.StringIO()
                    try:
                        print_qr_ascii(qr_scan_data)
                    finally:
                        qr_text = sys.stdout.getvalue()
                        sys.stdout = old_stdout
                    if qr_text:
                        print(qr_text)
                except Exception as exc:
                    logger.error("weixin: QR refresh failed: %s", exc)
                    return None
            elif status == "confirmed":
                account_id = str(status_resp.get("ilink_bot_id") or "")
                token = str(status_resp.get("bot_token") or "")
                confirmed_base_url = str(status_resp.get("baseurl") or base_url)
                user_id = str(status_resp.get("ilink_user_id") or "")
                if not account_id or not token:
                    logger.error("weixin: QR confirmed but credential payload was incomplete")
                    return None
                save_weixin_credentials(
                    account_id=account_id,
                    token=token,
                    base_url=confirmed_base_url,
                    user_id=user_id,
                )
                print(f"\n✓ 微信连接成功！account_id={account_id}")
                print("  WeChat connected successfully!")
                return {
                    "account_id": account_id,
                    "token": token,
                    "base_url": confirmed_base_url,
                    "user_id": user_id,
                }
            await asyncio.sleep(1)

    print("\n✗ 微信登录超时。")
    print("  WeChat login timed out.")
    return None


def main() -> None:
    """CLI: ``cd backend && uv run python -m app.channels.weixin_setup``."""
    asyncio.run(qr_login())


if __name__ == "__main__":
    main()
