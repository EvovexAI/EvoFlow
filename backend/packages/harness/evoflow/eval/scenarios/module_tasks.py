"""Module scenario: 任务中心 — create/list + pending→executing→completed."""

from __future__ import annotations

from pathlib import Path

from evoflow.eval.scenarios._harness import check, finalize, run_scenario
from evoflow.eval.scenarios._persist import expect_task


def _run(home: Path) -> dict:
    del home
    from evoflow.admin import tasks as tasks_admin

    created = tasks_admin.create_task(
        name="模块评测任务",
        description="tasks module scenario",
        initial_status="pending",
        source="eval-module",
    )
    tid = str(created.get("task_id") or created.get("id") or "")

    listed = tasks_admin.list_tasks(status="pending", source="eval-module")
    rows = listed.get("tasks") or listed.get("items") or listed.get("rows") or []
    if not isinstance(rows, list):
        rows = []
    ids = [
        str(r.get("task_id") or r.get("id") or "")
        for r in rows
        if isinstance(r, dict)
    ]

    got = tasks_admin.get_task(tid) if tid else {}
    exec_out = tasks_admin.set_task_state(tid, "executing") if tid else {}
    done_out = (
        tasks_admin.set_task_state(tid, "completed", summary="模块评测完成") if tid else {}
    )
    final = tasks_admin.get_task(tid) if tid else {}
    final_task = final.get("task") if isinstance(final.get("task"), dict) else final
    final_status = str(final_task.get("status") or done_out.get("status") or "")

    assertions = [
        check(
            "task_created",
            bool(tid),
            inputs={
                "name": "模块评测任务",
                "initial_status": "pending",
                "source": "eval-module",
            },
            expected="非空 task_id",
            actual=tid,
            api="tasks_admin.create_task",
        ),
        check(
            "listed_by_source",
            tid in ids,
            inputs={"status": "pending", "source": "eval-module"},
            expected=tid,
            actual=ids[:20],
            api="tasks_admin.list_tasks",
        ),
        check(
            "get_task",
            bool(got),
            inputs={"task_id": tid},
            expected="task payload",
            actual={"keys": list(got.keys())[:12] if isinstance(got, dict) else type(got).__name__},
            api="tasks_admin.get_task",
        ),
        check(
            "to_executing",
            str(exec_out.get("status") or "") == "executing"
            or str((exec_out.get("task") or {}).get("status") or "") == "executing",
            inputs={"task_id": tid, "to": "executing"},
            expected="executing",
            actual=exec_out.get("status") or (exec_out.get("task") or {}).get("status"),
            api="tasks_admin.set_task_state",
        ),
        check(
            "to_completed",
            final_status in ("completed", "done", "reviewed"),
            inputs={"task_id": tid, "to": "completed", "summary": "模块评测完成"},
            expected=["completed", "done", "reviewed"],
            actual=final_status,
            api="tasks_admin.set_task_state",
        ),
    ]
    persist = [*expect_task(tid, status=final_status if final_status else "completed")] if tid else []
    return finalize(
        assertions + persist,
        metrics={"task_id": tid, "final_status": final_status},
        steps=[
            {"step": 1, "api": "create_task", "result": {"task_id": tid}},
            {"step": 2, "api": "list_tasks", "result": {"ids": ids[:10]}},
            {"step": 3, "api": "set_task_state(executing)", "result": exec_out.get("status")},
            {"step": 4, "api": "set_task_state(completed)", "result": final_status},
        ],
    )


def run(**_kwargs) -> dict:
    return run_scenario(_run)
