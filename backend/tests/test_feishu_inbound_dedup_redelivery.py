"""Feishu WS reconnect redelivers the same message_id — must not re-run the agent."""

from __future__ import annotations

from unittest.mock import patch

from app.channels.feishu import _FeishuInboundDeduper


def test_same_msg_id_within_memory_is_duplicate():
    d = _FeishuInboundDeduper(id_ttl=86_400.0, content_ttl=20.0)
    assert (
        d.is_duplicate(
            account_id="emp-a",
            msg_id="om_replay_1",
            chat_id="oc_chat",
            text="你是谁",
        )
        is False
    )
    assert (
        d.is_duplicate(
            account_id="emp-a",
            msg_id="om_replay_1",
            chat_id="oc_chat",
            text="你是谁",
        )
        is True
    )


def test_durable_push_log_blocks_after_memory_ttl_expiry():
    """Simulates: first handle → TTL purged memory → Feishu redelivers same om_…"""
    d = _FeishuInboundDeduper(id_ttl=0.01, content_ttl=0.01)
    with patch.object(_FeishuInboundDeduper, "_durable_seen", return_value=False):
        assert (
            d.is_duplicate(
                account_id="emp-a",
                msg_id="om_old",
                chat_id="oc_chat",
                text="哈喽",
            )
            is False
        )
    # Force memory expiry
    d._by_msg_id.clear()
    d._by_content.clear()
    with patch.object(_FeishuInboundDeduper, "_durable_seen", return_value=True) as durable:
        assert (
            d.is_duplicate(
                account_id="emp-a",
                msg_id="om_old",
                chat_id="oc_chat",
                text="哈喽",
            )
            is True
        )
        durable.assert_called()


def test_different_msg_id_same_text_after_content_window_allowed():
    d = _FeishuInboundDeduper(id_ttl=86_400.0, content_ttl=0.01)
    assert (
        d.is_duplicate(
            account_id="emp-a",
            msg_id="om_1",
            chat_id="oc_chat",
            text="你好",
        )
        is False
    )
    d._by_content.clear()
    with patch.object(_FeishuInboundDeduper, "_durable_seen", return_value=False):
        assert (
            d.is_duplicate(
                account_id="emp-a",
                msg_id="om_2",
                chat_id="oc_chat",
                text="你好",
            )
            is False
        )
