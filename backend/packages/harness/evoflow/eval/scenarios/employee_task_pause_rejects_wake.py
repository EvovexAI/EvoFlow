"""Employee: paused role rejects proactive wake/dispatch_task."""

from __future__ import annotations

import asyncio
from pathlib import Path

from evoflow.eval.scenarios._harness import check, finalize, run_scenario
from evoflow.eval.scenarios._persist import expect_agent, expect_role
from evoflow.eval.scenarios._runtime_contract import ensure_agent, runtime_contract_metrics

_CODE = "eval-emp-pause-wake"


def _run(home: Path) -> dict:
    del home
    from evoflow.admin import employees as employees_admin
    from evoflow.proactive.repositories import ProactiveRepository
    from evoflow.proactive.runner import get_proactive_runner

    ensure_agent(
        agent_code=_CODE,
        agent_name="暂停拒唤醒评测",
        description="pause rejects wake",
        soul="Paused.",
        system_prompt="Do not work while paused.",
        tools=["read"],
    )
    employees_admin.hire(
        {
            "agent_code": _CODE,
            "role_name": "暂停拒唤醒员",
            "responsibilities": ["仅在岗时处理"],
            "work_schedule_enabled": False,
        }
    )
    employees_admin.pause_role(_CODE)
    role = ProactiveRepository.get_role(_CODE)
    status = str(getattr(role, "status", "") or "")

    runner = get_proactive_runner()
    result = asyncio.run(
        runner.dispatch_task(
            _CODE,
            goal="暂停态不应执行",
            description="eval pause rejects wake",
            source="eval",
        )
    )
    err = str(result.get("error") or result.get("message") or "")
    rejected = not bool(result.get("ok"))
    gate_msg = ("paused" in err.lower()) or ("active" in err.lower()) or ("status" in err.lower())

    assertions = [
        check(
            "role_paused",
            status == "paused",
            inputs={"agent_code": _CODE},
            expected="paused",
            actual=status,
            api="employees_admin.pause_role",
        ),
        check(
            "dispatch_task_rejected",
            rejected and (gate_msg or status == "paused"),
            inputs={"goal": "暂停态不应执行"},
            expected="ok=false with paused/active gate",
            actual={"ok": result.get("ok"), "error": err, "keys": list(result.keys())[:12]},
            api="ProactiveRunner.dispatch_task",
        ),
    ]
    persist = [
        expect_agent(_CODE),
        expect_role(_CODE, status="paused", role_name="暂停拒唤醒员"),
    ]
    metrics = runtime_contract_metrics(
        agent_codes=[_CODE],
        extra={"eval_pack": "employees", "arch": "emp.gate.pause_wake", "dispatch_result": result},
    )
    return finalize(
        assertions + persist,
        metrics=metrics,
        steps=[
            {"step": 1, "api": "hire+pause"},
            {"step": 2, "api": "dispatch_task while paused", "result": {"ok": result.get("ok")}},
        ],
    )


def run(**_kwargs) -> dict:
    return run_scenario(_run)
