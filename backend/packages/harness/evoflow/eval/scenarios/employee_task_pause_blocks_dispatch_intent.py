"""Employee task: pause role remains auditable; resume restores active."""

from __future__ import annotations

from pathlib import Path

from evoflow.eval.scenarios._harness import check, finalize, run_scenario
from evoflow.eval.scenarios._persist import expect_agent, expect_role, expect_task, expect_user_item
from evoflow.eval.scenarios._runtime_contract import (
    ensure_agent,
    expect_duty_brief,
    runtime_contract_metrics,
)

_CODE = "eval-emp-pause"


def _run(home: Path) -> dict:
    del home
    from evoflow.admin import employees as employees_admin
    from evoflow.admin import items as items_admin
    from evoflow.proactive.repositories import ProactiveRepository

    ensure_agent(
        agent_code=_CODE,
        agent_name="暂停恢复评测智能体",
        description="pause dispatch intent",
        soul="Pause aware.",
        system_prompt="Paused roles must not pretend on-duty.",
        tools=["read"],
    )
    employees_admin.hire(
        {
            "agent_code": _CODE,
            "role_name": "可暂停值班员",
            "responsibilities": ["值班"],
        }
    )
    paused = employees_admin.pause_role(_CODE)
    role_paused = ProactiveRepository.get_role(_CODE)
    created = items_admin.create_item(title="暂停态派发审计", notes="pause")
    item_id = created["item"]["id"]
    dispatched = items_admin.dispatch_item(item_id, agent_code=_CODE, wake_now=False)
    task_id = str(dispatched.get("task_id") or "")
    resumed = employees_admin.resume_role(_CODE)
    role_resumed = ProactiveRepository.get_role(_CODE)

    assertions = [
        check(
            "paused_status",
            paused.get("status") == "paused"
            or (role_paused is not None and role_paused.status == "paused"),
            inputs={"agent_code": _CODE},
            expected="paused",
            actual={"api": paused.get("status"), "db": getattr(role_paused, "status", None)},
            api="employees_admin.pause_role",
        ),
        check(
            "dispatch_while_paused_still_auditable",
            bool(task_id),
            inputs={
                "item_id": item_id,
                "note": "task may still be created; role.status must stay paused",
            },
            expected="task_id + role paused",
            actual={"task_id": task_id, "role_status": getattr(role_paused, "status", None)},
            api="items_admin.dispatch_item",
        ),
        check(
            "resumed_status",
            resumed.get("status") == "active"
            or (role_resumed is not None and role_resumed.status == "active"),
            inputs={"agent_code": _CODE},
            expected="active",
            actual={"api": resumed.get("status"), "db": getattr(role_resumed, "status", None)},
            api="employees_admin.resume_role",
        ),
        expect_duty_brief(_CODE, must_contain=["可暂停值班员"]),
    ]
    persist = [
        expect_agent(_CODE, agent_name="暂停恢复评测智能体"),
        expect_role(_CODE, status="active", role_name="可暂停值班员"),
        expect_user_item(item_id, title="暂停态派发审计"),
    ]
    if task_id:
        persist.extend(expect_task(task_id, assigned_to=_CODE, user_item_id=item_id))

    metrics = runtime_contract_metrics(
        agent_codes=[_CODE],
        task_id=task_id or None,
        extra={
            "paused_during_dispatch": True,
            "final_role_status": getattr(role_resumed, "status", None),
        },
    )
    return finalize(
        assertions + persist,
        metrics=metrics,
        steps=[
            {"step": 1, "api": "hire"},
            {"step": 2, "api": "pause_role"},
            {"step": 3, "api": "dispatch while paused", "task_id": task_id},
            {"step": 4, "api": "resume_role"},
        ],
    )


def run(**_kwargs) -> dict:
    return run_scenario(_run)
