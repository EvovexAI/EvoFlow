"""Employee IM bots must use proactive:…:chat:… session keys (智能体员工 group)."""

from __future__ import annotations

from app.channels.manager import ChannelManager, _agent_code_from_im_session_key
from app.channels.message_bus import InboundMessage, InboundMessageType


def _msg(**kwargs):
    defaults = dict(
        channel_name="feishu",
        chat_id="oc_abc123def456",
        user_id="ou_user",
        text="hi",
        msg_type=InboundMessageType.CHAT,
        account_id="",
        metadata={},
    )
    defaults.update(kwargs)
    return InboundMessage(**defaults)


def test_agent_code_from_im_session_key():
    assert _agent_code_from_im_session_key("agent:main:feishu:oc_1") == "main"
    assert (
        _agent_code_from_im_session_key("proactive:douyin-blogger-analyst:chat:feishu:oc_1")
        == "douyin-blogger-analyst"
    )
    assert _agent_code_from_im_session_key("proactive:analyst") == "analyst"


def test_employee_feishu_session_key_is_proactive_chat(monkeypatch):
    mgr = ChannelManager.__new__(ChannelManager)

    def _fake_resolve(self, msg, thread_id):  # noqa: ANN001
        return ("lead_agent", {}, {"agent_name": "douyin-blogger-analyst"})

    monkeypatch.setattr(ChannelManager, "_resolve_run_params", _fake_resolve)
    key = ChannelManager._channel_thread_session_key(
        mgr,
        _msg(account_id="douyin-blogger-analyst"),
    )
    assert key == "proactive:douyin-blogger-analyst:chat:feishu:oc_abc123def456"


def test_primary_feishu_session_key_stays_agent(monkeypatch):
    mgr = ChannelManager.__new__(ChannelManager)

    def _fake_resolve(self, msg, thread_id):  # noqa: ANN001
        return ("lead_agent", {}, {"agent_name": "main"})

    monkeypatch.setattr(ChannelManager, "_resolve_run_params", _fake_resolve)
    key = ChannelManager._channel_thread_session_key(mgr, _msg(account_id=""))
    assert key == "agent:main:feishu:oc_abc123def456"
