"""Cross-module alt: approval rejected ledger parity."""

from __future__ import annotations

import asyncio
from pathlib import Path

from evoflow.eval.scenarios._harness import check, finalize, run_scenario
from evoflow.eval.scenarios._persist import (
    expect_agent,
    expect_approval,
    expect_initiative,
    expect_role,
    expect_task,
)


def _run(home: Path) -> dict:
    from evoflow.admin import agents as agents_admin
    from evoflow.admin import employees as employees_admin
    from evoflow.proactive.decision_gate import DecisionGate
    from evoflow.proactive.models import ApprovalStatus, InitiativeStatus
    from evoflow.proactive.repositories import ProactiveRepository
    from evoflow.proactive.work_items import create_role_work_item, load_work_item_task

    code = "eval-saga-reject"
    try:
        agents_admin.create_agent(
            {
                "agent_code": code,
                "agent_name": "Saga拒绝岗",
                "description": "reject saga",
                "soul": "reject",
            }
        )
    except Exception:  # noqa: BLE001
        pass
    try:
        employees_admin.hire(
            {
                "agent_code": code,
                "role_name": "Saga拒绝审批员",
                "responsibilities": ["审批"],
                "autonomy_level": "approval_for_all",
                "approval_channels": ["desktop"],
                "workspace_path": str(home),
            }
        )
    except Exception:  # noqa: BLE001
        pass

    role = ProactiveRepository.get_role(code)
    assert role is not None
    created = create_role_work_item(
        role,
        {
            "title": "Saga拒绝方案",
            "description": "将被拒绝",
            "action_type": "analysis",
            "risk_level": "low",
            "rationale": "saga-reject",
        },
        round_id="round:eval-saga-rej",
        goal="拒绝一致性",
        source="role",
        raised_by=code,
    )
    tid = str(created.get("task_id") or "")
    gate = DecisionGate()
    task = load_work_item_task(tid)
    appr = asyncio.run(gate.request_approval_for_task(role, task))
    asyncio.run(
        gate.process_decision(
            appr.id,
            decision="rejected",
            decided_by="user",
            rejection_reason="eval saga reject",
        )
    )
    appr2 = ProactiveRepository.get_approval(appr.id)
    bridge = ProactiveRepository.get_initiative(f"task:{tid}")
    ok = (
        appr2 is not None
        and appr2.status == ApprovalStatus.REJECTED
        and bridge is not None
        and bridge.status == InitiativeStatus.REJECTED
    )

    assertions = [
        check(
            "role_ready",
            role is not None,
            inputs={"agent_code": code},
            expected="岗位存在",
            actual=code,
            api="employees_admin.hire",
        ),
        check(
            "approval_rejected",
            ok,
            inputs={"task_id": tid, "approval_id": appr.id},
            expected="approval+initiative REJECTED",
            actual={
                "approval": str(getattr(appr2, "status", None)),
                "initiative": str(getattr(bridge, "status", None)),
            },
            api="DecisionGate.process_decision",
        ),
    ]
    persist = [
        expect_agent(code, agent_name="Saga拒绝岗"),
        expect_role(code, role_name="Saga拒绝审批员"),
        expect_approval(appr.id, status=ApprovalStatus.REJECTED.value),
        expect_initiative(f"task:{tid}", status=InitiativeStatus.REJECTED.value),
        *expect_task(tid),
    ]
    return finalize(
        assertions + persist,
        metrics={"agent_code": code, "task_id": tid, "approval_id": appr.id},
        steps=[
            {"step": 1, "module": "agents", "api": "create+hire"},
            {"step": 2, "module": "tasks", "api": "create_role_work_item", "task_id": tid},
            {"step": 3, "module": "tasks", "api": "request+reject approval"},
        ],
    )


def run(**_kwargs) -> dict:
    return run_scenario(_run)
