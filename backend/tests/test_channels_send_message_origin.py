"""channels.send_message routes to the inbound IM origin on the session."""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from evoflow.admin.errors import ValidationError
from evoflow.admin import platform_handlers as H


def test_channels_send_message_requires_session_key():
    with pytest.raises(ValidationError, match="session_key"):
        H.channels_send_message({"text": "hi"})


def test_channels_send_message_uses_origin_not_agent_picker(monkeypatch):
    captured: dict = {}

    def _push(*, session_key, text="", paths=None, title=""):
        captured["session_key"] = session_key
        captured["text"] = text
        captured["paths"] = list(paths or [])
        captured["title"] = title
        return {
            "ok": True,
            "channel": "feishu",
            "chat_id": "oc_from_session",
            "account_id": "aigc-prompt-reverser",
            "attachments": ["frame.jpg"],
        }

    monkeypatch.setattr(
        "evoflow.runtime.ports.push_to_inbound_origin",
        _push,
    )

    out = H.channels_send_message(
        {
            "session_key": "proactive:aigc-prompt-reverser:chat:feishu:oc_from_session",
            "text": "图在这里",
            "paths": ["/mnt/user-data/outputs/frame.jpg"],
            # Agent must not be able to override routing:
            "channel": "wecom",
            "account_id": "wrong-bot",
            "chat_id": "oc_wrong",
        }
    )
    assert out["ok"] is True
    assert out["channel"] == "feishu"
    assert out["account_id"] == "aigc-prompt-reverser"
    assert captured["session_key"].startswith("proactive:aigc-prompt-reverser:")
    assert captured["paths"] == ["/mnt/user-data/outputs/frame.jpg"]
    assert "wrong" not in captured.get("text", "")


@pytest.mark.asyncio
async def test_push_to_inbound_origin_publishes_outbound(monkeypatch):
    from app.gateway import channel_result_push as crp

    monkeypatch.setattr(
        crp,
        "resolve_inbound_origin_from_session",
        lambda _sk: {
            "session_key": "sk",
            "channel": "feishu",
            "chat_id": "oc_x",
            "account_id": "emp-bot",
            "topic_id": None,
            "thread_id": "tid-1",
            "user_id": "ou_x",
            "agent_code": "emp-bot",
        },
    )

    published = []

    class _Bus:
        async def publish_outbound(self, msg):
            published.append(msg)

    service = SimpleNamespace(
        bus=_Bus(),
        get_status=lambda: {"channels": {"feishu": {"running": True}}},
    )
    monkeypatch.setattr("app.channels.service.get_channel_service", lambda: service)
    monkeypatch.setattr(
        "app.channels.manager._resolve_attachments",
        lambda _tid, _paths: [],
    )

    out = await crp.push_to_inbound_origin(
        session_key="sk",
        text="你好",
        paths=[],
    )
    assert out["ok"] is True
    assert len(published) == 1
    msg = published[0]
    assert msg.channel_name == "feishu"
    assert msg.chat_id == "oc_x"
    assert msg.account_id == "emp-bot"
    assert msg.text == "你好"


def test_channels_send_message_accepts_image_url(monkeypatch):
    """Prompt documents image_url / file_path; handler must forward them as paths."""
    captured: dict = {}

    def _push(*, session_key, text="", paths=None, title=""):
        captured["paths"] = list(paths or [])
        return {
            "ok": True,
            "channel": "feishu",
            "chat_id": "oc_x",
            "account_id": "ecommerce-content-operator",
            "attachments": ["duck.png"],
            "unresolved_paths": [],
        }

    monkeypatch.setattr(
        "evoflow.runtime.ports.push_to_inbound_origin",
        _push,
    )

    local = r"D:\dev\github\knowledge-library\duck.png"
    out = H.channels_send_message(
        {
            "session_key": "proactive:ecommerce-content-operator:chat:feishu:oc_x",
            "text": "见图",
            "image_url": local,
        }
    )
    assert out["ok"] is True
    assert captured["paths"] == [local]


def test_channels_send_message_accepts_file_path_alias(monkeypatch):
    captured: dict = {}

    def _push(*, session_key, text="", paths=None, title=""):
        captured["paths"] = list(paths or [])
        return {"ok": True, "channel": "feishu", "chat_id": "oc_x", "account_id": "x"}

    monkeypatch.setattr("evoflow.runtime.ports.push_to_inbound_origin", _push)
    H.channels_send_message(
        {
            "session_key": "proactive:x:chat:feishu:oc_x",
            "text": "文件",
            "file_path": "/mnt/user-data/outputs/a.pdf",
        }
    )
    assert captured["paths"] == ["/mnt/user-data/outputs/a.pdf"]


@pytest.mark.asyncio
async def test_push_materializes_https_image_url(monkeypatch, tmp_path):
    from pathlib import Path as P

    from app.channels.message_bus import ResolvedAttachment
    from app.gateway import channel_result_push as crp

    monkeypatch.setattr(
        crp,
        "resolve_inbound_origin_from_session",
        lambda _sk: {
            "session_key": "sk",
            "channel": "feishu",
            "chat_id": "oc_x",
            "account_id": "emp-bot",
            "topic_id": None,
            "thread_id": "tid-1",
            "user_id": "ou_x",
            "agent_code": "emp-bot",
        },
    )

    published = []

    class _Bus:
        async def publish_outbound(self, msg):
            published.append(msg)

    service = SimpleNamespace(
        bus=_Bus(),
        get_status=lambda: {"channels": {"feishu": {"running": True}}},
    )
    monkeypatch.setattr("app.channels.service.get_channel_service", lambda: service)
    monkeypatch.setattr(
        "app.channels.manager._resolve_attachments",
        lambda _tid, _paths: [],
    )

    fake = tmp_path / "remote.jpg"
    fake.write_bytes(b"jpeg-bytes")

    def _fake_materialize(url: str):
        assert url.startswith("https://")
        return ResolvedAttachment(
            virtual_path=url,
            actual_path=P(fake),
            filename="remote.jpg",
            mime_type="image/jpeg",
            size=fake.stat().st_size,
            is_image=True,
        )

    monkeypatch.setattr(crp, "_materialize_remote_attachment", _fake_materialize)

    out = await crp.push_to_inbound_origin(
        session_key="sk",
        text="见图",
        paths=["https://example.com/remote.jpg"],
    )
    assert out["ok"] is True
    assert out["attachments"] == ["remote.jpg"]
    assert out["unresolved_paths"] == []
    assert len(published) == 1
    assert published[0].attachments[0].is_image is True

