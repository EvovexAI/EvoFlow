"""Scenario: DecisionGate approve/reject ↔ task status parity (no mocks)."""

from __future__ import annotations

import asyncio
from pathlib import Path

from evoflow.eval.scenarios._harness import check, finalize, run_scenario
from evoflow.eval.scenarios._persist import (
    expect_approval,
    expect_initiative,
    expect_role,
    expect_task,
)


def _run(home: Path) -> dict:
    from evoflow.proactive.decision_gate import DecisionGate
    from evoflow.proactive.models import (
        ApprovalStatus,
        InitiativeStatus,
        ProactiveAutonomyLevel,
        ProactiveRole,
        ProactiveRoleConfig,
    )
    from evoflow.proactive.repositories import ProactiveRepository
    from evoflow.proactive.work_items import create_role_work_item, load_work_item_task

    code = "eval-approver"
    role = ProactiveRole(
        agent_code=code,
        role_name="评测审批员",
        department="QA",
        status="active",
        config=ProactiveRoleConfig(
            autonomy_level=ProactiveAutonomyLevel.APPROVAL_FOR_ALL,
            approval_channels=["desktop"],
            workspace_path=str(home),
        ),
    )
    ProactiveRepository.save_role(role)

    created = create_role_work_item(
        role,
        {
            "title": "评测审批方案",
            "description": "需要批准后再执行",
            "action_type": "analysis",
            "risk_level": "low",
            "rationale": "scenario",
        },
        round_id="round:eval-appr",
        goal="审批一致性",
        source="role",
        raised_by=code,
    )
    tid = str(created.get("task_id") or "")

    gate = DecisionGate()
    task = load_work_item_task(tid)
    appr = asyncio.run(gate.request_approval_for_task(role, task))
    pending_ok = appr.status == ApprovalStatus.PENDING
    bridge = ProactiveRepository.get_initiative(f"task:{tid}")
    bridge_pending = bridge is not None and bridge.status == InitiativeStatus.PENDING_APPROVAL

    updated = asyncio.run(
        gate.process_decision(appr.id, decision="approved", decided_by="user")
    )
    approved_ok = updated is not None and updated.status == InitiativeStatus.APPROVED
    appr2 = ProactiveRepository.get_approval(appr.id)
    appr_approved = appr2 is not None and appr2.status == ApprovalStatus.APPROVED

    created2 = create_role_work_item(
        role,
        {
            "title": "评测拒绝方案",
            "description": "将被拒绝",
            "action_type": "analysis",
            "risk_level": "low",
            "rationale": "scenario-reject",
        },
        round_id="round:eval-rej",
        goal="拒绝一致性",
        source="role",
        raised_by=code,
    )
    tid2 = str(created2.get("task_id") or "")
    gate2 = DecisionGate()
    task2 = load_work_item_task(tid2)
    appr_r = asyncio.run(gate2.request_approval_for_task(role, task2))
    asyncio.run(
        gate2.process_decision(
            appr_r.id,
            decision="rejected",
            decided_by="user",
            rejection_reason="eval reject",
        )
    )
    appr_rej = ProactiveRepository.get_approval(appr_r.id)
    bridge_rej = ProactiveRepository.get_initiative(f"task:{tid2}")
    reject_ok = (
        appr_rej is not None
        and appr_rej.status == ApprovalStatus.REJECTED
        and bridge_rej is not None
        and bridge_rej.status == InitiativeStatus.REJECTED
    )

    assertions = [
        check(
            "task_created",
            bool(tid),
            inputs={"role": code, "title": "评测审批方案"},
            expected="非空 task_id",
            actual=tid,
            api="create_role_work_item",
        ),
        check(
            "approval_pending",
            pending_ok,
            inputs={"task_id": tid},
            expected=str(ApprovalStatus.PENDING),
            actual=str(getattr(appr, "status", None)),
            api="DecisionGate.request_approval_for_task",
        ),
        check(
            "bridge_pending",
            bridge_pending,
            inputs={"initiative_id": f"task:{tid}"},
            expected=str(InitiativeStatus.PENDING_APPROVAL),
            actual=str(getattr(bridge, "status", None)),
            api="ProactiveRepository.get_initiative",
        ),
        check(
            "approved",
            approved_ok,
            inputs={"approval_id": getattr(appr, "id", None), "decision": "approved"},
            expected=str(InitiativeStatus.APPROVED),
            actual=str(getattr(updated, "status", None)),
            api="DecisionGate.process_decision",
        ),
        check(
            "approval_row_approved",
            appr_approved,
            inputs={"approval_id": getattr(appr, "id", None)},
            expected=str(ApprovalStatus.APPROVED),
            actual=str(getattr(appr2, "status", None)),
            api="ProactiveRepository.get_approval",
        ),
        check(
            "rejected",
            reject_ok,
            inputs={"task_id": tid2, "decision": "rejected", "reason": "eval reject"},
            expected={
                "approval": str(ApprovalStatus.REJECTED),
                "bridge": str(InitiativeStatus.REJECTED),
            },
            actual={
                "approval": str(getattr(appr_rej, "status", None)),
                "bridge": str(getattr(bridge_rej, "status", None)),
            },
            api="DecisionGate.process_decision",
        ),
    ]
    persist = [
        expect_role(code, status="active", role_name="评测审批员"),
        expect_approval(appr.id, status=ApprovalStatus.APPROVED.value),
        expect_initiative(f"task:{tid}", status=InitiativeStatus.APPROVED.value),
        expect_approval(appr_r.id, status=ApprovalStatus.REJECTED.value),
        expect_initiative(f"task:{tid2}", status=InitiativeStatus.REJECTED.value),
        *expect_task(tid),
        *expect_task(tid2),
    ]
    return finalize(
        assertions + persist,
        metrics={"approve_task_id": tid, "reject_task_id": tid2},
        steps=[
            {"step": 1, "api": "ProactiveRepository.save_role", "inputs": {"agent_code": code}},
            {"step": 2, "api": "create_role_work_item", "result": {"task_id": tid}},
            {"step": 3, "api": "DecisionGate.request_approval_for_task", "result": {"approval_id": getattr(appr, "id", None)}},
            {"step": 4, "api": "DecisionGate.process_decision(approved)"},
            {"step": 5, "api": "create_role_work_item", "result": {"task_id": tid2}},
            {"step": 6, "api": "DecisionGate.process_decision(rejected)"},
        ],
    )


def run(**_kwargs) -> dict:
    return run_scenario(_run)
