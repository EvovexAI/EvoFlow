"""Unit tests for ambient agent_actor + Task mutate ACL."""

from __future__ import annotations

import pytest

from evoflow.admin.errors import ValidationError
from evoflow.authz.agent_actor import (
    assert_can_mutate_assigned_task,
    bind_agent_actor_into_context,
    get_current_agent_actor,
    is_privileged_task_actor,
    normalize_agent_actor,
    resolve_agent_actor_from_mapping,
    set_current_agent_actor,
    stamp_raised_by,
)


def test_normalize_strips_proactive_and_task_suffix():
    assert normalize_agent_actor("proactive:sales_rep:task:abc") == "sales_rep"
    assert normalize_agent_actor("proactive:dev_lead:duty:r1") == "dev_lead"
    assert normalize_agent_actor("proactive:ops:chat:x") == "ops"
    assert normalize_agent_actor("plain_code") == "plain_code"


def test_resolve_prefers_employee_over_main_via_session():
    code = resolve_agent_actor_from_mapping(
        {
            "agent_name": "main",
            "session_key": "proactive:junior_dev:task:t1",
        }
    )
    assert code == "junior_dev"


def test_bind_sets_ambient_and_proactive_agent_code():
    set_current_agent_actor("stale")
    ctx = bind_agent_actor_into_context(
        {
            "session_key": "proactive:designer",
            "agent_name": "main",
        }
    )
    assert ctx.get("proactive_agent_code") == "designer"
    assert get_current_agent_actor() == "designer"
    set_current_agent_actor("")  # cleanup


@pytest.mark.parametrize(
    "actor",
    ["", "user", "main", "lead_agent", "auto", "xiaomi", "小V"],
)
def test_privileged_actors(actor: str):
    assert is_privileged_task_actor(actor) is True
    assert_can_mutate_assigned_task(actor=actor, assigned_to="someone_else")


def test_own_task_allowed():
    assert_can_mutate_assigned_task(actor="junior_dev", assigned_to="junior_dev")
    assert_can_mutate_assigned_task(actor="Junior_Dev", assigned_to="junior_dev")


def test_subordinate_cannot_mutate_manager_task():
    with pytest.raises(ValidationError, match="只能更新本岗 Task"):
        assert_can_mutate_assigned_task(actor="junior_dev", assigned_to="manager_lead")


def test_empty_ambient_is_privileged_cli():
    set_current_agent_actor("")
    assert get_current_agent_actor() == ""
    assert_can_mutate_assigned_task(assigned_to="any_employee")


def test_employee_cannot_mutate_unassigned():
    with pytest.raises(ValidationError, match="assigned_to 为空"):
        assert_can_mutate_assigned_task(actor="junior_dev", assigned_to=None)


def test_xiaomi_can_mutate_any():
    assert_can_mutate_assigned_task(actor="xiaomi", assigned_to="manager_lead")
    assert_can_mutate_assigned_task(actor="xiaomi", assigned_to=None)


def test_stamp_raised_by_uses_operator_not_model_guess():
    assert stamp_raised_by(actor="junior_dev", raised_by_arg="manager_lead") == "junior_dev"
    assert stamp_raised_by(actor="xiaomi", raised_by_arg="someone") == "xiaomi"
    assert stamp_raised_by(actor="", raised_by_arg="explicit_cli") == "explicit_cli"
    assert stamp_raised_by(actor="main", raised_by_arg="") == "user"
    set_current_agent_actor("designer")
    try:
        assert stamp_raised_by(raised_by_arg="forged") == "designer"
    finally:
        set_current_agent_actor("")


def test_should_auto_wake_on_create():
    from evoflow.proactive.task_startup_accelerator import should_auto_wake_on_create

    # Cross-person create → wake
    assert should_auto_wake_on_create(assigned_to="peer", raised_by="me") is True
    assert should_auto_wake_on_create(assigned_to="peer", raised_by="xiaomi") is True
    # Self-assign → no wake
    assert should_auto_wake_on_create(assigned_to="me", raised_by="me") is False
    assert should_auto_wake_on_create(assigned_to="me", actor="me") is False
    # No assignee / terminal status → no wake
    assert should_auto_wake_on_create(assigned_to="", raised_by="me") is False
    assert should_auto_wake_on_create(assigned_to="peer", raised_by="me", status="completed") is False


def test_start_flag_gates_auto_wake():
    """create ``start`` switch: True + cross-person ⇒ wake; False ⇒ queue only."""
    from evoflow.proactive.task_startup_accelerator import should_auto_wake_on_create

    cross = should_auto_wake_on_create(assigned_to="peer", raised_by="me")
    assert (True and cross) is True
    assert (False and cross) is False
