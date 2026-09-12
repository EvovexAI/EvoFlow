"""MessageBus — async pub/sub hub that decouples channels from the agent dispatcher."""

from __future__ import annotations

import asyncio
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
        # One handler per IM channel (feishu/weixin/…); channel restart replaces in place.
        self._outbound_by_channel: dict[str, OutboundCallback] = {}
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
    ) -> None:
        """Register an outbound handler.

        When ``channel_name`` is set, only one handler per channel is kept (restarts replace).
        Without ``channel_name``, the callback receives all outbound messages (tests).
        """
        if channel_name:
            self._outbound_by_channel[channel_name] = callback
            return
        self._outbound_listeners.append(callback)

    def unsubscribe_outbound(
        self,
        callback: OutboundCallback | None = None,
        *,
        channel_name: str | None = None,
    ) -> None:
        """Remove a channel handler or an ad-hoc listener."""
        if channel_name:
            self._outbound_by_channel.pop(channel_name, None)
            return
        if callback is not None:
            self._outbound_listeners = [cb for cb in self._outbound_listeners if cb is not callback]

    @staticmethod
    async def _invoke_outbound_callback(callback: OutboundCallback, msg: OutboundMessage) -> None:
        try:
            await callback(msg)
        except Exception:
            logger.exception("Error in outbound callback for channel=%s", msg.channel_name)

    async def publish_outbound(self, msg: OutboundMessage) -> None:
        """Dispatch an outbound message to the channel handler and optional listeners."""
        from app.channels.channel_io_log import log_channel_outbound

        log_channel_outbound(msg)
        channel_cb = self._outbound_by_channel.get(msg.channel_name)
        listener_count = (1 if channel_cb else 0) + len(self._outbound_listeners)
        logger.info(
            "[Bus] outbound dispatching: channel=%s, chat_id=%s, listeners=%d, text_len=%d",
            msg.channel_name,
            msg.chat_id,
            listener_count,
            len(msg.text),
        )
        if channel_cb is not None:
            await self._invoke_outbound_callback(channel_cb, msg)
        for callback in self._outbound_listeners:
            await self._invoke_outbound_callback(callback, msg)
