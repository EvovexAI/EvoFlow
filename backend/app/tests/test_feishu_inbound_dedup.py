"""Feishu inbound dedup + group mention gate."""

from __future__ import annotations

from types import SimpleNamespace

from app.channels.feishu import (
    _FeishuInboundDeduper,
    _feishu_account_open_id,
    _feishu_mention_open_ids,
    _feishu_sender_is_bot,
    _feishu_should_skip_unmentioned_group,
)


def test_inbound_deduper_same_msg_id():
    d = _FeishuInboundDeduper(id_ttl=60, content_ttl=20)
    assert (
        d.is_duplicate(account_id="xiaomi", msg_id="om_1", chat_id="oc_g", text="@_user_1 我是谁")
        is False
    )
    assert (
        d.is_duplicate(account_id="xiaomi", msg_id="om_1", chat_id="oc_g", text="@_user_1 我是谁")
        is True
    )
    # Different account may still process the same Feishu message_id
    assert (
        d.is_duplicate(account_id="code-agent", msg_id="om_1", chat_id="oc_g", text="@_user_1 我是谁")
        is False
    )


def test_inbound_deduper_same_content_short_window():
    d = _FeishuInboundDeduper(id_ttl=60, content_ttl=20)
    assert d.is_duplicate(account_id="xiaomi", msg_id="om_a", chat_id="oc_g", text="@_user_1 你能干嘛呀") is False
    # New message_id, same normalized body → drop (WS replay / double delivery)
    assert d.is_duplicate(account_id="xiaomi", msg_id="om_b", chat_id="oc_g", text="@_user_1 你能干嘛呀") is True


def test_group_skip_when_mentions_exclude_self():
    assert (
        _feishu_should_skip_unmentioned_group(
            chat_type="group",
            chat_id="oc_g",
            bot_open_id="ou_xiaomi",
            mention_open_ids={"ou_other"},
            account_id="",
        )
        is True
    )
    # Employee dedicated WS must never drop on open_id mismatch
    assert (
        _feishu_should_skip_unmentioned_group(
            chat_type="group",
            chat_id="oc_g",
            bot_open_id="ou_xiaomi",
            mention_open_ids={"ou_other"},
            account_id="xiaomi",
        )
        is False
    )
    assert (
        _feishu_should_skip_unmentioned_group(
            chat_type="group",
            chat_id="oc_g",
            bot_open_id="ou_xiaomi",
            mention_open_ids={"ou_xiaomi"},
            account_id="",
        )
        is False
    )
    # Empty mentions → keep (delivery often already filtered)
    assert (
        _feishu_should_skip_unmentioned_group(
            chat_type="group",
            chat_id="oc_g",
            bot_open_id="ou_xiaomi",
            mention_open_ids=set(),
            account_id="",
        )
        is False
    )
    assert (
        _feishu_should_skip_unmentioned_group(
            chat_type="p2p",
            chat_id="ou_dm",
            bot_open_id="ou_xiaomi",
            mention_open_ids={"ou_other"},
            account_id="",
        )
        is False
    )


def test_mention_open_ids_and_account_open_id():
    msg = SimpleNamespace(
        mentions=[
            SimpleNamespace(id=SimpleNamespace(open_id="ou_a", user_id="")),
            {"id": {"open_id": "ou_b"}},
        ]
    )
    assert _feishu_mention_open_ids(msg) == {"ou_a", "ou_b"}
    cfg = {"accounts": {"xiaomi": {"open_id": "ou_xiaomi"}}, "open_id": "ou_primary"}
    assert _feishu_account_open_id(cfg, "xiaomi") == "ou_xiaomi"
    assert _feishu_account_open_id(cfg, "") == "ou_primary"


def test_sender_is_bot():
    user_ev = SimpleNamespace(event=SimpleNamespace(sender=SimpleNamespace(sender_type="user")))
    bot_ev = SimpleNamespace(event=SimpleNamespace(sender=SimpleNamespace(sender_type="app")))
    assert _feishu_sender_is_bot(user_ev) is False
    assert _feishu_sender_is_bot(bot_ev) is True


def test_prefer_account_id_keeps_empty_primary():
    from app.channels.feishu import FeishuChannel

    assert FeishuChannel._prefer_account_id("", "xiaomi") == ""
    assert FeishuChannel._prefer_account_id(None, "xiaomi") == "xiaomi"
    assert FeishuChannel._prefer_account_id(None, None, "") == ""


def test_resolve_outbound_trusts_stamped_primary_over_chat_account():
    from app.channels.feishu import FeishuChannel
    from app.channels.message_bus import MessageBus, OutboundMessage

    ch = FeishuChannel(MessageBus(), {"app_id": "x", "app_secret": "y"})
    ch._chat_account["oc_g"] = "xiaomi"
    # Stamped primary (""): must not fall back to xiaomi
    msg = OutboundMessage(
        channel_name="feishu",
        chat_id="oc_g",
        thread_id="t1",
        text="hi",
        metadata={"account_id": ""},
    )
    assert ch._resolve_outbound_account_id(msg) == ""
    # Employee stamp wins
    msg2 = OutboundMessage(
        channel_name="feishu",
        chat_id="oc_g",
        thread_id="t1",
        text="hi",
        metadata={"account_id": "code-agent"},
    )
    assert ch._resolve_outbound_account_id(msg2) == "code-agent"
    # Missing key → legacy chat_account hint
    msg3 = OutboundMessage(channel_name="feishu", chat_id="oc_g", thread_id="t1", text="hi", metadata={})
    assert ch._resolve_outbound_account_id(msg3) == "xiaomi"


def test_outbound_metadata_always_stamps_account_id():
    from app.channels.manager import ChannelManager
    from app.channels.message_bus import InboundMessage, InboundMessageType

    primary = InboundMessage(
        channel_name="feishu",
        chat_id="oc_g",
        user_id="ou_u",
        text="hi",
        msg_type=InboundMessageType.CHAT,
        metadata={},
    )
    assert ChannelManager._outbound_metadata_from_inbound(primary) == {"account_id": ""}
    xiaomi = InboundMessage(
        channel_name="feishu",
        chat_id="oc_g",
        user_id="ou_u",
        text="hi",
        msg_type=InboundMessageType.CHAT,
        metadata={"account_id": "xiaomi"},
    )
    assert ChannelManager._outbound_metadata_from_inbound(xiaomi) == {"account_id": "xiaomi"}
