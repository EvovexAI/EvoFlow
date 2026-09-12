"""Feishu multi-bot thread isolation + employee IM identity."""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import patch

from app.channels.manager import ChannelManager
from app.channels.message_bus import InboundMessage, InboundMessageType
from evoflow.agents.lead_agent.prompt import _proactive_employee_im_identity_block


def _msg(*, account_id: str = "", topic_id: str | None = None, channel: str = "feishu") -> InboundMessage:
    meta = {"account_id": account_id} if account_id else {}
    m = InboundMessage(
        channel_name=channel,
        chat_id="oc_group_1",
        user_id="ou_user",
        text="hello",
        msg_type=InboundMessageType.CHAT,
        metadata=meta,
    )
    m.topic_id = topic_id
    return m


def test_feishu_store_topic_isolates_accounts():
    a = ChannelManager._channel_store_topic(_msg(account_id="code-agent"))
    b = ChannelManager._channel_store_topic(_msg(account_id="xiaomi"))
    assert a == "acct:code-agent"
    assert b == "acct:xiaomi"
    assert a != b
    assert ChannelManager._channel_store_topic(_msg(account_id="")) is None
    assert (
        ChannelManager._channel_store_topic(_msg(account_id="code-agent", topic_id="root1"))
        == "acct:code-agent:root1"
    )


def test_im_routing_key_includes_account():
    k1 = ChannelManager._im_routing_key(_msg(account_id="code-agent"))
    k2 = ChannelManager._im_routing_key(_msg(account_id="xiaomi"))
    assert "acct:code-agent" in k1
    assert "acct:xiaomi" in k2
    assert k1 != k2


def test_proactive_employee_im_identity_block():
    from evoflow.agents.lead_agent.prompt import (
        _display_agent_name,
        _primary_assistant_im_identity_block,
        _proactive_employee_im_identity_block,
    )

    role = SimpleNamespace(
        status="active",
        role_name="前端工程师",
        department="研发",
        config=SimpleNamespace(responsibilities=["改页面", "自测关键路径"]),
    )
    with patch(
        "evoflow.proactive.repositories.ProactiveRepository.get_role",
        return_value=role,
    ):
        block = _proactive_employee_im_identity_block("code-agent")
    assert "前端工程师" in block
    assert "改页面" in block
    assert "我是前端工程师" in block
    assert "不要自称底层模型名" in block or "禁止自称底层模型名" in block
    with patch(
        "evoflow.proactive.repositories.ProactiveRepository.get_role",
        return_value=None,
    ):
        assert _proactive_employee_im_identity_block("unknown-agent") == ""

    # Primary must not inherit a leftover proactive role on agent_code=main
    main_role = SimpleNamespace(
        status="active",
        role_name="验证岗 2026-08-16",
        department="",
        config=SimpleNamespace(responsibilities=[]),
    )

    def _get_role(code: str):
        if code == "main":
            return main_role
        if code == "code-agent":
            return role
        return None

    with patch(
        "evoflow.proactive.repositories.ProactiveRepository.get_role",
        side_effect=_get_role,
    ):
        assert _proactive_employee_im_identity_block("main") == ""
        assert "EvoFlow" in _primary_assistant_im_identity_block("main")
        assert _display_agent_name("main", prompt_language="zh") == "EvoFlow"
        assert _display_agent_name("code-agent", prompt_language="zh") == "前端工程师"


def test_im_omit_shortcut_hint_for_group_and_xiaomi():
    from app.channels.manager import (
        _im_is_group_chat,
        _im_new_session_reply,
        _im_should_omit_shortcut_hint,
    )

    group = _msg(account_id="code-agent")
    group.metadata["chat_type"] = "group"
    assert _im_is_group_chat(group) is True
    assert _im_should_omit_shortcut_hint({"agent_name": "code-agent"}, group) is True

    # Feishu oc_ chat_id without chat_type still treated as group
    oc_only = _msg(account_id="code-agent")
    assert _im_is_group_chat(oc_only) is True

    p2p = InboundMessage(
        channel_name="feishu",
        chat_id="ou_dm_1",
        user_id="ou_user",
        text="hi",
        msg_type=InboundMessageType.CHAT,
        metadata={"chat_type": "p2p", "account_id": "code-agent"},
    )
    assert _im_is_group_chat(p2p) is False
    assert _im_should_omit_shortcut_hint({"agent_name": "code-agent"}, p2p) is False

    xiaomi_p2p = InboundMessage(
        channel_name="feishu",
        chat_id="ou_dm_2",
        user_id="ou_user",
        text="hi",
        msg_type=InboundMessageType.CHAT,
        metadata={"chat_type": "p2p", "account_id": "xiaomi"},
    )
    assert _im_should_omit_shortcut_hint({"agent_name": "xiaomi"}, xiaomi_p2p) is True

    group_new = _im_new_session_reply("feishu", "tid-1", include_shortcut_hint=False)
    assert "/help" not in group_new
    dm_new = _im_new_session_reply("feishu", "tid-2", include_shortcut_hint=True)
    assert "/help" in dm_new
