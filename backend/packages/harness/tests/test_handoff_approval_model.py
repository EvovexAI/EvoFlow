"""Handoff approval: completed+handlers → awaiting_close; medium+ waits before wake."""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import MagicMock, patch

from evoflow.admin.tasks import set_task_state
from evoflow.proactive.models import ProactiveAutonomyLevel, ProactiveRole, ProactiveRoleConfig


def _task_row(**extra):
    base = {
        "id": "Task_parent",
        "name": "上游",
        "status": "executing",
        "assigned_to": "product-manager",
        "risk_level": "low",
        "progress": 50,
    }
    base.update(extra)
    return base


def _role(autonomy: ProactiveAutonomyLevel):
    return ProactiveRole(
        agent_code="product-manager",
        role_name="产品经理",
        config=ProactiveRoleConfig(autonomy_level=autonomy),
    )


def test_completed_low_risk_dispatches_handlers_immediately():
    handlers = [
        {
            "agent_code": "quality-inspector",
            "content": "审核方案",
            "read_outputs": [{"type": "file", "key": "p", "value": "docs/p.md"}],
        }
    ]
    task = _task_row(risk_level="low")
    storage = MagicMock()

    with (
        patch("evoflow.admin.tasks.get_project_storage", return_value=storage),
        patch("evoflow.admin.tasks.find_main_task", return_value=({}, task)),
        patch("evoflow.admin.tasks.patch_collab_main_task_in_project_storage", return_value=True),
        patch("evoflow.collab.handler_org.assert_handlers_org_ok"),
        patch("evoflow.admin.tasks.handoff_needs_approval", return_value=False),
        patch("evoflow.admin.tasks.dispatch_confirmed_handlers") as mock_dispatch,
    ):
        mock_dispatch.return_value = [
            {"ok": True, "agent_code": "quality-inspector", "task_id": "Task_child"}
        ]
        out = set_task_state(
            "Task_parent",
            "completed",
            summary="方案已出",
            handlers=handlers,
        )

    assert out["status"] == "awaiting_close"
    assert out.get("handlers_pending_approval") is not True
    mock_dispatch.assert_called_once()
    assert out["handlers_dispatched"][0]["task_id"] == "Task_child"


def test_completed_medium_risk_requests_approval_without_dispatch():
    handlers = [
        {
            "agent_code": "quality-inspector",
            "content": "审核方案",
            "read_outputs": [{"type": "file", "key": "p", "value": "docs/p.md"}],
        }
    ]
    task = _task_row(risk_level="medium")
    patches: list[dict] = []

    def _patch(_storage, tid, updates):
        patches.append(dict(updates))
        return True

    with (
        patch("evoflow.admin.tasks.get_project_storage", return_value=MagicMock()),
        patch("evoflow.admin.tasks.find_main_task", return_value=({}, task)),
        patch("evoflow.admin.tasks.patch_collab_main_task_in_project_storage", side_effect=_patch),
        patch("evoflow.collab.handler_org.assert_handlers_org_ok"),
        patch("evoflow.admin.tasks.handoff_needs_approval", return_value=True),
        patch(
            "evoflow.admin.tasks._request_handoff_approval",
            return_value={"id": "appr_1", "already_pending": False},
        ),
        patch("evoflow.admin.tasks.dispatch_confirmed_handlers") as mock_dispatch,
    ):
        out = set_task_state(
            "Task_parent",
            "completed",
            summary="方案已出",
            handlers=handlers,
        )

    assert out["status"] == "awaiting_close"
    assert out.get("handlers_pending_approval") is True
    assert out.get("handoff_approval", {}).get("id") == "appr_1"
    mock_dispatch.assert_not_called()
    assert any(p.get("handlers_pending_approval") is True for p in patches)
    assert any(p.get("status") == "awaiting_close" for p in patches)


def test_reviewed_status_maps_to_completed():
    task = _task_row(risk_level="low")
    with (
        patch("evoflow.admin.tasks.get_project_storage", return_value=MagicMock()),
        patch("evoflow.admin.tasks.find_main_task", return_value=({}, task)),
        patch("evoflow.admin.tasks.patch_collab_main_task_in_project_storage", return_value=True),
        patch("evoflow.admin.tasks.handoff_needs_approval", return_value=False),
        patch("evoflow.admin.tasks.dispatch_confirmed_handlers", return_value=None),
    ):
        out = set_task_state("Task_parent", "reviewed", summary="旧交工语义")
    assert out["status"] == "completed"
    assert out["from_status"] == "executing"


def test_handoff_needs_approval_uses_autonomy_matrix():
    from evoflow.admin.tasks import handoff_needs_approval

    low = _task_row(risk_level="low")
    med = _task_row(risk_level="medium")
    role = _role(ProactiveAutonomyLevel.APPROVAL_FOR_RISKY)
    with patch("evoflow.admin.tasks._assignee_role_for_task", return_value=role):
        assert handoff_needs_approval(low) is False
        assert handoff_needs_approval(med) is True


def test_approve_dispatches_pending_handoff():
    import asyncio

    from evoflow.proactive.decision_gate import DecisionGate
    from evoflow.proactive.models import Approval, ApprovalStatus, InitiativeStatus

    gate = DecisionGate()
    approval = Approval(
        id="appr_x",
        initiative_id="task:Task_parent",
        task_id="Task_parent",
        role_agent_code="product-manager",
        channel="desktop",
        status=ApprovalStatus.PENDING,
        created_at="t",
        updated_at="t",
    )
    task = {
        "id": "Task_parent",
        "status": "awaiting_close",
        "assigned_to": "product-manager",
        "handlers_pending_approval": True,
        "handlers": [{"agent_code": "quality-inspector", "content": "x"}],
    }
    synthetic = SimpleNamespace(
        id="task:Task_parent",
        role_agent_code="product-manager",
        status=InitiativeStatus.PENDING_APPROVAL,
        approval_id=None,
        approved_by="",
        approved_at="",
    )

    with (
        patch(
            "evoflow.proactive.decision_gate.ProactiveRepository.get_approval",
            return_value=approval,
        ),
        patch("evoflow.proactive.decision_gate.ProactiveRepository.save_approval"),
        patch(
            "evoflow.proactive.decision_gate.ProactiveRepository.get_initiative",
            return_value=synthetic,
        ),
        patch("evoflow.proactive.decision_gate.ProactiveRepository.save_initiative"),
        patch(
            "evoflow.proactive.work_items.load_work_item_task",
            return_value=task,
        ),
        patch(
            "evoflow.admin.tasks.dispatch_handlers_after_approval",
            return_value=[{"ok": True}],
        ) as mock_disp,
    ):
        out = asyncio.run(
            gate.process_decision("appr_x", decision="approved", decided_by="user")
        )

    assert out is not None
    mock_disp.assert_called_once_with("Task_parent")


def test_prompt_teaches_completed_not_reviewed_handoff():
    from evoflow.proactive.models import ProactiveRole, ProactiveRoleConfig
    from evoflow.proactive.prompt import build_system_prompt

    role = ProactiveRole(
        agent_code="test",
        role_name="测试岗",
        config=ProactiveRoleConfig(responsibilities=["测"], soul_md="You are detail-oriented"),
    )
    prompt = build_system_prompt(role)
    assert "结案" in prompt
    assert "验收要点" in prompt or "怎么工作" in prompt
    assert "待确认" not in prompt
    assert "勿自己 completed" not in prompt


def test_awaiting_close_accept_to_completed_without_handlers():
    task = _task_row(status="awaiting_close", progress=100, risk_level="low")
    with (
        patch("evoflow.admin.tasks.get_project_storage", return_value=MagicMock()),
        patch("evoflow.admin.tasks.find_main_task", return_value=({}, task)),
        patch("evoflow.admin.tasks.patch_collab_main_task_in_project_storage", return_value=True),
        patch("evoflow.admin.tasks.task_handlers_of", return_value=[]),
        patch("evoflow.admin.tasks.handoff_needs_approval", return_value=False),
        patch("evoflow.admin.tasks.dispatch_confirmed_handlers", return_value=None),
    ):
        out = set_task_state("Task_parent", "completed", summary="提出人验收通过")
    assert out["status"] == "completed"
    assert out["from_status"] == "awaiting_close"
