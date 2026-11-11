"""serve-file / resolve-target must fail fast on URLs and junk paths (no tree walk)."""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi import HTTPException

from app.gateway.routers.workspaces import (
    _fuzzy_locate_under_workspace,
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


def test_fuzzy_locate_respects_budget(tmp_path: Path) -> None:
    """Wall budget must stop the walk even when max_scan is huge (media monorepo case)."""
    for i in range(40):
        d = tmp_path / f"seg-{i}"
        d.mkdir()
        (d / f"clip-{i}.mp4").write_bytes(b"x")
    # Near-zero budget → returns quickly (None or a hit if lucky on first file).
    hit = _fuzzy_locate_under_workspace(
        tmp_path,
        "no-such-file-zzzz.mp4",
        max_scan=100_000,
        budget_s=0.001,
    )
    assert hit is None


def test_resolve_target_soft_miss_shape() -> None:
    from app.gateway.routers.workspaces import _soft_miss_resolve_target

    miss = _soft_miss_resolve_target("projects/ep/missing.mp4")
    assert miss.exists is False
    assert miss.is_dir is False
    assert miss.path == "projects/ep/missing.mp4"


def test_resolve_target_heal_budget_stops_fat_walk(tmp_path: Path) -> None:
    """Missing media under a fat tree must miss within heal budget, not walk forever."""
    import time

    from app.gateway.routers.workspaces import _resolve_target_sync

    root = tmp_path / "workspace"
    root.mkdir()
    # Wide (not deep) tree — Windows MAX_PATH; still enough files to tempt a long walk.
    for i in range(80):
        d = root / f"seg-{i}"
        d.mkdir()
        (d / f"noise-{i}.mp4").write_bytes(b"x")
    t0 = time.perf_counter()
    _rel, _resolved, exists, is_dir = _resolve_target_sync(
        root=str(root),
        thread_id=None,
        rel="never-exists-zzzz.mp4",
    )
    elapsed = time.perf_counter() - t0
    assert exists is False
    assert is_dir is False
    # Budget 2.5s + overhead; must never approach the old 50–100s hangs.
    assert elapsed < 4.0
