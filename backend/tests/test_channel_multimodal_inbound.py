"""Regression tests for the cross-IM multimodal inbound pipeline.

Three layers are tested:

1. ``ChannelManager._build_human_input`` — converts ``InboundMessage.files``
   into a LangChain-shaped HumanMessage payload whose
   ``additional_kwargs.context_files`` matches what
   ``ContextFilesMiddleware`` consumes.

2. ``ChannelManager._release_channel_owned_paths`` — defers file cleanup
   until the manager finishes processing the message, and routes the call to
   the originating channel via ``ChannelService._channels``.

3. WeCom text-batching coalescing — a file followed by a text chunk is
   merged into one ``InboundMessage`` so the agent sees them together.
"""

from __future__ import annotations

import asyncio
import sys
import types
from pathlib import Path
from typing import Any

import pytest

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from app.channels.manager import (
    _build_human_input,
    _release_channel_owned_paths,
)
from app.channels.message_bus import InboundMessage, InboundMessageType
from app.channels.wecom import WecomChannel


# ---------------------------------------------------------------------------
# _build_human_input
# ---------------------------------------------------------------------------


def _inbound(files: list[dict[str, Any]] | None = None, *, text: str = "你好") -> InboundMessage:
    return InboundMessage(
        channel_name="wecom",
        chat_id="chat-1",
        user_id="user-1",
        text=text,
        msg_type=InboundMessageType.CHAT,
        files=files or [],
        metadata={"account_id": ""},
    )


def test_build_human_input_plain_text_has_no_files_block():
    out = _build_human_input(_inbound(files=None, text="只看文字"))
    assert "messages" in out and len(out["messages"]) == 1
    msg = out["messages"][0]
    assert msg["role"] == "human"
    assert msg["content"] == "只看文字"
    assert "additional_kwargs" not in msg


def test_build_human_input_attaches_context_files():
    files = [
        {
            "kind": "image",
            "path": "/tmp/cache/abc.png",
            "mime": "image/png",
            "filename": "screenshot.png",
            "size": 12345,
            "url": "https://example.com/abc.png",
            "account_id": "",
        },
        {
            "kind": "file",
            "path": "/tmp/cache/doc.pdf",
            "mime": "application/pdf",
            "filename": "doc.pdf",
            "size": 67890,
            "url": "",
            "account_id": "",
        },
    ]
    out = _build_human_input(_inbound(files=files, text="帮我看看"))
    msg = out["messages"][0]
    assert msg["content"] == "帮我看看"
    ctx = msg["additional_kwargs"]["context_files"]
    assert len(ctx) == 2

    image_entry = ctx[0]
    assert image_entry["path"] == "/tmp/cache/abc.png"
    assert image_entry["name"] == "screenshot.png"
    assert image_entry["kind"] == "image"
    assert image_entry["mime"] == "image/png"
    assert image_entry["size"] == 12345
    assert image_entry["url"] == "https://example.com/abc.png"

    file_entry = ctx[1]
    assert file_entry["path"] == "/tmp/cache/doc.pdf"
    assert file_entry["name"] == "doc.pdf"
    # Optional fields absent when not provided
    assert "url" not in file_entry


def test_build_human_input_skips_malformed_entries():
    files = [
        {"path": "", "filename": "nope"},  # empty path → dropped
        {"path": "/tmp/x.png"},            # missing filename → falls back to basename
        "not a dict",                      # non-dict → dropped
        {"path": "/tmp/ok.png", "filename": "ok.png"},
    ]
    out = _build_human_input(_inbound(files=files, text=""))
    ctx = out["messages"][0]["additional_kwargs"]["context_files"]
    assert len(ctx) == 2
    assert ctx[0]["name"] == "x.png"
    assert ctx[1]["name"] == "ok.png"


def test_build_human_input_drops_zero_size():
    files = [{"path": "/tmp/x.png", "filename": "x.png", "size": 0}]
    out = _build_human_input(_inbound(files=files, text=""))
    ctx = out["messages"][0]["additional_kwargs"]["context_files"][0]
    assert "size" not in ctx


# ---------------------------------------------------------------------------
# _release_channel_owned_paths
# ---------------------------------------------------------------------------


class _FakeChannel:
    def __init__(self) -> None:
        self.released: list[list[str]] = []

    def release_owned_temp_paths(self, paths):
        self.released.append(list(paths))


class _FakeService:
    def __init__(self, channels: dict[str, _FakeChannel]) -> None:
        self._channels = channels


def test_release_channel_owned_paths_calls_primary_namespace(monkeypatch):
    fake_channel = _FakeChannel()
    fake_service = _FakeService({"wecom": fake_channel})

    import app.channels.service as svc_mod

    monkeypatch.setattr(svc_mod, "get_channel_service", lambda: fake_service)

    msg = _inbound(
        files=[],
        text="hi",
    )
    msg.metadata["_owned_temp_paths"] = ["/tmp/a.png", "/tmp/b.pdf"]
    _release_channel_owned_paths(msg)

    assert fake_channel.released == [["/tmp/a.png", "/tmp/b.pdf"]]


def test_release_channel_owned_paths_falls_back_to_account_namespace(monkeypatch):
    primary = _FakeChannel()
    per_account = _FakeChannel()
    fake_service = _FakeService(
        {
            "wecom": primary,
            "wecom:customer-service": per_account,
        }
    )

    import app.channels.service as svc_mod

    monkeypatch.setattr(svc_mod, "get_channel_service", lambda: fake_service)

    msg = _inbound(files=[], text="hi")
    msg.metadata["account_id"] = "customer-service"
    msg.metadata["_owned_temp_paths"] = ["/tmp/x.png"]
    _release_channel_owned_paths(msg)

    # Per-account channel wins because it's first in candidate order
    assert per_account.released == [["/tmp/x.png"]]
    assert primary.released == []


def test_release_channel_owned_paths_noop_when_no_paths(monkeypatch):
    fake_channel = _FakeChannel()
    fake_service = _FakeService({"wecom": fake_channel})

    import app.channels.service as svc_mod

    monkeypatch.setattr(svc_mod, "get_channel_service", lambda: fake_service)

    msg = _inbound(files=[], text="hi")
    _release_channel_owned_paths(msg)
    assert fake_channel.released == []


def test_release_channel_owned_paths_noop_when_service_missing(monkeypatch):
    """Off-process / harness-only mode — no service registered, skip cleanup."""

    import app.channels.service as svc_mod

    def _missing():
        raise RuntimeError("service not started")

    monkeypatch.setattr(svc_mod, "get_channel_service", _missing)

    msg = _inbound(files=[], text="hi")
    msg.metadata["_owned_temp_paths"] = ["/tmp/x.png"]
    # Should not raise even though the service lookup explodes.
    _release_channel_owned_paths(msg)


# ---------------------------------------------------------------------------
# WeCom batching — image + follow-up text merge
# ---------------------------------------------------------------------------


class _FakeBus:
    def __init__(self) -> None:
        self.published: list[InboundMessage] = []

    async def publish_inbound(self, msg: InboundMessage) -> None:
        self.published.append(msg)


def _make_wecom(bus: _FakeBus) -> WecomChannel:
    """Build a WecomChannel without booting any network."""
    # Minimal config: channel name only, the batching methods under test do
    # not touch the WebSocket layer.
    channel = WecomChannel.__new__(WecomChannel)
    channel.name = "wecom"
    channel.bus = bus
    channel._account_id = ""
    channel._pending_text_batches = {}
    channel._pending_text_batch_tasks = {}
    channel._temp_media_paths = set()
    channel._text_batch_delay_seconds = 0.05
    channel._text_batch_split_delay_seconds = 0.1
    channel._SPLIT_THRESHOLD = 4000  # any reasonable value
    return channel


def test_batching_merges_image_then_text():
    bus = _FakeBus()

    async def _run():
        channel = _make_wecom(bus)
        image_msg = InboundMessage(
            channel_name="wecom",
            chat_id="c",
            user_id="u",
            text="",
            msg_type=InboundMessageType.CHAT,
            files=[
                {
                    "kind": "image",
                    "path": "/tmp/a.png",
                    "mime": "image/png",
                    "filename": "a.png",
                    "size": 10,
                    "url": "",
                    "account_id": "",
                }
            ],
            metadata={"account_id": "", "_owned_temp_paths": ["/tmp/a.png"]},
        )

        followup_msg = InboundMessage(
            channel_name="wecom",
            chat_id="c",
            user_id="u",
            text="帮我看看",
            msg_type=InboundMessageType.CHAT,
            files=[],
            metadata={"account_id": ""},
        )

        channel._enqueue_text_event(image_msg)
        channel._enqueue_text_event(followup_msg)

        for _ in range(60):
            if bus.published:
                return
            await asyncio.sleep(0.05)
        raise AssertionError("text batch never flushed")

    asyncio.run(_run())

    assert len(bus.published) == 1
    merged = bus.published[0]
    assert merged.text == "帮我看看"
    assert len(merged.files) == 1
    assert merged.files[0]["path"] == "/tmp/a.png"
    assert merged.metadata["_owned_temp_paths"] == ["/tmp/a.png"]


def test_batching_merges_multiple_text_chunks():
    bus = _FakeBus()

    async def _run():
        channel = _make_wecom(bus)
        first = InboundMessage(
            channel_name="wecom",
            chat_id="c",
            user_id="u",
            text="第一段",
            msg_type=InboundMessageType.CHAT,
            files=[],
            metadata={"account_id": ""},
        )
        second = InboundMessage(
            channel_name="wecom",
            chat_id="c",
            user_id="u",
            text="第二段",
            msg_type=InboundMessageType.CHAT,
            files=[],
            metadata={"account_id": ""},
        )

        channel._enqueue_text_event(first)
        channel._enqueue_text_event(second)

        for _ in range(60):
            if bus.published:
                return
            await asyncio.sleep(0.05)
        raise AssertionError("text batch never flushed")

    asyncio.run(_run())

    assert len(bus.published) == 1
    merged = bus.published[0]
    assert merged.text == "第一段\n第二段"
    assert merged.files == []
