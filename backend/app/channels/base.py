"""Abstract base class for IM channels."""

from __future__ import annotations

import json
import logging
import os
import sys
import time
from abc import ABC, abstractmethod
from dataclasses import replace
from pathlib import Path
from typing import Any

from app.channels.message_bus import InboundMessage, InboundMessageType, MessageBus, OutboundMessage, ResolvedAttachment

logger = logging.getLogger(__name__)

_DIAG_LOG_PATH = Path(
    os.environ.get("EVOFLOW_DIAG_LOG", r"C:\Users\admin\.evoflow-dev\logs\channel-diag.log")
)


def _diag_write(channel: str, event: str, **fields: Any) -> None:
    """Append a JSON line to the channel diagnostic log.

    Independent of uvicorn/logger pipeline so we can see traffic even when the
    launcher drops stderr or the root logger isn't configured for the channel.
    """
    try:
        _DIAG_LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
        line = json.dumps(
            {"ts": time.time(), "pid": os.getpid(), "channel": channel, "event": event, **fields},
            ensure_ascii=False,
            default=str,
        )
        with open(_DIAG_LOG_PATH, "a", encoding="utf-8") as fp:
            fp.write(line + "\n")
        # Also print to stderr so it shows up in the terminal
        print(line, file=sys.stderr, flush=True)
    except Exception:
        pass


class Channel(ABC):
    """Base class for all IM channel implementations.

    Each channel connects to an external messaging platform and:
    1. Receives messages, wraps them as InboundMessage, publishes to the bus.
    2. Subscribes to outbound messages and sends replies back to the platform.

    Subclasses must implement ``start``, ``stop``, and ``send``.
    """

    def __init__(self, name: str, bus: MessageBus, config: dict[str, Any]) -> None:
        self.name = name
        self.bus = bus
        self.config = config
        self._running = False

    # -- diagnostic helpers (override in subclasses for richer payloads) ----

    def _diag_outbound_enter(self, msg: OutboundMessage) -> None:
        _diag_write(
            self.name,
            "outbound_enter",
            chat_id=msg.chat_id,
            text_len=len(msg.text or ""),
            text_preview=(msg.text or "")[:300],
            is_final=msg.is_final,
            has_attachments=bool(msg.attachments),
        )

    def _diag_outbound_done(self, msg: OutboundMessage, *, ok: bool, error: str | None = None) -> None:
        _diag_write(
            self.name,
            "outbound_done",
            chat_id=msg.chat_id,
            ok=ok,
            error=error,
            is_final=msg.is_final,
        )

    @property
    def is_running(self) -> bool:
        return self._running

    # -- lifecycle ---------------------------------------------------------

    @abstractmethod
    async def start(self) -> None:
        """Start listening for messages from the external platform."""

    @abstractmethod
    async def stop(self) -> None:
        """Gracefully stop the channel."""

    # -- outbound ----------------------------------------------------------

    @abstractmethod
    async def send(self, msg: OutboundMessage) -> None:
        """Send a message back to the external platform.

        The implementation should use ``msg.chat_id`` and ``msg.thread_ts``
        to route the reply to the correct conversation/thread.
        """

    async def send_file(self, msg: OutboundMessage, attachment: ResolvedAttachment) -> bool:
        """Upload a single file attachment to the platform.

        Returns True if the upload succeeded, False otherwise.
        Default implementation returns False (no file upload support).
        """
        return False

    # -- helpers -----------------------------------------------------------

    def _make_inbound(
        self,
        chat_id: str,
        user_id: str,
        text: str,
        *,
        msg_type: InboundMessageType = InboundMessageType.CHAT,
        thread_ts: str | None = None,
        files: list[dict[str, Any]] | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> InboundMessage:
        """Convenience factory for creating InboundMessage instances."""
        return InboundMessage(
            channel_name=self.name,
            chat_id=chat_id,
            user_id=user_id,
            text=text,
            msg_type=msg_type,
            thread_ts=thread_ts,
            files=files or [],
            metadata=metadata or {},
        )

    async def _on_outbound(self, msg: OutboundMessage) -> None:
        """Outbound callback registered with the bus.

        Only forwards messages targeted at this channel.
        Sends the text message first, then uploads any file attachments.
        File uploads are skipped entirely when the text send fails to avoid
        partial deliveries (files without accompanying text).
        """
        if msg.channel_name == self.name:
            self._diag_outbound_enter(msg)
            try:
                await self.send(msg)
                self._diag_outbound_done(msg, ok=True)
            except Exception as exc:
                self._diag_outbound_done(msg, ok=False, error=str(exc))
                logger.exception("Failed to send outbound message on channel %s", self.name)
                return  # Do not attempt file uploads when the text message failed

            failed_names: list[str] = []
            for attachment in msg.attachments:
                try:
                    success = await self.send_file(msg, attachment)
                    if not success:
                        logger.warning("[%s] file upload skipped for %s", self.name, attachment.filename)
                        failed_names.append(attachment.filename)
                except Exception:
                    logger.exception("[%s] failed to upload file %s", self.name, attachment.filename)
                    failed_names.append(attachment.filename)

            if failed_names:
                notice = replace(
                    msg,
                    text=f"以下文件未能发送：{', '.join(failed_names)}",
                    attachments=[],
                    artifacts=[],
                )
                try:
                    await self.send(notice)
                except Exception:
                    logger.exception("[%s] failed to notify user about attachment failures", self.name)
