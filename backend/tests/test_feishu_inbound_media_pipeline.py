"""Feishu inbound parse / coalesce / media descriptor wiring."""

from __future__ import annotations

import asyncio
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

from app.channels.feishu_inbound_coalesce import FeishuInboundCoalescer
from app.channels.feishu_inbound_media import FeishuInboundMediaCache
from app.channels.feishu_inbound_parse import parse_feishu_message
from app.channels.message_bus import InboundMessage, InboundMessageType


def test_parse_plain_text():
    parsed = parse_feishu_message(
        message_type="text",
        content={"text": "你好"},
        message_id="om_1",
    )
    assert parsed.text == "你好"
    assert parsed.refs == []
    assert parsed.has_content


def test_parse_image_only():
    parsed = parse_feishu_message(
        message_type="image",
        content={"image_key": "img_abc"},
        message_id="om_img",
    )
    assert parsed.text == ""
    assert len(parsed.refs) == 1
    assert parsed.refs[0].kind == "image"
    assert parsed.refs[0].file_key == "img_abc"
    assert parsed.refs[0].resource_type == "image"
    assert parsed.has_content


def test_parse_file():
    parsed = parse_feishu_message(
        message_type="file",
        content={"file_key": "file_xyz", "file_name": "notes.pdf"},
        message_id="om_file",
    )
    assert parsed.refs[0].filename == "notes.pdf"
    assert parsed.refs[0].resource_type == "file"


def test_parse_post_with_embedded_image():
    content = {
        "title": "说明",
        "content": [
            [{"tag": "text", "text": "看这张图"}],
            [{"tag": "img", "image_key": "img_in_post"}],
            [{"tag": "at", "text": "@bot"}],
        ],
    }
    parsed = parse_feishu_message(message_type="post", content=content, message_id="om_post")
    assert "说明" in parsed.text
    assert "看这张图" in parsed.text
    assert len(parsed.refs) == 1
    assert parsed.refs[0].file_key == "img_in_post"


def test_parse_post_attachment_zone_files():
    """Client text+Word often arrives as post with top-level files[], not msg_type=file."""
    content = {
        "zh_cn": {
            "title": "",
            "content": [[{"tag": "text", "text": "这是啥"}]],
        },
        "files": [
            {"key": "file_v2_word_abc", "file_name": "report.docx"},
            {"file_key": "file_v2_pdf_xyz", "filename": "notes.pdf"},
        ],
    }
    parsed = parse_feishu_message(message_type="post", content=content, message_id="om_attach")
    assert parsed.text == "这是啥"
    assert len(parsed.refs) == 2
    assert parsed.refs[0].kind == "file"
    assert parsed.refs[0].file_key == "file_v2_word_abc"
    assert parsed.refs[0].filename == "report.docx"
    assert parsed.refs[1].file_key == "file_v2_pdf_xyz"


def test_parse_post_locale_wrapper():
    content = {
        "zh_cn": {
            "title": "",
            "content": [[{"tag": "text", "text": "locale body"}]],
        }
    }
    parsed = parse_feishu_message(message_type="post", content=content, message_id="om_zh")
    assert parsed.text == "locale body"


def test_parse_sticker_unsupported():
    parsed = parse_feishu_message(
        message_type="sticker",
        content={"file_key": "stk"},
        message_id="om_stk",
    )
    assert parsed.unsupported == "sticker"
    assert not parsed.has_content


def test_parse_content_json_string():
    parsed = parse_feishu_message(
        message_type="text",
        content='{"text":"from-json"}',
        message_id="om_j",
    )
    assert parsed.text == "from-json"


@pytest.mark.asyncio
async def test_coalesce_merges_image_then_text():
    published: list[tuple[InboundMessage, str]] = []

    async def _publish(msg: InboundMessage, mid: str) -> None:
        published.append((msg, mid))

    coalescer = FeishuInboundCoalescer(delay_seconds=0.05, text_grace_seconds=0.05, publish=_publish)

    img = InboundMessage(
        channel_name="feishu",
        chat_id="oc_1",
        user_id="ou_1",
        text="",
        files=[{"path": "/tmp/a.jpg", "kind": "image", "filename": "a.jpg"}],
        metadata={"message_id": "om_img", "message_ids": ["om_img"], "_owned_temp_paths": ["/tmp/a.jpg"]},
        account_id="",
    )
    text = InboundMessage(
        channel_name="feishu",
        chat_id="oc_1",
        user_id="ou_1",
        text="这是什么",
        files=[],
        metadata={"message_id": "om_txt", "message_ids": ["om_txt"]},
        account_id="",
    )
    await coalescer.accept(img, source_message_id="om_img")
    await coalescer.accept(text, source_message_id="om_txt")
    await asyncio.sleep(0.12)

    assert len(published) == 1
    out, primary = published[0]
    assert primary == "om_img"
    assert out.text == "这是什么"
    assert len(out.files) == 1
    assert out.metadata["_owned_temp_paths"] == ["/tmp/a.jpg"]
    assert out.metadata["message_ids"] == ["om_img", "om_txt"]


@pytest.mark.asyncio
async def test_coalesce_holds_text_for_late_file():
    """Text-first + slow file download must still merge (ops saw text-only before)."""
    published: list[tuple[InboundMessage, str]] = []

    async def _publish(msg: InboundMessage, mid: str) -> None:
        published.append((msg, mid))

    coalescer = FeishuInboundCoalescer(
        delay_seconds=0.05,
        text_grace_seconds=0.25,
        sticky_seconds=0.0,
        publish=_publish,
    )
    text = InboundMessage(
        channel_name="feishu",
        chat_id="oc_1",
        user_id="ou_1",
        text="这是啥",
        files=[],
        metadata={"message_id": "om_txt", "message_ids": ["om_txt"]},
        account_id="analyst",
    )
    doc = InboundMessage(
        channel_name="feishu",
        chat_id="oc_1",
        user_id="ou_1",
        text="",
        files=[{"path": "/tmp/a.docx", "kind": "file", "filename": "report.docx"}],
        metadata={
            "message_id": "om_file",
            "message_ids": ["om_file"],
            "_owned_temp_paths": ["/tmp/a.docx"],
        },
        account_id="analyst",
    )
    await coalescer.accept(text, source_message_id="om_txt")
    # Short delay: text would have flushed under old 0.6s-only policy once media
    # download lagged; grace keeps the batch open.
    await asyncio.sleep(0.08)
    assert published == []
    await coalescer.accept(doc, source_message_id="om_file")
    await asyncio.sleep(0.12)

    assert len(published) == 1
    out, primary = published[0]
    assert primary == "om_txt"
    assert out.text == "这是啥"
    assert len(out.files) == 1
    assert out.files[0]["filename"] == "report.docx"
    assert out.metadata["message_ids"] == ["om_txt", "om_file"]


@pytest.mark.asyncio
async def test_coalesce_sticky_reattaches_caption_after_text_flush():
    """Image event arriving after text already flushed still gets the caption."""
    published: list[tuple[InboundMessage, str]] = []

    async def _publish(msg: InboundMessage, mid: str) -> None:
        published.append((msg, mid))

    coalescer = FeishuInboundCoalescer(
        delay_seconds=0.05,
        text_grace_seconds=0.05,
        sticky_seconds=1.0,
        publish=_publish,
    )
    text = InboundMessage(
        channel_name="feishu",
        chat_id="oc_1",
        user_id="ou_1",
        text="这是什么图片",
        files=[],
        metadata={"message_id": "om_txt", "message_ids": ["om_txt"]},
        account_id="analyst",
    )
    img = InboundMessage(
        channel_name="feishu",
        chat_id="oc_1",
        user_id="ou_1",
        text="",
        files=[{"path": "/tmp/a.jpg", "kind": "image", "filename": "a.jpg"}],
        metadata={"message_id": "om_img", "message_ids": ["om_img"], "_owned_temp_paths": ["/tmp/a.jpg"]},
        account_id="analyst",
    )
    await coalescer.accept(text, source_message_id="om_txt")
    await asyncio.sleep(0.12)
    assert len(published) == 1
    assert published[0][0].text == "这是什么图片"
    assert not published[0][0].files

    await coalescer.accept(img, source_message_id="om_img")
    await asyncio.sleep(0.12)
    assert len(published) == 2
    out, _ = published[1]
    assert out.text == "这是什么图片"
    assert len(out.files) == 1
    assert out.metadata.get("sticky_text_from") == "om_txt"


@pytest.mark.asyncio
async def test_coalesce_command_flushes_pending_then_publishes():
    published: list[str] = []

    async def _publish(msg: InboundMessage, mid: str) -> None:
        published.append(f"{msg.msg_type.value}:{msg.text}:{mid}")

    coalescer = FeishuInboundCoalescer(delay_seconds=0.5, publish=_publish)
    pending = InboundMessage(
        channel_name="feishu",
        chat_id="oc_1",
        user_id="ou_1",
        text="pending",
        metadata={"message_id": "om_p"},
    )
    cmd = InboundMessage(
        channel_name="feishu",
        chat_id="oc_1",
        user_id="ou_1",
        text="/help",
        msg_type=InboundMessageType.COMMAND,
        metadata={"message_id": "om_c"},
    )
    await coalescer.accept(pending, source_message_id="om_p")
    await coalescer.accept(cmd, source_message_id="om_c")
    assert published == ["chat:pending:om_p", "command:/help:om_c"]


@pytest.mark.asyncio
async def test_media_cache_materialize_writes_channel_messages(tmp_path, monkeypatch):
    monkeypatch.setenv("EVOFLOW_HOME", str(tmp_path))
    from evoflow.config.paths import reset_paths_cache

    reset_paths_cache()
    png = b"\x89PNG\r\n\x1a\n" + b"\x00" * 16
    file_obj = MagicMock()
    file_obj.read.return_value = png

    response = SimpleNamespace(code=0, file=file_obj, file_name="pic.png", msg="ok")

    class _Resource:
        def get(self, request):  # noqa: ANN001
            assert request.message_id == "om_1"
            assert request.file_key == "img_1"
            assert request.type == "image"
            return response

    class _BuiltReq:
        def __init__(self) -> None:
            self.message_id = ""
            self.file_key = ""
            self.type = ""

    class _ReqBuilder:
        def __init__(self) -> None:
            self._req = _BuiltReq()

        def message_id(self, v):  # noqa: ANN001
            self._req.message_id = v
            return self

        def file_key(self, v):  # noqa: ANN001
            self._req.file_key = v
            return self

        def type(self, v):  # noqa: ANN001
            self._req.type = v
            return self

        def build(self):
            return self._req

    class _Req:
        @staticmethod
        def builder():
            return _ReqBuilder()

    client = SimpleNamespace(im=SimpleNamespace(v1=SimpleNamespace(message_resource=_Resource())))
    cache = FeishuInboundMediaCache(client_resolver=lambda _aid: client)
    cache._GetMessageResourceRequest = _Req
    monkeypatch.setattr(cache, "_ensure_sdk", lambda: True)

    from app.channels.feishu_inbound_parse import FeishuMediaRef

    refs = [FeishuMediaRef(kind="image", file_key="img_1", message_id="om_1")]
    files, owned = await cache.materialize(refs, account_id="")
    assert len(files) == 1
    assert files[0]["kind"] == "image"
    assert files[0]["mime"] == "image/png"
    assert len(owned) == 1
    assert owned[0] == files[0]["path"]
    path = Path(files[0]["path"])
    assert path.exists()
    # {EVOFLOW_HOME}/channel-messages/feishu/{YYYY}/{MM}/…
    parts = path.parts
    assert "channel-messages" in parts
    assert "feishu" in parts
    # Durable: cleanup must not delete channel-messages files.
    await cache.cleanup_all()
    assert path.exists()
    reset_paths_cache()
