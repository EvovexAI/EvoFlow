"""Per-employee IM bots: outbound must land on the same account_id slot as inbound."""

from __future__ import annotations

import asyncio

import pytest

from app.channels.base import Channel
from app.channels.message_bus import InboundMessage, MessageBus, OutboundMessage
from app.channels.manager import ChannelManager


class _DummyChannel(Channel):
    name = "feishu"

    def __init__(self, bus: MessageBus) -> None:
        super().__init__(name="feishu", bus=bus, config={})

    async def start(self) -> None:
        return None

    async def stop(self) -> None:
        return None

    async def send(self, msg: OutboundMessage) -> None:
        return None


def test_make_inbound_stamps_top_level_account_id():
    bus = MessageBus()
    ch = _DummyChannel(bus)
    inbound = ch._make_inbound(
        chat_id="oc_x",
        user_id="ou_y",
        text="hi",
        account_id="emp-tutor",
        metadata={"message_id": "om_1"},
    )
    assert inbound.account_id == "emp-tutor"
    assert inbound.metadata.get("account_id") == "emp-tutor"


def test_make_inbound_promotes_metadata_account_id():
    bus = MessageBus()
    ch = _DummyChannel(bus)
    inbound = ch._make_inbound(
        chat_id="oc_x",
        user_id="ou_y",
        text="hi",
        metadata={"account_id": "emp-from-meta"},
    )
    assert inbound.account_id == "emp-from-meta"


@pytest.mark.asyncio
async def test_bus_routes_outbound_to_employee_slot_not_primary():
    bus = MessageBus()
    received: list[str] = []

    async def on_emp(msg: OutboundMessage) -> None:
        received.append(f"emp:{msg.text}")

    async def on_primary(msg: OutboundMessage) -> None:
        received.append(f"primary:{msg.text}")

    bus.subscribe_outbound(on_primary, channel_name="feishu", account_id="")
    bus.subscribe_outbound(on_emp, channel_name="feishu", account_id="emp-tutor")

    await bus.publish_outbound(
        OutboundMessage(
            channel_name="feishu",
            chat_id="oc_x",
            thread_id="t1",
            text="hello-tutor",
            account_id="emp-tutor",
        )
    )
    assert received == ["emp:hello-tutor"]


@pytest.mark.asyncio
async def test_bus_falls_back_to_metadata_account_id():
    bus = MessageBus()
    received: list[str] = []

    async def on_emp(msg: OutboundMessage) -> None:
        received.append(msg.account_id)

    bus.subscribe_outbound(on_emp, channel_name="feishu", account_id="emp-tutor")
    await bus.publish_outbound(
        OutboundMessage(
            channel_name="feishu",
            chat_id="oc_x",
            thread_id="t1",
            text="hi",
            account_id="",  # legacy publisher
            metadata={"account_id": "emp-tutor"},
        )
    )
    assert received == ["emp-tutor"]


def test_manager_inbound_account_id_reads_metadata():
    msg = InboundMessage(
        channel_name="feishu",
        chat_id="oc_x",
        user_id="ou_y",
        text="hi",
        account_id="",
        metadata={"account_id": "emp-tutor"},
    )
    assert ChannelManager._inbound_account_id(msg) == "emp-tutor"
