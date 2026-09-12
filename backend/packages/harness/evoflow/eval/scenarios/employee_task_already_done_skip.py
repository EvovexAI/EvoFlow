"""Employee: already-done referenced tasks skip re-dispatch."""

from __future__ import annotations

import asyncio
from pathlib import Path

from evoflow.eval.scenarios._harness import check, finalize, run_scenario
from evoflow.eval.scenarios._persist import expect_agent, expect_role, expect_task
from evoflow.eval.scenarios._runtime_contract import ensure_agent, runtime_contract_metrics

_CODE = "eval-emp-done-skip"


def _run(home: Path) -> dict:
    del home
    from evoflow.admin import employees as employees_admin
    from evoflow.admin import tasks as tasks_admin
    from evoflow.collab.storage import get_project_storage, patch_collab_main_task_in_project_storage
    from evoflow.proactive.runner import get_proactive_runner
    from evoflow.proactive.work_items import create_role_work_item
    from evoflow.proactive.repositories import ProactiveRepository

    ensure_agent(
        agent_code=_CODE,
        agent_name="结案防重派评测",
        description="already done skip",
        soul="Done means done.",
        system_prompt="Do not redo finished work.",
        tools=["read"],
    )
    employees_admin.hire(
        {
            "agent_code": _CODE,
            "role_name": "结案防重派员",
            "responsibilities": ["完成即止"],
            "work_schedule_enabled": False,
        }
    )
    role = ProactiveRepository.get_role(_CODE)
    assert role is not None
    created = create_role_work_item(
        role,
        {
            "title": "已完成事项",
            "description": "eval already done",
            "action_type": "analysis",
            "risk_level": "low",
            "rationale": "seed completed",
        },
        round_id="round:emp-done",
        goal="结案",
        source="role",
        raised_by=_CODE,
    )
    tid = str(created.get("task_id") or "")
    storage = get_project_storage()
    patch_collab_main_task_in_project_storage(
        storage,
        tid,
        {"status": "completed", "progress": 100, "summary": "done for eval"},
    )
    task_after = tasks_admin.get_task(tid) if tid else {}
    status = ""
    if isinstance(task_after, dict):
        status = str(
            task_after.get("status") or (task_after.get("task") or {}).get("status") or ""
        )

    runner = get_proactive_runner()
    result = asyncio.run(
        runner.dispatch_task(
            _CODE,
            goal=f"请继续处理已完成任务 {tid}",
            description=f"related {tid}",
            related_task_id=tid,
            source="eval",
        )
    )
    skipped = bool(result.get("skipped")) or str(result.get("reason") or "") == "already_done"
    assertions = [
        check(
            "seed_completed",
            status.lower() in ("completed", "done", "reviewed"),
            inputs={"task_id": tid},
            expected="completed",
            actual=status,
            api="patch_collab_main_task_in_project_storage",
        ),
        check(
            "redispatch_skipped",
            bool(result.get("ok")) and skipped,
            inputs={"related_task_id": tid},
            expected="ok + skipped/already_done",
            actual={
                "ok": result.get("ok"),
                "skipped": result.get("skipped"),
                "reason": result.get("reason"),
                "message": result.get("message"),
            },
            api="ProactiveRunner.dispatch_task",
        ),
    ]
    persist = [expect_agent(_CODE), expect_role(_CODE, role_name="结案防重派员")]
    if tid:
        persist.extend(expect_task(tid, status=status or None))
    metrics = runtime_contract_metrics(
        agent_codes=[_CODE],
        task_id=tid or None,
        extra={"eval_pack": "employees", "arch": "emp.retry.already_done", "result": result},
    )
    return finalize(
        assertions + persist,
        metrics=metrics,
        steps=[
            {"step": 1, "api": "create_role_work_item + mark completed"},
            {"step": 2, "api": "dispatch_task related → already_done"},
        ],
    )


def run(**_kwargs) -> dict:
    return run_scenario(_run)
