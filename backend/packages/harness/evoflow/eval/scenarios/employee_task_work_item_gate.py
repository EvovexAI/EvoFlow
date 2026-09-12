"""Employee task: work_item → approval gate state machine (approve + reject)."""

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
from evoflow.eval.scenarios._runtime_contract import (
    ensure_agent,
    expect_duty_brief,
    runtime_contract_metrics,
)

_CODE = "eval-emp-gate"


def _run(home: Path) -> dict:
    from evoflow.admin import employees as employees_admin
    from evoflow.proactive.decision_gate import DecisionGate
    from evoflow.proactive.models import ApprovalStatus, InitiativeStatus
    from evoflow.proactive.repositories import ProactiveRepository
    from evoflow.proactive.work_items import create_role_work_item, load_work_item_task

    ensure_agent(
        agent_code=_CODE,
        agent_name="员工审批门智能体",
        description="work item gate",
        soul="Approval gate employee.",
        system_prompt="Request approval before acting.",
        tools=["read"],
    )
    employees_admin.hire(
        {
            "agent_code": _CODE,
            "role_name": "审批门值班员",
            "responsibilities": ["提交方案", "等待审批"],
        }
    )
    # Ensure autonomy requires approval
    role = ProactiveRepository.get_role(_CODE)
    assert role is not None
    from evoflow.proactive.models import ProactiveAutonomyLevel

    role.config.autonomy_level = ProactiveAutonomyLevel.APPROVAL_FOR_ALL
    role.config.workspace_path = str(home)
    ProactiveRepository.save_role(role)
    role = ProactiveRepository.get_role(_CODE)
    assert role is not None

    created = create_role_work_item(
        role,
        {
            "title": "员工任务审批方案",
            "description": "需批准",
            "action_type": "analysis",
            "risk_level": "low",
            "rationale": "employee_task_gate",
        },
        round_id="round:emp-gate",
        goal="审批门",
        source="role",
        raised_by=_CODE,
    )
    tid = str(created.get("task_id") or "")
    gate = DecisionGate()
    task = load_work_item_task(tid)
    appr = asyncio.run(gate.request_approval_for_task(role, task))
    asyncio.run(gate.process_decision(appr.id, decision="approved", decided_by="user"))
    appr_ok = ProactiveRepository.get_approval(appr.id)
    bridge_ok = ProactiveRepository.get_initiative(f"task:{tid}")

    created2 = create_role_work_item(
        role,
        {
            "title": "员工任务拒绝方案",
            "description": "将被拒",
            "action_type": "analysis",
            "risk_level": "low",
            "rationale": "employee_task_gate_reject",
        },
        round_id="round:emp-gate-rej",
        goal="拒绝门",
        source="role",
        raised_by=_CODE,
    )
    tid2 = str(created2.get("task_id") or "")
    task2 = load_work_item_task(tid2)
    appr_r = asyncio.run(gate.request_approval_for_task(role, task2))
    asyncio.run(
        gate.process_decision(
            appr_r.id,
            decision="rejected",
            decided_by="user",
            rejection_reason="eval emp gate reject",
        )
    )
    appr_rej = ProactiveRepository.get_approval(appr_r.id)
    bridge_rej = ProactiveRepository.get_initiative(f"task:{tid2}")

    assertions = [
        check(
            "approve_path",
            appr_ok is not None
            and appr_ok.status == ApprovalStatus.APPROVED
            and bridge_ok is not None
            and bridge_ok.status == InitiativeStatus.APPROVED,
            inputs={"task_id": tid},
            expected="approval+initiative APPROVED",
            actual={
                "approval": str(getattr(appr_ok, "status", None)),
                "initiative": str(getattr(bridge_ok, "status", None)),
            },
            api="DecisionGate.process_decision",
        ),
        check(
            "reject_path",
            appr_rej is not None
            and appr_rej.status == ApprovalStatus.REJECTED
            and bridge_rej is not None
            and bridge_rej.status == InitiativeStatus.REJECTED,
            inputs={"task_id": tid2},
            expected="approval+initiative REJECTED",
            actual={
                "approval": str(getattr(appr_rej, "status", None)),
                "initiative": str(getattr(bridge_rej, "status", None)),
            },
            api="DecisionGate.process_decision",
        ),
        expect_duty_brief(_CODE, must_contain=["审批门值班员"]),
    ]
    persist = [
        expect_agent(_CODE, agent_name="员工审批门智能体"),
        expect_role(_CODE, role_name="审批门值班员"),
        expect_approval(appr.id, status=ApprovalStatus.APPROVED.value),
        expect_initiative(f"task:{tid}", status=InitiativeStatus.APPROVED.value),
        expect_approval(appr_r.id, status=ApprovalStatus.REJECTED.value),
        expect_initiative(f"task:{tid2}", status=InitiativeStatus.REJECTED.value),
        *expect_task(tid),
        *expect_task(tid2),
    ]
    metrics = runtime_contract_metrics(
        agent_codes=[_CODE],
        extra={"approve_task_id": tid, "reject_task_id": tid2},
    )
    return finalize(
        assertions + persist,
        metrics=metrics,
        steps=[
            {"step": 1, "api": "create_agent+hire"},
            {"step": 2, "api": "create_role_work_item approve path", "task_id": tid},
            {"step": 3, "api": "create_role_work_item reject path", "task_id": tid2},
        ],
    )


def run(**_kwargs) -> dict:
    return run_scenario(_run)
