"""Lazy execution authorize when user already confirmed「开始执行」."""

from __future__ import annotations

from unittest.mock import patch

from evoflow.collab.authorize_execution import (
    collab_thread_allows_execution_start,
    ensure_task_execution_authorized_for_user,
    is_task_execution_authorized,
    resolve_thread_id_for_task,
    user_has_confirmed_execution_start,
)
from evoflow.collab.models import CollabPhase
from evoflow.collab.storage import ProjectStorage, new_project_bundle_root_task
from evoflow.collab.thread_collab import merge_thread_collab_state, save_thread_collab_state
from evoflow.collab.user_execution_confirm import mark_user_execution_confirmed
from evoflow.config.paths import Paths


def test_ensure_authorizes_when_thread_marked(tmp_path) -> None:
    storage = ProjectStorage(tmp_path / "bundles")
    project, task = new_project_bundle_root_task("t", "description long enough here", thread_id="thread-a")
    task["status"] = "executing"
    storage.save_project(project)
    task_id = str(task["id"])

    paths = Paths(base_dir=str(tmp_path / "home"))
    with patch("evoflow.collab.authorize_execution.get_paths", return_value=paths):
        mark_user_execution_confirmed(paths, "thread-a")
        assert user_has_confirmed_execution_start("thread-a")
        ok, _msg = ensure_task_execution_authorized_for_user(storage, task_id, thread_id="thread-a")
    assert ok is True
    assert is_task_execution_authorized(storage, task_id)


class _HumanMsg:
    type = "human"

    def __init__(self, content: str) -> None:
        self.content = content


def test_ensure_authorizes_from_recent_human_message(tmp_path) -> None:
    storage = ProjectStorage(tmp_path / "bundles")
    project, task = new_project_bundle_root_task("t", "description long enough here", thread_id="thread-c")
    task["status"] = "executing"
    storage.save_project(project)
    task_id = str(task["id"])

    msgs = [_HumanMsg("开始执行")]
    assert user_has_confirmed_execution_start("", messages=msgs)
    ok, _msg = ensure_task_execution_authorized_for_user(
        storage,
        task_id,
        thread_id="thread-c",
        messages=msgs,
    )
    assert ok is True
    assert is_task_execution_authorized(storage, task_id)


def test_collab_awaiting_exec_phase_allows_lazy_authorize(tmp_path) -> None:
    storage = ProjectStorage(tmp_path / "bundles")
    project, task = new_project_bundle_root_task("t", "description long enough here", thread_id="thread-phase")
    task["status"] = "planned"
    task_id = str(task["id"])
    storage.save_project(project)

    paths = Paths(base_dir=str(tmp_path / "home"))
    save_thread_collab_state(
        paths,
        "thread-phase",
        merge_thread_collab_state(
            None,
            {
                "bound_task_id": task_id,
                "collab_phase": CollabPhase.AWAITING_EXEC.value,
            },
        ),
    )

    assert collab_thread_allows_execution_start(storage, task_id, thread_id="thread-phase")
    ok, _msg = ensure_task_execution_authorized_for_user(storage, task_id, thread_id="")
    assert ok is True
    assert is_task_execution_authorized(storage, task_id)


def test_resolve_thread_id_from_task_row(tmp_path) -> None:
    storage = ProjectStorage(tmp_path / "bundles")
    project, task = new_project_bundle_root_task("t", "description long enough here", thread_id="thread-row")
    storage.save_project(project)
    tid = resolve_thread_id_for_task(storage, str(task["id"]), thread_id_hint="")
    assert tid == "thread-row"


def test_ensure_fails_without_user_confirm(tmp_path) -> None:
    storage = ProjectStorage(tmp_path / "bundles")
    project, task = new_project_bundle_root_task("t", "description long enough here", thread_id="thread-b")
    task["status"] = "planned"
    storage.save_project(project)
    task_id = str(task["id"])

    ok, msg = ensure_task_execution_authorized_for_user(storage, task_id, thread_id="thread-b")
    assert ok is False
    assert "待授权" in msg
