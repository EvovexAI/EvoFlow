"""Subtask terminal outcome must go through subtask_outcome_report (or system fallback)."""

from __future__ import annotations

import asyncio

import pytest

from evoflow.collab.storage import find_subtask_by_ids, get_project_storage, new_project_bundle_root_task
from evoflow.collab.subtask_outcome import (
    apply_subtask_outcome_report,
    apply_subtask_system_outcome,
    build_subtask_outcome_snapshot,
    format_subtask_outcome_mandate_block,
    get_subtask_task_report,
    is_subtask_outcome_reported,
)
from evoflow.tools.builtins.task_tool import _finalize_collab_subtask_terminal


class _FakeSubagentResult:
    def __init__(self, *, result: str | None = None, error: str | None = None) -> None:
        self.result = result
        self.error = error


@pytest.fixture
def collab_subtask(tmp_path, monkeypatch):
    monkeypatch.setenv("EVOFLOW_DATA_DIR", str(tmp_path))
    storage = get_project_storage()
    project, task = new_project_bundle_root_task("main", "x" * 30, thread_id="t_outcome")
    task_id = str(task["id"])
    subtask_id = "Subtask_outcome_01"
    task["subtasks"] = [
        {
            "id": subtask_id,
            "name": "build",
            "description": "Do work",
            "status": "in_progress",
            "assigned_to": "general-purpose",
        }
    ]
    storage.save_project(project)
    return storage, task_id, subtask_id


def test_get_subtask_task_report_ignores_memory_and_unreported_row(collab_subtask) -> None:
    storage, task_id, subtask_id = collab_subtask
    row = find_subtask_by_ids(storage, task_id, subtask_id)
    assert row is not None
    row["output_summary"] = "memory draft must not leak"
    row["result"] = "orphan result without outcome"
    assert get_subtask_task_report(row) == ""

    async def _run() -> None:
        await apply_subtask_outcome_report(
            main_task_id=task_id,
            subtask_id=subtask_id,
            outcome="completed",
            summary="Official summary from tool.",
            storage=storage,
        )

    asyncio.run(_run())
    row2 = find_subtask_by_ids(storage, task_id, subtask_id)
    assert row2 is not None
    assert get_subtask_task_report(row2) == "Official summary from tool."
    snap = build_subtask_outcome_snapshot(row2)
    assert snap["reported"] is True
    assert snap["summary"] == "Official summary from tool."


def test_outcome_record_persists_run_id(tmp_path, monkeypatch) -> None:
    from evoflow.collab.conversation_persist import list_subtask_conversation_ui_messages
    from evoflow.collab.thread_ids import collab_subtask_executor_thread_id
    from evoflow.persistence import chat_message_repositories as msg_repo
    from evoflow.persistence import session_repositories as sess_repo
    from evoflow.persistence.db import reset_db_for_tests
    from evoflow.scheduler.subagent_stream import subagent_stream_task_id_ctx

    monkeypatch.setenv("EVOFLOW_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("EVOFLOW_HOME", str(tmp_path))
    reset_db_for_tests()
    storage = get_project_storage()
    project, task = new_project_bundle_root_task("main", "x" * 30, thread_id="t_outcome_run")
    task_id = str(task["id"])
    subtask_id = "Subtask_outcome_run_01"
    task["subtasks"] = [
        {
            "id": subtask_id,
            "name": "build",
            "description": "Do work",
            "status": "in_progress",
            "assigned_to": "general-purpose",
        }
    ]
    storage.save_project(project)
    lead = str(task.get("thread_id") or "").strip()
    sess_repo.upsert_session_row(
        "agent:main:outcome-run",
        thread_id=lead,
        created_at_ms=1,
        updated_at_ms=1,
        message_count=0,
        context={},
        title="collab",
    )
    bg_run = "bg-subagent-task-xyz"

    async def _run() -> None:
        with subagent_stream_task_id_ctx(bg_run):
            res = await apply_subtask_outcome_report(
                main_task_id=task_id,
                subtask_id=subtask_id,
                outcome="completed",
                summary="Done with run id.",
                storage=storage,
                tool_call_id="call_outcome_tool_1",
            )
        assert res.get("ok") is True

    asyncio.run(_run())
    executor = collab_subtask_executor_thread_id(lead, subtask_id)
    rows = msg_repo.list_messages_for_thread_id(executor, limit=20)
    outcome_rows = [
        r
        for r in rows
        if str(r.get("tool_name") or r.get("name") or "") == "subtask_outcome_report"
    ]
    assert len(outcome_rows) == 1
    assert outcome_rows[0].get("run_id") == bg_run
    task = storage.load_project(project["id"])["tasks"][0]
    ui = list_subtask_conversation_ui_messages(task, subtask_id)
    out_ui = [m for m in ui if str(m.get("tool_name") or m.get("name") or "") == "subtask_outcome_report"]
    assert out_ui and out_ui[0].get("run_id") == bg_run


def test_worker_outcome_report_marks_terminal(collab_subtask) -> None:
    storage, task_id, subtask_id = collab_subtask

    async def _run() -> None:
        res = await apply_subtask_outcome_report(
            main_task_id=task_id,
            subtask_id=subtask_id,
            outcome="completed",
            summary="Built outputs/foo.py and ran tests.",
            evidence_paths=["outputs/foo.py"],
            storage=storage,
        )
        assert res.get("ok") is True
        row = find_subtask_by_ids(storage, task_id, subtask_id)
        assert row is not None
        assert row.get("status") == "completed"
        assert is_subtask_outcome_reported(row)
        assert "outputs/foo.py" in str(row.get("task_report") or "")
        assert str(row.get("task_report") or "") == str(row.get("result") or "")
        outs = row.get("outputs") or []
        assert any(str(o.get("value") or "") == "outputs/foo.py" for o in outs if isinstance(o, dict))

    asyncio.run(_run())


def test_system_outcome_skips_when_worker_reported(collab_subtask) -> None:
    storage, task_id, subtask_id = collab_subtask

    async def _run() -> None:
        await apply_subtask_outcome_report(
            main_task_id=task_id,
            subtask_id=subtask_id,
            outcome="failed",
            summary="Could not finish",
            error="missing dependency",
            storage=storage,
        )
        skipped = await apply_subtask_system_outcome(
            main_task_id=task_id,
            subtask_id=subtask_id,
            outcome="completed",
            summary="should not apply",
            storage=storage,
        )
        assert skipped is False
        row = find_subtask_by_ids(storage, task_id, subtask_id)
        assert row is not None
        assert row.get("status") == "failed"

    asyncio.run(_run())


def test_finalize_without_report_marks_failed(collab_subtask) -> None:
    storage, task_id, subtask_id = collab_subtask

    async def _run() -> None:
        result = _FakeSubagentResult(result="I said done in chat only")
        kind, msg = await _finalize_collab_subtask_terminal(
            executor_outcome="completed",
            result=result,
            resolved_collab=task_id,
            resolved_subtask=subtask_id,
            stream_task_id="tc_1",
            writer=None,
            ws=lambda ev: ev,
        )
        assert kind == "failed"
        assert "subtask_outcome_report" in msg
        row = find_subtask_by_ids(storage, task_id, subtask_id)
        assert row is not None
        assert row.get("status") == "failed"
        assert is_subtask_outcome_reported(row)

    asyncio.run(_run())


def test_finalize_respects_worker_report(collab_subtask) -> None:
    storage, task_id, subtask_id = collab_subtask

    async def _run() -> None:
        await apply_subtask_outcome_report(
            main_task_id=task_id,
            subtask_id=subtask_id,
            outcome="completed",
            summary="Verified on disk",
            storage=storage,
        )
        result = _FakeSubagentResult(result="executor noise")
        kind, msg = await _finalize_collab_subtask_terminal(
            executor_outcome="completed",
            result=result,
            resolved_collab=task_id,
            resolved_subtask=subtask_id,
            stream_task_id="tc_2",
            writer=None,
            ws=lambda ev: ev,
        )
        assert kind == "completed"
        assert "subtask_outcome_report" in msg
        row = find_subtask_by_ids(storage, task_id, subtask_id)
        assert row is not None
        assert row.get("status") == "completed"

    asyncio.run(_run())


def test_mandate_block_mentions_tool() -> None:
    block = format_subtask_outcome_mandate_block()
    assert "subtask_outcome_report" in block
    assert "结束不等于子任务完成" in block
