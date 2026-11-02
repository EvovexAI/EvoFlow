"""serve-file / resolve-target must fail fast on URLs and junk paths (no tree walk)."""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi import HTTPException

from app.gateway.routers.workspaces import (
    _looks_like_url_or_data,
    _prepare_serve_file_target,
    _should_attempt_path_heal,
)


def test_url_paths_detected() -> None:
    assert _looks_like_url_or_data("https://127.0.0.1:8790/generated/x.png")
    assert _looks_like_url_or_data("http://example.com/a.png")
    assert _looks_like_url_or_data("data:image/png;base64,xx")
    assert not _looks_like_url_or_data(r"D:\dev\out\a.png")


def test_heal_skipped_for_url_dir_and_placeholder() -> None:
    assert _should_attempt_path_heal("https://x/y.png", Path("x")) is False
    assert _should_attempt_path_heal("/video.mp4", Path("/video.mp4")) is False
    assert _should_attempt_path_heal("/+audio.mp3", Path("/+audio.mp3")) is False
    assert _should_attempt_path_heal("outputs/segments", Path("outputs/segments")) is False
    assert _should_attempt_path_heal("outputs/clip.mp4", Path("outputs/clip.mp4")) is True


def test_prepare_serve_file_rejects_https() -> None:
    with pytest.raises(HTTPException) as ei:
        _prepare_serve_file_target(
            root=None,
            thread_id=None,
            path="https://127.0.0.1:8790/generated/x.png",
        )
    assert ei.value.status_code == 400
