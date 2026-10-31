"""GET /api/tasks page_size / limit alias + list slim helpers."""

from __future__ import annotations

from app.gateway.routers.tasks import (
    _TASKS_LIST_ALL_CAP,
    _TASKS_LIST_DEFAULT_PAGE,
    _resolve_list_page_size,
    _slim_task_for_list,
)
from evoflow.persistence.task_repositories import _root_task_sql_filters


def test_resolve_list_page_size_prefers_page_size() -> None:
    assert _resolve_list_page_size(page_size=20, limit=40) == 20
    assert _resolve_list_page_size(page_size=0, limit=40) == 40
    assert _resolve_list_page_size(page_size=0, limit=None) == 0
    assert _resolve_list_page_size(page_size=0, limit=0) == 0


def test_tasks_list_defaults_are_bounded() -> None:
    assert _TASKS_LIST_DEFAULT_PAGE == 40
    assert _TASKS_LIST_ALL_CAP == 200
    assert _TASKS_LIST_ALL_CAP >= _TASKS_LIST_DEFAULT_PAGE


def test_root_task_sql_filters_exclude_noise_and_role() -> None:
    where, params = _root_task_sql_filters(exclude_noise=True, has_role=True)
    assert "task_id = main_task_id" in where
    assert "assigned_role" in where
    assert "proactive_patrol" in where
    assert params == []


def test_slim_task_for_list_drops_heavy_fields() -> None:
    row = _slim_task_for_list(
        {
            "id": "t1",
            "name": "demo",
            "description": "x" * 400,
            "outputs": [{"type": "text", "value": "big"}],
            "handlers": [{"id": "h1"}],
            "input_refs": [{"id": "r1"}],
            "subtasks": [],
            "plan_steps": [{"id": "s1"}, {"id": "s2"}],
            "app_definition_snapshot": {"huge": True},
            "result_text": "y" * 500,
        }
    )
    assert row["id"] == "t1"
    assert len(row["description"]) == 160
    assert "outputs" not in row
    assert "handlers" not in row
    assert "input_refs" not in row
    assert "subtasks" not in row
    assert "app_definition_snapshot" not in row
    assert "result_text" not in row
    assert row["plan_steps_count"] == 2
    assert "plan_steps" not in row
