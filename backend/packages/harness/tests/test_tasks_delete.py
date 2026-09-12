"""admin/CLI hard-delete for collab main tasks."""

from __future__ import annotations

import pytest

from evoflow.admin import tasks as admin_tasks
from evoflow.admin.errors import NotFoundError, ValidationError
from evoflow.cli.commands import tasks as tasks_cli


def test_delete_task_removes_row(tmp_path, monkeypatch):
    monkeypatch.setenv("EVOFLOW_DATA_DIR", str(tmp_path))
    created = admin_tasks.create_task(
        name="误建单",
        description="delete me",
        assignee="product-manager",
        assigned_role="产品经理",
        source="role",
        raised_by="product-manager",
    )
    tid = created["task_id"]
    out = admin_tasks.delete_task(tid)
    assert out.get("ok") is True
    assert out.get("task_id") == tid
    with pytest.raises(NotFoundError):
        admin_tasks.get_task(tid)


def test_cli_delete_requires_yes(tmp_path, monkeypatch):
    monkeypatch.setenv("EVOFLOW_DATA_DIR", str(tmp_path))
    created = admin_tasks.create_task(
        name="need-yes",
        assignee="a",
        assigned_role="岗",
        source="role",
        raised_by="a",
    )
    tid = created["task_id"]

    class Args:
        task_id = tid
        yes = False

    with pytest.raises(ValidationError):
        tasks_cli._delete(Args())

    Args.yes = True
    out = tasks_cli._delete(Args())
    assert out.get("deleted") is True
    with pytest.raises(NotFoundError):
        admin_tasks.get_task(tid)
