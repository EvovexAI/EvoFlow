"""Task-center list path must use light SQL summaries (not N× full bundles)."""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest


def test_collab_task_row_to_summary_maps_root_row():
    from evoflow.persistence.task_row_mappers import collab_task_row_to_summary

    row = {
        "main_task_id": "t1",
        "task_id": "t1",
        "name": "任务: demo",
        "description": "d",
        "status": "pending",
        "parent_id": None,
        "assigned_to": "agent-a",
        "error_text": None,
        "created_at": "2026-08-26T01:00:00Z",
        "started_at": None,
        "completed_at": None,
        "progress": 0,
        "execution_authorized": 0,
        "thread_id": "th-1",
        "authorized_at": None,
        "authorized_by": None,
        "extra_json": '{"source":"chat","assigned_role":"pm"}',
        "sort_order": 0,
        "updated_at": "2026-08-26T02:00:00Z",
        "plan_goal": "",
        "plan_open_questions": "",
        "plan_bound_at": "",
    }
    out = collab_task_row_to_summary(row)
    assert out["id"] == "t1"
    assert out["main_task_id"] == "t1"
    assert out["name"] == "demo"
    assert out["source"] == "chat"
    assert out["assigned_role"] == "pm"
    assert out["updated_at"] == "2026-08-26T02:00:00Z"
    assert out["subtasks"] == []


def test_list_tasks_catalog_sync_uses_summaries_not_bundles():
    from app.gateway.routers import tasks as tasks_mod

    fake = [
        {
            "id": "a1",
            "name": "alpha",
            "status": "pending",
            "source": "chat",
            "created_at": "2026-08-26T01:00:00Z",
            "updated_at": "2026-08-26T03:00:00Z",
        },
        {
            "id": "b1",
            "name": "beta",
            "status": "completed",
            "source": "chat",
            "created_at": "2026-08-26T01:00:00Z",
            "updated_at": "2026-08-26T02:00:00Z",
        },
    ]
    with patch(
        "evoflow.persistence.repositories.list_root_task_summaries",
        return_value=fake,
    ) as mock_list:
        payload = tasks_mod._list_tasks_catalog_sync(
            status=None,
            source=None,
            search=None,
            project_id=None,
            sort="updated_at",
            order="desc",
            page=1,
            page_size=0,
            hide_noise=False,
        )
    mock_list.assert_called_once_with(main_task_id=None)
    assert payload["total"] == 2
    assert payload["tasks"][0]["id"] == "a1"


@pytest.mark.asyncio
async def test_list_tasks_catalog_offloads_to_thread():
    """Ensure list path does not call storage.list_projects / load_project."""
    from app.gateway.routers import tasks as tasks_mod

    storage = MagicMock()
    storage.list_projects.side_effect = AssertionError("must not full-scan projects")
    storage.load_project.side_effect = AssertionError("must not load bundles")

    with patch.object(tasks_mod, "get_project_storage", return_value=storage):
        with patch.object(
            tasks_mod,
            "_list_tasks_catalog_sync",
            return_value={
                "tasks": [],
                "total": 0,
                "page": 1,
                "page_size": 0,
                "page_count": 0,
                "filters": {},
            },
        ) as sync_mock:
            with patch("asyncio.to_thread", new_callable=AsyncMock) as to_thread:
                async def _run(fn, **kw):
                    return sync_mock(**kw)

                to_thread.side_effect = _run
                result = await tasks_mod.list_tasks(
                    status=None,
                    source=None,
                    search=None,
                    project_id=None,
                    thread_id=None,
                    session_key=None,
                    prefer_task_id=None,
                    sort="updated_at",
                    order="desc",
                    page=1,
                    page_size=0,
                    hide_noise=True,
                )
    assert result["success"] is True
    to_thread.assert_awaited()
    storage.list_projects.assert_not_called()


def test_admin_list_tasks_uses_light_sql_not_bundles():
    """Agent ``tasks`` list must not N× load_project (hang dump smoking gun)."""
    from evoflow.admin import tasks as admin_tasks

    roots = [
        {
            "id": "r1",
            "main_task_id": "r1",
            "name": "root-a",
            "status": "pending",
            "source": "role",
            "assigned_role": "pm",
            "assigned_to": "agent-a",
            "progress": 0,
            "created_at": "2026-08-26T01:00:00Z",
            "updated_at": "2026-08-26T03:00:00Z",
            "outputs": [{"type": "file", "value": "rel/out.md"}],
        }
    ]
    subs = [
        {
            "id": "s1",
            "main_task_id": "r1",
            "_collab_parent_task_id": "r1",
            "name": "sub-a",
            "status": "pending",
            "source": "role",
            "assigned_role": "pm",
            "progress": 10,
            "created_at": "2026-08-26T01:00:00Z",
            "updated_at": "2026-08-26T02:00:00Z",
        }
    ]
    with patch(
        "evoflow.persistence.repositories.list_root_task_summaries",
        return_value=roots,
    ) as mock_roots:
        with patch(
            "evoflow.persistence.repositories.list_subtask_summaries",
            return_value=subs,
        ) as mock_subs:
            with patch(
                "evoflow.collab.task_outputs.absolutize_file_path",
                side_effect=AssertionError("list must not absolutize paths"),
            ):
                with patch.object(admin_tasks, "get_project_storage") as mock_storage:
                    mock_storage.side_effect = AssertionError("must not use ProjectStorage list")
                    out = admin_tasks.list_tasks(limit=20, include_subtasks=True)
    mock_roots.assert_called_once_with(main_task_id=None)
    mock_subs.assert_called_once_with(main_task_id=None)
    assert out["total"] == 2
    assert out["tasks"][0]["task_id"] == "r1"
    assert any(t.get("subtask_id") == "s1" for t in out["tasks"])


def test_absolutize_file_path_avoids_path_resolve(tmp_path, monkeypatch):
    """Windows hang was Path.resolve → _readlink_deep; keep abspath/normpath only."""
    from evoflow.collab import task_outputs as to

    workspace = tmp_path / "ws"
    workspace.mkdir()
    target = workspace / "a.md"
    target.write_text("x", encoding="utf-8")

    def _boom(*_a, **_k):
        raise AssertionError("Path.resolve must not be used")

    monkeypatch.setattr(to.Path, "resolve", _boom)
    out = to.absolutize_file_path("a.md", str(workspace))
    assert out.replace("\\", "/").endswith("/a.md")
    assert "ws" in out.replace("\\", "/")
