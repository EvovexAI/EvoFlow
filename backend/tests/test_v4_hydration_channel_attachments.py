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


def test_attachments_include_desktop_data_urls():
    """桌面 chatSend 把图片编码成 data: URL 块——回放必须保留（readAttachment 直接当 URL 用）。"""
    small = "data:image/png;base64," + "A" * 64
    webp = "data:image/webp;base64," + "B" * 64
    oversized = "data:image/gif;base64," + "C" * 2_800_001
    atts = _attachments_from_user_payload(
        {
            "content": [
                {"type": "text", "text": "看图"},
                {"type": "image_url", "image_url": {"url": small}},
                {"type": "image_url", "image_url": {"url": webp}},
                {"type": "image_url", "image_url": {"url": oversized}},
            ]
        }
    )
    refs = [a["ref"] for a in atts]
    assert refs == [small, webp]
    assert atts[0]["mime"] == "image/png"
    assert atts[1]["mime"] == "image/webp"
    assert all(a["bytes"] == 0 for a in atts)


def test_big_data_url_materialized_to_cache_file(tmp_path: Path, monkeypatch):
    """对齐 ZCode：超过内联阈值的大图落盘 v4-image-cache，ref 换本地路径；小图保持行内。"""
    import base64

    from app.gateway.v4 import image_cache

    def _fake_cache_dir() -> Path:
        d = tmp_path / "cache"
        d.mkdir(parents=True, exist_ok=True)
        return d

    monkeypatch.setattr(image_cache, "v4_image_cache_dir", _fake_cache_dir)
    payload = b"\x89PNG\r\n\x1a\n" + b"\x00" * 80_000
    big = "data:image/png;base64," + base64.b64encode(payload).decode()
    small = "data:image/png;base64," + "A" * 64

    atts = _attachments_from_user_payload(
        {
            "content": [
                {"type": "image_url", "image_url": {"url": big}},
                {"type": "image_url", "image_url": {"url": small}},
            ]
        }
    )
    assert len(atts) == 2
    # 大图：ref 是缓存文件路径，bytes = 解码后字节数，文件内容与原字节一致
    ref_path = Path(atts[0]["ref"])
    assert ref_path.is_file() and ref_path.suffix == ".png"
    assert ref_path.parent.name == "cache"
    assert atts[0]["bytes"] == len(payload)
    assert ref_path.read_bytes() == payload
    # 幂等：再次提取同一 data URL 得到同一路径，不重复写盘
    again = _attachments_from_user_payload(
        {"content": [{"type": "image_url", "image_url": {"url": big}}]}
    )
    assert again[0]["ref"] == atts[0]["ref"]
    # 小图：保持行内
    assert atts[1]["ref"] == small


def test_extractor_user_attachments_from_stream_body():
    """POST /runs/stream body 的 image_url 块 → live 镜像 AttachmentRef（只看最新 human）。"""
    import base64

    from app.gateway.routers.langgraph_proxy import _extract_user_attachments_from_stream_body

    png = base64.b64encode(b"\x89PNG" + b"x" * 16).decode()
    mid1 = f"data:image/png;base64,{png}"
    mid2 = f"data:image/jpeg;base64,{png}"
    big = "data:image/gif;base64," + "A" * 2_800_001
    body = json.dumps(
        {
            "input": {
                "messages": [
                    {"role": "user", "content": "旧文本", "id": "u0"},
                    {
                        "role": "user",
                        "content": [
                            {"type": "text", "text": "看图"},
                            {"type": "image_url", "image_url": {"url": mid1}},
                            {"type": "image_url", "image_url": {"url": mid1}},
                            {"type": "image_url", "image_url": {"url": mid2}},
                            {"type": "image_url", "image_url": {"url": big}},
                        ],
                        "id": "u1",
                    },
                ]
            }
        }
    ).encode()
    atts = _extract_user_attachments_from_stream_body(body)
    assert [a["ref"] for a in atts] == [mid1, mid2]
    assert [a["mime"] for a in atts] == ["image/png", "image/jpeg"]
    # 只看最新一条 human：历史轮次的图不重复挂
    older = json.dumps({"input": {"messages": [{"role": "user", "content": "纯文本"}]}}).encode()
    assert _extract_user_attachments_from_stream_body(older) == []
