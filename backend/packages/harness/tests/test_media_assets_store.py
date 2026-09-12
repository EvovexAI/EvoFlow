"""Media assets SQLite persistence."""

from __future__ import annotations

from evoflow.persistence.schema import ensure_app_schema

import sqlite3

import pytest

from evoflow.persistence.media_assets import (
    list_media_assets,
    record_media_asset,
    update_media_asset_by_task,
)


@pytest.fixture()
def media_db(tmp_path, monkeypatch):
    db_path = tmp_path / "test.db"
    monkeypatch.setenv("EVOFLOW_HOME", str(tmp_path))
    import evoflow.config.paths as paths_mod

    paths_mod._paths = None
    import evoflow.persistence.db as db_mod

    db_mod._conn = None
    conn = sqlite3.connect(str(db_path))
    ensure_app_schema(conn)
    conn.commit()
    conn.close()

    from evoflow.persistence.db import get_db

    get_db()
    yield
    db_mod._conn = None


def test_record_and_list_assets(media_db):
    rid = record_media_asset(
        thread_id="thread-abc",
        tool_name="media_image_generate",
        media_kind="image",
        provider="wan",
        task_id="task-001",
        status="processing",
    )
    assert rid is not None

    update_media_asset_by_task(
        provider="wan",
        task_id="task-001",
        status="succeeded",
        remote_url="https://example.com/a.png",
        local_path="outputs/media_image_task-001.png",
    )

    items = list_media_assets(thread_id="thread-abc")
    assert len(items) == 1
    assert items[0]["status"] == "succeeded"
    assert items[0]["remote_url"] == "https://example.com/a.png"
    assert items[0]["local_path"] == "outputs/media_image_task-001.png"


def test_list_without_thread(media_db):
    record_media_asset(
        thread_id="t1",
        tool_name="media_voiceover_synthesize",
        media_kind="audio",
        provider="dashscope",
        status="succeeded",
        local_path="outputs/voiceover.mp3",
    )
    all_items = list_media_assets(limit=10)
    assert len(all_items) >= 1
