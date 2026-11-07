"""``workflow.run_status`` must not ship the same long text three times.

Regression for the 2026-11-07 run: one 4-node run cost ~8.9k tokens because the
payload carried ``run.steps`` + a hoisted ``steps`` + a ``trail`` copy, so every
step's ``description`` / ``result_summary`` appeared twice in full.
"""

from __future__ import annotations

import json

import pytest

from evoflow.admin import platform_handlers as H
from evoflow.admin import apps as apps_admin
from evoflow.admin.errors import ValidationError


def _step(ref: str, summary: str) -> dict:
    return {
        "ref": ref,
        "name": f"Step {ref}",
        "status": "completed",
        "assigned_agent": "agent",
        "progress": 100,
        "description": "任务全文" * 60,
        "result_summary": summary,
        "error_text": "",
        "outputs": [{"type": "file", "key": "f", "value": "/tmp/f.md"}],
        "evidence_paths": ["/tmp/f.md"],
    }


def _fake_run(steps: list[dict]) -> dict:
    return {
        "run": {
            "run_id": "Run_x",
            "app_id": "App_x",
            "status": "completed",
            "progress": 100,
            "task_id": "T1",
            "result_summary": "末段结论" * 50,
            "subtask_status": {"1": "completed"},
            "parameters": {"a": "1"},
            "steps": steps,
            # the two heavy blocks the platform tool never needs to re-read
            "plan": {"goal": "很大的计划体" * 100, "steps": steps},
            "subtasks_sync": {"created": [{"description": "下发全文" * 100}]},
        }
    }


@pytest.fixture
def steps():
    return [_step(str(i), f"结论{i}" * 120) for i in range(1, 5)]


@pytest.fixture
def patched(monkeypatch, steps):
    monkeypatch.setattr(apps_admin, "get_run", lambda run_id: _fake_run(steps))
    return steps


def test_run_no_longer_embeds_steps_plan_or_subtasks(patched):
    out = H.workflow_run_status({"runId": "Run_x"})

    run = out["run"]
    assert "steps" not in run
    assert "plan" not in run
    assert "subtasks_sync" not in run
    # non-duplicated detail still reachable
    assert run["parameters"] == {"a": "1"}
    # one authoritative full-detail copy at the top level
    assert out["steps"] == patched
    assert out["status"] == "completed"
    assert out["progress"] == 100
    assert out["subtask_status"] == {"1": "completed"}
    assert out["result_summary"] == "末段结论" * 50
    assert out["task_id"] == "T1"


def test_trail_is_a_compact_index_over_steps(patched):
    out = H.workflow_run_status({"runId": "Run_x"})

    # evoflow-system-verification audits trail: step count / name / status /
    # assigned_agent must stay, plus a glanceable summary head.
    for t, st in zip(out["trail"], patched):
        assert set(t) <= {"ref", "name", "status", "assigned_agent", "progress", "result_summary", "error_text"}
        assert {"ref", "name", "status", "assigned_agent", "progress"} <= set(t)
        assert t["status"] == st["status"]
        assert len(str(t["result_summary"])) <= 200
        # full text lives exactly once — in steps
        assert "description" not in t

    assert all(len(st["description"]) > 200 for st in out["steps"])


def test_error_text_surfaces_in_trail_only_when_present(monkeypatch):
    steps = [_step("1", "结论")]
    steps[0]["error_text"] = "工具失败：Guardrail denied"
    monkeypatch.setattr(apps_admin, "get_run", lambda run_id: _fake_run(steps))
    out = H.workflow_run_status({"runId": "Run_x"})
    assert out["trail"][0]["error_text"] == "工具失败：Guardrail denied"


def test_payload_smaller_than_duplicated_shape(patched):
    slim = len(json.dumps(H.workflow_run_status({"runId": "Run_x"}), ensure_ascii=False).encode("utf-8"))
    naive = len(json.dumps({"ok": True, **_fake_run(patched)}, ensure_ascii=False).encode("utf-8"))
    assert slim < naive * 0.75, f"expected real savings, got slim={slim} naive={naive}"


def test_run_id_required():
    with pytest.raises(ValidationError, match="runId"):
        H.workflow_run_status({})
