"""Tests for board zombie reclaim (executing@100 / awaiting_close)."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from unittest.mock import MagicMock, patch

from evoflow.collab.task_reclaim import (
    classify_zombie_reclaim,
    reclaim_zombie_tasks,
)


def test_classify_stuck_executing_100():
    old = (datetime.now(UTC) - timedelta(days=4)).isoformat()
    hit = classify_zombie_reclaim(
        {
            "id": "t1",
            "name": "评测中心 Phase 2",
            "status": "executing",
            "progress": 100,
            "updated_at": old,
        },
        stuck_days=3,
    )
    assert hit and hit["reason"] == "stuck_executing_100"
    assert hit["to_status"] == "completed"

    fresh = classify_zombie_reclaim(
        {
            "id": "t2",
            "name": "刚跑完",
            "status": "executing",
            "progress": 100,
            "updated_at": datetime.now(UTC).isoformat(),
        },
        stuck_days=3,
    )
    assert fresh is None


def test_classify_awaiting_close_all_children_done():
    old = (datetime.now(UTC) - timedelta(days=5)).isoformat()
    parent = {
        "id": "parent1",
        "name": "根单",
        "status": "awaiting_close",
        "progress": 100,
        "updated_at": old,
    }
    with patch(
        "evoflow.collab.task_reclaim._children_all_fully_closed",
        return_value={"total": 2, "open": 0, "all_done": True, "open_rows": []},
    ):
        hit = classify_zombie_reclaim(parent, awaiting_close_days=3)
    assert hit and hit["reason"] == "awaiting_close_all_children_done"


def test_classify_awaiting_close_skips_when_child_open():
    old = (datetime.now(UTC) - timedelta(days=5)).isoformat()
    parent = {
        "id": "parent2",
        "name": "根单",
        "status": "awaiting_close",
        "progress": 100,
        "updated_at": old,
    }
    with patch(
        "evoflow.collab.task_reclaim._children_all_fully_closed",
        return_value={
            "total": 1,
            "open": 1,
            "all_done": False,
            "open_rows": [{"task_id": "c1", "status": "executing"}],
        },
    ):
        assert classify_zombie_reclaim(parent, awaiting_close_days=3) is None


def test_classify_awaiting_close_orphan_stale():
    old = (datetime.now(UTC) - timedelta(days=5)).isoformat()
    parent = {
        "id": "orphan1",
        "name": "无下游待闭环",
        "status": "awaiting_close",
        "progress": 100,
        "updated_at": old,
    }
    with patch(
        "evoflow.collab.task_reclaim._children_all_fully_closed",
        return_value={"total": 0, "open": 0, "all_done": True, "open_rows": []},
    ):
        hit = classify_zombie_reclaim(parent, awaiting_close_days=3)
    assert hit and hit["reason"] == "awaiting_close_orphan_stale"


def test_reclaim_dry_run():
    old = (datetime.now(UTC) - timedelta(days=5)).isoformat()
    storage = MagicMock()
    storage.list_projects.return_value = [{"id": "p1"}]
    storage.load_project.return_value = {
        "id": "p1",
        "tasks": [
            {
                "id": "z1",
                "name": "僵尸执行",
                "status": "executing",
                "progress": 100,
                "updated_at": old,
            }
        ],
    }
    with patch("evoflow.collab.storage.get_project_storage", return_value=storage):
        out = reclaim_zombie_tasks(dry_run=True, stuck_days=3)
    assert out["dry_run"] is True
    assert out["count"] == 1
    assert out["candidates"][0]["task_id"] == "z1"
    assert out["reclaimed"] == []
