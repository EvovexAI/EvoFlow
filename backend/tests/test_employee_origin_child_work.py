"""Origin-session employee child_work → bottom-dock avatar trail."""

from __future__ import annotations

import pytest


@pytest.fixture()
def _schema_ready(tmp_path, monkeypatch):
    db_path = tmp_path / "emp_child.db"
    monkeypatch.setenv("EVOFLOW_DB_PATH", str(db_path))
    from evoflow.persistence.db import get_db, reset_db_for_tests
    from evoflow.persistence.schema import ensure_app_schema

    reset_db_for_tests()
    ensure_app_schema(get_db())
    yield
    reset_db_for_tests()


def test_register_on_origin_not_employee_session(_schema_ready):
    from evoflow.collab.employee_child_work import (
        KIND_EMPLOYEE,
        register_origin_employee_child_work,
    )
    from evoflow.persistence.session_runtime_repository import list_child_works

    origin = "agent:main:thread-1"
    row = register_origin_employee_child_work(
        origin_session_key=origin,
        agent_code="dev-qa",
        role_name="测试工程师",
        employee_session_key="proactive:dev-qa:chat:1",
        source="dispatch",
        goal_preview="打个招呼",
    )
    assert row and row.get("kind") == KIND_EMPLOYEE
    assert str(row.get("ref_id") or "").startswith("dev-qa@")
    active = list_child_works(origin, active_only=True)
    assert len(active) == 1
    assert active[0]["extra"].get("role_name") == "测试工程师"

    # Same employee from a second caller chat must not collide on work_id.
    origin2 = "agent:main:thread-2"
    row2 = register_origin_employee_child_work(
        origin_session_key=origin2,
        agent_code="dev-qa",
        role_name="测试工程师",
    )
    assert row2 and row2.get("work_id") != row.get("work_id")
    assert list_child_works(origin2, active_only=True)

    # Must not hang icon on the employee trail itself.
    assert (
        register_origin_employee_child_work(
            origin_session_key="proactive:dev-qa:duty:x",
            agent_code="dev-qa",
        )
        is None
    )


def test_soft_idle_without_reply_blocks_icon_complete(_schema_ready):
    from evoflow.collab.employee_child_work import (
        register_origin_employee_child_work,
        soft_session_end_may_complete_icons,
    )

    origin = "agent:xiaomi:s1"
    emp = "proactive:dev-qa:chat:9"
    register_origin_employee_child_work(
        origin_session_key=origin,
        agent_code="dev-qa",
        employee_session_key=emp,
    )
    assert (
        soft_session_end_may_complete_icons(
            employee_session_key=emp,
            agent_code="dev-qa",
            run_status="done",
            reason="langgraph_idle",
        )
        is False
    )
    assert (
        soft_session_end_may_complete_icons(
            employee_session_key=emp,
            agent_code="dev-qa",
            run_status="completed",
            reason="agent_completed",
        )
        is True
    )


def test_reregister_clears_ended_at(_schema_ready):
    from evoflow.collab.employee_child_work import (
        complete_origin_employee_child_works,
        register_origin_employee_child_work,
    )
    from evoflow.persistence.session_runtime_repository import list_child_works

    origin = "agent:xiaomi:s2"
    register_origin_employee_child_work(
        origin_session_key=origin,
        agent_code="dev-qa",
        employee_session_key="proactive:dev-qa:chat:a",
    )
    complete_origin_employee_child_works(agent_code="dev-qa", status="completed")
    done = list_child_works(origin, active_only=False)
    assert done and done[0]["status"] == "completed" and done[0].get("ended_at")
    again = register_origin_employee_child_work(
        origin_session_key=origin,
        agent_code="dev-qa",
        employee_session_key="proactive:dev-qa:chat:a",
        goal_preview="再来一遍",
    )
    assert again and again["status"] == "running"
    assert not again.get("ended_at")
    active = list_child_works(origin, active_only=True)
    assert len(active) == 1


def test_complete_clears_origin_icon(_schema_ready):
    from evoflow.collab.employee_child_work import (
        complete_origin_employee_child_works,
        register_origin_employee_child_work,
    )
    from evoflow.persistence.session_runtime_repository import list_child_works

    origin = "agent:xiaomi:s1"
    register_origin_employee_child_work(
        origin_session_key=origin,
        agent_code="dev-qa",
        duty_run_id="duty_abc",
        employee_session_key="proactive:dev-qa:chat:9",
    )
    n = complete_origin_employee_child_works(
        agent_code="dev-qa",
        duty_run_id="duty_abc",
        status="completed",
    )
    assert n == 1
    assert list_child_works(origin, active_only=True) == []
