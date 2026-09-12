"""Tests for IM channel message I/O logging."""

from unittest.mock import patch

from app.channels.channel_io_log import log_channel_inbound, log_channel_outbound
from app.channels.message_bus import InboundMessage, InboundMessageType, OutboundMessage


def test_log_channel_inbound_writes_full_user_text():
    msg = InboundMessage(
        channel_name="feishu",
        chat_id="oc_chat",
        user_id="ou_user",
        text="用户发来的完整消息\n第二行",
        msg_type=InboundMessageType.CHAT,
    )
    with patch("app.channels.channel_io_log.logger") as mock_logger:
        log_channel_inbound(msg)
    mock_logger.info.assert_called_once()
    args = mock_logger.info.call_args[0]
    assert "feishu" in args
    assert "用户发来的完整消息\n第二行" in args


def test_log_channel_outbound_skips_partial_by_default():
    msg = OutboundMessage(
        channel_name="feishu",
        chat_id="oc_chat",
        thread_id="thread-1",
        text="streaming chunk",
        is_final=False,
    )
    with patch("app.channels.channel_io_log.logger") as mock_logger:
        log_channel_outbound(msg)
    mock_logger.info.assert_not_called()


def test_log_channel_outbound_logs_final_assistant_text():
    msg = OutboundMessage(
        channel_name="weixin",
        chat_id="wx_chat",
        thread_id="thread-2",
        text="助手完整回复",
        is_final=True,
    )
    with patch("app.channels.channel_io_log.logger") as mock_logger:
        log_channel_outbound(msg)
    mock_logger.info.assert_called_once()
    args = mock_logger.info.call_args[0]
    assert "weixin" in args
    assert "助手完整回复" in args
