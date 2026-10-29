"""MessageBus — async pub/sub hub that decouples channels from the agent dispatcher."""

from __future__ import annotations

import asyncio
import contextlib
import logging
import time
from collections.abc import Callable, Coroutine
from dataclasses import dataclass, field
from enum import StrEnum
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Message types
# ---------------------------------------------------------------------------


class InboundMessageType(StrEnum):
    """Types of messages arriving from IM channels."""

    CHAT = "chat"
    COMMAND = "command"


@dataclass
class InboundMessage:
    """A message arriving from an IM channel toward the agent dispatcher.

    Attributes:
        channel_name: Name of the source channel (e.g. "feishu", "slack").
        chat_id: Platform-specific chat/conversation identifier.
        user_id: Platform-specific user identifier.
        text: The message text.
        msg_type: Whether this is a regular chat message or a command.
        thread_ts: Optional platform thread identifier (for threaded replies).
        topic_id: Conversation topic identifier used to map to a EvoFlow thread.
            Messages sharing the same ``topic_id`` within a ``chat_id`` will
            reuse the same EvoFlow thread.  When ``None``, the store uses only
            ``channel_name:chat_id`` (e.g. one continuous thread per Feishu chat
            or Telegram private chat).
        files: Optional list of file attachments (platform-specific dicts).
        metadata: Arbitrary extra data from the channel.
        created_at: Unix timestamp when the message was created.
    """

    channel_name: str
    chat_id: str
    user_id: str
    text: str
    msg_type: InboundMessageType = InboundMessageType.CHAT
    thread_ts: str | None = None
    topic_id: str | None = None
    files: list[dict[str, Any]] = field(default_factory=list)
    metadata: dict[str, Any] = field(default_factory=dict)
    # account_id: identifies which channel instance picked up the message
    # (e.g. "" = primary bot, "customer-service" = a per-employee bot).
    # Echoed verbatim onto the matching OutboundMessage so the bus can route
    # the reply back to the same instance.
    account_id: str = ""
    created_at: float = field(default_factory=time.time)


@dataclass
class ResolvedAttachment:
    """A file attachment resolved to a host filesystem path, ready for upload.

    Attributes:
        virtual_path: Original virtual path (e.g. /mnt/user-data/outputs/report.pdf).
        actual_path: Resolved host filesystem path.
        filename: Basename of the file.
        mime_type: MIME type (e.g. "application/pdf").
        size: File size in bytes.
        is_image: True for image/* MIME types (platforms may handle images differently).
    """

    virtual_path: str
    actual_path: Path
    filename: str
    mime_type: str
    size: int
    is_image: bool


@dataclass
class OutboundMessage:
    """A message from the agent dispatcher back to a channel.

    Attributes:
        channel_name: Target channel name (used for routing).
        chat_id: Target chat/conversation identifier.
        thread_id: EvoFlow thread ID that produced this response.
        text: The response text.
        artifacts: List of artifact paths produced by the agent.
        is_final: Whether this is the final message in the response stream.
        thread_ts: Optional platform thread identifier for threaded replies.
        metadata: Arbitrary extra data.
        created_at: Unix timestamp.
    """

    channel_name: str
    chat_id: str
    thread_id: str
    text: str
    artifacts: list[str] = field(default_factory=list)
    attachments: list[ResolvedAttachment] = field(default_factory=list)
    is_final: bool = True
    thread_ts: str | None = None
    topic_id: str | None = None
    metadata: dict[str, Any] = field(default_factory=dict)
    # account_id: identifies which channel instance should receive the
    # reply (e.g. "" = primary bot, "customer-service" = per-employee bot).
    # Bus routes outbound via ``(channel_name, account_id)`` so replies
    # always go to the same instance that received the inbound.
    account_id: str = ""
    created_at: float = field(default_factory=time.time)


# ---------------------------------------------------------------------------
# MessageBus
# ---------------------------------------------------------------------------

OutboundCallback = Callable[[OutboundMessage], Coroutine[Any, Any, None]]


class MessageBus:
    """Async pub/sub hub connecting channels and the agent dispatcher.

    Channels publish inbound messages; the dispatcher consumes them.
    The dispatcher publishes outbound messages; channels receive them
    via registered callbacks.
    """

    def __init__(self) -> None:
        self._inbound_queue: asyncio.Queue[InboundMessage] = asyncio.Queue()
        # One handler per (channel_name, account_id) tuple. Multiple IM accounts
        # may share a channel_name (e.g. primary bot + per-employee bots both
        # named "wecom"), and each instance must own its own callback — otherwise
        # the last-started instance overwrites the earlier ones and replies get
        # sent by whichever bot happens to have started last.
        self._outbound_by_account: dict[tuple[str, str], OutboundCallback] = {}
        # Ad-hoc listeners (tests, debug taps) receive every outbound message.
        self._outbound_listeners: list[OutboundCallback] = []

    # -- inbound -----------------------------------------------------------

    async def publish_inbound(self, msg: InboundMessage) -> None:
        """Enqueue an inbound message from a channel."""
        from app.channels.channel_io_log import log_channel_inbound

        log_channel_inbound(msg)
        await self._inbound_queue.put(msg)
        logger.info(
            "[Bus] inbound enqueued: channel=%s, chat_id=%s, type=%s, queue_size=%d",
            msg.channel_name,
            msg.chat_id,
            msg.msg_type.value,
            self._inbound_queue.qsize(),
        )

    async def get_inbound(self, timeout: float | None = None) -> InboundMessage:
        """Block until the next inbound message is available.

        When ``timeout`` is set, raise ``asyncio.TimeoutError`` if no message arrives in time.
        """
        if timeout is None:
            return await self._inbound_queue.get()
        return await asyncio.wait_for(self._inbound_queue.get(), timeout)

    @property
    def inbound_queue(self) -> asyncio.Queue[InboundMessage]:
        return self._inbound_queue

    # -- outbound ----------------------------------------------------------

    def subscribe_outbound(
        self,
        callback: OutboundCallback,
        *,
        channel_name: str | None = None,
        account_id: str = "",
    ) -> None:
        """Register an outbound handler.

        With ``channel_name``, the handler is keyed by ``(channel_name, account_id)``
        so multiple channel instances (e.g. a primary bot + several per-employee
        bots all named ``"wecom"``) each get their own callback. Restarting one
        instance only replaces its own slot — it does NOT clobber siblings.

        Without ``channel_name``, the callback receives all outbound messages
        (tests / debug taps).
        """
        if channel_name:
            self._outbound_by_account[(channel_name, account_id)] = callback
            return
        self._outbound_listeners.append(callback)

    def unsubscribe_outbound(
        self,
        callback: OutboundCallback | None = None,
        *,
        channel_name: str | None = None,
        account_id: str = "",
    ) -> None:
        """Remove a channel handler or an ad-hoc listener.

        ``channel_name`` + ``account_id`` identify the specific slot; the
        callback argument is unused in that path but kept for listener mode.
        """
        if channel_name:
            self._outbound_by_account.pop((channel_name, account_id), None)
            return
        if callback is not None:
            self._outbound_listeners = [cb for cb in self._outbound_listeners if cb is not callback]

    @staticmethod
    async def _invoke_outbound_callback(callback: OutboundCallback, msg: OutboundMessage) -> None:
        """Invoke a channel/listener callback; re-raise so callers can audit failure."""
        await callback(msg)

    def has_outbound(self, channel_name: str, account_id: str = "") -> bool:
        """True when a channel instance is registered for this outbound slot."""
        return (str(channel_name or ""), str(account_id or "")) in self._outbound_by_account

    @staticmethod
    def _record_outbound_push(
        msg: OutboundMessage,
        *,
        status: str,
        event: str,
        error: str = "",
        delivery: str = "",
    ) -> None:
        """Write one ops row for a final outbound. Never raises into the send path."""
        if not msg.is_final:
            return
        with contextlib.suppress(Exception):
            from evoflow.persistence.channel_push_repositories import safe_record_push

            _meta = msg.metadata if isinstance(msg.metadata, dict) else {}
            _kind = str(_meta.get("kind") or "im_message").strip() or "im_message"
            _rtype = str(_meta.get("receive_id_type") or "chat_id").strip() or "chat_id"
            _triggered = str(_meta.get("triggered_by") or "agent").strip() or "agent"
            _title = str(_meta.get("title") or "").strip()
            _task_id = str(_meta.get("task_id") or "").strip()
            _role = str(_meta.get("role_agent_code") or "").strip()
            _sender = str(msg.account_id or "").strip() or str(_meta.get("account_id") or "").strip()
            payload: dict[str, Any] = {
                "thread_id": str(msg.thread_id or ""),
                "topic_id": str(msg.topic_id or ""),
                "is_final": True,
                "artifacts": list(msg.artifacts or [])[:8],
                "attachments": [
                    getattr(a, "virtual_path", str(a)) if not isinstance(a, str) else a
                    for a in (msg.attachments or [])
                ][:8],
                "msg_type": "interactive" if _meta.get("proactive_markdown") else None,
                "source": "message_bus",
                "metadata": {k: _meta[k] for k in list(_meta.keys())[:12]},
            }
            if delivery:
                payload["delivery"] = delivery
            safe_record_push(
                direction="outbound",
                channel=str(msg.channel_name or "").strip() or "im",
                kind=_kind,
                event=event,
                transport="im_event",
                task_id=_task_id,
                role_agent_code=_role,
                sender_account_id=_sender,
                external_message_id=str(msg.thread_ts or ""),
                receive_id=str(msg.chat_id or ""),
                receive_id_type=_rtype,
                title=_title,
                content_summary=str(msg.text or "")[:800],
                payload=payload,
                status=status,
                error=str(error or "")[:400],
                triggered_by=_triggered,
            )

    async def publish_outbound(self, msg: OutboundMessage) -> None:
        """Dispatch an outbound message to the channel handler and optional listeners.

        Ops audit for ``is_final`` runs **after** the channel callback attempt so
        「成功已回复」means the handler ran without raising — not merely that the
        bus accepted the message. Missing handlers / send exceptions are logged
        as ``status=error`` (event ``send_failed`` / ``dropped``).
        """
        from app.channels.channel_io_log import log_channel_outbound

        log_channel_outbound(msg)
        # Route by (channel_name, account_id) so the reply lands on the same
        # channel instance that received the inbound. Empty account_id means
        # "primary bot" and is its own slot — it no longer catches replies
        # meant for per-employee bots.
        #
        # Proactive markdown may intentionally use slot="" (primary) while
        # stamping metadata.account_id for credentials — do NOT promote that
        # into the routing key or the message is dropped when only primary is
        # registered. Older reply publishers that only stamped metadata still
        # get the fallthrough below.
        _meta_route = msg.metadata if isinstance(msg.metadata, dict) else {}
        aid = str(msg.account_id or "").strip()
        if not aid and not _meta_route.get("proactive_markdown"):
            aid = str(_meta_route.get("account_id") or "").strip()
            if aid:
                msg.account_id = aid
        key = (msg.channel_name, str(msg.account_id or "").strip())
        aid = str(msg.account_id or "").strip()
        channel_cb = self._outbound_by_account.get(key)
        delivery_via = "exact"
        # Employee inbound (Feishu nested WS / bootstrap tag) stamps account_id=emp-…
        # while the multiplexed primary only registered slot "". Without this
        # fallback replies are audited as dropped and never reach Feishu.
        if channel_cb is None and aid:
            primary_cb = self._outbound_by_account.get((msg.channel_name, ""))
            if primary_cb is not None:
                channel_cb = primary_cb
                delivery_via = "primary_fallback"
                logger.warning(
                    "[Bus] outbound slot missing for %s/%s — falling back to primary slot "
                    "(registered=%s)",
                    msg.channel_name,
                    aid,
                    sorted(
                        f"{ch}:{a or '-'}"
                        for (ch, a) in self._outbound_by_account
                        if ch == msg.channel_name
                    ),
                )
        listener_count = (1 if channel_cb else 0) + len(self._outbound_listeners)
        logger.info(
            "[Bus] outbound dispatching: channel=%s account_id=%s chat_id=%s listeners=%d "
            "via=%s text_len=%d",
            msg.channel_name,
            aid,
            msg.chat_id,
            listener_count,
            delivery_via,
            len(msg.text),
        )
        deliver_error = ""
        delivery = "ok"
        if channel_cb is not None:
            logger.info(
                "[Bus] invoking channel callback for %s/%s via=%s",
                msg.channel_name,
                aid or "-",
                delivery_via,
            )
            try:
                await self._invoke_outbound_callback(channel_cb, msg)
                logger.info(
                    "[Bus] channel callback completed for %s/%s (text_len=%d via=%s)",
                    msg.channel_name,
                    aid or "-",
                    len(msg.text),
                    delivery_via,
                )
            except Exception as exc:
                deliver_error = str(exc)[:400]
                delivery = "callback_error"
                logger.exception(
                    "[Bus] outbound callback failed channel=%s account_id=%s chat_id=%s",
                    msg.channel_name,
                    aid,
                    msg.chat_id,
                )
        else:
            delivery = "no_callback"
            registered = sorted(
                f"{ch}:{a or '-'}" for (ch, a) in self._outbound_by_account if ch == msg.channel_name
            )
            deliver_error = (
                f"no outbound callback for channel={msg.channel_name} account_id={aid or '-'}"
                f" registered={registered}"
            )
            logger.warning(
                "[Bus] no outbound callback registered for channel=%s account_id=%s "
                "registered=%s — message dropped",
                msg.channel_name,
                aid,
                registered,
            )
        for callback in self._outbound_listeners:
            try:
                await self._invoke_outbound_callback(callback, msg)
            except Exception:
                logger.exception(
                    "Error in outbound listener for channel=%s", msg.channel_name
                )
        # Channel-audit AFTER dispatch: ops 「成功已回复」 must not lie when the
        # Feishu/WeCom handler never ran or raised. Stream patches stay unaudited.
        if msg.is_final:
            if delivery == "ok":
                self._record_outbound_push(msg, status="ok", event="sent", delivery=delivery)
            else:
                self._record_outbound_push(
                    msg,
                    status="error",
                    event="send_failed" if delivery == "callback_error" else "dropped",
                    error=deliver_error,
                    delivery=delivery,
                )
