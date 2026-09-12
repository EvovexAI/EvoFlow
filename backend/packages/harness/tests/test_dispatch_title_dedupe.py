"""Tests for dispatch title-level open-task reuse."""

from __future__ import annotations

from unittest.mock import MagicMock, patch

from evoflow.proactive.work_items import find_open_work_item_by_title


def test_find_open_work_item_by_title_same_assignee():
    storage = MagicMock()
    storage.list_projects.return_value = [{"id": "p1"}]
    storage.load_project.return_value = {
        "id": "p1",
        "tasks": [
            {
                "id": "old",
                "name": "开发报销 API",
                "assigned_to": "dev-backend",
                "status": "pending",
                "progress": 0,
                "updated_at": "2026-08-01T00:00:00Z",
            },
            {
                "id": "newer",
                "name": "开发报销 API",
                "assigned_to": "dev-backend",
                "status": "executing",
                "progress": 10,
                "updated_at": "2026-08-09T00:00:00Z",
            },
            {
                "id": "other",
                "name": "开发报销 API",
                "assigned_to": "fe-dev",
                "status": "pending",
                "progress": 0,
                "updated_at": "2026-08-10T00:00:00Z",
            },
            {
                "id": "done",
                "name": "开发报销 API",
                "assigned_to": "dev-backend",
                "status": "completed",
                "progress": 100,
                "updated_at": "2026-08-11T00:00:00Z",
            },
        ],
    }
    with patch("evoflow.collab.storage.get_project_storage", return_value=storage):
        tid = find_open_work_item_by_title("dev-backend", "开发报销 API")
    assert tid == "newer"


def test_find_open_work_item_by_title_no_cross_assignee():
    storage = MagicMock()
    storage.list_projects.return_value = [{"id": "p1"}]
    storage.load_project.return_value = {
        "id": "p1",
        "tasks": [
            {
                "id": "fe",
                "name": "汇报每个人工作进度",
                "assigned_to": "fe-dev",
                "status": "pending",
                "updated_at": "2026-08-07T00:00:00Z",
            }
        ],
    }
    with patch("evoflow.collab.storage.get_project_storage", return_value=storage):
        assert find_open_work_item_by_title("be-dev", "汇报每个人工作进度") is None
