"""Cross-module negative: agent without hire — dispatch ledger is explicit."""

from __future__ import annotations

from pathlib import Path

from evoflow.eval.scenarios._harness import check, finalize, run_scenario
from evoflow.eval.scenarios._persist import expect_agent, expect_no_role, expect_task, expect_user_item


def _run(home: Path) -> dict:
    del home
    from evoflow.admin import agents as agents_admin
    from evoflow.admin import items as items_admin
    from evoflow.admin import tasks as tasks_admin
    from evoflow.proactive.repositories import ProactiveRepository

    code = "eval-saga-no-hire"
    try:
        agents_admin.create_agent(
            {
                "agent_code": code,
                "agent_name": "Saga未雇佣",
                "description": "saga no hire",
                "soul": "no hire",
            }
        )
    except Exception:  # noqa: BLE001
        pass

    role = ProactiveRepository.get_role(code)
    created = items_admin.create_item(title="Saga未雇佣派发", notes="cross negative")
    item_id = str((created.get("item") or created).get("id") or "")
    dispatched = items_admin.dispatch_item(item_id, agent_code=code, wake_now=False)
    task_id = str(dispatched.get("task_id") or "")
    task = tasks_admin.get_task(task_id) if task_id else {}
    row = task.get("task") if isinstance(task.get("task"), dict) else task
    assigned_role = str((row or {}).get("assigned_role") or "")
    source_ref = str((row or {}).get("source_ref") or "")
    expected_ref = f"item:{item_id}"
    item_after = dispatched.get("item") or items_admin.get_item(item_id)["item"]
    linked = list(item_after.get("linked_task_ids") or [])

    assertions = [
        check(
            "not_hired",
            role is None,
            inputs={"agent_code": code},
            expected="无岗位",
            actual=bool(role),
            api="ProactiveRepository.get_role",
        ),
        check(
            "dispatch_creates_task",
            bool(task_id) and task_id in linked,
            inputs={"item_id": item_id, "agent_code": code},
            expected="task 关联 item",
            actual={"task_id": task_id, "linked": linked},
            api="items_admin.dispatch_item",
        ),
        check(
            "no_role_on_task",
            assigned_role in ("", "None", "null"),
            inputs={"task_id": task_id},
            expected="assigned_role 空",
            actual=assigned_role,
            api="tasks_admin.get_task",
        ),
        check(
            "source_ref",
            source_ref == expected_ref or expected_ref in source_ref,
            inputs={"task_id": task_id},
            expected=expected_ref,
            actual=source_ref,
            api="tasks_admin.get_task",
        ),
    ]
    persist = [
        expect_agent(code, agent_name="Saga未雇佣"),
        expect_no_role(code),
        expect_user_item(item_id, title="Saga未雇佣派发"),
        *expect_task(task_id, source_ref=expected_ref, user_item_id=item_id),
    ]
    return finalize(
        assertions + persist,
        metrics={"agent_code": code, "item_id": item_id, "task_id": task_id},
        steps=[
            {"step": 1, "module": "agents", "api": "create_agent only"},
            {"step": 2, "module": "items", "api": "create+dispatch", "task_id": task_id},
        ],
    )


def run(**_kwargs) -> dict:
    return run_scenario(_run)
