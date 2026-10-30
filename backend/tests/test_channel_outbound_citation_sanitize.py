"""IM outbound must strip evo-asset-citation / loose citation_entries leaks."""

from __future__ import annotations

import asyncio

import pytest

from app.channels.message_bus import MessageBus, OutboundMessage
from app.channels.outbound_text import sanitize_channel_outbound_text


def test_sanitize_strips_loose_citation_entries_leak():
    raw = (
        "已核对报价。\n\n"
        "citation_entries: kb_ed4de5d2768e4a398753533ea7ed5234 | note=["
        "参考图实物一致性、assetPublicBaseUrl 阻塞]"
    )
    assert sanitize_channel_outbound_text(raw) == "已核对报价。"


def test_sanitize_strips_xml_block():
    raw = (
        "结论。\n\n"
        "<evo-asset-citation>\n"
        "<citation_entries>\n"
        "memory/facts/foo.md:1-2|note=[x]\n"
        "</citation_entries>\n"
        "</evo-asset-citation>"
    )
    assert sanitize_channel_outbound_text(raw).strip() == "结论。"


@pytest.mark.asyncio
async def test_bus_publish_outbound_sanitizes_text_before_callback():
    bus = MessageBus()
    seen: list[str] = []

    async def _on_outbound(msg: OutboundMessage) -> None:
        seen.append(msg.text)

    bus.subscribe_outbound(_on_outbound, channel_name="feishu", account_id="")
    await bus.publish_outbound(
        OutboundMessage(
            channel_name="feishu",
            chat_id="oc_test",
            thread_id="t1",
            text="正文\n\ncitation_entries: kb_abc | note=[泄漏]",
            is_final=True,
        )
    )
    # Allow listener tasks if any; primary callback is awaited inline.
    await asyncio.sleep(0)
    assert seen == ["正文"]
