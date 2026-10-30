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


@pytest.mark.asyncio
async def test_bus_records_outbound_error_when_no_callback(monkeypatch):
    """Ops must not show 「成功已回复」 when the Feishu slot is not registered."""
    bus = MessageBus()
    recorded: list[dict] = []

    def _fake_safe_record_push(**kwargs):
        recorded.append(kwargs)

    import evoflow.persistence.channel_push_repositories as repo

    monkeypatch.setattr(repo, "safe_record_push", _fake_safe_record_push)

    await bus.publish_outbound(
        OutboundMessage(
            channel_name="feishu",
            chat_id="oc_x",
            thread_id="t1",
            text="ghost reply",
            is_final=True,
            account_id="ecommerce-content-operator",
        )
    )
    assert len(recorded) == 1
    assert recorded[0]["status"] == "error"
    assert recorded[0]["event"] == "dropped"
    assert "no outbound callback" in (recorded[0].get("error") or "")


@pytest.mark.asyncio
async def test_bus_falls_back_to_primary_when_employee_slot_missing(monkeypatch):
    """Nested Feishu WS tags inbound emp-… while primary only registered slot \"\"."""
    bus = MessageBus()
    received: list[str] = []
    recorded: list[dict] = []

    async def on_primary(msg: OutboundMessage) -> None:
        received.append(f"primary:{msg.account_id}:{msg.text}")

    def _fake_safe_record_push(**kwargs):
        recorded.append(kwargs)

    import evoflow.persistence.channel_push_repositories as repo

    monkeypatch.setattr(repo, "safe_record_push", _fake_safe_record_push)
    bus.subscribe_outbound(on_primary, channel_name="feishu", account_id="")

    await bus.publish_outbound(
        OutboundMessage(
            channel_name="feishu",
            chat_id="oc_x",
            thread_id="t1",
            text="好了吗-reply",
            is_final=True,
            account_id="douyin-analyst",
        )
    )
    assert received == ["primary:douyin-analyst:好了吗-reply"]
    assert len(recorded) == 1
    assert recorded[0]["status"] == "ok"
    assert recorded[0]["event"] == "sent"


@pytest.mark.asyncio
async def test_bus_records_outbound_ok_only_after_callback(monkeypatch):
    bus = MessageBus()
    recorded: list[dict] = []
    saw: list[str] = []

    async def on_emp(msg: OutboundMessage) -> None:
        saw.append(msg.text)

    def _fake_safe_record_push(**kwargs):
        recorded.append(kwargs)

    import evoflow.persistence.channel_push_repositories as repo

    monkeypatch.setattr(repo, "safe_record_push", _fake_safe_record_push)
    bus.subscribe_outbound(on_emp, channel_name="feishu", account_id="emp-tutor")

    await bus.publish_outbound(
        OutboundMessage(
            channel_name="feishu",
            chat_id="oc_x",
            thread_id="t1",
            text="delivered",
            is_final=True,
            account_id="emp-tutor",
        )
    )
    assert saw == ["delivered"]
    assert len(recorded) == 1
    assert recorded[0]["status"] == "ok"
    assert recorded[0]["event"] == "sent"


@pytest.mark.asyncio
async def test_bus_records_outbound_error_when_callback_raises(monkeypatch):
    bus = MessageBus()
    recorded: list[dict] = []

    async def boom(_msg: OutboundMessage) -> None:
        raise RuntimeError("feishu card patch failed")

    def _fake_safe_record_push(**kwargs):
        recorded.append(kwargs)

    import evoflow.persistence.channel_push_repositories as repo

    monkeypatch.setattr(repo, "safe_record_push", _fake_safe_record_push)
    bus.subscribe_outbound(boom, channel_name="feishu", account_id="emp-tutor")

    await bus.publish_outbound(
        OutboundMessage(
            channel_name="feishu",
            chat_id="oc_x",
            thread_id="t1",
            text="oops",
            is_final=True,
            account_id="emp-tutor",
        )
    )
    assert len(recorded) == 1
    assert recorded[0]["status"] == "error"
    assert recorded[0]["event"] == "send_failed"
    assert "feishu card patch failed" in (recorded[0].get("error") or "")
