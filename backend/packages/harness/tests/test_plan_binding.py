"""Tests for plan persistence on bound main task."""

from __future__ import annotations

from evoflow.agents.mission_state.plan_binding import attach_bound_plan_from_thread_task


def test_attach_bound_plan_from_thread_task(monkeypatch) -> None:
    plan_snap = {
        "goal": "x",
        "steps": [
            {
                "ref": 1,
                "name": "s1",
                "goal": "do x",
                "inputs": "i",
                "outputs": "o",
                "acceptance": "a",
                "failure": "f",
                "assigned_agent": "general-purpose",
            }
        ],
        "flowchart_mermaid": "",
        "validation": [],
        "open_questions": "无",
        "step_count": 1,
    }
    monkeypatch.setattr(
        "evoflow.collab.plan_on_task.load_bound_main_task_plan",
        lambda tid, disk_bound="": (plan_snap, 4242, {"id": "Task_root"}) if tid == "t-bind" else (None, 0, None),
    )

    task: dict = {"id": "Task_new"}
    meta = attach_bound_plan_from_thread_task(task, "t-bind")
    assert meta.get("attached") is True
    assert task["plan_goal"] == "x"
    assert meta.get("plan_bound_ts_ms") == 4242


def test_attach_skips_when_no_thread_id() -> None:
    task: dict = {"id": "Task_root"}
    meta = attach_bound_plan_from_thread_task(task, None)
    assert meta.get("attached") is False
    assert "plan_goal" not in task
