"""Task observability aggregation tests."""

from __future__ import annotations

import gc
import json
import tempfile
import uuid
from pathlib import Path

import pytest

from evoflow.collab.storage import get_project_storage, new_project_bundle_root_task
from evoflow.collab.task_observability import collect_task_thread_ids, summarize_task_observability
from evoflow.observability.queries import fetch_task_observability_metrics
from evoflow.observability.recorder import get_observability_recorder, reset_observability_store_for_tests
from evoflow.persistence.db import reset_db_for_tests

_EVOFLOW_ROOT = Path(__file__).resolve().parents[4]


@pytest.fixture
def sqlite_tmp(monkeypatch: pytest.MonkeyPatch):
    with tempfile.TemporaryDirectory() as tmp:
        monkeypatch.setenv("EVOFLOW_HOME", tmp)
        reset_db_for_tests()
        yield tmp
        reset_db_for_tests()
        gc.collect()


@pytest.fixture
def obs_tmp(sqlite_tmp: str, monkeypatch: pytest.MonkeyPatch):
    del sqlite_tmp
    monkeypatch.setenv("EVOFLOW_CONFIG_PATH", str(_EVOFLOW_ROOT / "config.yaml"))
    from evoflow.config.app_config import get_app_config, reset_app_config, set_app_config

    with tempfile.TemporaryDirectory() as tmp:
        obs_path = f"{tmp}/obs.db"
        reset_app_config()
        reset_observability_store_for_tests()
        base = get_app_config()
        custom = base.model_copy(deep=True)
        custom.observability = custom.observability.model_copy(
            update={"enabled": True, "sqlite_path": obs_path}
        )
        set_app_config(custom)
        yield obs_path
        reset_observability_store_for_tests()
        reset_app_config()
        gc.collect()


def test_collect_task_thread_ids_includes_lead_and_subtasks() -> None:
    lead = str(uuid.uuid4())
    task = {
        "thread_id": lead,
        "subtasks": [
            {"id": "Sub_1", "subtask_thread_id": f"{lead}__sub__Sub_1"},
            {"id": "Sub_2"},
        ],
        "execution_history": [{"thread_id": "00000000-0000-4000-8000-000000000099"}],
    }
    ids = collect_task_thread_ids(task)
    assert lead in ids
    assert f"{lead}__sub__Sub_1" in ids
    assert f"{lead}__sub__Sub_2" in ids
    assert "00000000-0000-4000-8000-000000000099" in ids


def test_fetch_task_observability_metrics_aggregates(obs_tmp: str) -> None:
    del obs_tmp
    lead = str(uuid.uuid4())
    rec = get_observability_recorder()
    rec.record_model_request_payload(
        thread_id=lead,
        run_id="run-1",
        model_call_seq=1,
        provider="openai",
        model="gpt-test",
        stage="chat",
        trace_id=None,
        requested_at="2026-06-12T10:00:00Z",
        latency_ms=120.0,
        usage_json=json.dumps({"input_tokens": 100, "output_tokens": 50, "total_tokens": 150}),
    )
    rec.record_tool_invocation(
        thread_id=lead,
        run_id="run-1",
        tool_call_id="tc1",
        tool_name="read_file",
        started_at="2026-06-12T10:00:01Z",
        ended_at="2026-06-12T10:00:02Z",
        duration_ms=500.0,
        status="ok",
        input_obj={},
        output_text="done",
    )
    rec.record_tool_invocation(
        thread_id=lead,
        run_id="run-1",
        tool_call_id="tc2",
        tool_name="grep",
        started_at="2026-06-12T10:00:03Z",
        ended_at="2026-06-12T10:00:04Z",
        duration_ms=200.0,
        status="error",
        input_obj={},
        output_text="",
        error_type="ToolError",
        error_message="fail",
    )
    rec.record_task_lifecycle(
        thread_id=lead,
        occurred_at="2026-06-12T10:00:00Z",
        schema_version="v1",
        event="dispatch",
        main_task_id="Task_main_1",
        status="executing",
    )

    metrics = fetch_task_observability_metrics([lead], main_task_id="Task_main_1")
    assert metrics["enabled"] is True
    assert metrics["model_invocations"] == 1
    assert metrics["tool_invocations"] == 2
    assert metrics["tool_errors"] == 1
    assert metrics["tokens"]["total"] == 150
    assert metrics["models_used"][0]["model"] == "gpt-test"
    assert metrics["lifecycle_events"] == 1


def test_summarize_includes_per_subtask_breakdown(obs_tmp: str) -> None:
    del obs_tmp
    lead = str(uuid.uuid4())
    sub_thread = f"{lead}__sub__Sub_1"
    task = {
        "thread_id": lead,
        "subtasks": [{"id": "Sub_1", "name": "Step one"}],
    }
    rec = get_observability_recorder()
    rec.record_model_request_payload(
        thread_id=lead,
        run_id="r-lead",
        model_call_seq=1,
        provider="openai",
        model="lead-model",
        stage="chat",
        trace_id=None,
        requested_at="2026-06-12T10:00:00Z",
        latency_ms=50.0,
        usage_json=json.dumps({"input_tokens": 100, "output_tokens": 20, "total_tokens": 120}),
    )
    rec.record_model_request_payload(
        thread_id=sub_thread,
        run_id="r-sub",
        model_call_seq=1,
        provider="openai",
        model="worker-model",
        stage="chat",
        trace_id=None,
        requested_at="2026-06-12T10:01:00Z",
        latency_ms=80.0,
        usage_json=json.dumps({"input_tokens": 200, "output_tokens": 80, "total_tokens": 280}),
    )
    rec.record_tool_invocation(
        thread_id=sub_thread,
        run_id="r-sub",
        tool_call_id="t1",
        tool_name="read_file",
        started_at="2026-06-12T10:01:01Z",
        ended_at="2026-06-12T10:01:02Z",
        duration_ms=100.0,
        status="ok",
        input_obj={},
        output_text="ok",
    )

    out = summarize_task_observability("Task_main", task)
    assert out["model_invocations"] == 2
    assert out["tokens"]["total"] == 400
    assert len(out["subtasks"]) == 1
    sub = out["subtasks"][0]
    assert sub["subtask_id"] == "Sub_1"
    assert sub["model_invocations"] == 1
    assert sub["tool_invocations"] == 1
    assert sub["tokens"]["input"] == 200
    assert sub["tokens"]["output"] == 80
    assert sub["primary_model"] == "worker-model"
    assert out["lead"]["model_invocations"] == 1
    assert out["lead"]["tokens"]["total"] == 120


def test_summarize_includes_task_and_subtask_duration() -> None:
    task = {
        "status": "completed",
        "execution_started_at": "2026-06-12T10:00:00Z",
        "completed_at": "2026-06-12T10:30:00Z",
        "execution_duration_seconds": 1800,
        "subtasks": [
            {
                "id": "Sub_1",
                "status": "completed",
                "started_at": "2026-06-12T10:05:00Z",
                "completed_at": "2026-06-12T10:07:30Z",
            },
            {
                "id": "Sub_2",
                "status": "executing",
                "started_at": "2026-06-12T10:08:00Z",
            },
        ],
    }
    out = summarize_task_observability("Task_main", task)
    assert out["duration_ms"] == 1_800_000
    assert out["duration_running"] is False
    assert len(out["subtasks"]) == 2
    assert out["subtasks"][0]["duration_ms"] == 150_000
    assert out["subtasks"][0]["duration_running"] is False
    assert out["subtasks"][1]["duration_ms"] is not None
    assert out["subtasks"][1]["duration_running"] is True


def test_summarize_task_observability_end_to_end(sqlite_tmp: str, obs_tmp: str) -> None:
    del sqlite_tmp, obs_tmp
    storage = get_project_storage()
    lead = str(uuid.uuid4())
    project, task = new_project_bundle_root_task("Obs task", "desc")
    task_id = str(task["id"])
    project["id"] = task_id
    task["thread_id"] = lead
    project["tasks"] = [task]
    assert storage.save_project(project)

    rec = get_observability_recorder()
    rec.record_model_request_payload(
        thread_id=lead,
        run_id="run-2",
        model_call_seq=1,
        provider="anthropic",
        model="claude-test",
        stage="chat",
        trace_id=None,
        requested_at="2026-06-12T11:00:00Z",
        latency_ms=80.0,
        usage_json=json.dumps({"input_tokens": 10, "output_tokens": 5, "total_tokens": 15}),
    )

    out = summarize_task_observability(task_id, task)
    assert out["success"] is True
    assert out["task_id"] == task_id
    assert lead in out["thread_ids"]
    assert out["model_invocations"] == 1
    assert out["tokens"]["total"] == 15
    assert out["primary_model"] == "claude-test"
