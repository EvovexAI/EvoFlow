"""Duty brief Task board formatting."""

from __future__ import annotations

from evoflow.proactive.models import ProactiveMemory, ProactiveRole, ProactiveRoleConfig
from evoflow.proactive.prompt import build_user_prompt
from evoflow.proactive.work_items import format_task_board_for_prompt


def test_format_task_board_includes_id_status_progress_description() -> None:
    text = format_task_board_for_prompt(
        [
            {
                "task_id": "Task_20260720063318_526981",
                "name": "评估有机交班方案",
                "description": "方案在 outputs/organic-handoff-plan.md；拆 FE/BE/QA。",
                "status": "executing",
                "progress": 30,
                "raised_by": "product-manager",
                "parent_task_id": "Task_parent",
            }
        ]
    )
    assert "`Task_20260720063318_526981`" in text
    assert "[executing]" in text
    assert "30%" in text
    assert "outputs/organic-handoff-plan.md" in text
    assert "parent=`Task_parent`" in text
    assert "raised_by=product-manager" in text


def test_user_prompt_leads_with_task_board_not_initiative_shell() -> None:
    role = ProactiveRole(
        agent_code="quality-inspector",
        role_name="技术总监",
        config=ProactiveRoleConfig(),
    )
    board = format_task_board_for_prompt(
        [
            {
                "task_id": "Task_abc",
                "name": "评估方案",
                "description": "完整描述应出现在 brief",
                "status": "pending",
                "progress": 0,
            }
        ]
    )
    work_log = (
        "## 工作日志\n"
        "  🚫 [rejected] id=`task:Task_abc` 任务: 评估方案\n"
        "    -> 驳回原因（勿再提同题）: 无需处理\n"
    )
    prompt = build_user_prompt(
        role,
        ProactiveMemory(role_agent_code="quality-inspector"),
        work_log=work_log,
        task_board=board,
    )
    assert prompt.index("本岗看板 Task") < prompt.index("近况（审批")
    assert "`Task_abc`" in prompt
    assert "完整描述应出现在 brief" in prompt
    assert "勿把 id=`task:…` 当 CLI task_id" in prompt
