"""Employee task: dispatch ledger + wake-ready prompt/tools snapshot (no LLM)."""

from __future__ import annotations

from pathlib import Path

from evoflow.eval.scenarios._harness import check, finalize, run_scenario
from evoflow.eval.scenarios._persist import expect_agent, expect_role, expect_task, expect_user_item
from evoflow.eval.scenarios._runtime_contract import (
    ensure_agent,
    build_duty_brief_text,
    expect_duty_brief,
    expect_tools_include,
    runtime_contract_metrics,
    snapshot_agent_runtime,
)

_CODE = "eval-emp-dispatch"
_TOOLS = ["read"]


def _run(home: Path) -> dict:
    del home
    from evoflow.admin import employees as employees_admin
    from evoflow.admin import items as items_admin
    from evoflow.admin import tasks as tasks_admin

    ensure_agent(
        agent_code=_CODE,
        agent_name="员工派发评测智能体",
        description="dispatch ledger",
        soul="Dispatch duty employee.",
        system_prompt="Handle dispatched items carefully.",
        tools=list(_TOOLS),
    )
    hired = employees_admin.hire(
        {
            "agent_code": _CODE,
            "role_name": "派发值班员",
            "responsibilities": ["接收事项"],
        }
    )
    from evoflow.proactive.repositories import ProactiveRepository

    role_after_hire = ProactiveRepository.get_role(_CODE)
    created = items_admin.create_item(title="员工任务派发评测", notes="employee_task_dispatch")
    item = created["item"]
    item_id = item["id"]
    dispatched = items_admin.dispatch_item(item_id, agent_code=_CODE, wake_now=False)
    task_id = str(dispatched.get("task_id") or "")
    item_after = dispatched.get("item") or items_admin.get_item(item_id)["item"]
    linked = list(item_after.get("linked_task_ids") or [])
    task = tasks_admin.get_task(task_id) if task_id else {}
    source_ref = ""
    if isinstance(task, dict):
        source_ref = str(
            task.get("source_ref") or (task.get("task") or {}).get("source_ref") or ""
        )
    expected_ref = f"item:{item_id}"
    snap = snapshot_agent_runtime(_CODE)
    brief = build_duty_brief_text(_CODE)

    assertions = [
        check(
            "hired",
            bool(hired.get("agent_code") == _CODE and role_after_hire is not None),
            inputs={"agent_code": _CODE},
            expected="role row after hire",
            actual={
                "hire_agent_code": hired.get("agent_code"),
                "role_name": getattr(role_after_hire, "role_name", None),
            },
            api="employees_admin.hire",
        ),
        check(
            "task_created",
            bool(task_id),
            inputs={"item_id": item_id, "agent_code": _CODE, "wake_now": False},
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
            "wake_ready_prompt_snapshot",
            bool(brief) and "派发值班员" in brief,
            inputs={"note": "wake_now=False; snapshot is what wake would use"},
            expected="duty brief ready for wake",
            actual={"brief_len": len(brief), "preview": brief[:200]},
            api="build_system_prompt",
        ),
        expect_duty_brief(_CODE, must_contain=["派发值班员", "接收事项"]),
        expect_tools_include(_CODE, _TOOLS),
    ]
    persist = [
        expect_agent(_CODE, agent_name="员工派发评测智能体"),
        expect_role(_CODE, role_name="派发值班员"),
        expect_user_item(item_id, title="员工任务派发评测"),
    ]
    if task_id:
        persist.extend(
            expect_task(
                task_id,
                assigned_to=_CODE,
                source_ref=expected_ref,
                user_item_id=item_id,
            )
        )

    metrics = runtime_contract_metrics(
        agent_codes=[_CODE],
        task_id=task_id or None,
        extra={"item_id": item_id, "wake_now": False, "would_use_on_wake": snap},
    )
    return finalize(
        assertions + persist,
        metrics=metrics,
        steps=[
            {"step": 1, "api": "create_agent+hire", "agent_code": _CODE},
            {"step": 2, "api": "create_item", "item_id": item_id},
            {"step": 3, "api": "dispatch_item wake_now=False", "task_id": task_id},
            {"step": 4, "api": "snapshot duty brief + tools for wake readiness"},
        ],
    )


def run(**_kwargs) -> dict:
    return run_scenario(_run)
