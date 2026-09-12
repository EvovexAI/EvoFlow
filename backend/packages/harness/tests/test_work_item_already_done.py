"""Guards against re-dispatching already finished board Tasks."""

from __future__ import annotations

from evoflow.proactive.work_items import (
    extract_task_ids_from_text,
    format_task_board_for_prompt,
    is_work_item_done,
)


def test_is_work_item_done_terminal_statuses() -> None:
    assert is_work_item_done("reviewed")
    assert is_work_item_done("completed")
    assert is_work_item_done("cancelled")
    assert not is_work_item_done("awaiting_close")
    assert not is_work_item_done("awaiting_close", progress=100)
    assert not is_work_item_done("pending")
    assert not is_work_item_done("executing", progress=40)
    assert is_work_item_done("executing", progress=100)


def test_extract_task_ids_preserves_order() -> None:
    text = (
        "重试 Task_20260721072714_620865 和 Task_20260721062746_537245；"
        "再看 Task_20260721072714_620865"
    )
    ids = extract_task_ids_from_text(text)
    assert ids == [
        "Task_20260721072714_620865",
        "Task_20260721062746_537245",
    ]


def test_extract_task_ids_accepts_short_form() -> None:
    text = "继续 2607250827_a3f9 与 Task_20260725082222_399713"
    ids = extract_task_ids_from_text(text)
    assert ids == ["2607250827_a3f9", "Task_20260725082222_399713"]


def test_format_board_warns_against_redo() -> None:
    text = format_task_board_for_prompt(
        [
            {
                "task_id": "Task_1",
                "name": "文案替换",
                "status": "pending",
                "progress": 0,
                "description": "替换 tasks.js",
            }
        ]
    )
    assert "勿因结果文案含「超时」" in text
    assert "Task_1" in text
    assert "[pending]" in text


def test_system_prompt_requires_mind_map_and_progress() -> None:
    from evoflow.proactive.models import ProactiveRole, ProactiveRoleConfig
    from evoflow.proactive.prompt import build_system_prompt

    role = ProactiveRole(
        agent_code="fe",
        role_name="前端工程师",
        config=ProactiveRoleConfig(responsibilities=["修 UI"]),
    )
    prompt = build_system_prompt(role)
    assert "proactive_live_tasks" in prompt
    assert "思维导图" in prompt or "mind_map" in prompt
    assert "不强制" in prompt or "可选" in prompt or "进度" in prompt
    # Must not require concurrent mind_map on every dig turn
    assert "必须并行" not in prompt
    assert "须同批并发" not in prompt


def test_live_duty_tasks_section_empty() -> None:
    from evoflow.proactive.models import ProactiveRole, ProactiveRoleConfig
    from evoflow.proactive.work_items import format_live_duty_tasks_section

    role = ProactiveRole(
        agent_code="no-such-role-xyz",
        role_name="不存在的岗",
        config=ProactiveRoleConfig(),
    )
    text = format_live_duty_tasks_section(role)
    assert "<proactive_live_tasks>" in text
    assert "</proactive_live_tasks>" in text
    assert "暂无未结" in text
