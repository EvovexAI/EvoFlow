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


def test_skills_cta_goes_to_settings_skill_management_not_asset_market():
    """`/skills` 是资源中心市场页；通知「打开技能」必须进设置 → 技能。"""
    entry = _entry("skills.import_orphans", "skills")
    result = {
        "ok": True,
        "action": "skills.import_orphans",
        "imported": 3,
        "name": "custom",
    }
    ui = build_platform_ui_feedback(entry, {}, result)
    assert ui is not None
    skill = next(a for a in ui["actions"] if "技能" in str(a.get("label") or ""))
    assert skill["route"] == "/settings?tab=skill-management"


def test_mcp_cta_goes_to_settings_connectors():
    entry = _entry("mcp.install", "mcp")
    result = {"ok": True, "action": "mcp.install", "name": "demo"}
    ui = build_platform_ui_feedback(entry, {}, result)
    assert ui is not None
    mcp = next(a for a in ui["actions"] if "MCP" in str(a.get("label") or ""))
    assert mcp["route"] == "/settings?tab=mcp-connectors"


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
    assert progress["autoOpen"] is True
    assert progress["openStage"]["kind"] == "collab-workflow"
    assert progress["openStage"]["data"]["mainTaskId"] == "mt-wf"
    view = next(a for a in actions if a.get("label") == "查看任务")
    assert view["openStage"]["kind"] == "shell-page"
    assert view["openStage"]["data"]["path"] == "/task/mt-wf"
    # 已有进度 CTA：详情不抢栏（进度已 autoOpen）
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
        "role_name": "值班",
    }
    ui = build_platform_ui_feedback(entry, {"agent_code": "duty-ops"}, result)
    assert ui is not None
    progress = next(a for a in ui["actions"] if a.get("label") == "查看进度")
    assert progress["autoOpen"] is True
    assert progress["openStage"]["kind"] == "employeeProcess"
    assert progress["openStage"]["title"] == "值班"
    assert progress["openStage"]["data"]["taskId"] == "mt-wake"
    assert progress["openStage"]["data"]["agentCode"] == "duty-ops"
    assert progress["openStage"]["data"]["roleName"] == "值班"
    assert progress["openStage"]["data"]["roundId"] == "r1"


def test_employees_dispatch_open_stage_without_task_id():
    """派活常无 task_id：仍 autoOpen 员工实时进度（按 agent 跟对话）。"""
    entry = _entry("employees.dispatch", "employees")
    result = {
        "ok": True,
        "action": "employees.dispatch",
        "agent_code": "duty-ops",
        "role_name": "值班",
        "dispatched": True,
        "goal": "写周报",
    }
    ui = build_platform_ui_feedback(
        entry,
        {"agent_code": "duty-ops", "goal": "写周报"},
        result,
    )
    assert ui is not None
    progress = next(a for a in ui["actions"] if a.get("label") == "查看进度")
    assert progress["autoOpen"] is True
    assert progress["openStage"]["kind"] == "employeeProcess"
    assert progress["openStage"]["data"]["agentCode"] == "duty-ops"
    # 无真实 task 时用 live:{code} 占位，前端按 agent 跟岗对话
    assert progress["openStage"]["data"]["taskId"] == "live:duty-ops"


def test_employees_dispatch_drops_caller_main_session_key():
    """platform 注入的 agent:main:* 不能写进 CTA，否则右栏与左侧主聊同流。"""
    entry = _entry("employees.dispatch", "employees")
    result = {
        "ok": True,
        "action": "employees.dispatch",
        "agent_code": "dev-tech-director",
        "role_name": "技术总监",
        "dispatched": True,
        "scheduled": True,
    }
    ui = build_platform_ui_feedback(
        entry,
        {
            "agent_code": "dev-tech-director",
            "goal": "再来一单",
            "session_key": "agent:main:new-10a8acbd",
        },
        result,
    )
    assert ui is not None
    progress = next(a for a in ui["actions"] if a.get("label") == "查看进度")
    data = progress["openStage"]["data"]
    assert data["agentCode"] == "dev-tech-director"
    assert "sessionKey" not in data
    assert "session_key" not in data


def test_employees_chat_send_keeps_owned_proactive_session_key():
    entry = _entry("employees.chat_send", "employees")
    result = {
        "ok": True,
        "action": "employees.chat_send",
        "agent_code": "dev-qa",
        "role_name": "测试",
        "session_key": "proactive:dev-qa:chat:abc",
        "queued": True,
    }
    ui = build_platform_ui_feedback(
        entry,
        {"agent_code": "dev-qa", "session_key": "agent:main:caller"},
        result,
    )
    assert ui is not None
    progress = next(a for a in ui["actions"] if a.get("label") == "打开对话")
    assert progress["openStage"]["data"]["sessionKey"] == "proactive:dev-qa:chat:abc"


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


def test_employees_get_shell_page_no_auto_open():
    """查看员工详情（read）→ 出可点卡片，不自动展开右栏。

    【self-evolution-bot · 2026-11-20 · 第88轮 · 模型:deepseek-v4.1-flash-1017】
    改了什么：断言从 autoOpen is True 反转为不开。
    为什么：employees.get 在真源 READ_ONLY_ACTIONS 里，第87轮只翻转了 list 一类，
    本函数内还有一个私有白名单把它硬写成 auto_open=True —— 同一文件两套判据。
    用户「莫名其妙打开东西」里就有「只查一下谁在干嘛」这一条。
    """
    entry = _entry("employees.get", "employees", risk="read")
    result = {
        "ok": True,
        "action": "employees.get",
        "agent_code": "duty-ops",
        "role_name": "值班",
    }
    ui = build_platform_ui_feedback(entry, {"agent_code": "duty-ops"}, result)
    assert ui is not None
    assert "值班" in ui["title"]
    view = next(a for a in ui["actions"] if a.get("label") == "查看员工")
    assert not view.get("autoOpen")
    assert view["openStage"]["kind"] == "shell-page"
    assert view["openStage"]["data"]["path"] == "/proactive/duty-ops"
    assert view["openStage"]["data"]["mountId"] == "employees.detail"


def test_employees_list_shell_page_no_auto_open():
    """查看员工列表 → 只出可点通知卡，**不自动展开右栏**。

    【self-evolution-bot · 2026-11-20 · 第87轮 · 模型:deepseek-v4.1-flash-1017】
    改了什么：断言从 autoOpen is True 反转为不开。
    为什么：用户 2026-11-20 定「有通知就够了，右侧不要突然展开」。employees.list
    是纯只读查询，原来一调就把右栏顶开，是「莫名其妙打开东西」的主因。
    """
    entry = _entry("employees.list", "employees", risk="read")
    result = {
        "ok": True,
        "action": "employees.list",
        "roles": [{"agent_code": "a"}, {"agent_code": "b"}],
    }
    ui = build_platform_ui_feedback(entry, {}, result)
    assert ui is not None
    assert ui["title"] == "员工列表"
    view = next(a for a in ui["actions"] if a.get("label") == "打开员工")
    assert not view.get("autoOpen")
    assert view["openStage"]["kind"] == "shell-page"
    assert view["openStage"]["data"]["path"] == "/proactive"
    assert view["openStage"]["data"]["mountId"] == "employees.board"


def test_employees_brief_shell_page_no_auto_open():
    """单岗近况 brief → 出可点卡片，不自动展开右栏。

    【self-evolution-bot · 2026-11-20 · 第88轮 · 模型:deepseek-v4.1-flash-1017】
    改了什么：断言从 autoOpen is True 反转为不开。
    为什么：employees.brief 是 READ_ONLY_ACTIONS 成员。语音要「自动弹开看效果」时
    走的是小V提示词里明确的 `platform ui.show` 主动展示通道（agents/xiaomi/prompt.py
    第30/34行），不依赖事件自动开。用 auto 通道去兜语音场景，代价是每查一次近况都
    强开右栏 —— 这正是用户投诉的体感。能力没有减少，只是换了正确通道。
    """
    entry = _entry("employees.brief", "employees", risk="read")
    result = {
        "ok": True,
        "action": "employees.brief",
        "agent_code": "duty-ops",
        "role_name": "值班",
        "watch_path": "/proactive/duty-ops?live=1",
    }
    ui = build_platform_ui_feedback(entry, {"agent_code": "duty-ops"}, result)
    assert ui is not None
    assert "值班" in ui["title"]
    view = next(a for a in ui["actions"] if a.get("label") == "查看员工")
    assert not view.get("autoOpen")
    assert view["openStage"]["kind"] == "shell-page"
    assert view["openStage"]["data"]["path"] == "/proactive/duty-ops"
    assert view["openStage"]["data"]["mountId"] == "employees.detail"


def test_employees_board_overview_shell_page_no_auto_open():
    """看板总览 → 只出通知卡，不自动展开右栏（第87轮：只读不弹）。"""
    entry = _entry("employees.board_overview", "employees", risk="read")
    result = {"ok": True, "action": "employees.board_overview", "cards": []}
    ui = build_platform_ui_feedback(entry, {}, result)
    assert ui is not None
    view = next(a for a in ui["actions"] if a.get("label") == "打开员工")
    assert not view.get("autoOpen")
    assert view["openStage"]["data"]["path"] == "/proactive"


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
        "appId": "App_x",
        "runId": "run-1",
        "task_id": "mt-app-run",
        "run": {"run_id": "run-1", "task_id": "mt-app-run"},
    }
    ui = build_platform_ui_feedback(entry, {"appId": "App_x"}, result)
    assert ui is not None
    progress = next(a for a in ui["actions"] if a.get("label") == "打开工作流")
    assert progress["autoOpen"] is True
    assert progress["openStage"]["kind"] == "collab-workflow"
    assert progress["openStage"]["data"]["mainTaskId"] == "mt-app-run"
    # 右栏失败时的深链回落；不得是 /apps 列表
    assert progress.get("route") == "/apps/App_x/run?runId=run-1"
    assert not any(str(a.get("route") or "").rstrip("/") == "/apps" for a in ui["actions"])


def test_tasks_list_shell_page_no_auto_open():
    """任务列表（纯只读）→ 只出可点通知卡，不自动展开右栏（第87轮）。"""
    entry = _entry("tasks.list", "tasks", risk="read")
    result = {"ok": True, "action": "tasks.list", "tasks": [{"id": "mt-1"}]}
    ui = build_platform_ui_feedback(entry, {}, result)
    assert ui is not None
    view = next(a for a in ui["actions"] if a.get("label") == "打开任务")
    assert not view.get("autoOpen")
    assert view["openStage"]["kind"] == "shell-page"
    assert view["openStage"]["data"]["path"] == "/tasks"
    assert view["openStage"]["data"]["mountId"] == "tasks.board"


def test_items_list_shell_page_no_auto_open():
    """待办列表（纯只读）→ 只出通知卡，不自动展开右栏（第87轮）。"""
    entry = _entry("items.list", "items", risk="read")
    result = {"ok": True, "action": "items.list", "items": []}
    ui = build_platform_ui_feedback(entry, {}, result)
    assert ui is not None
    view = next(a for a in ui["actions"] if a.get("label") == "打开待办")
    assert not view.get("autoOpen")
    assert view["openStage"]["data"]["path"] == "/tasks/items"
    assert view["openStage"]["data"]["mountId"] == "items.board"


def test_items_create_shell_page_no_auto_open():
    """新建待办成功 → 出通知卡，右栏不自动弹（第87轮：要通知，不要抢视线）。"""
    entry = _entry("items.create", "items")
    result = {
        "ok": True,
        "action": "items.create",
        "item": {"id": "it-1", "title": "周五交报告"},
        "item_id": "it-1",
    }
    ui = build_platform_ui_feedback(entry, {}, result)
    assert ui is not None
    view = next(a for a in ui["actions"] if a.get("label") == "查看事项")
    assert not view.get("autoOpen")
    assert view["openStage"]["kind"] == "shell-page"
    assert view["openStage"]["data"]["path"] == "/tasks/items"
    assert view["openStage"]["data"]["mountId"] == "items.board"
    assert view["openStage"]["data"]["focusId"] == "it-1"
    assert "tab=items" in view["route"]


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


# ── 第87轮：右栏类型契约单一真源 + 只读不自动弹 的回归锁 ──────────────────
# 【self-evolution-bot · 2026-11-20 · 第87轮 · 模型:deepseek-v4.1-flash-1017】
# 改了什么：新增这两条测试，锁住「只读动作永不自动展开」与「契约只有一个真源」。
# 为什么：这两条规则原来前后端各写一遍且已漂移，没有测试挡着就会再漂回去。


def test_read_only_actions_never_auto_open():
    """所有只读动作的 should_auto_open 必须为 False（用户 2026-11-20 硬要求）。"""
    from evoflow.stage.right_panel_kinds import READ_ONLY_ACTIONS, should_auto_open

    leaked = [action for action in READ_ONLY_ACTIONS if should_auto_open(action)]
    assert not leaked, f"只读动作不应自动展开右栏，但以下被判为可自动开：{leaked}"


def test_write_actions_still_auto_open():
    """真在办事的动作仍必须自动展开（别把只读那刀砍过头）。"""
    from evoflow.stage.right_panel_kinds import should_auto_open

    for action in (
        "employees.wake",
        "employees.dispatch",
        "workflow.run",
        "workflow.resume",
    ):
        assert should_auto_open(action) is True, f"{action} 应允许自动展开"


def test_read_only_action_in_shell_whitelist_yields_no_auto_open():
    """只读壳页白名单里，每个 action 出的 CTA 都不得带 autoOpen。"""
    for action in (
        "employees.get",
        "employees.list",
        "tasks.get",
        "tasks.list",
        "items.get",
        "items.list",
    ):
        domain = action.split(".", 1)[0]
        entry = _entry(action, domain, risk="read")
        ui = build_platform_ui_feedback(entry, {}, {"ok": True, "action": action})
        assert ui is not None, f"{action} 应仍出通知卡"
        eager = [a for a in ui["actions"] if a.get("autoOpen")]
        assert not eager, f"{action} 不应自动展开，但 {eager} 带了 autoOpen"


def test_employee_process_contract_allows_agent_only():
    """employeeProcess 只强制 agentCode；taskId 可选（契约真源与实现一致）。"""
    from evoflow.stage.right_panel_kinds import missing_fields

    assert missing_fields("employeeProcess", {"agentCode": "duty-ops"}) == []
    assert missing_fields("employeeProcess", {}) == ["data.agentCode"]
    assert missing_fields("collabSubtaskTranscript", {"mainTaskId": "m"}) == [
        "data.subtaskId"
    ]


def test_ui_kinds_exposes_contract_to_model():
    """模型侧的 ui.kinds 必须能读出类型清单与触发规则。"""
    from evoflow.admin.platform_handlers import ui_kinds

    out = ui_kinds({})
    assert out["ok"] is True
    kinds = {spec["kind"] for spec in out["kinds"]}
    assert {"collab-workflow", "employeeProcess", "web-embed", "shell-page"} <= kinds
    # 退役类型不得出现在可开清单里
    assert "artifacts" not in kinds
    # 模型要能看出「只读不自动弹」
    assert "tasks.list" in out["readOnlyActions"]
    assert "employees.wake" in out["autoOpenActions"]


def test_shell_page_auto_open_only_from_truth_source():
    """全量动作扫描：任何只读动作都不得在 shell-page CTA 上带 autoOpen。

    【self-evolution-bot · 2026-11-20 · 第88轮 · 模型:deepseek-v4.1-flash-1017】
    改了什么：新增回归门禁，扫 platform 全部已注册动作（含 entity_id 与不带两种入参），
    逐一断言「READ_ONLY_ACTIONS 成员 ⇒ 产出 CTA 的 autoOpen 全为假」。
    为什么：第87轮我只修了 items.* 一处，同一份文件里还有 5 处私有白名单
    （employees.get/brief、tasks.get、workflow.run_status…）继续绕过统一判据；
    单点用例抓不住，必须全量扫描才能防止下一处再被手写出来。
    """
    from evoflow.admin.platform_actions import get_registry
    from evoflow.admin.platform_ui_feedback import build_platform_ui_feedback
    from evoflow.stage.right_panel_kinds import READ_ONLY_ACTIONS

    names = list(get_registry().keys())

    assert names, "动作注册表为空，扫描无效"
    violations: list[str] = []
    for name in names:
        if name not in READ_ONLY_ACTIONS:
            continue
        domain = name.split(".", 1)[0]
        for extra in ({}, {"task_id": "mt-1", "agent_code": "duty-ops", "runId": "r-1"}):
            entry = _entry(name, domain, risk="read")
            args = {"agent_code": "duty-ops", **extra}
            result = {"ok": True, "action": name, "task_id": "mt-1", "runId": "r-1"}
            ui = build_platform_ui_feedback(entry, args, result)
            if not ui:
                continue
            for a in ui.get("actions") or []:
                if a.get("autoOpen"):
                    violations.append(f"{name} args={extra} -> {a.get('label')}")
    assert not violations, "只读动作仍在自动展开右栏：\n" + "\n".join(violations)
