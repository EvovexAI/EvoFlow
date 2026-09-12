"""Weixin **个人微信** channel — iLink HTTP 长轮询（与 Hermes ``gateway/platforms/weixin.py`` 一致）。

企微 **AI Bot**（WebSocket + ``WECOM_BOT_ID``/``SECRET``）是另一套协议，见 Hermes ``wecom.py``；本模块不是企微适配器。
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import logging
import mimetypes
import os
import secrets
import struct
import tempfile
import time
import uuid
from pathlib import Path
from typing import Any

from app.channels.base import Channel
from app.channels.feishu_message_format import feishu_outbound_text
from app.channels.message_bus import InboundMessage, InboundMessageType, MessageBus, OutboundMessage, ResolvedAttachment
from app.channels.weixin_setup import ilink_connect_failed_try_ipv4, make_ilink_aiohttp_connector

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Constants (from hermes-agent iLink reference implementation)
# ---------------------------------------------------------------------------

ILINK_BASE_URL = "https://ilinkai.weixin.qq.com"
WEIXIN_CDN_BASE_URL = "https://novac2c.cdn.weixin.qq.com/c2c"
ILINK_APP_ID = "bot"
ILINK_APP_CLIENT_VERSION = (2 << 16) | (2 << 8) | 0
CHANNEL_VERSION = "2.2.0"

EP_GET_UPDATES = "ilink/bot/getupdates"
EP_SEND_MESSAGE = "ilink/bot/sendmessage"
EP_SEND_TYPING = "ilink/bot/sendtyping"
EP_GET_CONFIG = "ilink/bot/getconfig"
EP_GET_UPLOAD_URL = "ilink/bot/getuploadurl"

LONG_POLL_TIMEOUT_MS = 35_000
API_TIMEOUT_MS = 15_000
CONFIG_TIMEOUT_MS = 10_000

SESSION_EXPIRED_ERRCODE = -14
RATE_LIMIT_ERRCODE = -2
MAX_SEND_RETRIES = 5
MAX_CONSECUTIVE_FAILURES = 3
RETRY_DELAY_SECONDS = 2
BACKOFF_DELAY_SECONDS = 30
MESSAGE_DEDUP_TTL_SECONDS = 300

# Message item types
ITEM_TEXT = 1
ITEM_IMAGE = 2
ITEM_VOICE = 3
ITEM_FILE = 4
ITEM_VIDEO = 5

MSG_TYPE_USER = 1
MSG_TYPE_BOT = 2
MSG_STATE_FINISH = 2

TYPING_START = 1
TYPING_STOP = 2

TYPING_START = 1
TYPING_STOP = 2

# Media types for upload
MEDIA_IMAGE = 1
MEDIA_VIDEO = 2
MEDIA_FILE = 3
MEDIA_VOICE = 4


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _safe_id(value: str | None, keep: int = 8) -> str:
    raw = str(value or "").strip()
    if not raw:
        return "?"
    return raw[:keep] if len(raw) > keep else raw


def _json_dumps(payload: dict[str, Any]) -> str:
    return json.dumps(payload, ensure_ascii=False, separators=(",", ":"))


def _random_wechat_uin() -> str:
    value = struct.unpack(">I", secrets.token_bytes(4))[0]
    return base64.b64encode(str(value).encode("utf-8")).decode("ascii")


def _ilink_headers(token: str | None, body: str) -> dict[str, str]:
    headers = {
        "Content-Type": "application/json",
        "AuthorizationType": "ilink_bot_token",
        "Content-Length": str(len(body.encode("utf-8"))),
        "X-WECHAT-UIN": _random_wechat_uin(),
        "iLink-App-Id": ILINK_APP_ID,
        "iLink-App-ClientVersion": str(ILINK_APP_CLIENT_VERSION),
    }
    if token:
        headers["Authorization"] = f"Bearer {token}"
    return headers


def _pkcs7_pad(data: bytes, block_size: int = 16) -> bytes:
    pad_len = block_size - (len(data) % block_size)
    return data + bytes([pad_len] * pad_len)


def _aes128_ecb_encrypt(plaintext: bytes, key: bytes) -> bytes:
    from cryptography.hazmat.backends import default_backend
    from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes

    cipher = Cipher(algorithms.AES(key), modes.ECB(), backend=default_backend())
    encryptor = cipher.encryptor()
    return encryptor.update(_pkcs7_pad(plaintext)) + encryptor.finalize()


def _aes128_ecb_decrypt(ciphertext: bytes, key: bytes) -> bytes:
    from cryptography.hazmat.backends import default_backend
    from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes

    cipher = Cipher(algorithms.AES(key), modes.ECB(), backend=default_backend())
    decryptor = cipher.decryptor()
    padded = decryptor.update(ciphertext) + decryptor.finalize()
    if not padded:
        return padded
    pad_len = padded[-1]
    if 1 <= pad_len <= 16 and padded.endswith(bytes([pad_len]) * pad_len):
        return padded[:-pad_len]
    return padded


def _aes_padded_size(size: int) -> int:
    return ((size + 1 + 15) // 16) * 16


def _parse_aes_key(aes_key_b64: str) -> bytes:
    decoded = base64.b64decode(aes_key_b64)
    if len(decoded) == 16:
        return decoded
    if len(decoded) == 32:
        text = decoded.decode("ascii", errors="ignore")
        if text and all(ch in "0123456789abcdefABCDEF" for ch in text):
            return bytes.fromhex(text)
    raise ValueError(f"unexpected aes_key format ({len(decoded)} decoded bytes)")


def _extract_text(item_list: list[dict[str, Any]]) -> str:
    """Extract text content from iLink message item_list."""
    for item in item_list:
        if item.get("type") == ITEM_TEXT:
            text = str((item.get("text_item") or {}).get("text") or "")
            # Handle quoted/ref messages
            ref = item.get("ref_msg") or {}
            ref_item = ref.get("message_item") or {}
            if ref_item:
                ref_text = _extract_text([ref_item])
                ref_title = ref.get("title") or ""
                if ref_title or ref_text:
                    parts = [p for p in [ref_title, ref_text] if p]
                    text = f"[引用: {' | '.join(parts)}]\n{text}".strip()
            return text
    # Voice with transcription
    for item in item_list:
        if item.get("type") == ITEM_VOICE:
            voice_text = str((item.get("voice_item") or {}).get("text") or "")
            if voice_text:
                return voice_text
    return ""


def _guess_chat_type(message: dict[str, Any], account_id: str) -> tuple[str, str]:
    """Determine if a message is DM or group, return (chat_type, chat_id)."""
    del account_id  # group detection relies on explicit room_id only
    room_id = str(message.get("room_id") or message.get("chat_room_id") or "").strip()
    if room_id:
        return "group", room_id
    return "dm", str(message.get("from_user_id") or "")


def _message_type_from_media(media_types: list[str], text: str) -> InboundMessageType:
    if media_types or text.startswith("/"):
        return InboundMessageType.COMMAND if text.startswith("/") else InboundMessageType.CHAT
    return InboundMessageType.CHAT


def _cdn_download_url(cdn_base_url: str, encrypted_query_param: str) -> str:
    from urllib.parse import quote

    return f"{cdn_base_url.rstrip('/')}/download?encrypted_query_param={quote(encrypted_query_param, safe='')}"


def _cdn_upload_url(cdn_base_url: str, upload_param: str, filekey: str) -> str:
    from urllib.parse import quote

    return f"{cdn_base_url.rstrip('/')}/upload?encrypted_query_param={quote(upload_param, safe='')}&filekey={quote(filekey, safe='')}"


async def _send_typing(
    session: Any,
    *,
    base_url: str,
    token: str,
    to_user_id: str,
    typing_ticket: str,
    status: int,
) -> None:
    await _api_post(
        session,
        base_url=base_url,
        endpoint=EP_SEND_TYPING,
        payload={
            "ilink_user_id": to_user_id,
            "typing_ticket": typing_ticket,
            "status": status,
        },
        token=token,
        timeout_ms=CONFIG_TIMEOUT_MS,
    )


# ---------------------------------------------------------------------------
# Deduplication
# ---------------------------------------------------------------------------


class _MessageDeduplicator:
    """Simple in-memory message deduplication with TTL."""

    def __init__(self, ttl_seconds: int = MESSAGE_DEDUP_TTL_SECONDS):
        self._ttl = ttl_seconds
        self._seen: dict[str, float] = {}

    def is_duplicate(self, key: str) -> bool:
        now = time.time()
        self._cleanup(now)
        if key in self._seen:
            return True
        self._seen[key] = now
        return False

    def _cleanup(self, now: float) -> None:
        cutoff = now - self._ttl
        expired = [k for k, v in self._seen.items() if v < cutoff]
        for k in expired:
            del self._seen[k]


# ---------------------------------------------------------------------------
# ContextTokenStore — disk-backed context_token cache
# ---------------------------------------------------------------------------


class _ContextTokenStore:
    """Disk-backed context_token cache per account+peer."""

    def __init__(self, data_dir: Path):
        self._data_dir = data_dir
        self._cache: dict[str, str] = {}

    def _path(self, account_id: str) -> Path:
        return self._data_dir / f"{account_id}.context-tokens.json"

    def _key(self, account_id: str, user_id: str) -> str:
        return f"{account_id}:{user_id}"

    def restore(self, account_id: str) -> None:
        path = self._path(account_id)
        if not path.exists():
            return
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            for user_id, token in data.items():
                if isinstance(token, str) and token:
                    self._cache[self._key(account_id, user_id)] = token
        except Exception:
            pass

    def get(self, account_id: str, user_id: str) -> str | None:
        return self._cache.get(self._key(account_id, user_id))

    def set(self, account_id: str, user_id: str, token: str) -> None:
        self._cache[self._key(account_id, user_id)] = token
        self._persist(account_id)

    def _persist(self, account_id: str) -> None:
        prefix = f"{account_id}:"
        payload = {key[len(prefix) :]: value for key, value in self._cache.items() if key.startswith(prefix)}
        try:
            self._data_dir.mkdir(parents=True, exist_ok=True)
            path = self._path(account_id)
            tmp = path.with_suffix(".tmp")
            tmp.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
            tmp.replace(path)
        except Exception:
            pass


# ---------------------------------------------------------------------------
# TypingTicketCache
# ---------------------------------------------------------------------------


class _TypingTicketCache:
    """Short-lived typing ticket cache from getconfig."""

    def __init__(self, ttl_seconds: float = 600.0):
        self._ttl = ttl_seconds
        self._cache: dict[str, tuple[str, float]] = {}

    def get(self, user_id: str) -> str | None:
        entry = self._cache.get(user_id)
        if not entry:
            return None
        if time.time() - entry[1] >= self._ttl:
            self._cache.pop(user_id, None)
            return None
        return entry[0]

    def set(self, user_id: str, ticket: str) -> None:
        self._cache[user_id] = (ticket, time.time())


# ---------------------------------------------------------------------------
# API helpers
# ---------------------------------------------------------------------------


async def _api_post(
    session: Any,
    *,
    base_url: str,
    endpoint: str,
    payload: dict[str, Any],
    token: str | None,
    timeout_ms: int,
) -> dict[str, Any]:
    """HTTP POST to iLink API."""
    import aiohttp

    body = _json_dumps({**payload, "base_info": {"channel_version": CHANNEL_VERSION}})
    url = f"{base_url.rstrip('/')}/{endpoint}"
    timeout = aiohttp.ClientTimeout(total=timeout_ms / 1000)
    async with session.post(url, data=body, headers=_ilink_headers(token, body), timeout=timeout) as response:
        raw = await response.text()
        if not response.ok:
            raise RuntimeError(f"iLink POST {endpoint} HTTP {response.status}: {raw[:200]}")
        return json.loads(raw)


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
        "iLink-App-Id": ILINK_APP_ID,
        "iLink-App-ClientVersion": str(ILINK_APP_CLIENT_VERSION),
    }
    timeout = aiohttp.ClientTimeout(total=timeout_ms / 1000)
    async with session.get(url, headers=headers, timeout=timeout) as response:
        raw = await response.text()
        if not response.ok:
            raise RuntimeError(f"iLink GET {endpoint} HTTP {response.status}: {raw[:200]}")
        return json.loads(raw)


# ---------------------------------------------------------------------------
# WeixinChannel
# ---------------------------------------------------------------------------


class WeixinChannel(Channel):
    """Weixin (personal WeChat) channel via Tencent iLink Bot API.

    Uses HTTP long-polling for inbound messages — no public IP or webhook needed.
    Media files are transferred through an AES-128-ECB encrypted CDN.

    Configuration keys (in ``config.yaml`` under ``channels.weixin``):
        - ``account_id``: iLink Bot account ID (required, or auto-loaded from disk).
        - ``token``: iLink Bot token (required, or auto-loaded from disk).
        - ``base_url``: iLink API base URL (default: https://ilinkai.weixin.qq.com).
        - ``cdn_base_url``: CDN base URL (default: https://novac2c.cdn.weixin.qq.com/c2c).
        - Environment: optional ``EVOFLOW_ILINK_IPV4_ONLY=1`` to force IPv4-only aiohttp connector (default: dual-stack).
        - ``allowed_users``: (optional) Comma-separated user IDs. Empty = allow all.
        - ``group_policy``: Group handling — ``disabled`` (default), ``open``, ``allowlist``.
        - ``group_allowed_users``: (optional) Comma-separated group chat IDs.

    Credentials can be persisted automatically via ``weixin_setup.qr_login()``
    which saves them to ``{EVOFLOW_HOME}/weixin/accounts/<account_id>.json``.
    """

    MAX_MESSAGE_LENGTH = 2000

    def __init__(self, bus: MessageBus, config: dict[str, Any]) -> None:
        super().__init__(name="weixin", bus=bus, config=config)
        self._thread: asyncio.Task | None = None
        self._session: Any = None  # aiohttp.ClientSession
        self._dedup = _MessageDeduplicator(ttl_seconds=MESSAGE_DEDUP_TTL_SECONDS)
        self._typing_cache = _TypingTicketCache()
        self._token_store: _ContextTokenStore | None = None
        self._recent_outbound_fingerprint: dict[str, tuple[str, float]] = {}
        self._temp_media_paths: set[str] = set()

        # Resolve credentials: config > env > persisted file
        extra = config.get("extra", {}) if isinstance(config.get("extra"), dict) else {}
        self._account_id = str(extra.get("account_id") or config.get("account_id") or os.getenv("WEIXIN_ACCOUNT_ID", "")).strip()
        self._token = str(extra.get("token") or config.get("token") or os.getenv("WEIXIN_TOKEN", "")).strip()
        self._base_url = str(extra.get("base_url") or config.get("base_url") or os.getenv("WEIXIN_BASE_URL", ILINK_BASE_URL)).strip().rstrip("/")
        self._cdn_base_url = str(extra.get("cdn_base_url") or config.get("cdn_base_url") or os.getenv("WEIXIN_CDN_BASE_URL", WEIXIN_CDN_BASE_URL)).strip().rstrip("/")

        # Access policies
        self._dm_policy = str(extra.get("dm_policy") or os.getenv("WEIXIN_DM_POLICY", "open")).strip().lower()
        self._group_policy = str(extra.get("group_policy") or os.getenv("WEIXIN_GROUP_POLICY", "disabled")).strip().lower()

        allow_from = extra.get("allow_from") or extra.get("allowed_users") or os.getenv("WEIXIN_ALLOWED_USERS", "")
        group_allow_from = extra.get("group_allow_from") or extra.get("group_allowed_users") or os.getenv("WEIXIN_GROUP_ALLOWED_USERS", "")
        self._allow_from = self._coerce_list(allow_from)
        self._group_allow_from = self._coerce_list(group_allow_from)

        # Try loading persisted credentials if not configured
        if not self._token or not self._account_id:
            from app.channels.weixin_setup import load_first_weixin_credentials

            creds = load_first_weixin_credentials()
            if creds:
                if not self._account_id:
                    # Use the first account filename as account_id
                    from app.channels.weixin_setup import _weixin_home

                    home = _weixin_home()
                    for p in sorted(home.glob("*.json")):
                        self._account_id = p.stem
                        break
                if not self._token:
                    self._token = creds.get("token", "")
                if not self._base_url or self._base_url == ILINK_BASE_URL:
                    self._base_url = creds.get("base_url", self._base_url)

        # Init token store
        data_dir = self._data_dir()
        self._token_store = _ContextTokenStore(data_dir)

    @staticmethod
    def _coerce_list(value: Any) -> list[str]:
        if value is None:
            return []
        if isinstance(value, str):
            return [item.strip() for item in value.split(",") if item.strip()]
        if isinstance(value, (list, tuple, set)):
            return [str(item).strip() for item in value if str(item).strip()]
        return [str(value).strip()] if str(value).strip() else []

    def _data_dir(self) -> Path:
        """Directory for weixin account data (credentials, context tokens, sync buffer)."""
        import os

        home = (os.getenv("EVOFLOW_HOME") or "").strip()
        if home:
            return Path(home) / "weixin" / "accounts"
        return Path(__file__).resolve().parent.parent.parent / ".evo-flow" / "weixin" / "accounts"

    def _is_dm_allowed(self, sender_id: str) -> bool:
        if self._dm_policy == "disabled":
            return False
        if self._dm_policy == "allowlist":
            return sender_id in self._allow_from
        return True

    # -- lifecycle ---------------------------------------------------------

    async def start(self) -> None:
        if self._running:
            return

        try:
            import aiohttp
        except ImportError:
            logger.error("aiohttp is not installed. Install it with: uv add aiohttp")
            return

        try:
            from cryptography.hazmat.primitives.ciphers import Cipher  # noqa: F401
        except ImportError:
            logger.error("cryptography is not installed. Install it with: uv add cryptography")
            return

        if not self._token:
            logger.error("Weixin channel requires a token. Run the QR login or set WEIXIN_TOKEN.")
            return
        if not self._account_id:
            logger.error("Weixin channel requires an account_id. Run the QR login or set WEIXIN_ACCOUNT_ID.")
            return

        self._session = aiohttp.ClientSession(trust_env=True, connector=make_ilink_aiohttp_connector())
        self._token_store.restore(self._account_id)
        self._running = True
        self.bus.subscribe_outbound(self._on_outbound, channel_name=self.name)

        # Start poll loop in the current event loop
        self._thread = asyncio.create_task(self._poll_loop(), name="weixin-poll")
        logger.info("[Weixin] Connected account=%s base=%s", _safe_id(self._account_id), self._base_url)

    async def stop(self) -> None:
        self._running = False
        self.bus.unsubscribe_outbound(channel_name=self.name)

        if self._thread:
            self._thread.cancel()
            try:
                await self._thread
            except asyncio.CancelledError:
                pass
            self._thread = None

        await self._cleanup_all_temp_paths()

        if self._session and not self._session.closed:
            await self._session.close()
        self._session = None
        logger.info("[Weixin] Disconnected")

    # -- polling loop ------------------------------------------------------

    async def _poll_loop(self) -> None:
        sync_buf = self._load_sync_buf()
        timeout_ms = LONG_POLL_TIMEOUT_MS
        consecutive_failures = 0

        while self._running:
            try:
                response = await self._get_updates(sync_buf, timeout_ms)
                # Server can suggest a different timeout
                suggested = response.get("longpolling_timeout_ms")
                if isinstance(suggested, int) and suggested > 0:
                    timeout_ms = suggested

                ret = response.get("ret", 0)
                errcode = response.get("errcode", 0)
                if ret not in (0, None) or errcode not in (0, None):
                    if ret == SESSION_EXPIRED_ERRCODE or errcode == SESSION_EXPIRED_ERRCODE:
                        logger.error("[Weixin] Session expired; pausing for 10 minutes")
                        await asyncio.sleep(600)
                        consecutive_failures = 0
                        continue
                    consecutive_failures += 1
                    logger.warning(
                        "[Weixin] getUpdates failed ret=%s errcode=%s errmsg=%s (%d/%d)",
                        ret,
                        errcode,
                        response.get("errmsg", ""),
                        consecutive_failures,
                        MAX_CONSECUTIVE_FAILURES,
                    )
                    await asyncio.sleep(BACKOFF_DELAY_SECONDS if consecutive_failures >= MAX_CONSECUTIVE_FAILURES else RETRY_DELAY_SECONDS)
                    if consecutive_failures >= MAX_CONSECUTIVE_FAILURES:
                        consecutive_failures = 0
                    continue

                consecutive_failures = 0
                new_sync_buf = str(response.get("get_updates_buf") or "")
                if new_sync_buf:
                    sync_buf = new_sync_buf
                    self._save_sync_buf(sync_buf)

                for message in response.get("msgs") or []:
                    asyncio.create_task(self._process_message(message))
            except asyncio.CancelledError:
                break
            except Exception as exc:
                import aiohttp

                if self._session and self._running and ilink_connect_failed_try_ipv4(exc):
                    logger.warning("[Weixin] reconnecting iLink with IPv4-only after: %s", exc)
                    if not self._session.closed:
                        await self._session.close()
                    self._session = aiohttp.ClientSession(trust_env=True, connector=make_ilink_aiohttp_connector())
                    consecutive_failures = 0
                    continue
                consecutive_failures += 1
                logger.error("[Weixin] poll error (%d/%d): %s", consecutive_failures, MAX_CONSECUTIVE_FAILURES, exc)
                await asyncio.sleep(BACKOFF_DELAY_SECONDS if consecutive_failures >= MAX_CONSECUTIVE_FAILURES else RETRY_DELAY_SECONDS)
                if consecutive_failures >= MAX_CONSECUTIVE_FAILURES:
                    consecutive_failures = 0

    async def _get_updates(self, sync_buf: str, timeout_ms: int) -> dict[str, Any]:
        try:
            return await _api_post(
                self._session,
                base_url=self._base_url,
                endpoint=EP_GET_UPDATES,
                payload={"get_updates_buf": sync_buf},
                token=self._token,
                timeout_ms=timeout_ms,
            )
        except TimeoutError:
            return {"ret": 0, "msgs": [], "get_updates_buf": sync_buf}

    def _load_sync_buf(self) -> str:
        path = self._data_dir() / f"{self._account_id}.sync.json"
        if not path.exists():
            return ""
        try:
            return json.loads(path.read_text(encoding="utf-8")).get("get_updates_buf", "")
        except Exception:
            return ""

    def _save_sync_buf(self, sync_buf: str) -> None:
        path = self._data_dir() / f"{self._account_id}.sync.json"
        self._data_dir().mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(".tmp")
        tmp.write_text(json.dumps({"get_updates_buf": sync_buf}), encoding="utf-8")
        tmp.replace(path)

    # -- message processing ------------------------------------------------

    async def _process_message(self, message: dict[str, Any]) -> None:
        sender_id = str(message.get("from_user_id") or "").strip()
        if not sender_id or sender_id == self._account_id:
            return

        message_id = str(message.get("message_id") or "").strip()
        if message_id and self._dedup.is_duplicate(message_id):
            return

        item_list = message.get("item_list") or []
        text = _extract_text(item_list)

        chat_type, effective_chat_id = _guess_chat_type(message, self._account_id)

        # Group policy check
        if chat_type == "group":
            if self._group_policy == "disabled":
                return
            if self._group_policy == "allowlist" and effective_chat_id not in self._group_allow_from:
                return
        elif not self._is_dm_allowed(sender_id):
            return

        # Update context token
        context_token = str(message.get("context_token") or "").strip()
        if context_token and self._token_store:
            self._token_store.set(self._account_id, sender_id, context_token)

        # Fire-and-forget typing ticket fetch
        if context_token:
            asyncio.create_task(self._maybe_fetch_typing_ticket(sender_id, context_token))

        # Collect media files
        media_paths: list[str] = []
        media_types: list[str] = []
        for item in item_list:
            await self._collect_media(item, media_paths, media_types)
            ref_message = item.get("ref_msg") or {}
            ref_item = ref_message.get("message_item")
            if isinstance(ref_item, dict):
                await self._collect_media(ref_item, media_paths, media_types)

        if not text and not media_paths:
            return

        event = InboundMessage(
            channel_name=self.name,
            chat_id=effective_chat_id,
            user_id=sender_id,
            text=text,
            msg_type=_message_type_from_media(media_types, text),
            thread_ts=message_id or None,
            files=[],  # media_paths are local file paths, not platform dicts
            metadata={"chat_type": chat_type},
        )
        logger.info(
            "[Weixin] inbound from=%s chat_id=%s type=%s text_len=%d media=%d\n--- user ---\n%s\n---",
            _safe_id(sender_id),
            _safe_id(effective_chat_id),
            chat_type,
            len(text or ""),
            len(media_paths),
            (text or "").strip() or "(empty)",
        )
        asyncio.create_task(self.send_typing(sender_id))
        await self.bus.publish_inbound(event)
        if media_paths:
            asyncio.create_task(self._cleanup_temp_paths(list(media_paths)))

    async def _collect_media(
        self,
        item: dict[str, Any],
        media_paths: list[str],
        media_types: list[str],
    ) -> None:
        """Download media from item and cache locally."""
        if not self._session:
            return
        item_type = item.get("type")
        try:
            if item_type == ITEM_IMAGE:
                path = await self._download_image(item)
                if path:
                    media_paths.append(path)
                    media_types.append("image/jpeg")
            elif item_type == ITEM_VIDEO:
                path = await self._download_video(item)
                if path:
                    media_paths.append(path)
                    media_types.append("video/mp4")
            elif item_type == ITEM_FILE:
                path, mime = await self._download_file(item)
                if path:
                    media_paths.append(path)
                    media_types.append(mime)
            elif item_type == ITEM_VOICE:
                path = await self._download_voice(item)
                if path:
                    media_paths.append(path)
                    media_types.append("audio/silk")
        except Exception as exc:
            logger.warning("[Weixin] media download failed: %s", exc)

    async def _download_media_bytes(
        self,
        encrypted_query_param: str | None,
        aes_key_b64: str | None,
        full_url: str | None,
    ) -> bytes:
        """Download and optionally decrypt media from WeChat CDN."""
        import aiohttp

        if encrypted_query_param:
            url = _cdn_download_url(self._cdn_base_url, encrypted_query_param)
            timeout = aiohttp.ClientTimeout(total=60)
            async with self._session.get(url, timeout=timeout) as resp:
                resp.raise_for_status()
                raw = await resp.read()
        elif full_url:
            timeout = aiohttp.ClientTimeout(total=60)
            async with self._session.get(full_url, timeout=timeout) as resp:
                resp.raise_for_status()
                raw = await resp.read()
        else:
            raise RuntimeError("media item had neither encrypt_query_param nor full_url")

        if aes_key_b64:
            raw = _aes128_ecb_decrypt(raw, _parse_aes_key(aes_key_b64))
        return raw

    def _cache_bytes(self, data: bytes, suffix: str) -> str:
        """Write bytes to a temp file and return the path."""
        with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as f:
            f.write(data)
            path = f.name
        self._temp_media_paths.add(path)
        return path

    async def _cleanup_temp_paths(self, paths: list[str]) -> None:
        for path in paths:
            self._temp_media_paths.discard(path)
            try:
                os.unlink(path)
            except OSError as exc:
                logger.debug("[Weixin] failed to remove temp media %s: %s", path, exc)

    async def _cleanup_all_temp_paths(self) -> None:
        paths = list(self._temp_media_paths)
        self._temp_media_paths.clear()
        await self._cleanup_temp_paths(paths)

    async def _download_image(self, item: dict[str, Any]) -> str | None:
        media = (item.get("image_item") or {}).get("media") or {}
        aes_key = (item.get("image_item") or {}).get("aeskey")
        aes_key_b64 = None
        if aes_key:
            try:
                aes_key_b64 = base64.b64encode(bytes.fromhex(str(aes_key))).decode("ascii")
            except Exception:
                aes_key_b64 = media.get("aes_key")
        data = await self._download_media_bytes(
            encrypted_query_param=media.get("encrypt_query_param"),
            aes_key_b64=aes_key_b64,
            full_url=media.get("full_url"),
        )
        return self._cache_bytes(data, ".jpg")

    async def _download_video(self, item: dict[str, Any]) -> str | None:
        media = (item.get("video_item") or {}).get("media") or {}
        data = await self._download_media_bytes(
            encrypted_query_param=media.get("encrypt_query_param"),
            aes_key_b64=media.get("aes_key"),
            full_url=media.get("full_url"),
        )
        return self._cache_bytes(data, ".mp4")

    async def _download_file(self, item: dict[str, Any]) -> tuple[str | None, str]:
        file_item = item.get("file_item") or {}
        media = file_item.get("media") or {}
        filename = str(file_item.get("file_name") or "document.bin")
        mime = mimetypes.guess_type(filename)[0] or "application/octet-stream"
        data = await self._download_media_bytes(
            encrypted_query_param=media.get("encrypt_query_param"),
            aes_key_b64=media.get("aes_key"),
            full_url=media.get("full_url"),
        )
        return self._cache_bytes(data, f".{filename.rsplit('.', 1)[-1] if '.' in filename else 'bin'}"), mime

    async def _download_voice(self, item: dict[str, Any]) -> str | None:
        voice_item = item.get("voice_item") or {}
        if voice_item.get("text"):
            return None  # Has transcription, handled as text
        media = voice_item.get("media") or {}
        data = await self._download_media_bytes(
            encrypted_query_param=media.get("encrypt_query_param"),
            aes_key_b64=media.get("aes_key"),
            full_url=media.get("full_url"),
        )
        return self._cache_bytes(data, ".silk")

    async def _maybe_fetch_typing_ticket(self, user_id: str, context_token: str) -> None:
        if not self._session or self._typing_cache.get(user_id):
            return
        try:
            response = await _api_post(
                self._session,
                base_url=self._base_url,
                endpoint=EP_GET_CONFIG,
                payload={"ilink_user_id": user_id, "context_token": context_token},
                token=self._token,
                timeout_ms=CONFIG_TIMEOUT_MS,
            )
            ticket = str(response.get("typing_ticket") or "")
            if ticket:
                self._typing_cache.set(user_id, ticket)
        except Exception:
            pass

    async def send_typing(self, chat_id: str) -> None:
        if not self._session or not self._token:
            return
        typing_ticket = self._typing_cache.get(chat_id)
        if not typing_ticket:
            return
        try:
            await _send_typing(
                self._session,
                base_url=self._base_url,
                token=self._token,
                to_user_id=chat_id,
                typing_ticket=typing_ticket,
                status=TYPING_START,
            )
        except Exception as exc:
            logger.debug("[Weixin] typing start failed for %s: %s", _safe_id(chat_id), exc)

    @staticmethod
    def _api_response_ok(resp: dict[str, Any] | None) -> bool:
        if not resp:
            return False
        ret = resp.get("ret")
        errcode = resp.get("errcode")
        if (ret is not None and ret != 0) or (errcode is not None and errcode != 0):
            return False
        return True

    # -- outbound messaging ------------------------------------------------

    async def send(self, msg: OutboundMessage) -> None:
        if not self._session or not self._token:
            return

        # Weixin only supports complete messages (no Feishu-style card patch stream).
        if not msg.is_final:
            return

        text = feishu_outbound_text(msg.text or "")
        logger.info(
            "[Weixin] outbound chat_id=%s thread_id=%s text_len=%d chunks=%d\n--- assistant ---\n%s\n---",
            _safe_id(msg.chat_id),
            msg.thread_id,
            len(text),
            max(1, len(self._split_text(text))),
            text.strip() or "(empty)",
        )
        now = time.monotonic()
        text_hash = hashlib.sha256(text.encode()).hexdigest()[:16]
        fp_key = f"{msg.chat_id}:{msg.thread_id}:{text_hash}"
        last = self._recent_outbound_fingerprint.get(fp_key)
        if last and (now - last[1]) < 8.0:
            logger.info("[Weixin] skip duplicate outbound: chat_id=%s thread_id=%s", _safe_id(msg.chat_id), msg.thread_id)
            return
        self._recent_outbound_fingerprint[fp_key] = (text_hash, now)

        context_token = self._token_store.get(self._account_id, msg.chat_id) if self._token_store else None
        client_id = f"evoflow-weixin-{uuid.uuid4().hex}"

        chunks = self._split_text(text)
        idx = 0
        while idx < len(chunks):
            chunk = chunks[idx]
            sent_ok = False
            for _attempt in range(MAX_SEND_RETRIES):
                try:
                    resp = await _api_post(
                        self._session,
                        base_url=self._base_url,
                        endpoint=EP_SEND_MESSAGE,
                        payload={
                            "msg": {
                                "from_user_id": "",
                                "to_user_id": msg.chat_id,
                                "client_id": f"{client_id}-{idx}",
                                "message_type": MSG_TYPE_BOT,
                                "message_state": MSG_STATE_FINISH,
                                "item_list": [{"type": ITEM_TEXT, "text_item": {"text": chunk}}],
                                **({"context_token": context_token} if context_token else {}),
                            }
                        },
                        token=self._token,
                        timeout_ms=API_TIMEOUT_MS,
                    )
                    if self._api_response_ok(resp):
                        sent_ok = True
                        break
                    ret = resp.get("ret") if resp else None
                    errcode = resp.get("errcode") if resp else None
                    is_expired = ret == SESSION_EXPIRED_ERRCODE or errcode == SESSION_EXPIRED_ERRCODE
                    if is_expired and context_token:
                        context_token = None
                        logger.warning(
                            "[Weixin] session expired for %s; retrying without token",
                            _safe_id(msg.chat_id),
                        )
                        continue
                    if ret == RATE_LIMIT_ERRCODE or errcode == RATE_LIMIT_ERRCODE:
                        await asyncio.sleep(3)
                        continue
                    errmsg = (resp or {}).get("errmsg") or (resp or {}).get("msg") or "unknown error"
                    logger.warning("[Weixin] send error: ret=%s errcode=%s errmsg=%s", ret, errcode, errmsg)
                    break
                except Exception as exc:
                    logger.warning("[Weixin] send chunk failed: %s", exc)
                    break
            else:
                logger.warning("[Weixin] chunk %d dropped after %d retries", idx, MAX_SEND_RETRIES)
            if sent_ok and idx < len(chunks) - 1:
                await asyncio.sleep(0.3)
            idx += 1

    async def send_file(self, msg: OutboundMessage, attachment: ResolvedAttachment) -> bool:
        """Send a file via encrypted CDN upload."""
        if not self._session or not self._token:
            return False

        try:
            plaintext = attachment.actual_path.read_bytes()
            mime = attachment.mime_type

            # Determine media type
            if mime.startswith("image/"):
                media_type = MEDIA_IMAGE
            elif mime.startswith("video/"):
                media_type = MEDIA_VIDEO
            else:
                media_type = MEDIA_FILE

            filekey = secrets.token_hex(16)
            aes_key = secrets.token_bytes(16)
            rawsize = len(plaintext)
            rawfilemd5 = hashlib.md5(plaintext).hexdigest()

            upload_resp = await _api_post(
                self._session,
                base_url=self._base_url,
                endpoint=EP_GET_UPLOAD_URL,
                payload={
                    "filekey": filekey,
                    "media_type": media_type,
                    "to_user_id": msg.chat_id,
                    "rawsize": rawsize,
                    "rawfilemd5": rawfilemd5,
                    "filesize": _aes_padded_size(rawsize),
                    "aeskey": aes_key.hex(),
                    "no_need_thumb": True,
                },
                token=self._token,
                timeout_ms=API_TIMEOUT_MS,
            )

            upload_param = str(upload_resp.get("upload_param") or "")
            upload_full_url = str(upload_resp.get("upload_full_url") or "")

            if upload_full_url:
                upload_url = upload_full_url
            elif upload_param:
                upload_url = _cdn_upload_url(self._cdn_base_url, upload_param, filekey)
            else:
                logger.warning("[Weixin] getUploadUrl returned no upload URL")
                return False

            ciphertext = _aes128_ecb_encrypt(plaintext, aes_key)

            # Upload ciphertext to CDN
            import aiohttp

            timeout = aiohttp.ClientTimeout(total=120)
            async with self._session.post(
                upload_url,
                data=ciphertext,
                headers={"Content-Type": "application/octet-stream"},
                timeout=timeout,
            ) as resp:
                if resp.status != 200:
                    raw = await resp.text()
                    raise RuntimeError(f"CDN upload HTTP {resp.status}: {raw[:200]}")
                encrypted_param = resp.headers.get("x-encrypted-param")
                if not encrypted_param:
                    raise RuntimeError("CDN upload missing x-encrypted-param header")
                await resp.read()

            # Build media item and send
            context_token = self._token_store.get(self._account_id, msg.chat_id) if self._token_store else None
            client_id = f"evoflow-weixin-{uuid.uuid4().hex}"

            # iLink API expects aes_key as base64(hex_string)
            aes_key_for_api = base64.b64encode(aes_key.hex().encode("ascii")).decode("ascii")

            if mime.startswith("image/"):
                media_item = {
                    "type": ITEM_IMAGE,
                    "image_item": {
                        "media": {
                            "encrypt_query_param": encrypted_param,
                            "aes_key": aes_key_for_api,
                            "encrypt_type": 1,
                        },
                        "mid_size": len(ciphertext),
                    },
                }
            else:
                media_item = {
                    "type": ITEM_FILE,
                    "file_item": {
                        "media": {
                            "encrypt_query_param": encrypted_param,
                            "aes_key": aes_key_for_api,
                            "encrypt_type": 1,
                        },
                        "file_name": attachment.filename,
                        "len": str(rawsize),
                    },
                }

            await _api_post(
                self._session,
                base_url=self._base_url,
                endpoint=EP_SEND_MESSAGE,
                payload={
                    "msg": {
                        "from_user_id": "",
                        "to_user_id": msg.chat_id,
                        "client_id": client_id,
                        "message_type": MSG_TYPE_BOT,
                        "message_state": MSG_STATE_FINISH,
                        "item_list": [media_item],
                        **({"context_token": context_token} if context_token else {}),
                    }
                },
                token=self._token,
                timeout_ms=API_TIMEOUT_MS,
            )
            logger.info("[Weixin] file sent: %s to chat=%s", attachment.filename, msg.chat_id)
            return True
        except Exception:
            logger.exception("[Weixin] failed to send file: %s", attachment.filename)
            return False

    def _split_text(self, content: str) -> list[str]:
        """Split content into messages respecting MAX_MESSAGE_LENGTH."""
        if not content:
            return []
        if len(content) <= self.MAX_MESSAGE_LENGTH:
            return [content]

        chunks: list[str] = []
        current = ""
        for line in content.splitlines():
            candidate = f"{current}\n{line}" if current else line
            if len(candidate) <= self.MAX_MESSAGE_LENGTH:
                current = candidate
            else:
                if current:
                    chunks.append(current)
                    current = ""
                # Long single line — hard split
                while len(line) > self.MAX_MESSAGE_LENGTH:
                    chunks.append(line[: self.MAX_MESSAGE_LENGTH])
                    line = line[self.MAX_MESSAGE_LENGTH :]
                if line:
                    current = line
        if current:
            chunks.append(current)
        return [c for c in chunks if c]
