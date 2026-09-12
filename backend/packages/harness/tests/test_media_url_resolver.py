"""Tests for media URL resolution (local path → remote URL)."""

from __future__ import annotations

from evoflow.persistence.schema import ensure_app_schema

import json
from unittest.mock import MagicMock

import pytest

from evoflow.community.media_generation import tools as media_tools
from evoflow.community.media_generation.media_url_resolver import resolve_media_reference_url
from evoflow.persistence.media_assets import find_remote_url_for_local_path, record_media_asset, update_media_asset_by_task


@pytest.fixture()
def media_db(tmp_path, monkeypatch):
    db_path = tmp_path / "test.db"
    monkeypatch.setenv("EVOFLOW_HOME", str(tmp_path))
    import evoflow.config.paths as paths_mod

    paths_mod._paths = None
    import evoflow.persistence.db as db_mod

    db_mod._conn = None
    import sqlite3

    
    conn = sqlite3.connect(str(db_path))
    ensure_app_schema(conn)
    conn.commit()
    conn.close()
    from evoflow.persistence.db import get_db

    get_db()
    yield
    db_mod._conn = None


def test_find_remote_url_by_absolute_local_path(media_db):
    record_media_asset(
        thread_id="t1",
        tool_name="media_image_generate",
        media_kind="image",
        provider="wan",
        task_id="img-1",
        status="processing",
    )
    update_media_asset_by_task(
        provider="wan",
        task_id="img-1",
        status="succeeded",
        remote_url="https://cdn.example.com/cat.png",
        local_path="D:/proj/outputs/media_image_x.png",
    )
    url = find_remote_url_for_local_path(
        thread_id="t1",
        path_keys={"D:/proj/outputs/media_image_x.png", "media_image_x.png"},
        media_kind="image",
    )
    assert url == "https://cdn.example.com/cat.png"


def test_media_video_generate_resolves_local_first_frame_from_registry(media_db, tmp_path, monkeypatch):
    outputs = tmp_path / "outputs"
    outputs.mkdir()
    img = outputs / "media_image_abc.png"
    img.write_bytes(b"png")

    record_media_asset(
        thread_id="thread-1",
        tool_name="media_image_generate",
        media_kind="image",
        provider="wan",
        task_id="task-img",
        status="succeeded",
        remote_url="https://cdn.example.com/keyframe.png",
        local_path=str(img).replace("\\", "/"),
    )

    runtime = MagicMock()
    runtime.context = {"thread_id": "thread-1"}
    runtime.config = {"configurable": {"thread_id": "thread-1", "local_workspace_root": str(tmp_path)}}
    runtime.state = {"thread_data": {"outputs_path": str(outputs)}}

    captured = {}

    def _fake_submit(prov, **kw):
        captured.update(kw)
        return "task-vid-1"

    monkeypatch.setattr(media_tools, "_submit_video", _fake_submit)
    monkeypatch.setattr(media_tools, "record_task_submitted", lambda *a, **k: None)

    raw = media_tools.media_video_generate_tool.func(
        runtime,
        prompt="cat moves",
        mode="image2video",
        provider="wan",
        first_frame_url=str(img),
        audio_url=None,
        duration=5,
        aspect_ratio="1:1",
    )
    data = json.loads(raw)
    assert data["ok"] is True
    assert captured["first_frame_url"] == "https://cdn.example.com/keyframe.png"
    assert captured["mode"] == "image2video"
    assert "resolve" in data["message"].lower() or data.get("extra", {}).get("resolve_notes")


def test_media_video_generate_uploads_when_no_registry(media_db, tmp_path, monkeypatch):
    outputs = tmp_path / "outputs"
    outputs.mkdir()
    img = outputs / "frame.png"
    img.write_bytes(b"png")

    runtime = MagicMock()
    runtime.context = {"thread_id": "thread-2"}
    runtime.config = {"configurable": {"thread_id": "thread-2", "local_workspace_root": str(tmp_path)}}
    runtime.state = {"thread_data": {"outputs_path": str(outputs)}}

    captured = {}

    def _fake_submit(prov, **kw):
        captured.update(kw)
        return "task-vid-2"

    monkeypatch.setattr(media_tools, "_submit_video", _fake_submit)
    monkeypatch.setattr(media_tools, "record_task_submitted", lambda *a, **k: None)
    monkeypatch.setattr(
        "evoflow.community.media_generation.media_url_resolver.upload_local_file",
        lambda **kw: "oss://dashscope-instant/test/frame.png",
    )

    raw = media_tools.media_video_generate_tool.func(
        runtime,
        prompt="motion",
        mode="image2video",
        provider="wan",
        first_frame_url=str(img),
        audio_url=None,
        duration=5,
        aspect_ratio="16:9",
    )
    data = json.loads(raw)
    assert data["ok"] is True
    assert captured["first_frame_url"].startswith("oss://")


def test_resolve_jimeng_local_first_frame_as_data_url(tmp_path):
    outputs = tmp_path / "outputs"
    outputs.mkdir()
    img = outputs / "frame.png"
    img.write_bytes(b"\x89PNG\r\n\x1a\n")

    url, note = resolve_media_reference_url(
        str(img),
        runtime=None,
        provider="jimeng",
        purpose="first_frame",
        outputs_dir=outputs,
    )
    assert url.startswith("data:image/png;base64,")
    assert note and "Seedance" in note
