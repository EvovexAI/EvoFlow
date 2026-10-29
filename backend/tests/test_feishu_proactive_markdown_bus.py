"""Proactive markdown must exit via MessageBus (same funnel as chat replies)."""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock

import pytest

from app.channels.feishu import FeishuChannel
from app.channels.message_bus import MessageBus, OutboundMessage


@pytest.mark.asyncio
async def test_send_proactive_markdown_publishes_to_bus_not_direct_create():
    bus = MessageBus()
    channel = object.__new__(FeishuChannel)
    channel.bus = bus
    channel.name = "feishu"
    channel._running = True
    channel._instance_account_id = ""
    channel._api_client = object()
    channel._api_client_for = MagicMock(return_value=channel._api_client)
    channel._create_card = AsyncMock()

    seen: list[OutboundMessage] = []

    async def _capture(msg: OutboundMessage) -> None:
        seen.append(msg)
        await channel.send(msg)

    bus.subscribe_outbound(_capture, channel_name="feishu", account_id="")

    await channel.send_proactive_markdown(
        "oc_chat",
        "你好，我是小助手",
        receive_id_type="chat_id",
        account_id="employee_a",
        kind="self_intro",
        title="员工自我介绍",
        triggered_by="system",
    )

    assert len(seen) == 1
    msg = seen[0]
    assert msg.channel_name == "feishu"
    assert msg.chat_id == "oc_chat"
    # Multiplex: route on primary slot, credentials via metadata.
    assert msg.account_id == ""
    assert msg.metadata.get("proactive_markdown") is True
    assert msg.metadata.get("account_id") == "employee_a"
    assert msg.metadata.get("kind") == "self_intro"
    assert msg.metadata.get("receive_id_type") == "chat_id"
    channel._create_card.assert_awaited_once()
    args, kwargs = channel._create_card.await_args
    assert args[0] == "oc_chat"
    assert kwargs.get("receive_id_type") == "chat_id"
    assert kwargs.get("account_id") == "employee_a"


@pytest.mark.asyncio
async def test_bus_does_not_reroute_proactive_off_primary_slot():
    """metadata.account_id must not steal routing away from slot=\"\"."""
    bus = MessageBus()
    delivered: list[str] = []

    async def primary_cb(msg: OutboundMessage) -> None:
        delivered.append("primary")

    async def employee_cb(msg: OutboundMessage) -> None:
        delivered.append("employee")

    bus.subscribe_outbound(primary_cb, channel_name="feishu", account_id="")
    bus.subscribe_outbound(employee_cb, channel_name="feishu", account_id="emp")

    await bus.publish_outbound(
        OutboundMessage(
            channel_name="feishu",
            chat_id="oc_x",
            thread_id="",
            text="hi",
            account_id="",  # primary slot on purpose
            metadata={"proactive_markdown": True, "account_id": "emp", "kind": "self_intro"},
        )
    )
    assert delivered == ["primary"]
