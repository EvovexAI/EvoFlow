"""Complete IM channel message I/O logging (user inbound / assistant outbound)."""

from __future__ import annotations

import logging
from datetime import UTC, datetime

from app.channels.message_bus import InboundMessage, OutboundMessage

logger = logging.getLogger(__name__)


def _now_iso() -> str:
    return datetime.now(UTC).isoformat().replace("+00:00", "Z")


def _format_text_block(text: str) -> str:
    body = str(text or "")
    if not body:
        return "(empty)"
    return body


def log_channel_inbound(msg: InboundMessage, *, thread_id: str | None = None) -> None:
    """Log full user message from IM channel (Feishu / Weixin / …)."""
    text = _format_text_block(msg.text)
    logger.info(
        "[ChannelIO] inbound channel=%s chat_id=%s user_id=%s type=%s topic_id=%s thread_ts=%s files=%d\n--- user ---\n%s\n---",
        msg.channel_name,
        msg.chat_id,
        msg.user_id,
        msg.msg_type.value,
        msg.topic_id,
        msg.thread_ts,
        len(msg.files or []),
        text,
    )


def log_channel_inbound_bound(msg: InboundMessage, thread_id: str) -> None:
    """Correlate inbound user message with LangGraph thread_id (after routing)."""
    tid = (thread_id or "").strip()
    if not tid:
        return
    logger.info(
        "[ChannelIO] inbound bound channel=%s chat_id=%s thread_id=%s user_id=%s\n--- user ---\n%s\n---",
        msg.channel_name,
        msg.chat_id,
        tid,
        msg.user_id,
        _format_text_block(msg.text),
    )


def log_channel_outbound(msg: OutboundMessage, *, skip_partial: bool = True) -> None:
    """Log full assistant reply sent to IM channel."""
    if skip_partial and not msg.is_final:
        logger.debug(
            "[ChannelIO] outbound partial skipped: channel=%s chat_id=%s text_len=%d",
            msg.channel_name,
            msg.chat_id,
            len(msg.text or ""),
        )
        return
    text = _format_text_block(msg.text)
    logger.info(
        "[ChannelIO] outbound channel=%s chat_id=%s thread_id=%s is_final=%s artifacts=%d attachments=%d\n--- assistant ---\n%s\n---",
        msg.channel_name,
        msg.chat_id,
        msg.thread_id,
        msg.is_final,
        len(msg.artifacts or []),
        len(msg.attachments or []),
        text,
    )
