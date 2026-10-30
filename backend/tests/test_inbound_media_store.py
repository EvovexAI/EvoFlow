"""Durable channel inbound media path layout under EVOFLOW_HOME."""

from __future__ import annotations

from datetime import datetime
from pathlib import Path


def test_write_inbound_media_layout(tmp_path, monkeypatch):
    monkeypatch.setenv("EVOFLOW_HOME", str(tmp_path))
    from evoflow.config.paths import reset_paths_cache

    reset_paths_cache()
    from app.channels.inbound_media_store import (
        channel_inbound_media_dir,
        is_under_channel_messages,
        write_inbound_media_bytes,
    )

    when = datetime(2026, 10, 29, 22, 0, 0)
    path = Path(
        write_inbound_media_bytes(
            b"hello-bytes",
            channel="feishu",
            filename="feishu-image-img_v3_0.jpg",
            unique_hint="om_abc_img_v3",
            when=when,
        )
    )
    assert path.exists()
    assert path.read_bytes() == b"hello-bytes"
    expected_dir = channel_inbound_media_dir("feishu", when=when)
    assert path.parent == expected_dir
    assert expected_dir.as_posix().endswith("channel-messages/feishu/2026/10")
    assert "feishu-image-img_v3_0" in path.name
    assert is_under_channel_messages(path)
    assert not is_under_channel_messages(tmp_path / "other.bin")
    reset_paths_cache()


def test_allocate_avoids_collision(tmp_path, monkeypatch):
    monkeypatch.setenv("EVOFLOW_HOME", str(tmp_path))
    from evoflow.config.paths import reset_paths_cache

    reset_paths_cache()
    from app.channels.inbound_media_store import allocate_inbound_media_path, write_inbound_media_bytes

    when = datetime(2026, 10, 29)
    a = Path(
        write_inbound_media_bytes(
            b"a",
            channel="wecom",
            filename="shot.jpg",
            unique_hint="h1",
            when=when,
        )
    )
    b = allocate_inbound_media_path("wecom", "shot.jpg", unique_hint="h1", when=when)
    assert a.exists()
    assert b != a
    reset_paths_cache()
