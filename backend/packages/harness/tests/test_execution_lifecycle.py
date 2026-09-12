"""Task execution lifecycle: authorize intent and progress labels."""

from __future__ import annotations

from evoflow.collab.execution_lifecycle import (
    LIFECYCLE_AUTHORIZED,
    LIFECYCLE_AWAITING_AUTHORIZATION,
    infer_main_task_lifecycle_stage,
    lifecycle_label_zh,
    user_execution_start_intent,
)


def test_user_execution_start_intent_structured() -> None:
    payload = '__EVF_CLARIFY_ANS_V1__: {"answers":[{"selected_option_labels":["开始执行"]}]}'
    assert user_execution_start_intent(payload) is True


def test_user_execution_start_intent_natural_language() -> None:
    assert user_execution_start_intent("开始执行") is True
    assert user_execution_start_intent("好的，按计划开始执行") is True
    assert user_execution_start_intent("继续修改计划") is False


def test_lifecycle_awaiting_authorization() -> None:
    task = {
        "status": "planned",
        "execution_authorized": False,
        "plan_goal": "x",
        "plan_steps": [{"ref": 1, "name": "s1", "goal": "x", "inputs": "i", "outputs": "o", "acceptance": "a", "failure": "f", "assigned_agent": "general-purpose"}],
    }
    stage = infer_main_task_lifecycle_stage(task, collab_phase="plan_ready")
    assert stage == LIFECYCLE_AWAITING_AUTHORIZATION
    assert lifecycle_label_zh(stage) == "待授权开始执行"


def test_lifecycle_authorized() -> None:
    task = {"status": "planned", "execution_authorized": True}
    stage = infer_main_task_lifecycle_stage(task, collab_phase="awaiting_exec")
    assert stage == LIFECYCLE_AUTHORIZED
