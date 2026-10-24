"""platform_ui_feedback: 查看进度 openStage CTA for tasks / employees."""

from evoflow.admin.platform_actions import PlatformAction
from evoflow.admin.platform_ui_feedback import build_platform_ui_feedback


def _entry(name: str, domain: str, risk: str = "write") -> PlatformAction:
    return PlatformAction(
        name=name,
        domain=domain,
        summary="",
        risk=risk,
        params="",
    )


def test_tasks_create_workflow_open_stage():
    entry = _entry("tasks.create", "tasks")
    result = {
        "ok": True,
        "action": "tasks.create",
        "task_id": "mt-wf",
        "task": {"id": "mt-wf", "name": "拆解", "source": "chat"},
    }
    ui = build_platform_ui_feedback(entry, {}, result)
    assert ui is not None
    actions = ui["actions"]
    progress = next(a for a in actions if a.get("label") == "查看进度")
    assert progress["openStage"]["kind"] == "collab-workflow"
    assert progress["openStage"]["data"]["mainTaskId"] == "mt-wf"
    assert any(a.get("route") for a in actions)


def test_tasks_create_employee_open_stage():
    entry = _entry("tasks.create", "tasks")
    result = {
        "ok": True,
        "action": "tasks.create",
        "task": {
            "id": "mt-emp",
            "name": "值班",
            "source": "role",
            "assigned_to": "duty-ops",
        },
    }
    ui = build_platform_ui_feedback(entry, {}, result)
    assert ui is not None
    progress = next(a for a in ui["actions"] if a.get("label") == "查看进度")
    assert progress["openStage"]["kind"] == "employeeProcess"
    assert progress["openStage"]["data"]["taskId"] == "mt-emp"
    assert progress["openStage"]["data"]["agentCode"] == "duty-ops"


def test_employees_wake_open_stage_when_task_present():
    entry = _entry("employees.wake", "employees")
    result = {
        "ok": True,
        "action": "employees.wake",
        "agent_code": "duty-ops",
        "task_id": "mt-wake",
        "round_id": "r1",
    }
    ui = build_platform_ui_feedback(entry, {"agent_code": "duty-ops"}, result)
    assert ui is not None
    progress = next(a for a in ui["actions"] if a.get("label") == "查看进度")
    assert progress["openStage"]["kind"] == "employeeProcess"
    assert progress["openStage"]["data"]["taskId"] == "mt-wake"
    assert progress["openStage"]["data"]["agentCode"] == "duty-ops"
    assert progress["openStage"]["data"]["roundId"] == "r1"


def test_employees_create_without_task_has_no_progress_cta():
    entry = _entry("employees.create", "employees")
    result = {
        "ok": True,
        "action": "employees.create",
        "agent_code": "duty-ops",
        "role_name": "值班",
    }
    ui = build_platform_ui_feedback(entry, {"agent_code": "duty-ops"}, result)
    assert ui is not None
    assert not any(a.get("label") == "查看进度" for a in ui["actions"])
