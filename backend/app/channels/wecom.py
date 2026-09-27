"""WeCom (Enterprise WeChat) channel for EvoFlow.

Connects to WeCom via the **AI Bot WebSocket gateway** (出站长连接，无需公网 IP) —
same protocol family as hermes-agent's ``plugins/platforms/wecom/adapter.py``:

- authenticate via ``aibot_subscribe``
- receive inbound ``aibot_msg_callback`` / ``aibot_event_callback`` events
- send outbound markdown via ``aibot_send_msg`` (DM) / ``aibot_respond_msg`` (groups)
- upload outbound media via ``aibot_upload_media_init/chunk/finish``
- best-effort download of inbound image/file attachments for agent context

Configuration (``config.yaml`` under ``channels.wecom``):

    channels:
      wecom:
        enabled: true
        bot_id: "your-bot-id"          # or WECOM_BOT_ID env var
        secret: "your-secret"          # or WECOM_SECRET env var
        websocket_url: "wss://openws.work.weixin.qq.com"
        dm_policy: "pairing"           # open | allowlist | disabled | pairing
        allow_from: ["user_id_1"]
        group_policy: "pairing"        # open | allowlist | disabled | pairing
        group_allow_from: ["group_id_1"]

The channel uses only outbound connections, so no public endpoint / webhook is
required.  Media decryption uses the ``cryptography`` package (already a backend
dependency).
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import logging
import mimetypes
import os
import re
import time
import uuid
from pathlib import Path
from typing import Any
from urllib.parse import unquote, urlparse

import aiohttp

from app.channels.base import Channel
from app.channels.feishu_message_format import feishu_outbound_text
from app.channels.message_bus import InboundMessage, InboundMessageType, MessageBus, OutboundMessage, ResolvedAttachment

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Protocol constants (WeCom AI Bot WebSocket API)
# ---------------------------------------------------------------------------

DEFAULT_WS_URL = "wss://openws.work.weixin.qq.com"

APP_CMD_SUBSCRIBE = "aibot_subscribe"
APP_CMD_CALLBACK = "aibot_msg_callback"
APP_CMD_LEGACY_CALLBACK = "aibot_callback"
APP_CMD_EVENT_CALLBACK = "aibot_event_callback"
APP_CMD_SEND = "aibot_send_msg"
APP_CMD_RESPONSE = "aibot_respond_msg"
APP_CMD_PING = "ping"
APP_CMD_UPLOAD_MEDIA_INIT = "aibot_upload_media_init"
APP_CMD_UPLOAD_MEDIA_CHUNK = "aibot_upload_media_chunk"
APP_CMD_UPLOAD_MEDIA_FINISH = "aibot_upload_media_finish"

CALLBACK_COMMANDS = {APP_CMD_CALLBACK, APP_CMD_LEGACY_CALLBACK}
NON_RESPONSE_COMMANDS = CALLBACK_COMMANDS | {APP_CMD_EVENT_CALLBACK}

MAX_MESSAGE_LENGTH = 4000
CONNECT_TIMEOUT_SECONDS = 20.0
REQUEST_TIMEOUT_SECONDS = 15.0
HEARTBEAT_INTERVAL_SECONDS = 30.0
RECONNECT_BACKOFF = [2, 5, 10, 30, 60]

DEDUP_MAX_SIZE = 1000

IMAGE_MAX_BYTES = 10 * 1024 * 1024
VIDEO_MAX_BYTES = 10 * 1024 * 1024
VOICE_MAX_BYTES = 2 * 1024 * 1024
FILE_MAX_BYTES = 20 * 1024 * 1024
ABSOLUTE_MAX_BYTES = FILE_MAX_BYTES
UPLOAD_CHUNK_SIZE = 512 * 1024
MAX_UPLOAD_CHUNKS = 100
VOICE_SUPPORTED_MIMES = {"audio/amr"}

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _coerce_list(value: Any) -> list[str]:
    """Coerce config values into a trimmed string list."""
    if value is None:
        return []
    if isinstance(value, str):
        return [item.strip() for item in value.split(",") if item.strip()]
    if isinstance(value, (list, tuple, set)):
        return [str(item).strip() for item in value if str(item).strip()]
    return [str(value).strip()] if str(value).strip() else []


def _normalize_entry(raw: str) -> str:
    """Normalize allowlist entries such as ``wecom:user:foo``."""
    value = str(raw).strip()
    value = re.sub(r"^wecom:", "", value, flags=re.IGNORECASE)
    value = re.sub(r"^(user|group):", "", value, flags=re.IGNORECASE)
    return value.strip()


def _entry_matches(entries: list[str], target: str) -> bool:
    """Case-insensitive allowlist match with ``*`` support."""
    normalized_target = str(target).strip().lower()
    for entry in entries:
        normalized = _normalize_entry(entry).lower()
        if normalized == "*" or normalized == normalized_target:
            return True
    return False


# ---------------------------------------------------------------------------
# In-memory message deduplication
# ---------------------------------------------------------------------------


class _MessageDeduplicator:
    """Simple in-memory dedup with TTL for WeCom redeliveries."""

    def __init__(self, ttl_seconds: float = 300.0, max_size: int = DEDUP_MAX_SIZE):
        self._ttl = ttl_seconds
        self._max_size = max_size
        self._seen: dict[str, float] = {}

    def is_duplicate(self, key: str) -> bool:
        now = time.time()
        self._cleanup(now)
        if key in self._seen:
            return True
        self._seen[key] = now
        while len(self._seen) > self._max_size:
            self._seen.pop(next(iter(self._seen)), None)
        return False

    def clear(self) -> None:
        self._seen.clear()

    def _cleanup(self, now: float) -> None:
        cutoff = now - self._ttl
        expired = [k for k, v in self._seen.items() if v < cutoff]
        for k in expired:
            self._seen.pop(k, None)


# ---------------------------------------------------------------------------
# WecomChannel
# ---------------------------------------------------------------------------


class WecomChannel(Channel):
    """WeCom (Enterprise WeChat) channel via AI Bot WebSocket gateway.

    Uses an outbound persistent WebSocket — no public IP or webhook needed,
    matching the EvoFlow Feishu/Weixin "all outbound connections" philosophy.

    Supports **per-employee bot binding** via ``account_id``:
    - ``account_id == ""`` (default) → "primary bot" (no employee bound). Messages
      flow through ``ChannelManager`` with ``metadata.account_id == ""`` and fall
      through to the default ``assistant_id`` (``lead_agent`` — the main agent).
    - ``account_id == "<agent_code>"`` → employee bot. The same field is stamped
      on every inbound message so the manager can route to that employee.
    """

    MAX_MESSAGE_LENGTH = MAX_MESSAGE_LENGTH
    SUPPORTS_MESSAGE_EDITING = False
    _SPLIT_THRESHOLD = 3900

    def __init__(
        self,
        bus: MessageBus,
        config: dict[str, Any],
        *,
        account_id: str = "",
    ) -> None:
        super().__init__(name="wecom", bus=bus, config=config)
        # Per-employee binding: "" = primary (no employee), "<code>" = proactive role agent_code.
        # Backwards compatible — old callers that pass only ``(bus, config)`` keep the empty
        # account_id and behave exactly as before this refactor.
        self._account_id: str = str(account_id or "").strip()

        extra = config.get("extra") if isinstance(config.get("extra"), dict) else {}
        self._bot_id = str(extra.get("bot_id") or config.get("bot_id") or os.getenv("WECOM_BOT_ID", "")).strip()
        self._secret = str(extra.get("secret") or config.get("secret") or os.getenv("WECOM_SECRET", "")).strip()
        self._ws_url = str(
            extra.get("websocket_url")
            or config.get("websocket_url")
            or os.getenv("WECOM_WEBSOCKET_URL", DEFAULT_WS_URL)
        ).strip() or DEFAULT_WS_URL

        self._dm_policy = str(extra.get("dm_policy") or config.get("dm_policy") or os.getenv("WECOM_DM_POLICY", "pairing")).strip().lower()
        self._allow_from = _coerce_list(
            extra.get("allow_from")
            or config.get("allow_from")
            or os.getenv("WECOM_ALLOWED_USERS", "")
        )
        self._group_policy = str(extra.get("group_policy") or config.get("group_policy") or os.getenv("WECOM_GROUP_POLICY", "pairing")).strip().lower()
        self._group_allow_from = _coerce_list(extra.get("group_allow_from") or config.get("group_allow_from"))
        self._groups = config.get("groups") if isinstance(config.get("groups"), dict) else {}

        # WebSocket session / state
        self._session: aiohttp.ClientSession | None = None
        self._ws: aiohttp.ClientWebSocketResponse | None = None
        self._listen_task: asyncio.Task | None = None
        self._heartbeat_task: asyncio.Task | None = None
        self._pending_responses: dict[str, asyncio.Future] = {}
        self._dedup = _MessageDeduplicator()
        self._reply_req_ids: dict[str, str] = {}
        self._last_chat_req_ids: dict[str, str] = {}
        self._device_id = uuid.uuid4().hex

        # Text batching: WeCom clients split long messages near 4000 chars.
        self._text_batch_delay_seconds = 0.6
        self._text_batch_split_delay_seconds = 2.0
        self._pending_text_batches: dict[str, InboundMessage] = {}
        self._pending_text_batch_tasks: dict[str, asyncio.Task] = {}
        self._temp_media_paths: set[str] = set()

        self.store = None

    # ------------------------------------------------------------------
    # Credential / policy helpers
    # ------------------------------------------------------------------

    def _is_dm_intake_allowed(self, sender_id: str) -> bool:
        principal = str(sender_id or "").strip()
        if not principal:
            return False
        if self._dm_policy == "disabled":
            return False
        if self._dm_policy == "allowlist":
            return _entry_matches(self._allow_from, principal)
        if self._dm_policy == "pairing":
            return True
        if self._dm_policy == "open":
            return True
        return False

    def _is_group_allowed(self, chat_id: str, sender_id: str) -> bool:
        if self._group_policy == "disabled":
            return False
        if self._group_policy == "allowlist" and not _entry_matches(self._group_allow_from, chat_id):
            return False

        group_cfg = self._resolve_group_cfg(chat_id)
        sender_allow = _coerce_list(group_cfg.get("allow_from") or group_cfg.get("allowFrom"))
        if sender_allow:
            return _entry_matches(sender_allow, sender_id)
        # Default (``pairing`` and ``open``): accept group messages from any sender.
        # Pairing model in WeCom means the bot itself is "paired" with the group by the
        # admin installing the bot into the group; once installed, everyone in the
        # group can talk to it. Sender-level allowlists above still gate traffic.
        return True

    def _resolve_group_cfg(self, chat_id: str) -> dict[str, Any]:
        if not isinstance(self._groups, dict):
            return {}
        if chat_id in self._groups and isinstance(self._groups[chat_id], dict):
            return self._groups[chat_id]
        lowered = chat_id.lower()
        for key, value in self._groups.items():
            if isinstance(key, str) and key.lower() == lowered and isinstance(value, dict):
                return value
        wildcard = self._groups.get("*")
        return wildcard if isinstance(wildcard, dict) else {}

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------

    def _log_prefix(self) -> str:
        """Stable log tag identifying which bot a line belongs to."""
        return f"[Wecom:{self._account_id or 'primary'}]"

    def _diag_log(self, event: str, **fields: Any) -> None:
        """Write a diagnostic line to ~/.evoflow-dev/logs/wecom-diag.log.

        Independent of uvicorn/logger pipeline so we always see traffic even
        when the launcher drops stderr or root logger isn't configured.
        """
        try:
            from pathlib import Path
            import json as _json
            import time as _time
            log_dir = Path(os.environ.get("EVOFLOW_LOG_DIR", r"C:\Users\admin\.evoflow-dev\logs"))
            log_dir.mkdir(parents=True, exist_ok=True)
            line = _json.dumps(
                {"ts": _time.time(), "pid": os.getpid(), "event": event, **fields},
                ensure_ascii=False,
                default=str,
            )
            with open(log_dir / "wecom-diag.log", "a", encoding="utf-8") as fp:
                fp.write(line + "\n")
        except Exception:
            pass

    async def start(self) -> None:
        if self._running:
            return
        if not self._bot_id or not self._secret:
            self._diag_log("start_skipped", reason="missing bot_id or secret")
            logger.error("%s requires bot_id and secret (config or WECOM_BOT_ID/WECOM_SECRET)", self._log_prefix())
            return

        self._session = aiohttp.ClientSession(trust_env=True)
        self._running = True
        self.bus.subscribe_outbound(self._on_outbound, channel_name=self.name)
        self._diag_log("start_ok", bot_id=self._bot_id[:8], ws_url=self._ws_url, account_id=self._account_id)

        # WebSocket connect/retry runs in a background task — never blocks gateway boot.
        self._listen_task = asyncio.create_task(self._listen_loop(), name="wecom-ws")
        self._heartbeat_task = asyncio.create_task(self._heartbeat_loop(), name="wecom-heartbeat")
        logger.info("%s starting (bot_id=%s ws=%s)", self._log_prefix(), self._bot_id[:8], self._ws_url)

    async def stop(self) -> None:
        self._running = False
        self.bus.unsubscribe_outbound(channel_name=self.name)

        if self._listen_task:
            self._listen_task.cancel()
            try:
                await self._listen_task
            except asyncio.CancelledError:
                pass
            self._listen_task = None

        if self._heartbeat_task:
            self._heartbeat_task.cancel()
            try:
                await self._heartbeat_task
            except asyncio.CancelledError:
                pass
            self._heartbeat_task = None

        self._fail_pending_responses(RuntimeError("WeCom adapter disconnected"))
        await self._cleanup_ws()
        if self._session and not self._session.closed:
            await self._session.close()
        self._session = None
        self._dedup.clear()
        await self._cleanup_all_temp_paths()
        logger.info("%s stopped", self._log_prefix())

    async def _cleanup_ws(self) -> None:
        if self._ws and not self._ws.closed:
            await self._ws.close()
        self._ws = None

    async def _open_connection(self) -> None:
        """Open and authenticate a websocket connection."""
        if not self._session:
            self._session = aiohttp.ClientSession(trust_env=True)
        await self._cleanup_ws()
        self._ws = await self._session.ws_connect(
            self._ws_url,
            heartbeat=HEARTBEAT_INTERVAL_SECONDS * 2,
            timeout=CONNECT_TIMEOUT_SECONDS,
        )

        req_id = self._new_req_id("subscribe")
        await self._send_json(
            {
                "cmd": APP_CMD_SUBSCRIBE,
                "headers": {"req_id": req_id},
                "body": {
                    "bot_id": self._bot_id,
                    "secret": self._secret,
                    "device_id": self._device_id,
                },
            }
        )

        auth_payload = await self._wait_for_handshake(req_id)
        errcode = auth_payload.get("errcode", 0)
        if errcode not in {0, None}:
            errmsg = auth_payload.get("errmsg", "authentication failed")
            raise RuntimeError(f"{errmsg} (errcode={errcode})")

    async def _wait_for_handshake(self, req_id: str) -> dict[str, Any]:
        if not self._ws:
            raise RuntimeError("WebSocket not initialized")

        deadline = asyncio.get_running_loop().time() + CONNECT_TIMEOUT_SECONDS
        while True:
            remaining = deadline - asyncio.get_running_loop().time()
            if remaining <= 0:
                raise TimeoutError("Timed out waiting for WeCom subscribe acknowledgement")

            msg = await asyncio.wait_for(self._ws.receive(), timeout=remaining)
            if msg.type == aiohttp.WSMsgType.TEXT:
                payload = self._parse_json(msg.data)
                if not payload:
                    continue
                if payload.get("cmd") == APP_CMD_PING:
                    continue
                if self._payload_req_id(payload) == req_id:
                    return payload
                logger.debug("[Wecom] ignoring pre-auth payload: %s", payload.get("cmd"))
            elif msg.type in {aiohttp.WSMsgType.CLOSED, aiohttp.WSMsgType.CLOSE, aiohttp.WSMsgType.ERROR}:
                raise RuntimeError("WeCom websocket closed during authentication")

    async def _listen_loop(self) -> None:
        """Read websocket events forever, reconnecting on errors."""
        backoff_idx = 0
        while self._running:
            try:
                await self._open_connection()
                backoff_idx = 0
                logger.info("[Wecom] connected to %s", self._ws_url)
                await self._read_events()
            except asyncio.CancelledError:
                return
            except Exception as exc:
                if not self._running:
                    return
                logger.warning("[Wecom] websocket error: %s", exc)
                self._fail_pending_responses(RuntimeError("WeCom connection interrupted"))

                delay = RECONNECT_BACKOFF[min(backoff_idx, len(RECONNECT_BACKOFF) - 1)]
                backoff_idx += 1
                await asyncio.sleep(delay)

    async def _read_events(self) -> None:
        if not self._ws:
            raise RuntimeError("WebSocket not connected")

        while self._running and self._ws and not self._ws.closed:
            msg = await self._ws.receive()
            if msg.type == aiohttp.WSMsgType.TEXT:
                payload = self._parse_json(msg.data)
                if payload:
                    await self._dispatch_payload(payload)
            elif msg.type in {aiohttp.WSMsgType.CLOSE, aiohttp.WSMsgType.CLOSED, aiohttp.WSMsgType.ERROR, aiohttp.WSMsgType.CLOSING}:
                raise RuntimeError("WeCom websocket closed")

    async def _heartbeat_loop(self) -> None:
        """Send lightweight application-level pings."""
        try:
            while self._running:
                await asyncio.sleep(HEARTBEAT_INTERVAL_SECONDS)
                if not self._ws or self._ws.closed:
                    continue
                try:
                    await self._send_json(
                        {
                            "cmd": APP_CMD_PING,
                            "headers": {"req_id": self._new_req_id("ping")},
                            "body": {},
                        }
                    )
                except Exception as exc:
                    logger.debug("[Wecom] heartbeat send failed: %s", exc)
        except asyncio.CancelledError:
            pass

    async def _dispatch_payload(self, payload: dict[str, Any]) -> None:
        """Route inbound websocket payloads."""
        req_id = self._payload_req_id(payload)
        cmd = str(payload.get("cmd") or "")

        if req_id and req_id in self._pending_responses and cmd not in NON_RESPONSE_COMMANDS:
            future = self._pending_responses.get(req_id)
            if future and not future.done():
                future.set_result(payload)
            return

        if cmd in CALLBACK_COMMANDS:
            await self._on_message(payload)
            return
        if cmd in {APP_CMD_PING, APP_CMD_EVENT_CALLBACK}:
            return

        logger.debug("[Wecom] ignoring websocket payload: %s", cmd or payload)

    def _fail_pending_responses(self, exc: Exception) -> None:
        for req_id, future in list(self._pending_responses.items()):
            if not future.done():
                future.set_exception(exc)
            self._pending_responses.pop(req_id, None)

    async def _send_json(self, payload: dict[str, Any]) -> None:
        if not self._ws or self._ws.closed:
            raise RuntimeError("WeCom websocket is not connected")
        await self._ws.send_json(payload)

    async def _send_request(self, cmd: str, body: dict[str, Any], timeout: float = REQUEST_TIMEOUT_SECONDS) -> dict[str, Any]:
        if not self._ws or self._ws.closed:
            raise RuntimeError("WeCom websocket is not connected")

        req_id = self._new_req_id(cmd)
        future = asyncio.get_running_loop().create_future()
        self._pending_responses[req_id] = future
        try:
            await self._send_json({"cmd": cmd, "headers": {"req_id": req_id}, "body": body})
            response = await asyncio.wait_for(future, timeout=timeout)
            return response
        finally:
            self._pending_responses.pop(req_id, None)

    async def _send_reply_request(
        self,
        reply_req_id: str,
        body: dict[str, Any],
        cmd: str = APP_CMD_RESPONSE,
        timeout: float = REQUEST_TIMEOUT_SECONDS,
    ) -> dict[str, Any]:
        if not self._ws or self._ws.closed:
            raise RuntimeError("WeCom websocket is not connected")

        normalized_req_id = str(reply_req_id or "").strip()
        if not normalized_req_id:
            raise ValueError("reply_req_id is required")

        future = asyncio.get_running_loop().create_future()
        self._pending_responses[normalized_req_id] = future
        try:
            await self._send_json(
                {"cmd": cmd, "headers": {"req_id": normalized_req_id}, "body": body}
            )
            response = await asyncio.wait_for(future, timeout=timeout)
            return response
        finally:
            self._pending_responses.pop(normalized_req_id, None)

    @staticmethod
    def _new_req_id(prefix: str) -> str:
        return f"{prefix}-{uuid.uuid4().hex}"

    @staticmethod
    def _payload_req_id(payload: dict[str, Any]) -> str:
        headers = payload.get("headers")
        if isinstance(headers, dict):
            return str(headers.get("req_id") or "")
        return ""

    @staticmethod
    def _parse_json(raw: Any) -> dict[str, Any] | None:
        try:
            payload = json.loads(raw)
        except Exception:
            logger.debug("Failed to parse WeCom payload: %r", raw)
            return None
        return payload if isinstance(payload, dict) else None

    # ------------------------------------------------------------------
    # Inbound message parsing
    # ------------------------------------------------------------------

    async def _on_message(self, payload: dict[str, Any]) -> None:
        """Process an inbound WeCom message callback event."""
        body = payload.get("body")
        if not isinstance(body, dict):
            return

        msg_id = str(body.get("msgid") or self._payload_req_id(payload) or uuid.uuid4().hex)
        # Namespaced dedup key: a redelivered message on the primary bot must not
        # collide with the same msgid arriving on a different employee's bot.
        if self._dedup.is_duplicate(self._account_key(msg_id)):
            logger.debug("%s duplicate message %s ignored", self._log_prefix(), msg_id)
            return
        self._remember_reply_req_id(msg_id, self._payload_req_id(payload))

        sender = body.get("from") if isinstance(body.get("from"), dict) else {}
        sender_id = str(sender.get("userid") or "").strip()
        chat_id = str(body.get("chatid") or sender_id).strip()
        if not chat_id:
            logger.debug("[Wecom] missing chat id, skipping message")
            return

        is_group = str(body.get("chattype") or "").lower() == "group"
        if is_group:
            if not self._is_group_allowed(chat_id, sender_id):
                logger.debug("[Wecom] group %s / sender %s blocked by policy", chat_id, sender_id)
                return
        elif not self._is_dm_intake_allowed(sender_id):
            logger.debug("[Wecom] DM sender %s blocked by policy", sender_id)
            return

        # Cache the inbound req_id after policy checks so proactive sends to this
        # chat can fall back to APP_CMD_RESPONSE (required for groups).
        self._remember_chat_req_id(chat_id, self._payload_req_id(payload))

        text, reply_text = self._extract_text(body)
        if is_group and text:
            text = re.sub(r"^@\S+\s*", "", text).strip()
        media_descriptors, media_types = await self._extract_media(body)
        message_type = self._derive_message_type(body, text, media_types)

        if not text and reply_text and not media_descriptors:
            text = reply_text

        if not text and not media_descriptors:
            logger.debug("[Wecom] empty message skipped")
            return

        event = InboundMessage(
            channel_name=self.name,
            chat_id=chat_id,
            user_id=sender_id or None,
            text=text,
            msg_type=InboundMessageType.COMMAND if text.startswith("/") else InboundMessageType.CHAT,
            thread_ts=msg_id,
            topic_id=None,
            files=list(media_descriptors),
            # account_id is stamped on every inbound so ChannelManager can route
            # per-employee bot messages to the right proactive role. Empty string
            # means "primary bot, no employee bound" → default assistant_id.
            metadata={
                "chat_type": "group" if is_group else "dm",
                "account_id": self._account_id,
                # manager calls ``release_owned_temp_paths`` after the agent
                # finishes so the file is alive when ContextFilesMiddleware
                # reads it.  Without this, ``_cleanup_temp_paths`` would
                # unlink the file in a fire-and-forget task immediately
                # after publish_inbound returns.
                "_owned_temp_paths": [
                    str(item.get("path") or "") for item in media_descriptors if item.get("path")
                ],
            },
        )
        logger.info(
            "%s inbound from=%s chat_id=%s type=%s text_len=%d media=%d | text=%.200s",
            self._log_prefix(),
            sender_id[:8] if sender_id else "?",
            chat_id[:12],
            "group" if is_group else "dm",
            len(text or ""),
            len(media_descriptors),
            text if text else "(no text)",
        )

        # Only batch plain text messages — commands/media dispatch immediately.
        if message_type == InboundMessageType.CHAT and not text.startswith("/") and self._text_batch_delay_seconds > 0:
            self._enqueue_text_event(event)
        else:
            self._diag_log("publish_inbound", chat_id=event.chat_id, text_len=len(event.text or ""), text_preview=(event.text or "")[:300], kind=str(message_type))
            await self.bus.publish_inbound(event)
        # Files are now owned by the manager — see metadata["_owned_temp_paths"].
        # ``release_owned_temp_paths`` is the only thing that should unlink them.
        if not event.files and media_descriptors:
            # No manager will run (e.g. test path) — clean up immediately so we
            # don't leak temp files when there's nothing downstream to release.
            asyncio.create_task(self._cleanup_temp_paths(
                [str(item.get("path") or "") for item in media_descriptors if item.get("path")]
            ))

    # -- text batching (handles WeCom client-side 4000-char splits) ------

    def _account_key(self, suffix: str) -> str:
        """Namespace a per-bot cache key so two accounts never collide.

        Empty ``account_id`` collapses to a stable ``"primary"`` segment so the
        primary bot's caches behave like before the refactor (no namespace
        prefix in user-visible keys; just internal anti-collision).
        """
        return f"{self._account_id or 'primary'}:{suffix}"

    def _text_batch_key(self, event: InboundMessage) -> str:
        # Per-account text batching: a sales-bot DM and a research-bot DM
        # in the same chat_id must not merge.
        return f"{self._account_id or 'primary'}:{event.channel_name}:{event.chat_id}:{event.user_id}"

    def _enqueue_text_event(self, event: InboundMessage) -> None:
        """Buffer a plain-text chat event; later events may append text/files.

        Multi-modal flow: a user often fires *图片* then a follow-up *看看这张图*.
        Each chunk arrives as a separate ``aibot_msg_callback``; without
        merging, the first image is dispatched alone (manager commits the
        temp file cleanup), and the follow-up text gets processed in a
        second, unrelated turn — losing the visual context.

        We coalesce:
          - **text chunks**: appended to the buffered event's ``text`` (newline
            separated), and the debounce timer resets so the trailing
            message wins.  This matches WeCom's own client-side 4000-char
            split behavior already covered by the original batching.
          - **file chunks**: stashed in ``files``; the buffered event's
            debounce timer also resets so any file is followed by a small
            grace window for the user to type a follow-up.
          - **commands**: never batched — bypass this path in the caller.

        The flush eventually publishes one InboundMessage carrying the merged
        text + files.  Cleanup ownership travels with that one event.
        """
        key = self._text_batch_key(event)
        existing = self._pending_text_batches.get(key)
        chunk_len = len(event.text or "")
        if existing is None:
            event.__dict__["_last_chunk_len"] = chunk_len
            self._pending_text_batches[key] = event
        else:
            if event.text:
                existing.text = f"{existing.text}\n{event.text}" if existing.text else event.text
            if event.files:
                # Preserve file-descriptor order (image first then follow-up text).
                existing.files = list(existing.files or []) + list(event.files or [])
                # Owned temp paths live on metadata; merge them so the manager
                # releases every file once the merged event is processed.
                owned = []
                meta = existing.metadata if isinstance(existing.metadata, dict) else {}
                if isinstance(meta.get("_owned_temp_paths"), list):
                    owned = list(meta["_owned_temp_paths"])
                new_owned = (
                    list((event.metadata or {}).get("_owned_temp_paths") or [])
                    if isinstance(event.metadata, dict)
                    else []
                )
                if new_owned:
                    existing.metadata = {
                        **meta,
                        "_owned_temp_paths": owned + [p for p in new_owned if p and p not in owned],
                    }
            existing.__dict__["_last_chunk_len"] = chunk_len

        prior_task = self._pending_text_batch_tasks.get(key)
        if prior_task and not prior_task.done():
            prior_task.cancel()
        self._pending_text_batch_tasks[key] = asyncio.create_task(self._flush_text_batch(key))

    async def _flush_text_batch(self, key: str) -> None:
        current_task = asyncio.current_task()
        try:
            pending = self._pending_text_batches.get(key)
            last_len = getattr(pending, "_last_chunk_len", 0) if pending else 0
            delay = self._text_batch_split_delay_seconds if last_len >= self._SPLIT_THRESHOLD else self._text_batch_delay_seconds
            await asyncio.sleep(delay)
            if self._pending_text_batch_tasks.get(key) is not current_task:
                return
            event = self._pending_text_batches.pop(key, None)
            if not event:
                return
            logger.info(
                "[Wecom] flushing text batch %s (text_len=%d files=%d)",
                key,
                len(event.text or ""),
                len(event.files or []),
            )
            self._diag_log("publish_inbound_batch", chat_id=event.chat_id, text_len=len(event.text or ""), text_preview=(event.text or "")[:300], files=len(event.files or []))
            await self.bus.publish_inbound(event)
        finally:
            if self._pending_text_batch_tasks.get(key) is current_task:
                self._pending_text_batch_tasks.pop(key, None)

    # -- media -----------------------------------------------------------

    async def _extract_media(self, body: dict[str, Any]) -> tuple[list[dict[str, Any]], list[str]]:
        """Best-effort extraction of inbound media into file descriptors.

        Each returned dict carries the local cache path that downstream stages
        (manager → LangGraph run input → ContextFilesMiddleware → multimodal
        LLM) can read.  Lifecycle is owned by the channel until the manager
        finishes processing the inbound message; ``_cleanup_temp_paths`` runs
        only after the bus confirms the inbound was processed (see
        ``release_owned_temp_paths``).

        Returns ``(file_descriptors, mime_types)`` so the caller can also
        react to media type without re-scanning the descriptors.
        """
        # Always log the raw body so we can see exactly what WeCom is sending.
        # This is the single most important diagnostic for "image not received" bugs.
        try:
            _mixed = body.get("mixed")
            _mixed_items = (_mixed or {}).get("msg_item", []) if isinstance(_mixed, dict) else []
            _mixed_types = [
                str(item.get("msgtype") or "?") for item in _mixed_items if isinstance(item, dict)
            ]
        except Exception:
            _mixed_types = []
        self._diag_log(
            "extract_media_body",
            msgtype=str(body.get("msgtype") or ""),
            has_image=bool(body.get("image")),
            has_file=bool(body.get("file")),
            has_appmsg=bool(body.get("appmsg")),
            has_mixed=bool(body.get("mixed")),
            has_quote=bool(body.get("quote")),
            body_keys=list(body.keys()),
            mixed_types=_mixed_types,
            mixed_count=len(_mixed_items),
            # Include first 1500 chars of body so we see the mixed items themselves
            body_preview=str(body)[:1500],
        )
        media_descriptors: list[dict[str, Any]] = []
        media_types: list[str] = []
        refs: list[tuple[str, dict[str, Any]]] = []
        msgtype = str(body.get("msgtype") or "").lower()

        if msgtype == "mixed":
            _raw_mixed = body.get("mixed")
            mixed = _raw_mixed if isinstance(_raw_mixed, dict) else {}
            _raw_items = mixed.get("msg_item")
            items = _raw_items if isinstance(_raw_items, list) else []
            for item in items:
                if not isinstance(item, dict):
                    continue
                item_type = str(item.get("msgtype") or "").lower()
                if item_type == "image" and isinstance(item.get("image"), dict):
                    refs.append(("image", item["image"]))
        else:
            if isinstance(body.get("image"), dict):
                refs.append(("image", body["image"]))
            if msgtype == "file" and isinstance(body.get("file"), dict):
                refs.append(("file", body["file"]))
            if msgtype == "appmsg" and isinstance(body.get("appmsg"), dict):
                appmsg = body["appmsg"]
                if isinstance(appmsg.get("file"), dict):
                    refs.append(("file", appmsg["file"]))
                elif isinstance(appmsg.get("image"), dict):
                    refs.append(("image", appmsg["image"]))

        quote = body.get("quote") if isinstance(body.get("quote"), dict) else {}
        quote_type = str(quote.get("msgtype") or "").lower()
        if quote_type == "image" and isinstance(quote.get("image"), dict):
            refs.append(("image", quote["image"]))
        elif quote_type == "file" and isinstance(quote.get("file"), dict):
            refs.append(("file", quote["file"]))

        for kind, ref in refs:
            self._diag_log(
                "cache_media_attempt",
                kind=kind,
                has_url=bool(ref.get("url")),
                has_aeskey=bool(ref.get("aeskey")),
                has_base64=bool(ref.get("base64")),
                ref_keys=list(ref.keys()),
                url_preview=str(ref.get("url") or "")[:120],
            )
            cached = await self._cache_media(kind, ref)
            if not cached:
                self._diag_log(
                    "cache_media_returned_none",
                    kind=kind,
                    url_preview=str(ref.get("url") or "")[:120],
                )
                continue
            path, content_type, filename, size, source_url = cached
            self._diag_log(
                "cache_media_ok",
                kind=kind,
                path=path,
                mime=content_type,
                size=size,
            )
            descriptor = self._build_file_descriptor(
                kind=kind,
                path=path,
                mime=content_type,
                filename=filename,
                size=size,
                url=source_url,
            )
            media_descriptors.append(descriptor)
            media_types.append(content_type)

        return media_descriptors, media_types

    def _build_file_descriptor(
        self,
        *,
        kind: str,
        path: str,
        mime: str,
        filename: str,
        size: int,
        url: str,
    ) -> dict[str, Any]:
        """Build a normalized file descriptor consumed by ``InboundMessage.files``.

        ``kind`` is one of ``image`` / ``file`` / ``audio`` / ``video`` and
        matches the categories ContextFilesMiddleware branches on when
        generating multimodal blocks.  ``mime`` follows the IANA type strings
        (e.g. ``image/jpeg``) so the consumer can decide between native image
        blocks and ``view_image`` tool calls.
        """
        kind_normalized = (
            kind if kind in {"image", "file", "audio", "video"} else "file"
        )
        return {
            "kind": kind_normalized,
            "path": path,
            "mime": str(mime or "application/octet-stream").split(";", 1)[0].strip(),
            "filename": filename or Path(path).name,
            "size": int(size or 0),
            "url": url or "",
            # account_id lets manager/router resolve an inbound file back to
            # the originating bot when several employees share one gateway.
            "account_id": self._account_id or "",
        }

    def release_owned_temp_paths(self, paths: list[str] | None) -> None:
        """Public hook the manager calls after a message has been processed.

        Avoids the previous race where the channel unlinked the temp file the
        moment after ``publish_inbound`` returned — long before the agent or
        ContextFilesMiddleware ever read it.  Idempotent and safe with an
        empty/None input.
        """
        if not paths:
            return
        asyncio.create_task(self._cleanup_temp_paths(list(paths)))

    async def _cache_media(self, kind: str, media: dict[str, Any]) -> tuple[str, str, str, int, str] | None:
        """Cache an inbound image/file/media reference to local storage.

        Returns ``(path, mime, filename, size, source_url)`` so the caller can
        build a file descriptor without re-querying the media dictionary.
        ``source_url`` is the platform-provided URL (or empty string for
        base64-embedded payloads).
        """
        source_url = str(media.get("url") or "").strip()
        if "base64" in media and media.get("base64"):
            try:
                raw = self._decode_base64(media["base64"])
            except Exception as exc:
                logger.debug("[Wecom] failed to decode %s base64 media: %s", kind, exc)
                return None

            size = len(raw)
            if kind == "image":
                ext = self._detect_image_ext(raw)
                try:
                    path = self._cache_bytes(raw, ext)
                    return path, self._mime_for_ext(ext, fallback="image/jpeg"), Path(path).name, size, source_url
                except Exception as exc:
                    logger.warning("[Wecom] rejected image bytes: %s", exc)
                    return None

            filename = str(media.get("filename") or media.get("name") or "wecom_file")
            ext = f".{filename.rsplit('.', 1)[-1] if '.' in filename else 'bin'}"
            try:
                path = self._cache_bytes(raw, ext)
            except Exception as exc:
                logger.warning("[Wecom] rejected file bytes: %s", exc)
                return None
            mime = mimetypes.guess_type(filename)[0] or "application/octet-stream"
            return path, mime, filename, size, source_url

        if not source_url:
            return None

        try:
            raw, headers = await self._download_remote_bytes(source_url, max_bytes=ABSOLUTE_MAX_BYTES)
        except Exception as exc:
            logger.debug("[Wecom] failed to download %s from %s: %s", kind, source_url, exc)
            return None

        aes_key = str(media.get("aeskey") or "").strip()
        if aes_key:
            try:
                raw = self._decrypt_file_bytes(raw, aes_key)
            except Exception as exc:
                logger.debug("[Wecom] failed to decrypt %s from %s: %s", kind, source_url, exc)
                return None

        size = len(raw)
        content_type = str(headers.get("content-type") or "").split(";", 1)[0].strip() or "application/octet-stream"
        if kind == "image":
            ext = self._guess_extension(source_url, content_type, fallback=self._detect_image_ext(raw))
            try:
                path = self._cache_bytes(raw, ext)
            except Exception as exc:
                logger.warning("[Wecom] rejected non-image bytes from %s: %s", source_url, exc)
                return None
            return path, content_type or self._mime_for_ext(ext, fallback="image/jpeg"), Path(path).name, size, source_url

        filename = self._guess_filename(source_url, headers.get("content-disposition"), content_type)
        try:
            path = self._cache_bytes(raw, f".{filename.rsplit('.', 1)[-1] if '.' in filename else 'bin'}")
        except Exception as exc:
            logger.warning("[Wecom] rejected file bytes from %s: %s", source_url, exc)
            return None
        return path, content_type, filename, size, source_url

    def _cache_bytes(self, data: bytes, suffix: str) -> str:
        import tempfile

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
                logger.debug("[Wecom] failed to remove temp media %s: %s", path, exc)

    async def _cleanup_all_temp_paths(self) -> None:
        paths = list(self._temp_media_paths)
        self._temp_media_paths.clear()
        await self._cleanup_temp_paths(paths)

    @staticmethod
    def _decode_base64(data: str) -> bytes:
        payload = data.split(",", 1)[-1].strip()
        return base64.b64decode(payload)

    @staticmethod
    def _detect_image_ext(data: bytes) -> str:
        if data.startswith(b"\x89PNG\r\n\x1a\n"):
            return ".png"
        if data.startswith(b"\xff\xd8\xff"):
            return ".jpg"
        if data.startswith((b"GIF87a", b"GIF89a")):
            return ".gif"
        if data.startswith(b"RIFF") and data[8:12] == b"WEBP":
            return ".webp"
        return ".jpg"

    @staticmethod
    def _mime_for_ext(ext: str, fallback: str = "application/octet-stream") -> str:
        return mimetypes.types_map.get(ext.lower(), fallback)

    @staticmethod
    def _guess_extension(url: str, content_type: str, fallback: str) -> str:
        ext = mimetypes.guess_extension(content_type) if content_type else None
        if ext:
            return ext
        path_ext = Path(urlparse(url).path).suffix
        if path_ext:
            return path_ext
        return fallback

    @staticmethod
    def _guess_filename(url: str, content_disposition: str | None, content_type: str) -> str:
        if content_disposition:
            match = re.search(r'filename="?([^";]+)"?', content_disposition)
            if match:
                return match.group(1)
        name = Path(urlparse(url).path).name or "document"
        if "." not in name:
            ext = mimetypes.guess_extension(content_type) or ".bin"
            name = f"{name}{ext}"
        return name

    @staticmethod
    def _derive_message_type(body: dict[str, Any], text: str, media_types: list[str]) -> InboundMessageType:
        if any(mtype.startswith(("application/", "text/")) for mtype in media_types):
            return InboundMessageType.CHAT if not text.startswith("/") else InboundMessageType.COMMAND
        if any(mtype.startswith("image/") for mtype in media_types):
            return InboundMessageType.CHAT if text else InboundMessageType.CHAT
        if str(body.get("msgtype") or "").lower() == "voice":
            return InboundMessageType.CHAT
        return InboundMessageType.COMMAND if text.startswith("/") else InboundMessageType.CHAT

    # ------------------------------------------------------------------
    # Text extraction
    # ------------------------------------------------------------------

    @staticmethod
    def _extract_text(body: dict[str, Any]) -> tuple[str, str | None]:
        """Extract plain text and quoted text from a callback payload."""
        text_parts: list[str] = []
        reply_text: str | None = None
        msgtype = str(body.get("msgtype") or "").lower()

        if msgtype == "mixed":
            _raw_mixed = body.get("mixed")
            mixed = _raw_mixed if isinstance(_raw_mixed, dict) else {}
            _raw_items = mixed.get("msg_item")
            items = _raw_items if isinstance(_raw_items, list) else []
            for item in items:
                if not isinstance(item, dict):
                    continue
                if str(item.get("msgtype") or "").lower() == "text":
                    _raw_text = item.get("text")
                    text_block = _raw_text if isinstance(_raw_text, dict) else {}
                    content = str(text_block.get("content") or "").strip()
                    if content:
                        text_parts.append(content)
        else:
            text_block = body.get("text") if isinstance(body.get("text"), dict) else {}
            content = str(text_block.get("content") or "").strip()
            if content:
                text_parts.append(content)

            if msgtype == "voice":
                voice_block = body.get("voice") if isinstance(body.get("voice"), dict) else {}
                voice_text = str(voice_block.get("content") or "").strip()
                if voice_text:
                    text_parts.append(voice_text)

            if msgtype == "appmsg":
                appmsg = body.get("appmsg") if isinstance(body.get("appmsg"), dict) else {}
                title = str(appmsg.get("title") or "").strip()
                if title:
                    text_parts.append(title)

        quote = body.get("quote") if isinstance(body.get("quote"), dict) else {}
        quote_type = str(quote.get("msgtype") or "").lower()
        if quote_type == "text":
            quote_text = quote.get("text") if isinstance(quote.get("text"), dict) else {}
            reply_text = str(quote_text.get("content") or "").strip() or None
        elif quote_type == "voice":
            quote_voice = quote.get("voice") if isinstance(quote.get("voice"), dict) else {}
            reply_text = str(quote_voice.get("content") or "").strip() or None

        return "\n".join(part for part in text_parts if part).strip(), reply_text

    def _remember_reply_req_id(self, message_id: str, req_id: str) -> None:
        normalized_message_id = str(message_id or "").strip()
        normalized_req_id = str(req_id or "").strip()
        if not normalized_message_id or not normalized_req_id:
            return
        self._reply_req_ids[self._account_key(normalized_message_id)] = normalized_req_id
        while len(self._reply_req_ids) > DEDUP_MAX_SIZE:
            self._reply_req_ids.pop(next(iter(self._reply_req_ids)))

    def _remember_chat_req_id(self, chat_id: str, req_id: str) -> None:
        normalized_chat_id = str(chat_id or "").strip()
        normalized_req_id = str(req_id or "").strip()
        if not normalized_chat_id or not normalized_req_id:
            return
        self._last_chat_req_ids[self._account_key(normalized_chat_id)] = normalized_req_id
        while len(self._last_chat_req_ids) > DEDUP_MAX_SIZE:
            self._last_chat_req_ids.pop(next(iter(self._last_chat_req_ids)))

    def _reply_req_id_for_message(self, reply_to: str | None) -> str | None:
        normalized = str(reply_to or "").strip()
        if not normalized or normalized.startswith("quote:"):
            return None
        return self._reply_req_ids.get(self._account_key(normalized))

    # ------------------------------------------------------------------
    # Outbound messaging
    # ------------------------------------------------------------------

    @staticmethod
    def _guess_mime_type(filename: str) -> str:
        mime_type = mimetypes.guess_type(filename)[0]
        if mime_type:
            return mime_type
        if Path(filename).suffix.lower() == ".amr":
            return "audio/amr"
        return "application/octet-stream"

    @staticmethod
    def _normalize_content_type(content_type: str, filename: str) -> str:
        normalized = str(content_type or "").split(";", 1)[0].strip().lower()
        guessed = WecomChannel._guess_mime_type(filename)
        if not normalized:
            return guessed
        if normalized in {"application/octet-stream", "text/plain"}:
            return guessed
        return normalized

    @staticmethod
    def _detect_wecom_media_type(content_type: str) -> str:
        mime_type = str(content_type or "").strip().lower()
        if mime_type.startswith("image/"):
            return "image"
        if mime_type.startswith("video/"):
            return "video"
        if mime_type.startswith("audio/") or mime_type == "application/ogg":
            return "voice"
        return "file"

    @staticmethod
    def _apply_file_size_limits(file_size: int, detected_type: str, content_type: str | None = None) -> dict[str, Any]:
        file_size_mb = file_size / (1024 * 1024)
        normalized_type = str(detected_type or "file").lower()
        normalized_content_type = str(content_type or "").strip().lower()

        if file_size > ABSOLUTE_MAX_BYTES:
            return {
                "final_type": normalized_type,
                "rejected": True,
                "reject_reason": (
                    f"文件大小 {file_size_mb:.2f}MB 超过了企业微信允许的最大限制 20MB，无法发送。"
                    "请尝试压缩文件或减小文件大小。"
                ),
                "downgraded": False,
                "downgrade_note": None,
            }

        if normalized_type == "image" and file_size > IMAGE_MAX_BYTES:
            return {
                "final_type": "file",
                "rejected": False,
                "reject_reason": None,
                "downgraded": True,
                "downgrade_note": f"图片大小 {file_size_mb:.2f}MB 超过 10MB 限制，已转为文件格式发送",
            }

        if normalized_type == "video" and file_size > VIDEO_MAX_BYTES:
            return {
                "final_type": "file",
                "rejected": False,
                "reject_reason": None,
                "downgraded": True,
                "downgrade_note": f"视频大小 {file_size_mb:.2f}MB 超过 10MB 限制，已转为文件格式发送",
            }

        if normalized_type == "voice":
            if normalized_content_type and normalized_content_type not in VOICE_SUPPORTED_MIMES:
                return {
                    "final_type": "file",
                    "rejected": False,
                    "reject_reason": None,
                    "downgraded": True,
                    "downgrade_note": (
                        f"语音格式 {normalized_content_type} 不支持，企微仅支持 AMR 格式，已转为文件格式发送"
                    ),
                }
            if file_size > VOICE_MAX_BYTES:
                return {
                    "final_type": "file",
                    "rejected": False,
                    "reject_reason": None,
                    "downgraded": True,
                    "downgrade_note": f"语音大小 {file_size_mb:.2f}MB 超过 2MB 限制，已转为文件格式发送",
                }

        return {
            "final_type": normalized_type,
            "rejected": False,
            "reject_reason": None,
            "downgraded": False,
            "downgrade_note": None,
        }

    @staticmethod
    def _response_error(response: dict[str, Any]) -> str | None:
        errcode = response.get("errcode", 0)
        if errcode in {0, None}:
            return None
        errmsg = str(response.get("errmsg") or "unknown error")
        return f"WeCom errcode {errcode}: {errmsg}"

    def _raise_for_wecom_error(self, response: dict[str, Any], operation: str) -> None:
        error = self._response_error(response)
        if error:
            raise RuntimeError(f"{operation} failed: {error}")

    @staticmethod
    def _decrypt_file_bytes(encrypted_data: bytes, aes_key: str) -> bytes:
        if not encrypted_data:
            raise ValueError("encrypted_data is empty")
        if not aes_key:
            raise ValueError("aes_key is required")

        aes_key = aes_key + "=" * ((4 - len(aes_key) % 4) % 4)
        key = base64.b64decode(aes_key)
        if len(key) != 32:
            raise ValueError(f"Invalid WeCom AES key length: expected 32 bytes, got {len(key)}")

        from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes

        cipher = Cipher(algorithms.AES(key), modes.CBC(key[:16]))
        decryptor = cipher.decryptor()
        decrypted = decryptor.update(encrypted_data) + decryptor.finalize()

        pad_len = decrypted[-1]
        if pad_len < 1 or pad_len > 32 or pad_len > len(decrypted):
            raise ValueError(f"Invalid PKCS#7 padding value: {pad_len}")
        if any(byte != pad_len for byte in decrypted[-pad_len:]):
            raise ValueError("Invalid PKCS#7 padding: padding bytes mismatch")
        return decrypted[:-pad_len]

    async def _download_remote_bytes(
        self,
        url: str,
        max_bytes: int,
    ) -> tuple[bytes, dict[str, str]]:
        # Hostile-environment agent note:
        # The shared aiohttp session is created with ``trust_env=True`` so the
        # WeCom WebSocket can honor ``HTTPS_PROXY`` / ``HTTP_PROXY``. That same
        # proxy chain breaks HTTPS downloads of media through CONNECT tunnels
        # (the aiohttp ProxyConnector can't wrap a second TLS context around
        # an already-proxied socket, raising ``TLS-in-TLS``).
        #
        # Media downloads are short, low-frequency, and target known public
        # CDNs (cos / qcloud). It's safer — and faster — to fetch them with a
        # dedicated, no-proxy aiohttp session. The connector has to be built
        # fresh every call so DNS picks up the public address; reusing one
        # from the gateway boot session would inherit any cached DNS state.
        try:
            import aiohttp as _aiohttp  # local alias to keep top-level import intact
            ssl_ctx = _aiohttp.TCPConnector(
                ssl=True,
                force_close=False,
                enable_cleanup_closed=True,
            )
            async with _aiohttp.ClientSession(
                connector=ssl_ctx,
                trust_env=False,
                timeout=_aiohttp.ClientTimeout(total=30),
            ) as session:
                async with session.get(url) as response:
                    status = response.status
                    response.raise_for_status()
                    headers = {key.lower(): value for key, value in response.headers.items()}
                    data = await response.read()
                    if len(data) > max_bytes:
                        raise ValueError(
                            f"Remote media exceeds WeCom limit: {len(data)} bytes > {max_bytes} bytes"
                        )
                    self._diag_log(
                        "download_remote_bytes_ok",
                        url_preview=url[:120],
                        status=status,
                        bytes=len(data),
                        content_type=headers.get("content-type", ""),
                    )
                    return bytes(data), headers
        except Exception as exc:
            self._diag_log(
                "download_remote_bytes_failed",
                url_preview=url[:120],
                error=str(exc),
                error_type=type(exc).__name__,
            )
            raise

    @staticmethod
    def _looks_like_url(media_source: str) -> bool:
        parsed = urlparse(str(media_source or ""))
        return parsed.scheme in {"http", "https"}

    async def _load_outbound_media(
        self,
        media_source: str,
        file_name: str | None = None,
    ) -> tuple[bytes, str, str]:
        source = str(media_source or "").strip()
        if not source:
            raise ValueError("media source is required")
        if re.fullmatch(r"<[^>\n]+>", source):
            raise ValueError(f"Media placeholder was not replaced with a real file path: {source}")

        parsed = urlparse(source)
        if parsed.scheme in {"http", "https"}:
            data, headers = await self._download_remote_bytes(source, max_bytes=ABSOLUTE_MAX_BYTES)
            content_disposition = headers.get("content-disposition")
            resolved_name = file_name or self._guess_filename(source, content_disposition, headers.get("content-type", ""))
            content_type = self._normalize_content_type(headers.get("content-type", ""), resolved_name)
            return data, content_type, resolved_name

        if parsed.scheme == "file":
            local_path = Path(unquote(parsed.path)).expanduser()
        else:
            local_path = Path(source).expanduser()

        if not local_path.is_absolute():
            local_path = (Path.cwd() / local_path).resolve()

        if not local_path.exists() or not local_path.is_file():
            raise FileNotFoundError(f"Media file not found: {local_path}")

        data = local_path.read_bytes()
        resolved_name = file_name or local_path.name
        content_type = self._normalize_content_type("", resolved_name)
        return data, content_type, resolved_name

    async def _prepare_outbound_media(
        self,
        media_source: str,
        file_name: str | None = None,
    ) -> dict[str, Any]:
        data, content_type, resolved_name = await self._load_outbound_media(media_source, file_name=file_name)
        detected_type = self._detect_wecom_media_type(content_type)
        size_check = self._apply_file_size_limits(len(data), detected_type, content_type)
        return {
            "data": data,
            "content_type": content_type,
            "file_name": resolved_name,
            "detected_type": detected_type,
            **size_check,
        }

    async def _upload_media_bytes(self, data: bytes, media_type: str, filename: str) -> dict[str, Any]:
        if not data:
            raise ValueError("Cannot upload empty media")

        total_size = len(data)
        total_chunks = (total_size + UPLOAD_CHUNK_SIZE - 1) // UPLOAD_CHUNK_SIZE
        if total_chunks > MAX_UPLOAD_CHUNKS:
            raise ValueError(f"File too large: {total_chunks} chunks exceeds maximum of {MAX_UPLOAD_CHUNKS} chunks")

        init_response = await self._send_request(
            APP_CMD_UPLOAD_MEDIA_INIT,
            {
                "type": media_type,
                "filename": filename,
                "total_size": total_size,
                "total_chunks": total_chunks,
                "md5": hashlib.md5(data).hexdigest(),
            },
        )
        self._raise_for_wecom_error(init_response, "media upload init")

        init_body = init_response.get("body") if isinstance(init_response.get("body"), dict) else {}
        upload_id = str(init_body.get("upload_id") or "").strip()
        if not upload_id:
            raise RuntimeError(f"media upload init failed: missing upload_id in response {init_response}")

        for chunk_index, start in enumerate(range(0, total_size, UPLOAD_CHUNK_SIZE)):
            chunk = data[start : start + UPLOAD_CHUNK_SIZE]
            chunk_response = await self._send_request(
                APP_CMD_UPLOAD_MEDIA_CHUNK,
                {
                    "upload_id": upload_id,
                    "chunk_index": chunk_index,
                    "base64_data": base64.b64encode(chunk).decode("ascii"),
                },
            )
            self._raise_for_wecom_error(chunk_response, f"media upload chunk {chunk_index}")

        finish_response = await self._send_request(
            APP_CMD_UPLOAD_MEDIA_FINISH,
            {"upload_id": upload_id},
        )
        self._raise_for_wecom_error(finish_response, "media upload finish")

        finish_body = finish_response.get("body") if isinstance(finish_response.get("body"), dict) else {}
        media_id = str(finish_body.get("media_id") or "").strip()
        if not media_id:
            raise RuntimeError(f"media upload finish failed: missing media_id in response {finish_response}")

        return {
            "type": str(finish_body.get("type") or media_type),
            "media_id": media_id,
            "created_at": finish_body.get("created_at"),
        }

    async def _send_media_message(self, chat_id: str, media_type: str, media_id: str) -> dict[str, Any]:
        response = await self._send_request(
            APP_CMD_SEND,
            {
                "chatid": chat_id,
                "msgtype": media_type,
                media_type: {"media_id": media_id},
            },
        )
        self._raise_for_wecom_error(response, "send media message")
        return response

    async def _send_reply_markdown(self, reply_req_id: str, content: str) -> dict[str, Any]:
        response = await self._send_reply_request(
            reply_req_id,
            {
                "msgtype": "markdown",
                "markdown": {"content": content[: self.MAX_MESSAGE_LENGTH]},
            },
        )
        self._raise_for_wecom_error(response, "send reply markdown")
        return response

    async def _send_reply_media_message(
        self,
        reply_req_id: str,
        media_type: str,
        media_id: str,
    ) -> dict[str, Any]:
        response = await self._send_reply_request(
            reply_req_id,
            {
                "msgtype": media_type,
                media_type: {"media_id": media_id},
            },
        )
        self._raise_for_wecom_error(response, "send reply media message")
        return response

    async def _send_followup_markdown(
        self,
        chat_id: str,
        content: str,
        reply_to: str | None = None,
    ) -> OutboundMessage | None:
        if not content:
            return None
        outbound = OutboundMessage(
            channel_name=self.name,
            chat_id=chat_id,
            thread_id="",
            text=content,
            is_final=True,
            thread_ts=reply_to,
        )
        await self.send(outbound)
        return outbound

    async def _send_media_source(
        self,
        msg: OutboundMessage,
        media_source: str,
        caption: str | None = None,
        file_name: str | None = None,
    ) -> bool:
        chat_id = msg.chat_id
        if not chat_id:
            return False

        try:
            prepared = await self._prepare_outbound_media(media_source, file_name=file_name)
        except FileNotFoundError as exc:
            logger.warning("[Wecom] media file not found: %s", exc)
            return False
        except Exception as exc:
            logger.error("[Wecom] failed to prepare outbound media %s: %s", media_source, exc)
            return False

        if prepared["rejected"]:
            await self._send_followup_markdown(chat_id, f"⚠️ {prepared['reject_reason']}", reply_to=msg.thread_ts)
            return False

        reply_req_id = self._reply_req_id_for_message(msg.thread_ts)
        if not reply_req_id:
            cached = self._last_chat_req_ids.get(self._account_key(chat_id))
            if cached:
                reply_req_id = cached

        try:
            upload_result = await self._upload_media_bytes(
                prepared["data"],
                prepared["final_type"],
                prepared["file_name"],
            )
            if reply_req_id:
                await self._send_reply_media_message(reply_req_id, prepared["final_type"], upload_result["media_id"])
            else:
                await self._send_media_message(chat_id, prepared["final_type"], upload_result["media_id"])
        except TimeoutError:
            logger.warning("[Wecom] timeout sending media to %s", chat_id)
            return False
        except Exception as exc:
            logger.error("[Wecom] failed to send media %s: %s", media_source, exc)
            return False

        if caption:
            await self._send_followup_markdown(chat_id, caption, reply_to=msg.thread_ts)
        if prepared["downgraded"] and prepared["downgrade_note"]:
            await self._send_followup_markdown(chat_id, f"ℹ️ {prepared['downgrade_note']}", reply_to=msg.thread_ts)
        return True

    async def send(self, msg: OutboundMessage) -> None:
        """Send markdown to a WeCom chat via proactive ``aibot_send_msg`` / reply."""
        self._diag_log("send_enter", chat_id=msg.chat_id, text_len=len(msg.text or ""), is_final=msg.is_final, text_preview=(msg.text or "")[:300])
        if not msg.is_final:
            self._diag_log("send_skip_non_final", chat_id=msg.chat_id)
            return  # WeCom has no draft-streaming; only send complete messages.

        chat_id = msg.chat_id
        if not chat_id or not self._ws:
            self._diag_log("send_skip_no_ws", chat_id=chat_id, ws_state="connected" if self._ws is not None else "none", running=self._running)
            logger.warning("[Wecom] send skipped: chat_id=%s ws=%s running=%s", chat_id, "connected" if self._ws is not None else "none", self._running)
            return

        text = feishu_outbound_text(msg.text or "")
        if not text.strip():
            return

        logger.info(
            "%s outbound chat_id=%s text_len=%d | text=%.300s",
            self._log_prefix(),
            chat_id[:12],
            len(text),
            text[:300],
        )

        try:
            reply_req_id = self._reply_req_id_for_message(msg.thread_ts)
            if not reply_req_id:
                cached = self._last_chat_req_ids.get(self._account_key(chat_id))
                if cached:
                    reply_req_id = cached

            chunks = self._split_text(text)
            self._diag_log("send_chunks", chat_id=chat_id, chunk_count=len(chunks))
            for chunk in chunks:
                if reply_req_id:
                    await self._send_reply_markdown(reply_req_id, chunk)
                else:
                    await self._send_request(
                        APP_CMD_SEND,
                        {
                            "chatid": chat_id,
                            "msgtype": "markdown",
                            "markdown": {"content": chunk},
                        },
                    )
            self._diag_log("send_done_ok", chat_id=chat_id, chunk_count=len(chunks))
        except TimeoutError:
            self._diag_log("send_done_timeout", chat_id=chat_id)
            logger.warning("[Wecom] timeout sending message to %s", chat_id)
        except Exception as exc:
            self._diag_log("send_done_error", chat_id=chat_id, error=str(exc))
            logger.error("[Wecom] send failed: %s", exc)

    async def send_file(self, msg: OutboundMessage, attachment: ResolvedAttachment) -> bool:
        """Send a file/image/voice via WeCom media upload."""
        return await self._send_media_source(
            msg,
            media_source=str(attachment.actual_path),
            caption=attachment.filename,
            file_name=attachment.filename,
        )

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
                while len(line) > self.MAX_MESSAGE_LENGTH:
                    chunks.append(line[: self.MAX_MESSAGE_LENGTH])
                    line = line[self.MAX_MESSAGE_LENGTH :]
                if line:
                    current = line
        if current:
            chunks.append(current)
        return [c for c in chunks if c]

    async def send_typing(self, chat_id: str) -> None:
        """WeCom does not expose typing indicators in this adapter."""
        del chat_id
# ---------------------------------------------------------------------------
# Module-level wrappers for offline unit tests (and light reuse).
#
# The channel methods live on ``WecomChannel`` (staticmethod / instance method),
# but the unit tests import these as module-level functions for convenience.
# These wrappers delegate to the channel class with no behavioural change.
# ---------------------------------------------------------------------------


def _extract_text(body: dict[str, Any]) -> tuple[str, str | None]:
    """Module-level wrapper → :meth:`WecomChannel._extract_text`."""
    return WecomChannel._extract_text(body)


def _response_error(response: dict[str, Any]) -> str | None:
    """Module-level wrapper → :meth:`WecomChannel._response_error`."""
    return WecomChannel._response_error(response)


def _apply_file_size_limits(
    file_size: int,
    detected_type: str,
    content_type: str | None = None,
) -> dict[str, Any]:
    """Module-level wrapper → :meth:`WecomChannel._apply_file_size_limits`."""
    return WecomChannel._apply_file_size_limits(file_size, detected_type, content_type)


def _split_text(channel_or_content: Any, content: str | None = None) -> list[str]:
    """Module-level wrapper → :meth:`WecomChannel._split_text`.

    Accepts both ``_split_text(instance, text)`` (test style) and
    ``_split_text(text)`` (bare style).
    """
    if isinstance(channel_or_content, WecomChannel):
        if content is None:
            return []
        return channel_or_content._split_text(content)
    return WecomChannel(bus=None, config={})._split_text(str(channel_or_content or ""))
