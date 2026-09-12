"""resolve_main_task_id_for_thread for supervisor start_execution."""

from __future__ import annotations

from evoflow.collab.storage import ProjectStorage, new_project_bundle_root_task
from evoflow.collab.supervisor_plan_gate import resolve_main_task_id_for_thread
from evoflow.collab.thread_collab import merge_thread_collab_state, save_thread_collab_state
from evoflow.config.paths import Paths


def test_resolve_from_disk_bound_task_id(tmp_path) -> None:
    paths = Paths(base_dir=str(tmp_path / "home"))
    storage = ProjectStorage(tmp_path / "bundles")
    project, task = new_project_bundle_root_task("t", "description long enough here", thread_id="thread-a")
    storage.save_project(project)
    tid = str(task["id"])
    save_thread_collab_state(
        paths,
        "thread-a",
        merge_thread_collab_state(None, {"bound_task_id": tid, "collab_phase": "plan_ready"}),
    )
    assert resolve_main_task_id_for_thread("thread-a") == tid


def test_resolve_from_latest_task_on_thread_when_no_bound(tmp_path) -> None:
    storage = ProjectStorage(tmp_path / "bundles")
    project, task = new_project_bundle_root_task("t", "description long enough here", thread_id="thread-b")
    task["status"] = "planned"
    storage.save_project(project)
    tid = str(task["id"])
    assert resolve_main_task_id_for_thread("thread-b") == tid


def test_explicit_task_id_wins(tmp_path) -> None:
    storage = ProjectStorage(tmp_path / "bundles")
    project, task = new_project_bundle_root_task("t", "description long enough here", thread_id="thread-c")
    storage.save_project(project)
    str(task["id"])
    assert resolve_main_task_id_for_thread("thread-c", explicit_task_id="other") == "other"
