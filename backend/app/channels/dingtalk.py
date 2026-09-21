"""DingTalk (钉钉) channel for EvoFlow.

Connects to DingTalk via **Stream Mode** (official ``dingtalk-stream`` SDK) —
a long-lived outbound WebSocket, so no public IP or inbound webhook is needed,
matching EvoFlow's "all channels use outbound connections" philosophy.

Protocol reference: hermes-agent's ``plugins/platforms/dingtalk/adapter.py``.

Configuration (``config.yaml`` under ``channels.dingtalk``):

    channels:
      dingtalk:
        enabled: true
        client_id: "dingxxxx"          # or DINGTALK_CLIENT_ID env var
        client_secret: "..."           # or DINGTALK_CLIENT_SECRET env var
        # require_mention: true        # group chats must @-mention the bot
        # allowed_users: ["staff_id"]  # empty = allow all; "*" = any
        # free_response_chats: ["cid"] # chats that bypass require_mention
        # allowed_chats: ["cid"]       # hard allowlist (empty = no restriction)

The reply path uses the incoming message's ``session_webhook`` (markdown), so
the bot can only reply after an inbound message — same constraint as the
Feishu/WeCom adapters.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import uuid
from typing import Any

import httpx

from app.channels.base import Channel
from app.channels.feishu_message_format import feishu_outbound_text
from app.channels.message_bus import InboundMessage, InboundMessageType, MessageBus, OutboundMessage

logger = logging.getLogger(__name__)

MAX_MESSAGE_LENGTH = 20000
RECONNECT_BACKOFF = [2, 5, 10, 30, 60]
_SESSION_WEBHOOKS_MAX = 500
_DINGTALK_WEBHOOK_RE = re.compile(r"^https://(?:api|oapi)\.dingtalk\.com/")

try:
    import dingtalk_stream
    from dingtalk_stream import ChatbotMessage
    from dingtalk_stream.frames import AckMessage, CallbackMessage

    DINGTALK_STREAM_AVAILABLE = True
except Exception:  # noqa: BLE001 — optional SDK; degrade gracefully
    DINGTALK_STREAM_AVAILABLE = False
    dingtalk_stream = None  # type: ignore[assignment]
    ChatbotMessage = None  # type: ignore[assignment]
    CallbackMessage = None  # type: ignore[assignment]
    AckMessage = type("AckMessage", (), {"STATUS_OK": 200, "STATUS_SYSTEM_EXCEPTION": 500})  # type: ignore[assignment]


def _coerce_set(value: Any) -> set[str]:
    """Coerce config value into a trimmed string set."""
    if value is None:
        return set()
    if isinstance(value, str):
        return {part.strip() for part in value.split(",") if part.strip()}
    if isinstance(value, (list, tuple, set)):
        return {str(part).strip() for part in value if str(part).strip()}
    return {str(value).strip()} if str(value).strip() else set()


def _truthy(value: Any) -> bool:
    if isinstance(value, str):
        return value.strip().lower() in ("1", "true", "yes", "on")
    return bool(value)


class _MessageDeduplicator:
    """In-memory dedup with TTL for DingTalk redeliveries."""

    def __init__(self, ttl_seconds: float = 300.0, max_size: int = 1000):
        self._ttl = ttl_seconds
        self._max_size = max_size
        self._seen: dict[str, float] = {}

    def is_duplicate(self, key: str) -> bool:
        import time

        now = time.time()
        cutoff = now - self._ttl
        expired = [k for k, v in self._seen.items() if v < cutoff]
        for k in expired:
            self._seen.pop(k, None)
        if key in self._seen:
            return True
        self._seen[key] = now
        while len(self._seen) > self._max_size:
            self._seen.pop(next(iter(self._seen)), None)
        return False

    def clear(self) -> None:
        self._seen.clear()


class DingtalkChannel(Channel):
    """DingTalk chatbot channel via Stream Mode (``dingtalk-stream`` SDK)."""

    MAX_MESSAGE_LENGTH = MAX_MESSAGE_LENGTH

    def __init__(self, bus: MessageBus, config: dict[str, Any]) -> None:
        super().__init__(name="dingtalk", bus=bus, config=config)
        extra = config.get("extra") if isinstance(config.get("extra"), dict) else {}
        self._client_id = str(extra.get("client_id") or config.get("client_id") or os.getenv("DINGTALK_CLIENT_ID", "")).strip()
        self._client_secret = str(extra.get("client_secret") or config.get("client_secret") or os.getenv("DINGTALK_CLIENT_SECRET", "")).strip()

        self._require_mention = _truthy(
            extra.get("require_mention") or config.get("require_mention") or os.getenv("DINGTALK_REQUIRE_MENTION", False)
        )
        self._allowed_users = {u.lower() for u in _coerce_set(extra.get("allowed_users") or config.get("allowed_users") or os.getenv("DINGTALK_ALLOWED_USERS", ""))}
        self._free_response_chats = _coerce_set(extra.get("free_response_chats") or config.get("free_response_chats") or os.getenv("DINGTALK_FREE_RESPONSE_CHATS", ""))
        self._allowed_chats = _coerce_set(extra.get("allowed_chats") or config.get("allowed_chats") or os.getenv("DINGTALK_ALLOWED_CHATS", ""))

        self._stream_client: Any = None
        self._stream_task: asyncio.Task | None = None
        self._http_client: httpx.AsyncClient | None = None
        self._session_webhooks: dict[str, tuple[str, int]] = {}
        self._dedup = _MessageDeduplicator()
        self.store = None

    # ------------------------------------------------------------------
    # Credential / access helpers
    # ------------------------------------------------------------------

    def _is_user_allowed(self, sender_id: str, sender_staff_id: str) -> bool:
        if not self._allowed_users or "*" in self._allowed_users:
            return True
        candidates = {(sender_id or "").lower(), (sender_staff_id or "").lower()}
        candidates.discard("")
        return bool(candidates & self._allowed_users)

    def _message_mentions_bot(self, message: Any) -> bool:
        return bool(getattr(message, "is_in_at_list", False))

    def _should_process_group(self, message: Any, chat_id: str) -> bool:
        """Apply DingTalk group trigger rules (DMs pass unconditionally)."""
        if self._allowed_chats and chat_id and chat_id not in self._allowed_chats:
            return False
        if chat_id and chat_id in self._free_response_chats:
            return True
        if not self._require_mention:
            return True
        return self._message_mentions_bot(message)

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------

    async def start(self) -> None:
        if self._running:
            return
        if not DINGTALK_STREAM_AVAILABLE:
            logger.error("dingtalk-stream is not installed. Run: uv add 'dingtalk-stream>=0.20'")
            return
        if not self._client_id or not self._client_secret:
            logger.error("Dingtalk channel requires client_id and client_secret (config or DINGTALK_CLIENT_ID/DINGTALK_CLIENT_SECRET)")
            return

        self._http_client = httpx.AsyncClient(timeout=30.0)
        credential = dingtalk_stream.Credential(self._client_id, self._client_secret)
        self._stream_client = dingtalk_stream.DingTalkStreamClient(credential)
        handler = _IncomingHandler(self)
        self._stream_client.register_callback_handler(dingtalk_stream.ChatbotMessage.TOPIC, handler)

        self._running = True
        self.bus.subscribe_outbound(self._on_outbound, channel_name=self.name)
        self._stream_task = asyncio.create_task(self._run_stream(), name="dingtalk-stream")
        logger.info("[Dingtalk] channel started (client_id=%s)", self._client_id[:8])

    async def stop(self) -> None:
        self._running = False
        self.bus.unsubscribe_outbound(channel_name=self.name)

        websocket = getattr(self._stream_client, "websocket", None) if self._stream_client else None
        if websocket is not None:
            try:
                await websocket.close()
            except Exception:
                pass

        if self._stream_task:
            if hasattr(self._stream_client, "close"):
                try:
                    await asyncio.to_thread(self._stream_client.close)
                except Exception:
                    pass
            self._stream_task.cancel()
            try:
                await asyncio.wait_for(self._stream_task, timeout=5.0)
            except asyncio.CancelledError:
                pass
            except TimeoutError:
                pass
            self._stream_task = None

        if self._http_client:
            await self._http_client.aclose()
            self._http_client = None
        self._stream_client = None
        self._session_webhooks.clear()
        self._dedup.clear()
        logger.info("[Dingtalk] channel stopped")

    async def _run_stream(self) -> None:
        """Run the async stream client with auto-reconnection."""
        backoff_idx = 0
        while self._running:
            try:
                await self._stream_client.start()
                backoff_idx = 0
            except asyncio.CancelledError:
                return
            except Exception as exc:
                if not self._running:
                    return
                logger.warning("[Dingtalk] stream error: %s", exc)
            if not self._running:
                return
            delay = RECONNECT_BACKOFF[min(backoff_idx, len(RECONNECT_BACKOFF) - 1)]
            logger.info("[Dingtalk] reconnecting in %ds...", delay)
            await asyncio.sleep(delay)
            backoff_idx += 1

    # ------------------------------------------------------------------
    # Inbound handling
    # ------------------------------------------------------------------

    async def _on_message(self, message: Any) -> None:
        msg_id = getattr(message, "message_id", None) or uuid.uuid4().hex
        if self._dedup.is_duplicate(msg_id):
            logger.debug("[Dingtalk] duplicate message %s ignored", msg_id)
            return

        conversation_id = getattr(message, "conversation_id", "") or ""
        conversation_type = getattr(message, "conversation_type", "1")
        is_group = str(conversation_type) == "2"
        sender_id = getattr(message, "sender_id", "") or ""
        sender_nick = getattr(message, "sender_nick", "") or sender_id
        sender_staff_id = getattr(message, "sender_staff_id", "") or ""
        chat_id = conversation_id or sender_id

        if not self._is_user_allowed(sender_id, sender_staff_id):
            logger.debug("[Dingtalk] dropping non-allowlisted user staff_id=%s sender_id=%s", sender_staff_id, sender_id)
            return

        text = self._extract_text(message)
        if is_group and not self._should_process_group(message, chat_id):
            logger.debug("[Dingtalk] dropping group message that failed mention gate chat_id=%s", chat_id)
            return

        # Store session webhook for reply routing
        session_webhook = getattr(message, "session_webhook", None) or ""
        expired_time = getattr(message, "session_webhook_expired_time", 0) or 0
        if session_webhook and chat_id and _DINGTALK_WEBHOOK_RE.match(session_webhook):
            if len(self._session_webhooks) >= _SESSION_WEBHOOKS_MAX:
                self._session_webhooks.pop(next(iter(self._session_webhooks)), None)
            self._session_webhooks[chat_id] = (session_webhook, expired_time)

        if not text:
            logger.debug("[Dingtalk] empty message skipped")
            return

        event = InboundMessage(
            channel_name=self.name,
            chat_id=chat_id,
            user_id=sender_staff_id or sender_id or None,
            text=text,
            msg_type=InboundMessageType.COMMAND if text.startswith("/") else InboundMessageType.CHAT,
            thread_ts=msg_id,
            topic_id=None,
            files=[],
            metadata={"chat_type": "group" if is_group else "dm", "sender_id": sender_id, "sender_nick": sender_nick},
        )
        logger.info(
            "[Dingtalk] inbound from=%s chat_id=%s type=%s text_len=%d\n--- user ---\n%s\n---",
            (sender_staff_id or sender_id)[:8],
            chat_id[:12],
            "group" if is_group else "dm",
            len(text),
            text.strip() or "(empty)",
        )
        await self.bus.publish_inbound(event)

    @staticmethod
    def _extract_text(message: Any) -> str:
        """Extract plain text from a DingTalk chatbot message (SDK >= 0.20)."""
        text = getattr(message, "text", None) or ""
        if hasattr(text, "content"):
            content = (text.content or "").strip()
        elif isinstance(text, dict):
            content = str(text.get("content", "")).strip() if isinstance(text.get("content"), str) else str(text.get("content", "") or "").strip()
        else:
            content = str(text).strip()

        if not content:
            rich_text = getattr(message, "rich_text_content", None) or getattr(message, "rich_text", None)
            if rich_text:
                rich_list = getattr(rich_text, "rich_text_list", None) or rich_text
                if isinstance(rich_list, list):
                    parts = []
                    for item in rich_list:
                        if isinstance(item, dict):
                            t = item.get("text") or item.get("content") or ""
                            if t:
                                parts.append(str(t))
                        elif hasattr(item, "text") and item.text:
                            parts.append(str(item.text))
                    content = " ".join(part for part in parts if part).strip()

        # audio → recognition text
        if not content and str(getattr(message, "message_type", "")) == "audio":
            extensions = getattr(message, "extensions", {}) or {}
            audio_content = extensions.get("content", {})
            if isinstance(audio_content, dict):
                content = str(audio_content.get("recognition", "") or "").strip()

        # file → fileName as text
        if not content and str(getattr(message, "message_type", "")) == "file":
            extensions = getattr(message, "extensions", {}) or {}
            file_content = extensions.get("content", {})
            if isinstance(file_content, dict):
                fname = str(file_content.get("fileName", "") or "").strip()
                if fname:
                    content = f"[文件] {fname}"

        return content

    # ------------------------------------------------------------------
    # Outbound messaging
    # ------------------------------------------------------------------

    def _get_valid_webhook(self, chat_id: str) -> str | None:
        info = self._session_webhooks.get(chat_id)
        if not info:
            return None
        webhook, expired_ms = info
        if expired_ms and expired_ms > 0:
            import time

            now_ms = int(time.time() * 1000)
            if now_ms + 5 * 60 * 1000 >= expired_ms:
                self._session_webhooks.pop(chat_id, None)
                return None
        return webhook

    @staticmethod
    def _normalize_markdown(text: str) -> str:
        """Normalize markdown for DingTalk's parser (numbered lists, code blocks)."""
        lines = text.split("\n")
        out: list[str] = []
        for i, line in enumerate(lines):
            is_numbered = re.match(r"^\d+\.\s", line.strip())
            if is_numbered and i > 0:
                prev = lines[i - 1]
                if prev.strip() and not re.match(r"^\d+\.\s", prev.strip()):
                    out.append("")
            if line.strip().startswith("```") and line != line.lstrip():
                indent = len(line) - len(line.lstrip())
                line = line[indent:]
            out.append(line)
        return "\n".join(out)

    async def send(self, msg: OutboundMessage) -> None:
        """Send a markdown reply via DingTalk session webhook."""
        if not msg.is_final:
            return  # DingTalk webhook has no streaming patch; send once at final.

        chat_id = msg.chat_id
        if not chat_id or not self._http_client:
            return
        text = feishu_outbound_text(msg.text or "")
        if not text.strip():
            return

        session_webhook = self._get_valid_webhook(chat_id)
        if not session_webhook:
            logger.warning("[Dingtalk] no valid session_webhook for chat_id=%s", chat_id)
            return

        logger.info(
            "[Dingtalk] outbound chat_id=%s text_len=%d\n--- assistant ---\n%s\n---",
            chat_id[:12],
            len(text),
            text.strip() or "(empty)",
        )

        normalized = self._normalize_markdown(text[: self.MAX_MESSAGE_LENGTH])
        payload = {
            "msgtype": "markdown",
            "markdown": {"title": "EvoFlow", "text": normalized},
        }
        try:
            resp = await self._http_client.post(session_webhook, json=payload, timeout=15.0)
            if resp.status_code >= 300:
                logger.warning("[Dingtalk] send failed HTTP %d: %s", resp.status_code, resp.text[:200])
                return
            data = resp.json()
            if data.get("errcode", 0) not in (0, None):
                logger.warning("[Dingtalk] send API error: %s", data.get("errmsg", "unknown"))
        except httpx.TimeoutException:
            logger.warning("[Dingtalk] timeout sending to %s", chat_id)
        except Exception as exc:
            logger.error("[Dingtalk] send failed: %s", exc)

    async def send_typing(self, chat_id: str) -> None:
        """DingTalk does not support typing indicators."""
        del chat_id


class _IncomingHandler(dingtalk_stream.ChatbotHandler if DINGTALK_STREAM_AVAILABLE else object):  # type: ignore[misc]
    """dingtalk-stream ChatbotHandler that forwards messages to the channel."""

    def __init__(self, channel: DingtalkChannel):
        if DINGTALK_STREAM_AVAILABLE:
            super().__init__()
        self._channel = channel

    def pre_start(self) -> None:
        """No-op pre-start hook required by dingtalk-stream SDK."""
        return

    async def process(self, message: CallbackMessage):  # type: ignore[override]
        """Called by dingtalk-stream when a message arrives (SDK >= 0.20)."""
        try:
            data = message.data
            if isinstance(data, str):
                data = json.loads(data)
            chatbot_msg = ChatbotMessage.from_dict(data)

            if not getattr(chatbot_msg, "session_webhook", None):
                webhook = (data.get("sessionWebhook") or data.get("session_webhook") or "") if isinstance(data, dict) else ""
                if webhook:
                    chatbot_msg.session_webhook = webhook

            if not getattr(chatbot_msg, "is_in_at_list", False):
                raw_flag = data.get("isInAtList") if isinstance(data, dict) else False
                if raw_flag:
                    chatbot_msg.is_in_at_list = True

            asyncio.create_task(self._safe_on_message(chatbot_msg))
        except Exception:
            logger.exception("[Dingtalk] error preparing incoming message")
            return AckMessage.STATUS_SYSTEM_EXCEPTION, "error"
        return AckMessage.STATUS_OK, "OK"

    async def _safe_on_message(self, chatbot_msg: ChatbotMessage) -> None:
        try:
            await self._channel._on_message(chatbot_msg)
        except Exception:
            logger.exception("[Dingtalk] error processing incoming message")
