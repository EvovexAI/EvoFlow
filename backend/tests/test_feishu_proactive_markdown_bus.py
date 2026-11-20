"""Proactive markdown must exit via MessageBus (same funnel as chat replies).

【self-evolution-bot · 2026-11-20 · 第92轮 · 模型:deepseek-v4.1-flash-1017】
为什么把 stub chat_id 换成长 id：2026-11-12 `5afcbd5f` 在
``send_proactive_markdown`` 里加了 ``is_plausible_feishu_chat_id`` 闸门
（拒绝 ``oc_test`` 这类短 stub，避免拿假 id 去打飞书换 230001）。本用例
写于 2026-10-29，早于该闸门，用的 ``oc_chat``（body 仅 4 字符 < 16）现在
必然被拒 → 用例红。被测语义是「proactive 走 MessageBus 而不是直接 create」，
与 id 真假无关，所以把 stub 换成一个**格式合法**的 id，闸门与语义同时成立。
"""

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
        "oc_a1b2c3d4e5f60718",
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
    assert msg.chat_id == "oc_a1b2c3d4e5f60718"
    # Multiplex: route on primary slot, credentials via metadata.
    assert msg.account_id == ""
    assert msg.metadata.get("proactive_markdown") is True
    assert msg.metadata.get("account_id") == "employee_a"
    assert msg.metadata.get("kind") == "self_intro"
    assert msg.metadata.get("receive_id_type") == "chat_id"
    channel._create_card.assert_awaited_once()
    args, kwargs = channel._create_card.await_args
    assert args[0] == "oc_a1b2c3d4e5f60718"
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
            chat_id="oc_a1b2c3d4e5f60718",
            thread_id="",
            text="hi",
            account_id="",  # primary slot on purpose
            metadata={"proactive_markdown": True, "account_id": "emp", "kind": "self_intro"},
        )
    )
    assert delivered == ["primary"]
