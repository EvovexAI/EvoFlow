"""Employee: busy mutex — overlapping dispatch returns busy."""

from __future__ import annotations

import asyncio
from pathlib import Path

from evoflow.eval.scenarios._harness import check, finalize, run_scenario
from evoflow.eval.scenarios._persist import expect_agent, expect_role
from evoflow.eval.scenarios._runtime_contract import ensure_agent, runtime_contract_metrics

_CODE = "eval-emp-busy"


def _run(home: Path) -> dict:
    del home
    from evoflow.admin import employees as employees_admin
    from evoflow.proactive.runner import get_proactive_runner

    ensure_agent(
        agent_code=_CODE,
        agent_name="Busy互斥评测",
        description="busy mutex",
        soul="One at a time.",
        system_prompt="Serial duty only.",
        tools=["read"],
    )
    employees_admin.hire(
        {
            "agent_code": _CODE,
            "role_name": "Busy互斥员",
            "responsibilities": ["互斥执行"],
            "work_schedule_enabled": False,
        }
    )
    runner = get_proactive_runner()

    async def _exercise() -> dict:
        reserved = await runner._reserve_role(_CODE)
        try:
            busy_flag = runner.is_role_busy(_CODE)
            second = await runner.dispatch_task(
                _CODE,
                goal="二次派发应 busy",
                description="eval busy mutex",
                source="eval",
            )
            return {
                "reserved": reserved,
                "busy_flag": busy_flag,
                "second": second,
            }
        finally:
            await runner._end_role(_CODE)

    out = asyncio.run(_exercise())
    second = out.get("second") or {}
    assertions = [
        check(
            "reserve_busy_slot",
            bool(out.get("reserved")) and bool(out.get("busy_flag")),
            inputs={"agent_code": _CODE},
            expected="reserve + is_role_busy",
            actual={"reserved": out.get("reserved"), "busy": out.get("busy_flag")},
            api="ProactiveRunner._reserve_role",
        ),
        check(
            "second_dispatch_busy",
            bool(second.get("busy")) or (not bool(second.get("ok"))),
            inputs={"goal": "二次派发应 busy"},
            expected="busy=true or ok=false",
            actual={
                "ok": second.get("ok"),
                "busy": second.get("busy"),
                "error": second.get("error"),
            },
            api="ProactiveRunner.dispatch_task",
        ),
        check(
            "busy_cleared_after_end",
            not runner.is_role_busy(_CODE),
            inputs={},
            expected=False,
            actual=runner.is_role_busy(_CODE),
            api="ProactiveRunner._end_role",
        ),
    ]
    persist = [expect_agent(_CODE), expect_role(_CODE, role_name="Busy互斥员")]
    metrics = runtime_contract_metrics(
        agent_codes=[_CODE],
        extra={"eval_pack": "employees", "arch": "emp.gate.busy", "second": second},
    )
    return finalize(
        assertions + persist,
        metrics=metrics,
        steps=[
            {"step": 1, "api": "hire"},
            {"step": 2, "api": "_reserve_role + dispatch_task"},
            {"step": 3, "api": "_end_role"},
        ],
    )


def run(**_kwargs) -> dict:
    return run_scenario(_run)
