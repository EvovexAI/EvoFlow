"""IM channel-messages paths must be readable by sandbox read tools."""

from __future__ import annotations

import os
from pathlib import Path
from types import SimpleNamespace

import pytest


@pytest.fixture()
def channel_img(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    root = tmp_path / "home"
    media = root / "channel-messages" / "feishu" / "2026" / "10"
    media.mkdir(parents=True)
    img = media / "feishu-image-test.jpg"
    # Minimal JPEG header so suffix checks pass; bytes don't need to decode.
    img.write_bytes(b"\xff\xd8\xff\xe0" + b"\x00" * 64)
    monkeypatch.setenv("EVOFLOW_HOME", str(root))
    from evoflow.config.paths import reset_paths_cache

    reset_paths_cache()
    yield img
    reset_paths_cache()


def test_is_channel_messages_path_allows_feishu_image(channel_img: Path, tmp_path: Path) -> None:
    from evoflow.sandbox.tools import _is_channel_messages_path

    assert _is_channel_messages_path(str(channel_img))
    outside = tmp_path / "elsewhere" / "secret.png"
    outside.parent.mkdir(parents=True, exist_ok=True)
    outside.write_bytes(b"\xff\xd8\xff\xe0" + b"\x00" * 16)
    assert not _is_channel_messages_path(str(outside))


def test_validate_local_tool_path_allows_channel_messages_read(channel_img: Path) -> None:
    from evoflow.sandbox.tools import validate_local_tool_path

    thread_data = {
        "workspace_path": str(channel_img.parent),
        "uploads_path": str(channel_img.parent),
        "outputs_path": str(channel_img.parent),
    }
    validate_local_tool_path(str(channel_img), thread_data, read_only=True)

    with pytest.raises(PermissionError):
        validate_local_tool_path(str(channel_img), thread_data, read_only=False)


def test_lead_transcript_keeps_empty_content_with_context_files(channel_img: Path) -> None:
    from evoflow.agents.middlewares.session_transcript_hydration_middleware import (
        lead_transcript_rows_to_lc_messages,
    )

    rows = [
        {
            "role": "user",
            "message_id": "m-img-only",
            "content_json": {
                "content": "",
                "contextFiles": [
                    {
                        "path": str(channel_img),
                        "name": "feishu-image-test.jpg",
                        "mime": "image/jpeg",
                        "kind": "image",
                    }
                ],
            },
        }
    ]
    msgs = lead_transcript_rows_to_lc_messages(rows)
    assert len(msgs) == 1
    assert msgs[0].additional_kwargs.get("context_files")
    assert msgs[0].additional_kwargs["context_files"][0]["path"] == str(channel_img)
    assert str(msgs[0].content or "").strip()  # placeholder, not empty
