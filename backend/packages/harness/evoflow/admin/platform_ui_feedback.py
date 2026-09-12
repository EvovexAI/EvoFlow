"""Structured UI feedback for successful ``platform`` write/destructive actions."""

from __future__ import annotations

from typing import Any

from evoflow.admin.platform_actions import PlatformAction, domain_guide

DOMAIN_ENTITY_ZH: dict[str, str] = {
    "knowledge": "知识库",
    "workflow": "工作流",
    "settings": "设置",
    "agents": "智能体",
    "employees": "智能体员工",
    "tasks": "协作任务",
    "items": "待办事项",
    "skills": "技能",
    "mcp": "MCP 配置",
    "automation": "定时任务",
    "approvals": "审批",
    "memory": "长期记忆",
    "experience": "经验",
    "verification": "验证轮次",
    "diagnostics": "诊断",
    "sessions": "会话",
    "appearance": "界面外观",
}

DOMAIN_ICON: dict[str, str] = {
    "knowledge": "knowledge",
    "workflow": "workflow",
    "settings": "settings",
    "agents": "agent",
    "employees": "employee",
    "tasks": "task",
    "items": "item",
    "skills": "skill",
    "mcp": "mcp",
    "automation": "automation",
    "approvals": "approval",
    "memory": "memory",
    "experience": "experience",
    "verification": "verification",
    "appearance": "settings",
}


def _first_str(*values: Any) -> str:
    for value in values:
        text = str(value or "").strip()
        if text:
            return text
    return ""


def _as_dict(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _pick_label(action: str, args: dict[str, Any], result: dict[str, Any]) -> str:
    item = _as_dict(result.get("item"))
    agent = _as_dict(result.get("agent"))
    skill = _as_dict(result.get("skill"))
    role = _as_dict(result.get("role"))
    task = _as_dict(result.get("task"))
    vault = _as_dict(result.get("vault"))
    automation = _as_dict(result.get("automation"))
    approval = _as_dict(result.get("approval"))
    app = _as_dict(result.get("app"))

    return _first_str(
        item.get("title"),
        item.get("name"),
        app.get("name"),
        result.get("title"),
        result.get("name"),
        result.get("role_name"),
        role.get("role_name"),
        agent.get("agent_name"),
        agent.get("agent_code"),
        skill.get("name"),
        skill.get("slug"),
        task.get("name"),
        task.get("title"),
        result.get("task_id"),
        result.get("taskId"),
        result.get("item_id"),
        result.get("itemId"),
        result.get("agent_code"),
        result.get("agentCode"),
        result.get("model"),
        result.get("model_name"),
        result.get("vaultId"),
        result.get("vault_id"),
        result.get("kbId"),
        result.get("kb_id"),
        vault.get("name"),
        vault.get("vaultId"),
        vault.get("id"),
        _as_dict(result.get("base")).get("name"),
        _as_dict(result.get("base")).get("id"),
        result.get("appId"),
        result.get("app_id"),
        result.get("runId"),
        result.get("run_id"),
        result.get("roundId"),
        result.get("round_id"),
        automation.get("name"),
        automation.get("id"),
        approval.get("id"),
        approval.get("task_id"),
        args.get("title"),
        args.get("name"),
        args.get("model"),
        args.get("agent_code"),
        args.get("agentCode"),
        args.get("task_id"),
        args.get("item_id"),
        args.get("id"),
        args.get("skill"),
        args.get("slug"),
        args.get("appId"),
        args.get("roundId"),
    )


def _pick_entity_id(action: str, args: dict[str, Any], result: dict[str, Any]) -> str:
    item = _as_dict(result.get("item"))
    agent = _as_dict(result.get("agent"))
    return _first_str(
        item.get("id"),
        result.get("item_id"),
        result.get("itemId"),
        result.get("task_id"),
        result.get("taskId"),
        result.get("agent_code"),
        result.get("agentCode"),
        agent.get("agent_code"),
        result.get("vaultId"),
        result.get("vault_id"),
        result.get("kbId"),
        result.get("kb_id"),
        _as_dict(result.get("base")).get("id"),
        _as_dict(result.get("vault")).get("id"),
        result.get("appId"),
        result.get("app_id"),
        result.get("runId"),
        result.get("run_id"),
        result.get("roundId"),
        result.get("round_id"),
        result.get("id"),
        args.get("item_id"),
        args.get("task_id"),
        args.get("agent_code"),
        args.get("id"),
        args.get("appId"),
        args.get("roundId"),
        args.get("vaultId"),
        args.get("kbId"),
    )


def _action_verb(action: str) -> str:
    _, _, tail = str(action or "").partition(".")
    return tail or action


def _build_title(action: str, domain: str, verb: str, label: str, args: dict[str, Any], result: dict[str, Any]) -> str:
    entity = DOMAIN_ENTITY_ZH.get(domain, domain_guide(domain).get("title") or domain)
    name = label or entity

    overrides: dict[str, str] = {
        "items.create": f"创建「{name}」待办事项成功",
        "items.update": f"修改「{name}」待办事项成功",
        "items.delete": f"已删除待办事项「{name}」",
        "items.dispatch": f"已将「{name}」派发给员工",
        "tasks.create": f"创建「{name}」协作任务成功",
        "tasks.set_state": f"协作任务「{name}」状态已更新",
        "tasks.delete": f"已删除协作任务「{name}」",
        "employees.hire": f"已添加智能体员工「{name}」",
        "employees.update": f"已更新员工「{name}」配置",
        "employees.pause": f"已暂停员工「{name}」值班",
        "employees.resume": f"已恢复员工「{name}」值班",
        "employees.stop": f"已停止员工「{name}」当前轮次",
        "employees.archive": f"已归档员工岗位「{name}」",
        "agents.create": f"已创建智能体「{name}」",
        "agents.update": f"已更新智能体「{name}」配置",
        "agents.delete": f"已删除智能体「{name}」",
        "knowledge.create": f"已创建知识库「{name}」",
        "knowledge.enable": f"知识库「{name}」已{'启用' if _arg_enabled(args, result) else '停用'}",
        "knowledge.ingest": f"已向知识库写入笔记「{name}」",
        "knowledge.note_delete": f"已删除笔记「{name}」",
        "knowledge.requeue": "已重排队卡住的知识库索引任务",
        "knowledge.reindex": f"已为知识库「{name}」排队重索引",
        "workflow.run": f"已启动工作流「{name}」",
        "workflow.stop": f"已停止工作流运行",
        "workflow.resume": f"已恢复工作流运行",
        "workflow.create": f"已创建工作流「{name}」",
        "workflow.generate": f"已生成工作流「{name}」",
        "workflow.update": f"已更新工作流「{name}」",
        "workflow.duplicate": f"已复制工作流「{name}」",
        "workflow.publish": f"工作流「{name}」已发布",
        "workflow.unpublish": f"工作流「{name}」已退回草稿",
        "workflow.delete": f"已删除工作流「{name}」",
        "workflow.restore_revision": f"工作流「{name}」已恢复历史版本",
        "settings.set_default_model": f"默认模型已改为「{name}」",
        "settings.create_model": f"已添加模型配置「{name}」",
        "settings.delete_model": f"已删除模型配置「{name}」",
        "assets.update_profile": "用户画像已更新",
        "settings.patch_web_search": "联网搜索配置已更新",
        "settings.test_web_search": "联网搜索测试完成",
        "skills.enable": f"技能「{name}」已{'启用' if _arg_enabled(args, result) else '停用'}",
        "skills.install": f"已安装技能「{name}」",
        "skills.delete": f"已删除技能「{name}」",
        "mcp.set": "MCP 配置已更新",
        "automation.create": f"已创建定时任务「{name}」",
        "automation.update": f"已更新定时任务「{name}」",
        "automation.set_status": f"定时任务「{name}」已更新状态",
        "automation.delete": f"已删除定时任务「{name}」",
        "approvals.approve": f"已批准「{name}」",
        "approvals.reject": f"已驳回「{name}」",
        "memory.clear": f"已清空「{name or '全部'}」长期记忆",
        "memory.delete_fact": "已删除一条记忆",
        "experience.save": f"已保存经验「{name}」",
        "experience.delete": f"已删除经验「{name}」",
        "verification.start": f"已开启验证轮次「{name}」",
        "verification.init": f"已初始化验证轮次「{name}」",
        "verification.step": f"已记录验证步骤「{name}」",
        "verification.update": f"已更新验证轮次「{name}」",
        "verification.conclude": f"验证轮次「{name}」已结束",
        "verification.delete": f"已删除验证轮次「{name}」",
        "appearance.patch": "界面外观已更新",
    }
    if action in overrides:
        return overrides[action]

    if verb in {"create", "save", "install", "hire", "ingest", "start", "init"}:
        return f"创建「{name}」{entity}成功" if verb != "hire" else f"已添加{entity}「{name}」"
    if verb in {"update", "set", "patch", "set_state", "set_status", "step", "conclude"}:
        return f"修改「{name}」{entity}成功" if name != entity else f"{entity}已更新"
    if verb in {"delete", "archive", "clear", "delete_fact", "note_delete", "reject"}:
        return f"已删除{entity}「{name}」" if name != entity else f"已删除{entity}"
    if verb in {"enable"}:
        state = "启用" if _arg_enabled(args, result) else "停用"
        return f"{entity}「{name}」已{state}"
    if verb in {"run"}:
        return f"已启动{entity}「{name}」"
    if verb in {"stop"}:
        return f"已停止{entity}"
    if verb in {"approve"}:
        return f"已批准「{name}」"
    if verb in {"dispatch"}:
        return f"已将「{name}」派发出去"
    if verb in {"pause", "resume"}:
        return f"员工「{name}」已{'暂停' if verb == 'pause' else '恢复'}"
    return f"{entity}操作成功"


def _arg_enabled(args: dict[str, Any], result: dict[str, Any]) -> bool:
    if "enabled" in result:
        return bool(result.get("enabled"))
    if "enabled" in args:
        return bool(args.get("enabled"))
    status = _first_str(result.get("status"), args.get("status")).lower()
    if status in {"active", "enabled", "on"}:
        return True
    if status in {"paused", "disabled", "off", "inactive"}:
        return False
    return True


def _build_subtitle(domain: str, action: str, result: dict[str, Any]) -> str:
    guide = domain_guide(domain)
    base = str(guide.get("title") or DOMAIN_ENTITY_ZH.get(domain) or domain)
    hint = _first_str(result.get("hint"))
    if hint and len(hint) <= 120:
        return hint
    if action.startswith("items."):
        return "已记入任务中心 · 我的事项"
    if action.startswith("tasks."):
        return "已记入任务中心 · 协作任务"
    if action.startswith("employees."):
        return "可在智能体员工页查看"
    if action.startswith("workflow."):
        return "可在工作流/应用页查看运行"
    if action.startswith("settings."):
        return "可在设置页查看"
    if action.startswith("skills."):
        return "可在技能页查看"
    if action.startswith("mcp."):
        servers = result.get("mcp_servers") or result.get("servers")
        if isinstance(servers, dict):
            return f"共 {len(servers)} 个 MCP 服务器"
        if isinstance(servers, list):
            return f"共 {len(servers)} 个 MCP 服务器"
        return "可在工具/MCP 页查看"
    if action.startswith("automation."):
        return "可在自动化页查看"
    return base


def _build_details(args: dict[str, Any], result: dict[str, Any]) -> list[dict[str, str]]:
    details: list[dict[str, str]] = []
    item = _as_dict(result.get("item"))
    due = _first_str(item.get("due_at"), args.get("due_at"), args.get("due"))
    if due:
        details.append({"label": "截止", "value": due})
    priority = _first_str(item.get("priority"), args.get("priority"))
    if priority:
        details.append({"label": "优先级", "value": priority})
    status = _first_str(item.get("status"), result.get("status"), args.get("status"), args.get("state"))
    if status:
        details.append({"label": "状态", "value": status})
    run_id = _first_str(result.get("runId"), result.get("run_id"))
    if run_id:
        details.append({"label": "运行", "value": run_id[:24]})
    assignee = _first_str(args.get("agent_code"), args.get("assignee"), result.get("agent_code"))
    if assignee and "dispatch" in str(result.get("action") or ""):
        details.append({"label": "派给", "value": assignee})
    return details[:4]


def _build_actions(action: str, domain: str, entity_id: str, result: dict[str, Any]) -> list[dict[str, str]]:
    actions: list[dict[str, str]] = []
    app_id = _first_str(result.get("appId"), result.get("app_id"))
    run_id = _first_str(result.get("runId"), result.get("run_id"))

    if domain == "items" and entity_id:
        actions.append({"label": "查看事项", "route": f"/tasks?tab=items&focus={entity_id}"})
    elif domain == "tasks" and entity_id:
        actions.append({"label": "查看任务", "route": f"/task/{entity_id}"})
    elif domain == "employees" and entity_id:
        actions.append({"label": "查看员工", "route": f"/proactive/{entity_id}"})
    elif domain == "agents" and entity_id:
        actions.append({"label": "查看智能体", "route": "/agents"})
    elif domain == "knowledge":
        vid = _first_str(
            result.get("kbId"),
            result.get("kb_id"),
            result.get("vaultId"),
            result.get("vault_id"),
            _as_dict(result.get("base")).get("id"),
            entity_id,
        )
        if vid:
            actions.append({"label": "查看知识库", "route": f"/knowledge/owned/{vid}"})
        else:
            actions.append({"label": "打开知识库", "route": "/knowledge"})
    elif domain == "workflow":
        if app_id and run_id:
            actions.append({"label": "查看运行", "route": f"/apps/{app_id}/run?runId={run_id}"})
        elif app_id:
            actions.append({"label": "编辑应用", "route": f"/apps/{app_id}"})
        else:
            actions.append({"label": "打开工作流", "route": "/apps"})
    elif domain == "settings":
        if "model" in action:
            actions.append({"label": "模型设置", "route": "/models"})
        else:
            actions.append({"label": "打开设置", "route": "/settings"})
    elif domain == "skills":
        actions.append({"label": "打开技能", "route": "/skills"})
    elif domain == "mcp":
        actions.append({"label": "打开 MCP", "route": "/tools"})
    elif domain == "automation" and entity_id:
        actions.append({"label": "查看自动化", "route": f"/automation?id={entity_id}"})
    elif domain == "automation":
        actions.append({"label": "打开自动化", "route": "/automation"})
    elif domain == "approvals":
        actions.append({"label": "查看审批", "route": "/tasks?status=pending"})
    elif domain == "memory":
        actions.append({"label": "打开记忆", "route": "/memory"})
    elif domain == "appearance":
        actions.append({"label": "打开外观设置", "route": "/settings"})
    return actions


def build_platform_ui_feedback(
    entry: PlatformAction,
    args: dict[str, Any],
    result: dict[str, Any],
) -> dict[str, Any] | None:
    """Return structured UI payload for successful write/destructive platform actions."""
    if not result.get("ok"):
        return None
    if result.get("pending_confirm"):
        return None
    if entry.risk not in {"write", "destructive"}:
        return None

    action = str(result.get("action") or entry.name).strip()
    domain = str(entry.domain or "").strip()
    verb = _action_verb(action)
    label = _pick_label(action, args, result)
    entity_id = _pick_entity_id(action, args, result)
    title = _build_title(action, domain, verb, label, args, result)
    subtitle = _build_subtitle(domain, action, result)
    details = _build_details(args, result)
    actions = _build_actions(action, domain, entity_id, result)

    kind = "warning" if entry.risk == "destructive" else "success"
    return {
        "kind": kind,
        "verb": verb,
        "domain": domain,
        "entityType": domain,
        "entityLabel": label or DOMAIN_ENTITY_ZH.get(domain, domain),
        "entityId": entity_id or None,
        "icon": DOMAIN_ICON.get(domain, domain),
        "title": title,
        "subtitle": subtitle,
        "details": details,
        "actions": actions,
        "action": action,
    }


def platform_ui_to_chat_artifact(
    ui: dict[str, Any],
    *,
    tool_call_id: str = "",
    action: str = "",
) -> dict[str, Any] | None:
    """Map platform UI feedback to a session-bound chat artifact (type=platform)."""
    title = _first_str(ui.get("title"))
    if not title:
        return None
    tcid = _first_str(tool_call_id)
    action_name = _first_str(ui.get("action"), action)
    entity_id = _first_str(ui.get("entityId"))
    if tcid:
        aid = f"platform:{tcid}"
    elif action_name:
        aid = f"platform:{action_name}:{entity_id or title}"
    else:
        aid = f"platform:{title}"
    actions = ui.get("actions") if isinstance(ui.get("actions"), list) else []
    route = ""
    for row in actions:
        if isinstance(row, dict) and _first_str(row.get("route")):
            route = _first_str(row.get("route"))
            break
    kind_raw = _first_str(ui.get("kind")).lower()
    kind = kind_raw if kind_raw in {"warning", "error"} else "success"
    item: dict[str, Any] = {
        "id": aid[:128],
        "type": "platform",
        "name": title,
        "label": title,
        "platformFeedbackKind": kind,
        "status": "new",
    }
    if route:
        item["url"] = route
    if action_name:
        item["platformAction"] = action_name
    domain = _first_str(ui.get("domain"))
    if domain:
        item["platformDomain"] = domain
    subtitle = _first_str(ui.get("subtitle"))
    if subtitle:
        item["platformSubtitle"] = subtitle
    if tcid:
        item["toolCallId"] = tcid
    if actions:
        item["platformActions"] = actions
    verb = _first_str(ui.get("verb"))
    if verb:
        item["platformVerb"] = verb
    entity_label = _first_str(ui.get("entityLabel"))
    if entity_label:
        item["platformEntityLabel"] = entity_label
    if entity_id:
        item["platformEntityId"] = entity_id
    return item
