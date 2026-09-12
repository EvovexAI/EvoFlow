"""Items negative: dispatch to agent without hire — task exists, role empty."""

from __future__ import annotations

from pathlib import Path

from evoflow.eval.scenarios._harness import check, finalize, run_scenario
from evoflow.eval.scenarios._persist import expect_agent, expect_no_role, expect_task, expect_user_item


def _run(home: Path) -> dict:
    del home
    from evoflow.admin import agents as agents_admin
    from evoflow.admin import items as items_admin
    from evoflow.admin import tasks as tasks_admin

    code = "eval-no-hire-agent"
    try:
        agents_admin.create_agent(
            {
                "agent_code": code,
                "agent_name": "未雇佣派发",
                "description": "no hire",
                "soul": "no hire",
            }
        )
    except Exception:  # noqa: BLE001
        pass

    created = items_admin.create_item(title="未雇佣派发事项", notes="negative")
    item_id = str((created.get("item") or created).get("id") or "")
    dispatched = items_admin.dispatch_item(item_id, agent_code=code, wake_now=False)
    task_id = str(dispatched.get("task_id") or "")
    task = tasks_admin.get_task(task_id) if task_id else {}
    row = task.get("task") if isinstance(task.get("task"), dict) else task
    assigned_role = str((row or {}).get("assigned_role") or "")
    source_ref = str((row or {}).get("source_ref") or "")
    expected_ref = f"item:{item_id}"

    assertions = [
        check(
            "task_created",
            bool(task_id),
            inputs={"item_id": item_id, "agent_code": code, "wake_now": False},
            expected="非空 task_id",
            actual=task_id,
            api="items_admin.dispatch_item",
        ),
        check(
            "assigned_role_empty",
            assigned_role in ("", "None", "null"),
            inputs={"task_id": task_id},
            expected="无岗位名（未雇佣）",
            actual=assigned_role,
            api="tasks_admin.get_task",
        ),
        check(
            "source_ref_ok",
            source_ref == expected_ref or expected_ref in source_ref,
            inputs={"task_id": task_id},
            expected=expected_ref,
            actual=source_ref,
            api="tasks_admin.get_task",
        ),
    ]
    persist = [
        expect_agent(code, agent_name="未雇佣派发"),
        expect_no_role(code),
        expect_user_item(item_id, title="未雇佣派发事项"),
        *expect_task(task_id, source_ref=expected_ref, user_item_id=item_id),
    ]
    return finalize(
        assertions + persist,
        metrics={"item_id": item_id, "task_id": task_id, "agent_code": code},
        steps=[
            {"step": 1, "module": "agents", "api": "create_agent (no hire)"},
            {"step": 2, "module": "items", "api": "create_item", "item_id": item_id},
            {"step": 3, "module": "items", "api": "dispatch_item", "task_id": task_id},
        ],
    )


def run(**_kwargs) -> dict:
    return run_scenario(_run)
