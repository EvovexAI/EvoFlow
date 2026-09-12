"""Scenario: item create → dispatch → collab task linkage."""

from __future__ import annotations

from pathlib import Path

from evoflow.eval.scenarios._harness import check, finalize, run_scenario
from evoflow.eval.scenarios._persist import expect_agent, expect_role, expect_task, expect_user_item


def _run(home: Path) -> dict:
    del home
    from evoflow.admin import agents as agents_admin
    from evoflow.admin import employees as employees_admin
    from evoflow.admin import items as items_admin
    from evoflow.admin import tasks as tasks_admin

    agents_admin.create_agent(
        {
            "agent_code": "eval-dispatcher",
            "agent_name": "Eval Dispatcher",
            "description": "eval",
            "soul": "Dispatch items.",
        }
    )
    employees_admin.hire(
        {
            "agent_code": "eval-dispatcher",
            "role_name": "派发员",
            "responsibilities": ["处理事项"],
        }
    )

    created = items_admin.create_item(title="评测事项-派发链路", notes="scenario")
    item = created["item"]
    item_id = item["id"]

    dispatched = items_admin.dispatch_item(
        item_id, agent_code="eval-dispatcher", wake_now=False
    )
    task_id = str(dispatched.get("task_id") or "")
    item_after = dispatched.get("item") or items_admin.get_item(item_id)["item"]
    linked = list(item_after.get("linked_task_ids") or [])
    task = tasks_admin.get_task(task_id) if task_id else {}
    source_ref = ""
    if isinstance(task, dict):
        source_ref = str(
            task.get("source_ref")
            or (task.get("task") or {}).get("source_ref")
            or ""
        )
    expected_ref = f"item:{item_id}"
    item_status = str(item_after.get("status") or "")

    assertions = [
        check(
            "item_created",
            bool(item_id),
            inputs={"title": "评测事项-派发链路", "notes": "scenario"},
            expected="非空 item_id",
            actual=item_id,
            api="items_admin.create_item",
        ),
        check(
            "task_created",
            bool(task_id),
            inputs={"item_id": item_id, "agent_code": "eval-dispatcher", "wake_now": False},
            expected="非空 task_id",
            actual=task_id,
            api="items_admin.dispatch_item",
        ),
        check(
            "linked_task_ids",
            task_id in linked,
            inputs={"item_id": item_id},
            expected=task_id,
            actual=linked,
            api="items_admin.dispatch_item",
        ),
        check(
            "source_ref",
            source_ref == expected_ref or expected_ref in source_ref,
            inputs={"task_id": task_id},
            expected=expected_ref,
            actual=source_ref,
            api="tasks_admin.get_task",
        ),
        check(
            "item_waiting",
            item_status in ("waiting", "in_progress", "todo"),
            inputs={"item_id": item_id},
            expected=["waiting", "in_progress", "todo"],
            actual=item_status,
            api="items_admin.get_item",
        ),
    ]
    persist = [
        expect_agent("eval-dispatcher", agent_name="Eval Dispatcher"),
        expect_role("eval-dispatcher", role_name="派发员"),
        expect_user_item(item_id, title="评测事项-派发链路"),
        *expect_task(
            task_id,
            assigned_to="eval-dispatcher",
            source_ref=expected_ref,
            user_item_id=item_id,
        ),
    ]
    return finalize(
        assertions + persist,
        metrics={"item_id": item_id, "task_id": task_id, "source_ref": source_ref},
        steps=[
            {"step": 1, "api": "agents_admin.create_agent + employees_admin.hire"},
            {"step": 2, "api": "items_admin.create_item", "result": {"item_id": item_id}},
            {"step": 3, "api": "items_admin.dispatch_item", "result": {"task_id": task_id}},
            {"step": 4, "api": "tasks_admin.get_task", "result": {"source_ref": source_ref}},
        ],
    )


def run(**_kwargs) -> dict:
    return run_scenario(_run)
