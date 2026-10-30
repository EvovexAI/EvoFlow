"""V4 hydration must project channel contextFiles onto userInput.attachments."""

from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import patch

from app.gateway.v4.conversation import V4ConversationHub
from app.gateway.v4.hydration import _attachments_from_user_payload, hydrate_session_from_transcript


def test_attachments_from_context_files(tmp_path: Path):
    img = tmp_path / "shot.png"
    img.write_bytes(b"\x89PNG\r\n\x1a\n" + b"\x00" * 32)
    doc = tmp_path / "notes.docx"
    doc.write_bytes(b"PK" + b"\x00" * 40)

    atts = _attachments_from_user_payload(
        {
            "content": "",
            "contextFiles": [
                {"path": str(img), "name": "shot.png", "mime": "image/png", "size": img.stat().st_size},
                {"path": str(doc), "name": "notes.docx", "mime": "application/vnd.openxmlformats-officedocument.wordprocessingml.document"},
            ],
        }
    )
    assert len(atts) == 2
    assert atts[0]["ref"] == str(img)
    assert atts[0]["fileName"] == "shot.png"
    assert atts[0]["mime"].startswith("image/")
    assert atts[1]["fileName"] == "notes.docx"
    assert atts[1]["bytes"] > 0


def test_hydrate_image_only_user_turn(tmp_path: Path):
    img = tmp_path / "feishu-image.jpg"
    img.write_bytes(b"\xff\xd8\xff" + b"\x00" * 24)
    tid = "thread-channel-att-1"
    messages = [
        {
            "role": "user",
            "message_id": "um1",
            "run_id": "run-att-1",
            "content_json": json.dumps(
                {
                    "content": "",
                    "contextFiles": [{"path": str(img), "name": "feishu-image.jpg", "mime": "image/jpeg"}],
                },
                ensure_ascii=False,
            ),
            "created_at": "2026-10-29T23:00:00+08:00",
        },
        {
            "role": "assistant",
            "message_id": "am1",
            "run_id": "run-att-1",
            "content_json": json.dumps({"content": "收到图片了"}, ensure_ascii=False),
            "created_at": "2026-10-29T23:00:01+08:00",
        },
    ]
    hub = V4ConversationHub()
    with (
        patch(
            "evoflow.persistence.session_repositories.find_session_key_by_thread_id",
            return_value="agent:main:test",
        ),
        patch(
            "evoflow.persistence.session_repositories.is_session_deleted",
            return_value=False,
        ),
        patch("app.gateway.v4.hydration._load_messages", return_value=messages),
    ):
        loaded = hydrate_session_from_transcript(hub, tid)
    assert loaded > 0
    rows = list(hub.get_session(tid).rows.values())
    users = [r for r in rows if r.get("kind") == "userInput"]
    assert len(users) == 1
    assert users[0].get("text") == ""
    atts = users[0].get("attachments") or []
    assert len(atts) == 1
    assert atts[0]["ref"] == str(img)
    assert atts[0]["fileName"] == "feishu-image.jpg"


def test_context_files_from_inbound_helper():
    from app.channels.manager import _context_files_from_inbound, _v4_attachments_from_context_files

    files = [
        {"path": "/tmp/a.png", "filename": "a.png", "mime": "image/png", "kind": "image", "size": 12},
        {"path": "", "filename": "drop-me"},
        "not-a-dict",
    ]
    ctx = _context_files_from_inbound(files)
    assert len(ctx) == 1
    assert ctx[0]["name"] == "a.png"
    atts = _v4_attachments_from_context_files(ctx)
    assert atts[0]["ref"] == "/tmp/a.png"
    assert atts[0]["mime"] == "image/png"
