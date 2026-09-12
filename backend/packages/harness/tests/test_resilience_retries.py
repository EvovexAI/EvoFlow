"""Retry / resilience: LLM stream, media CLI, subtask auto-requeue."""

from __future__ import annotations

import asyncio
from pathlib import Path

import pytest

from evoflow.collab.plan_subtasks_sync import sync_subtasks_from_plan_steps
from evoflow.collab.storage import ProjectStorage, find_main_task, new_project_bundle_root_task
from evoflow.models.vendor_roundtrip import (
    _is_retriable_stream_error,
    _stream_retry_attempts,
)
from evoflow.tools.builtins.supervisor.dependency import (
    skip_subtasks_blocked_by_exhausted_upstream_failure,
    subtask_auto_retry_max,
)
from evoflow.tools.builtins.supervisor.monitor import _collect_auto_retriable_subtasks_to_requeue


@pytest.fixture
def plan_chain_storage(tmp_path, monkeypatch):
    monkeypatch.setenv("EVOFLOW_DATA_DIR", str(tmp_path))
    storage = ProjectStorage(Path(tmp_path))
    project, task = new_project_bundle_root_task("retry-smoke", "description long enough", thread_id="t_retry")
    task_id = str(task["id"])
    storage.save_project(project)
    return storage, task_id


def test_stream_retry_helpers():
    assert _stream_retry_attempts() >= 1
    assert _is_retriable_stream_error(TimeoutError())
    assert _is_retriable_stream_error(asyncio.TimeoutError())
    assert _is_retriable_stream_error(RuntimeError("HTTP 429 rate limit"))
    assert not _is_retriable_stream_error(ValueError("bad prompt"))


def test_media_cli_retry(monkeypatch):
    import importlib.util
    import sys

    script_dir = Path(__file__).resolve().parents[4] / "skills" / "public" / "media-production" / "scripts"
    sys.path.insert(0, str(script_dir))
    spec = importlib.util.spec_from_file_location("media_cli_test", script_dir / "_media_cli.py")
    assert spec and spec.loader
    mod = importlib.util.module_from_spec(spec)
    sys.modules["media_cli_test"] = mod
    spec.loader.exec_module(mod)

    calls = {"n": 0}

    def flaky():
        calls["n"] += 1
        if calls["n"] < 2:
            raise RuntimeError("HTTP 503 temporarily unavailable")
        return "ok"

    assert mod._call_with_media_retry(flaky, label="test") == "ok"
    assert calls["n"] == 2


def test_auto_requeue_failed_subtask_when_deps_met(plan_chain_storage):
    storage, task_id = plan_chain_storage
    steps = [
        {"ref": 1, "name": "a", "assigned_agent": "general-purpose"},
        {"ref": 2, "name": "b", "assigned_agent": "general-purpose", "depends_on": ["1"]},
    ]
    sync_subtasks_from_plan_steps(task_id, steps, storage=storage)
    row = find_main_task(storage, task_id)
    assert row is not None
    _proj, task = row
    subs = sorted(task["subtasks"], key=lambda s: int(str(s.get("ref") or "0")))
    subs[0]["status"] = "completed"
    subs[1]["status"] = "failed"
    subs[1]["auto_retry_count"] = 0
    storage.save_project(_proj)

    row2 = find_main_task(storage, task_id)
    assert row2 is not None
    _p2, t2, retried = _collect_auto_retriable_subtasks_to_requeue(
        row2,
        max_retries_per_subtask=3,
        retry_reason="test",
    )
    assert retried == [str(subs[1]["id"])]
    assert subs[1]["status"] == "pending"
    assert subs[1]["auto_retry_count"] == 1


def test_skip_downstream_when_upstream_retries_exhausted(plan_chain_storage, monkeypatch):
    monkeypatch.setenv("EVOFLOW_SUBTASK_AUTO_RETRY_MAX", "2")
    assert subtask_auto_retry_max() == 2
    storage, task_id = plan_chain_storage
    steps = [
        {"ref": 1, "name": "a", "assigned_agent": "general-purpose"},
        {"ref": 2, "name": "b", "assigned_agent": "general-purpose", "depends_on": ["1"]},
        {"ref": 3, "name": "c", "assigned_agent": "general-purpose", "depends_on": ["2"]},
    ]
    sync_subtasks_from_plan_steps(task_id, steps, storage=storage)
    row = find_main_task(storage, task_id)
    assert row is not None
    _proj, task = row
    subs = sorted(task["subtasks"], key=lambda s: int(str(s.get("ref") or "0")))
    subs[0]["status"] = "completed"
    subs[1]["status"] = "failed"
    subs[1]["auto_retry_count"] = 2
    subs[2]["status"] = "planned"
    storage.save_project(_proj)

    result = skip_subtasks_blocked_by_exhausted_upstream_failure(storage, task_id, max_auto_retries=2)
    assert result["changed"] is True
    assert subs[2]["status"] == "skipped"
