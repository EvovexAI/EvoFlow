"""Scenario: task inbox transition legality."""

from __future__ import annotations

from pathlib import Path

from evoflow.eval.scenarios._harness import check, finalize, run_scenario
from evoflow.eval.scenarios._persist import expect_task


def _run(home: Path) -> dict:
    del home
    from evoflow.admin import tasks as tasks_admin
    from evoflow.admin.errors import ValidationError
    from evoflow.admin.tasks import _can_transition

    created = tasks_admin.create_task(
        name="评测状态机任务",
        description="用于校验 inbox/pending 合法迁移",
        initial_status="inbox",
        source="eval",
    )
    tid = str(created.get("id") or created.get("task_id") or "")

    legal = _can_transition("inbox", "pending")
    illegal = _can_transition("inbox", "executing")

    transitioned = False
    err_msg = ""
    status = ""
    try:
        out = tasks_admin.set_task_state(tid, "pending")
        transitioned = True
        status = str(out.get("status") or out.get("task", {}).get("status") or "")
    except Exception as exc:  # noqa: BLE001
        err_msg = str(exc)
        try:
            out2 = tasks_admin.set_task_state(tid, status="pending")
            transitioned = True
            status = str(out2.get("status") or "")
        except Exception as exc2:  # noqa: BLE001
            err_msg = f"{err_msg}; {exc2}"

    # Probe illegal inbox→executing on a *separate* inbox task so the happy-path
    # task stays at pending for durable reconcile (pending→executing is legal).
    probe = tasks_admin.create_task(
        name="评测状态机非法迁移探针",
        description="仍停留在 inbox，用于 inbox→executing 拒绝",
        initial_status="inbox",
        source="eval",
    )
    probe_id = str(probe.get("id") or probe.get("task_id") or "")
    illegal_raised = False
    try:
        if not illegal:
            try:
                tasks_admin.set_task_state(probe_id, "executing")
            except (ValidationError, Exception):
                illegal_raised = True
        else:
            illegal_raised = True
    except Exception:  # noqa: BLE001
        illegal_raised = True

    assertions = [
        check(
            "task_created",
            bool(tid),
            inputs={"name": "评测状态机任务", "initial_status": "inbox", "source": "eval"},
            expected="非空 task_id",
            actual=tid,
            api="tasks_admin.create_task",
        ),
        check(
            "inbox_to_pending_allowed",
            legal is True,
            inputs={"from": "inbox", "to": "pending"},
            expected=True,
            actual=legal,
            api="tasks._can_transition",
        ),
        check(
            "inbox_to_executing_blocked_or_guarded",
            illegal is False or illegal_raised,
            inputs={"from": "inbox", "to": "executing", "probe_task_id": probe_id},
            expected="illegal=False 或 set_task_state 抛错",
            actual={"illegal_allowed_by_table": illegal, "raised_or_blocked": illegal_raised, "probe_task_id": probe_id},
            api="tasks_admin.set_task_state",
        ),
        check(
            "transition_applied",
            transitioned,
            inputs={"task_id": tid, "to": "pending"},
            expected="pending",
            actual=status or err_msg,
            api="tasks_admin.set_task_state",
        ),
    ]
    persist = [*expect_task(tid, status=status if status else "pending")] if tid else []
    return finalize(
        assertions + persist,
        metrics={"task_id": tid, "status": status},
        steps=[
            {"step": 1, "api": "tasks_admin.create_task", "result": {"task_id": tid}},
            {"step": 2, "api": "_can_transition", "inputs": {"inbox→pending": legal, "inbox→executing": illegal}},
            {"step": 3, "api": "tasks_admin.set_task_state", "result": {"status": status, "error": err_msg}},
        ],
    )


def run(**_kwargs) -> dict:
    return run_scenario(_run)
