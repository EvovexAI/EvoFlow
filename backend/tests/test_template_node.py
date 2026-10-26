"""Deterministic template node (executor=template) — F-1 first slice.

Covers: render grammar reuse (params / steps.summary), inline execution state
transitions + outputs, wave-loop partition (template executed inline, LLM
remainder delegated), and publish validation of executor fields.
"""

from __future__ import annotations

from typing import Any
from unittest.mock import AsyncMock

import pytest

from evoflow.collab.template_node import (
    execute_template_subtask,
    is_template_subtask,
    render_template,
)


# ── Fixtures ────────────────────────────────────────────────────────────


class _FakeStorage:
    def __init__(self, project: dict[str, Any]):
        self.project = project
        self.saves = 0

    def list_projects(self) -> list[dict[str, Any]]:
        return [{"id": str(self.project.get("id"))}]

    def load_project(self, pid: str, *, bypass_cache: bool = False) -> dict[str, Any] | None:
        return self.project if str(self.project.get("id")) == str(pid) else None

    def save_project(self, data: dict[str, Any]) -> bool:
        self.saves += 1
        self.project = data
        return True


def _completed_upstream() -> dict[str, Any]:
    return {
        "id": "up1",
        "ref": "1",
        "status": "completed",
        "result_summary": "上游结论文本",
        "outputs": [{"type": "text", "key": "text", "value": "上游结论文本"}],
    }


def _template_row() -> dict[str, Any]:
    return {
        "id": "tpl1",
        "ref": "2",
        "name": "渲染摘要",
        "status": "pending",
        "executor": "template",
        "template": "主题：{{params.topic}}\n上游：{{steps.1.summary}}",
        "created_at": "2026-10-25T10:00:00Z",
        "progress": 0,
    }


def _llm_row() -> dict[str, Any]:
    return {"id": "llm1", "ref": "3", "name": "LLM 步骤", "status": "pending", "created_at": "2026-10-25T10:00:00Z"}


def _main_task(subtasks: list[dict[str, Any]]) -> dict[str, Any]:
    return {
        "id": "main1",
        "name": "t",
        "status": "executing",
        "subtasks": subtasks,
        "run_parameters": {"topic": "竞品日报"},
    }


def _project(task: dict[str, Any]) -> dict[str, Any]:
    return {"id": "main1", "name": "p", "tasks": [task]}


@pytest.fixture(autouse=True)
def _silence_write_path(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(
        "evoflow.collab.app_run_events.emit_app_run_for_task_id",
        lambda *_a, **_k: None,
    )
    monkeypatch.setattr(
        "evoflow.collab.task_progress.sync_main_task_from_subtasks",
        lambda *_a, **_k: {"ok": True, "changed": False},
    )


# ── render ──────────────────────────────────────────────────────────────


def test_render_mixed_text_params_and_upstream_summary():
    rendered, unresolved = render_template(
        "主题：{{params.topic}}；上游：{{steps.1.summary}}",
        params={"topic": "AI"},
        subtasks=[_completed_upstream()],
    )
    assert rendered == "主题：AI；上游：上游结论文本"
    assert unresolved == []


def test_render_single_expression_structured_value_becomes_text():
    rendered, _ = render_template("{{steps.1.output}}", params={}, subtasks=[
        {**_completed_upstream(), "structured_output": {"title": "T"}}
    ])
    assert "T" in rendered  # dict serialized to readable text


def test_render_unresolved_kept_verbatim_and_reported():
    rendered, unresolved = render_template(
        "缺参：{{params.missing}} / 缺上游：{{steps.9.summary}}",
        params={},
        subtasks=[_completed_upstream()],
    )
    assert "{{params.missing}}" in rendered
    assert "{{steps.9.summary}}" in rendered
    assert len(unresolved) == 2


def test_is_template_subtask_guard():
    assert is_template_subtask(_template_row()) is True
    assert is_template_subtask(_llm_row()) is False
    assert is_template_subtask({"executor": "template"}) is False  # no template text
    assert is_template_subtask(None) is False


# ── inline execution ────────────────────────────────────────────────────


def test_execute_template_subtask_completes_with_outputs():
    storage = _FakeStorage(_project(_main_task([_completed_upstream(), _template_row()])))
    out = execute_template_subtask(storage, "main1", _template_row(), params={"topic": "竞品日报"})
    assert out["ok"] is True
    row = next(st for st in storage.project["tasks"][0]["subtasks"] if st["id"] == "tpl1")
    assert row["status"] == "completed"
    assert row["progress"] == 100
    assert "竞品日报" in row["task_report"]
    assert "上游结论文本" in row["task_report"]
    assert row["outputs"] and row["outputs"][0]["type"] == "text"
    assert row.get("completed_at")
    assert storage.saves >= 1


def test_execute_template_subtask_failure_marks_business_error():
    bad = {**_template_row(), "template": "   "}  # renders empty -> failure
    storage = _FakeStorage(_project(_main_task([bad])))
    out = execute_template_subtask(storage, "main1", bad, params={})
    assert out["ok"] is False
    row = storage.project["tasks"][0]["subtasks"][0]
    assert row["status"] == "failed"
    assert row["error_kind"] == "business"
    assert "empty" in row["error"]


def test_execute_template_subtask_skips_already_completed():
    done = {**_template_row(), "status": "completed"}
    storage = _FakeStorage(_project(_main_task([done])))
    out = execute_template_subtask(storage, "main1", done, params={})
    assert out["ok"] is True and out.get("skipped") == "already_completed"
    assert storage.saves == 0


# ── wave loop partition ─────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_advance_runnable_wave_executes_template_and_delegates_llm(monkeypatch: pytest.MonkeyPatch):
    from evoflow.collab import step_runner

    tpl, llm = _template_row(), _llm_row()
    storage = _FakeStorage(_project(_main_task([_completed_upstream(), tpl, llm])))

    monkeypatch.setattr(
        "evoflow.collab.storage.find_main_task",
        lambda _s, tid, bypass_cache=False: (storage.project, storage.project["tasks"][0]),
    )
    # round 1: template runnable; round 2: llm runnable (template done unblocked it)
    def _resolver(storage_arg, tid, runtime=None):
        seq = getattr(_resolver, "seq", None) or [["tpl1"], ["llm1"]]
        _resolver.seq = seq[1:]
        return (seq[0], [])

    monkeypatch.setattr(
        "evoflow.collab.execution_kernel.resolve_runnable_subtasks",
        _resolver,
    )
    delegated_mock = AsyncMock(return_value=[{"subtaskId": "llm1", "ok": True, "detached": False}])
    monkeypatch.setattr(step_runner, "run_steps", delegated_mock)

    out = await step_runner.advance_runnable_wave(None, storage, "main1")

    row = next(st for st in storage.project["tasks"][0]["subtasks"] if st["id"] == "tpl1")
    assert row["status"] == "completed"
    assert "竞品日报" in row["task_report"]
    delegated_mock.assert_awaited_once()
    # run_steps(runtime, storage, main_task_id, subtask_ids) — only LLM ids delegated
    assert delegated_mock.await_args.args[2] == "main1"
    assert delegated_mock.await_args.args[3] == ["llm1"]
    assert out == [{"subtaskId": "llm1", "ok": True, "detached": False}]


@pytest.mark.asyncio
async def test_advance_runnable_wave_template_chain_without_llm(monkeypatch: pytest.MonkeyPatch):
    from evoflow.collab import step_runner

    tpl = _template_row()
    storage = _FakeStorage(_project(_main_task([_completed_upstream(), tpl])))

    monkeypatch.setattr(
        "evoflow.collab.storage.find_main_task",
        lambda _s, tid, bypass_cache=False: (storage.project, storage.project["tasks"][0]),
    )
    def _resolver(storage_arg, tid, runtime=None):
        seq = getattr(_resolver, "seq", None) or [["tpl1"], []]
        _resolver.seq = seq[1:]
        return (seq[0], [])

    monkeypatch.setattr(
        "evoflow.collab.execution_kernel.resolve_runnable_subtasks",
        _resolver,
    )
    delegated_mock = AsyncMock(return_value=[])
    monkeypatch.setattr(step_runner, "run_steps", delegated_mock)

    out = await step_runner.advance_runnable_wave(None, storage, "main1")

    row = storage.project["tasks"][0]["subtasks"][1]
    assert row["status"] == "completed"
    delegated_mock.assert_not_awaited()
    assert out == []


# ── publish validation ──────────────────────────────────────────────────


def test_validator_accepts_template_node_with_template():
    from evoflow.collab.workflow_validator import validate_app_definition

    app_def = {
        "parameters": [],
        "steps": [
            {"ref": "1", "name": "渲染", "executor": "template", "template": "Hello {{params.topic}}"}
        ],
    }
    result = validate_app_definition(app_def)
    assert result["valid"] is True


def test_validator_rejects_template_without_template_and_unknown_executor():
    from evoflow.collab.workflow_validator import validate_app_definition

    result = validate_app_definition(
        {
            "parameters": [],
            "steps": [
                {"ref": "1", "name": "坏节点", "executor": "template"},  # missing template
                {"ref": "2", "name": "未知执行器", "executor": "bash"},  # unsupported
            ],
        }
    )
    assert result["valid"] is False
    executor_errors = [e for e in result["errors"] if "executor" in e or "template" in e]
    assert any("non-empty template" in e for e in executor_errors)
    assert any("not supported" in e for e in executor_errors)
