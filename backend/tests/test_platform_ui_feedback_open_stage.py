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
    view = next(a for a in actions if a.get("label") == "查看任务")
    assert view["openStage"]["kind"] == "shell-page"
    assert view["openStage"]["data"]["path"] == "/task/mt-wf"
    # 已有进度 CTA：详情不 autoOpen
    assert view.get("autoOpen") is not True


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
    assert progress["autoOpen"] is True
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
    assert progress["autoOpen"] is True
    assert progress["openStage"]["kind"] == "employeeProcess"
    assert progress["openStage"]["data"]["taskId"] == "mt-wake"
    assert progress["openStage"]["data"]["agentCode"] == "duty-ops"
    assert progress["openStage"]["data"]["roundId"] == "r1"


def test_items_dispatch_open_stage_auto_open():
    entry = _entry("items.dispatch", "items")
    result = {
        "ok": True,
        "action": "items.dispatch",
        "task_id": "mt-item",
        "agent_code": "frontend-ops",
        "dispatched": True,
    }
    ui = build_platform_ui_feedback(
        entry,
        {"item_id": "it-1", "agent_code": "frontend-ops"},
        result,
    )
    assert ui is not None
    progress = next(a for a in ui["actions"] if a.get("label") == "查看进度")
    assert progress["autoOpen"] is True
    assert progress["openStage"]["kind"] == "employeeProcess"
    assert progress["openStage"]["data"]["taskId"] == "mt-item"
    assert progress["openStage"]["data"]["agentCode"] == "frontend-ops"


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
    view = next(a for a in ui["actions"] if a.get("label") == "查看员工")
    assert view["autoOpen"] is True
    assert view["openStage"]["kind"] == "shell-page"
    assert view["openStage"]["data"]["path"] == "/proactive/duty-ops"
    assert view["openStage"]["data"]["mountId"] == "employees.detail"
    assert view["route"] == "/proactive/duty-ops"


def test_employees_update_shell_page_auto_open():
    entry = _entry("employees.update", "employees")
    result = {
        "ok": True,
        "action": "employees.update",
        "agent_code": "duty-ops",
        "role_name": "值班",
    }
    ui = build_platform_ui_feedback(entry, {"agent_code": "duty-ops"}, result)
    assert ui is not None
    view = next(a for a in ui["actions"] if a.get("label") == "查看员工")
    assert view["autoOpen"] is True
    assert view["openStage"]["kind"] == "shell-page"
    assert view["openStage"]["data"]["path"] == "/proactive/duty-ops"


def test_employees_create_with_task_prefers_progress_auto_open():
    """带 task 的 create：进度 autoOpen，详情不抢栏。"""
    entry = _entry("employees.create", "employees")
    result = {
        "ok": True,
        "action": "employees.create",
        "agent_code": "duty-ops",
        "task_id": "mt-1",
        "role_name": "值班",
    }
    ui = build_platform_ui_feedback(entry, {"agent_code": "duty-ops"}, result)
    assert ui is not None
    progress = next(a for a in ui["actions"] if a.get("label") == "查看进度")
    assert progress["autoOpen"] is True
    view = next(a for a in ui["actions"] if a.get("label") == "查看员工")
    assert view.get("autoOpen") is not True
    assert view["openStage"]["kind"] == "shell-page"


def test_employees_delete_notifies_without_view_employee_cta():
    """删除后实体已不存在：仍有平台通知，但不挂「查看员工」。"""
    entry = _entry("employees.delete", "employees", risk="destructive")
    result = {
        "ok": True,
        "action": "employees.delete",
        "agent_code": "duty-ops",
        "role_name": "值班",
        "deleted": True,
    }
    ui = build_platform_ui_feedback(entry, {"agent_code": "duty-ops"}, result)
    assert ui is not None
    assert ui["kind"] == "warning"
    assert "删除" in ui["title"] or "已删除" in ui["title"]
    assert ui["actions"] == []
    assert not any(a.get("label") == "查看员工" for a in ui["actions"])


def test_workflow_run_open_stage_auto_open():
    entry = _entry("workflow.run", "workflow")
    result = {
        "ok": True,
        "action": "workflow.run",
        "runId": "run-1",
        "task_id": "mt-app-run",
        "run": {"run_id": "run-1", "task_id": "mt-app-run"},
    }
    ui = build_platform_ui_feedback(entry, {"appId": "App_x"}, result)
    assert ui is not None
    progress = next(a for a in ui["actions"] if a.get("label") == "查看进度")
    assert progress["autoOpen"] is True
    assert progress["openStage"]["kind"] == "collab-workflow"
    assert progress["openStage"]["data"]["mainTaskId"] == "mt-app-run"


def test_workflow_create_without_task_has_no_progress_cta():
    entry = _entry("workflow.create", "workflow")
    result = {
        "ok": True,
        "action": "workflow.create",
        "appId": "App_new",
        "name": "日报",
    }
    ui = build_platform_ui_feedback(entry, {"name": "日报"}, result)
    assert ui is not None
    assert not any(a.get("openStage") for a in ui["actions"])
