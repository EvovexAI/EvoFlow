"""Browser screenshot persistence (no base64 in model context)."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from evoflow.tools.builtins.browser_screenshot_store import (
    compact_legacy_screenshot_tool_content,
    format_screenshot_tool_result,
    resolve_screenshot_file,
    save_screenshot_png,
)


@pytest.fixture
def screenshot_home(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    monkeypatch.setenv("EVOFLOW_HOME", str(tmp_path))
    from evoflow.persistence.db import reset_db_for_tests

    reset_db_for_tests()
    yield tmp_path


def test_save_and_format_no_base64(screenshot_home: Path) -> None:
    del screenshot_home
    meta = save_screenshot_png("thread-1", b"\x89PNG\r\n\x01", page_url="https://example.com", width=100, height=50)
    out = format_screenshot_tool_result("thread-1", meta)
    assert "base64" not in out.lower()
    data = json.loads(out)
    assert data["type"] == "browser_screenshot"
    assert data["image_url"].startswith("/api/threads/")
    path = resolve_screenshot_file("thread-1", str(meta["screenshot_id"]))
    assert path is not None and path.is_file()


def test_compact_legacy_data_uri() -> None:
    legacy = "data:image/png;base64," + ("A" * 200)
    compact = compact_legacy_screenshot_tool_content(legacy, "browser_snapshot")
    assert "base64" not in compact
    assert "omitted" in compact.lower()
