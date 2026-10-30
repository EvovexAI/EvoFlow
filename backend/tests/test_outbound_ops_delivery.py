"""Ops audit summary should mirror IM delivery, not raw agent blobs."""

from __future__ import annotations

from pathlib import Path

from app.channels.feishu_message_format import build_outbound_ops_delivery
from app.channels.message_bus import ResolvedAttachment


def test_ops_delivery_strips_md_image_and_lists_attachments():
    att = ResolvedAttachment(
        virtual_path="/mnt/user-data/outputs/duck.png",
        actual_path=Path("D:/tmp/duck.png"),
        filename="duck.png",
        mime_type="image/png",
        size=12,
        is_image=True,
    )
    raw = "图没能显示在你那边\n\n![duck](/mnt/user-data/outputs/duck.png)\n软胶小鸭"
    out = build_outbound_ops_delivery(raw, attachments=[att], wire_msg_type="text")
    assert "图没能显示" in out["content_summary"]
    assert "![duck]" not in out["content_summary"]
    assert "【实发附件】图片：duck.png" in out["content_summary"]
    assert out["wire_msg_type"] == "text+image"
    assert out["attachments"][0]["filename"] == "duck.png"
    assert out["markdown_images_stripped"]


def test_ops_delivery_marks_stripped_md_without_attachment():
    out = build_outbound_ops_delivery(
        "见下图 ![x](https://example.com/a.png)",
        attachments=[],
    )
    assert "【正文 markdown 图已剥离" in out["content_summary"]
    assert out["wire_msg_type"] == "text"


def test_ops_delivery_ask_clarification_rewritten():
    payload = '{"question":"选哪个?","options":["A","B"],"clarification_type":"choice"}'
    out = build_outbound_ops_delivery(payload, attachments=[])
    assert "需要您确认" in out["content_summary"]
    assert payload not in out["content_summary"]


def test_msg_type_label_text_plus_image(tmp_path, monkeypatch):
    db_path = tmp_path / "ops_delivery.db"
    monkeypatch.setenv("EVOFLOW_DB_PATH", str(db_path))
    from evoflow.persistence.channel_push_repositories import list_paginated, record_push
    from evoflow.persistence.db import get_db, reset_db_for_tests
    from evoflow.persistence.schema import ensure_app_schema

    reset_db_for_tests()
    ensure_app_schema(get_db())
    try:
        record_push(
            direction="outbound",
            channel="feishu",
            kind="im_message",
            event="sent",
            content_summary="hello\n【实发附件】图片：a.png",
            payload={
                "msg_type": "text+image",
                "attachments": [{"filename": "a.png", "path": "/a.png", "mime": "image/png"}],
            },
            status="ok",
            triggered_by="agent",
        )
        page = list_paginated(page=1, page_size=10, channel="feishu")
        row = next(i for i in page["items"] if i.get("msg_type_raw") == "text+image")
        assert row["msg_type"] == "文本+图片"
        assert row["attachment_count"] >= 1
    finally:
        reset_db_for_tests()
        monkeypatch.delenv("EVOFLOW_DB_PATH", raising=False)
