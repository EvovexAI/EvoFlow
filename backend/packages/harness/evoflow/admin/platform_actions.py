"""平台行政：单一注册表 + 说明书（catalog）+ 分发执行。

通用内置工具 ``platform`` 的后端（EvoFlow / 小V 等均可挂载）。
能力只加注册条目，不新增工具名。Handler 见 ``platform_handlers.py``。
"""

from __future__ import annotations

import json
import logging
import re
from dataclasses import dataclass
from typing import Any, Callable

from evoflow.admin import platform_handlers as H
from evoflow.admin.errors import AdminError, NotFoundError, ValidationError

logger = logging.getLogger(__name__)

Handler = Callable[[dict[str, Any]], dict[str, Any]]

# Domains shown in catalog / help (keep in sync with registry)
PLATFORM_DOMAINS = (
    "knowledge",
    "workflow",
    "settings",
    "agents",
    "employees",
    "tasks",
    "items",
    "skills",
    "mcp",
    "automation",
    "approvals",
    "memory",
    "sessions",
    "experience",
    "diagnostics",
    "verification",
    "appearance",
)

# Per-domain routing copy for catalog / help (when to use + what lives here).
# Keep in sync with PLATFORM_DOMAINS and _build_registry action names.
DOMAIN_GUIDES: dict[str, dict[str, str]] = {
    "knowledge": {
        "title": "知识库",
        "when": "查/建/管平台自有知识库、语义检索文档、读写或删除笔记时（Obsidian Vault 为遗留接入）",
        "not": "对话内临时 checklist 用 todo；岗位开单推进用 tasks 工具",
    },
    "workflow": {
        "title": "工作流/应用",
        "when": "创建/改/发/删应用，从目标生成流程，复制、查版本、运行/暂停/恢复/查状态",
        "not": "不是定时自动化（用 automation）；不是岗位 Task 板",
    },
    "settings": {
        "title": "设置（模型/联网搜索）",
        "when": (
            "改默认模型、增删模型配置；"
            "或帮用户配置/测通「联网搜索」（含 Agent Plan 豆包 Harness Key、独立豆包/博查/Tavily 等）。"
            "用户说设置页太复杂、不会配搜索、豆包搜不通、Plan 联网怎么填时，优先在此域用对话代配。"
        ),
        "not": "不是用户画像（用 assets.*_profile / 资产中心）；不是临时搜一句网页（那用 web_search）；配好后搜网页仍用 web_search",
    },
    "assets": {
        "title": "资产中心（用户画像）",
        "when": "查看或更新用户画像（basic-info / preferences / persona）；用户说「我的画像」「记住我喜欢…」时",
        "not": "不是长期记忆 facts（用 memory）；不是经验库（用 experience）；面板入口 #/assets → 画像",
    },
    "agents": {
        "title": "智能体角色",
        "when": "CRUD 智能体角色定义（soul/skills/model）时",
        "not": "雇成值班岗用 employees；即时派活用 xiaomi_dispatch/wake（若有）",
    },
    "employees": {
        "title": "智能体员工岗位",
        "when": "雇佣/暂停/恢复/归档员工、改心跳、看工作日志时",
        "not": "改角色模板用 agents；开可执行工单用 tasks / items.dispatch",
    },
    "tasks": {
        "title": "协作任务台账（行政视角）",
        "when": "从行政侧列/查/建/改状态/删 Task 台账时",
        "not": (
            "值班过程中开单/progress/带 handlers 结案优先用专用工具 tasks；"
            "用户备忘录用 items；对话 checklist 用 todo"
        ),
    },
    "items": {
        "title": "用户事项/备忘",
        "when": "用户要记待办、备忘、截止日期；或把事项派给员工派生 Task 时",
        "not": "不自动开跑；对话内临时勾选用 todo；岗位执行中的工单用 tasks",
    },
    "skills": {
        "title": "技能",
        "when": "列出/查看/启用/安装/删除技能时",
        "not": "不是 MCP 服务器配置（用 mcp）",
    },
    "mcp": {
        "title": "MCP",
        "when": "查看或更新 MCP 服务器配置时",
        "not": "不是技能包安装（用 skills）",
    },
    "automation": {
        "title": "定时自动化",
        "when": "创建/列出/改/启停/删 Gateway 定时或 cron 自动化、看历史时",
        "not": "一次性跑工作流用 workflow.run；岗位心跳用 employees",
    },
    "approvals": {
        "title": "审批",
        "when": "列出待审批、批准或拒绝审批单时",
        "not": "不是任务状态本身（用 tasks.set_state / tasks 工具）",
    },
    "memory": {
        "title": "长期记忆",
        "when": "查看各 Agent 记忆、读/清记忆、删单条事实时",
        "not": "不是用户画像（用 assets.get_profile / assets.update_profile，或 #/assets → 画像）；不是经验库（用 experience）",
    },
    "sessions": {
        "title": "会话检索",
        "when": "按关键词检索历史会话时",
        "not": "不是当前对话内 todo",
    },
    "experience": {
        "title": "经验库",
        "when": "列出/查看/保存/删除可复用经验条目时",
        "not": "不是运行时记忆（用 memory）",
    },
    "diagnostics": {
        "title": "日志与异常诊断",
        "when": "系统报错、启动失败、任务跑挂；要知道有哪些日志源、哪些源有报错、汇总可转发的异常时间线时",
        "not": "不是会话内工具轨迹（用会话调试/任务详情）；不是改配置（用 settings）",
    },
    "verification": {
        "title": "系统验证",
        "when": "全平台/全流程串联验证：开一轮、记步骤（接口/入参出参/耗时）、更新进度、写结论与异常、按 roundId 复用时",
        "not": "不是评测中心回归（用 evoflow eval）；不是只扫日志（用 diagnostics）",
    },
    "appearance": {
        "title": "界面外观",
        "when": "改 EvoPanel 主题明暗、强调色色卡、自定义背景图/视频路径、液态玻璃开关与预设时",
        "not": "不是模型配置（用 settings.*）；改完后客户端会自动刷新界面",
    },
}


def domain_guide(domain: str) -> dict[str, str]:
    d = str(domain or "").strip().lower()
    base = DOMAIN_GUIDES.get(d, {})
    return {
        "domain": d,
        "title": base.get("title", d),
        "when": base.get("when", ""),
        "not": base.get("not", ""),
    }


@dataclass(frozen=True)
class PlatformAction:
    name: str
    domain: str
    summary: str
    risk: str  # read | write | destructive
    params: str
    examples: tuple[str, ...] = ()
    handler: Handler | None = None


def _parse_args(args_json: str | None) -> dict[str, Any]:
    raw = str(args_json or "").strip()
    if not raw:
        return {}
    try:
        data = json.loads(raw)
    except Exception as exc:
        raise ValidationError(f"args_json 不是合法 JSON: {exc}") from exc
    if not isinstance(data, dict):
        raise ValidationError("args_json 必须是 JSON 对象")
    return data


def _truthy_confirm(args: dict[str, Any], confirm: bool) -> bool:
    if confirm:
        return True
    for key in ("confirm", "confirmed", "yes"):
        v = args.get(key)
        if v is True:
            return True
        if isinstance(v, str) and v.strip().lower() in {"1", "true", "yes", "y", "确认", "好", "可以"}:
            return True
    return False


def _preview(action: PlatformAction, args: dict[str, Any]) -> dict[str, Any]:
    return {
        "ok": True,
        "pending_confirm": True,
        "action": action.name,
        "domain": action.domain,
        "risk": action.risk,
        "summary": action.summary,
        "args": args,
        "hint": (
            f"这是{action.risk}操作，尚未执行。"
            f"向用户复述将要做的事；用户确认后再次调用 "
            f"platform(action={action.name!r}, args_json=..., confirm=true)。"
        ),
    }


def _A(
    name: str,
    domain: str,
    summary: str,
    risk: str,
    params: str,
    handler: Handler,
    *examples: str,
) -> PlatformAction:
    return PlatformAction(
        name=name,
        domain=domain,
        summary=summary,
        risk=risk,
        params=params,
        examples=tuple(examples),
        handler=handler,
    )


def _build_registry() -> dict[str, PlatformAction]:
    items: list[PlatformAction] = [
        # knowledge
        _A("knowledge.list", "knowledge", "列出平台自有知识库", "read", "无", H.knowledge_list, "有哪些知识库"),
        _A("knowledge.search", "knowledge", "检索知识库文档", "read", "query, vaultId?/kbId?, top_k?, mode?", H.knowledge_search, "怎么配置 MCP"),
        _A("knowledge.create", "knowledge", "新建平台自有知识库", "write", "name, description?, embeddingModelRef?", H.knowledge_create, "建个英语单词库"),
        _A("knowledge.enable", "knowledge", "启用/停用 Obsidian Vault（遗留）", "write", "vaultId, enabled", H.knowledge_enable, "关掉某 Vault"),
        _A("knowledge.ingest", "knowledge", "写入一篇笔记", "write", "title, content, vaultId?/kbId?, summary?, tags?", H.knowledge_ingest, "把大纲写进库"),
        _A("knowledge.notes", "knowledge", "列出库内笔记", "read", "vaultId?/kbId?, prefix?, limit?", H.knowledge_notes, "英语库里有哪些笔记"),
        _A("knowledge.note_get", "knowledge", "读取一篇笔记", "read", "path, vaultId?/kbId?", H.knowledge_note_get, "打开某篇笔记"),
        _A("knowledge.note_delete", "knowledge", "删除一篇笔记", "destructive", "path, vaultId?/kbId?", H.knowledge_note_delete, "删掉这篇笔记"),
        _A("knowledge.requeue", "knowledge", "重排队卡住的索引任务", "write", "kbId?, limit?", H.knowledge_requeue, "processing 一直不完成"),
        _A("knowledge.reindex", "knowledge", "整库重索引（可改向量模型）", "write", "kbId, embeddingModelRef?, force?", H.knowledge_reindex, "改成 local 再重建向量"),
        # workflow
        _A("workflow.list", "workflow", "列出应用/工作流", "read", "status?, search?, limit?", H.workflow_list, "有哪些工作流"),
        _A("workflow.schema", "workflow", "查看创建工作流所需的步骤/参数模板", "read", "无", H.workflow_schema, "创建工作流要传什么参数"),
        _A("workflow.get", "workflow", "查看工作流详情", "read", "appId", H.workflow_get, "App_xxx 是干什么的"),
        _A("workflow.create", "workflow", "新建工作流草稿", "write", "name, description?, goal?, steps?, plan?, parameters?, canvas?", H.workflow_create, "建一个叫日报汇总的工作流"),
        _A("workflow.generate", "workflow", "从目标+步骤生成工作流", "write", "name, goal, steps?, description?, auto_extract?", H.workflow_generate, "根据计划生成可复用流程"),
        _A("workflow.update", "workflow", "修改工作流定义", "write", "appId, name?, description?, goal?, steps?, plan?, parameters?, canvas?, status?", H.workflow_update, "改一下步骤"),
        _A("workflow.duplicate", "workflow", "复制工作流", "write", "appId, name?", H.workflow_duplicate, "复制一份流程"),
        _A("workflow.publish", "workflow", "发布工作流", "write", "appId", H.workflow_publish, "发布这个应用"),
        _A("workflow.unpublish", "workflow", "退回草稿", "write", "appId", H.workflow_unpublish, "先下线别删"),
        _A("workflow.delete", "workflow", "删除工作流", "destructive", "appId", H.workflow_delete, "删掉这个应用"),
        _A("workflow.revisions", "workflow", "查看历史版本", "read", "appId, limit?", H.workflow_revisions, "这个应用改过几版"),
        _A("workflow.restore_revision", "workflow", "从历史版本恢复", "write", "appId, version, as_draft?", H.workflow_restore_revision, "恢复到上一版"),
        _A("workflow.run", "workflow", "启动一次运行", "write", "appId, parameters?", H.workflow_run, "跑一下拆解流程"),
        _A("workflow.stop", "workflow", "取消或暂停运行", "write", "runId, reason?, pause?", H.workflow_stop, "停掉刚才的运行"),
        _A("workflow.resume", "workflow", "恢复已暂停运行", "write", "runId", H.workflow_resume, "继续刚才暂停的运行"),
        _A("workflow.run_status", "workflow", "查看运行状态", "read", "runId", H.workflow_run_status, "那个运行到哪了"),
        _A("workflow.list_runs", "workflow", "查看应用运行历史", "read", "appId, limit?, page?", H.workflow_list_runs, "这个应用跑过几次"),
        # settings
        _A("settings.list_models", "settings", "列出模型与默认模型", "read", "无", H.settings_list_models, "有哪些模型"),
        _A("settings.get_default_model", "settings", "查看默认模型", "read", "无", H.settings_get_default_model, "默认模型是啥"),
        _A("settings.set_default_model", "settings", "设置默认模型", "write", "model", H.settings_set_default_model, "默认改成 glm-5.2"),
        _A("settings.get_model", "settings", "查看单个模型配置", "read", "model", H.settings_get_model, "glm 怎么配的"),
        _A("settings.create_model", "settings", "新增模型配置", "write", "name/model/base_url/api_key 等", H.settings_create_model, "加一个新模型"),
        _A("settings.delete_model", "settings", "删除模型配置", "destructive", "model", H.settings_delete_model, "删掉不用的模型"),
        _A(
            "assets.get_profile",
            "assets",
            "查看用户画像（资产中心：basic-info / preferences / persona）",
            "read",
            "无",
            H.assets_get_profile,
            "我的用户画像",
        ),
        _A(
            "assets.update_profile",
            "assets",
            "更新用户画像某一维度（资产中心）",
            "write",
            "path=basic-info|preferences|persona, content, mode?=append|replace",
            H.assets_update_profile,
            "记住我喜欢简洁回复",
            "把称呼改成老张",
        ),
        _A(
            "settings.get_web_search",
            "settings",
            "查看联网搜索配置与助手引导（密钥已脱敏；含 Agent Plan 状态）",
            "read",
            "无",
            H.settings_get_web_search,
            "联网搜索怎么配的",
            "豆包搜索配好了吗",
            "帮我看看 Agent Plan 联网搜索还缺什么",
            "设置里联网搜索太复杂，你帮我看下",
        ),
        _A(
            "settings.patch_web_search",
            "settings",
            "更新联网搜索密钥/首选渠道（对话代配，勿让用户自己翻复杂设置页）",
            "write",
            "preferredBackend?, doubaoApiKey?, tavilyApiKey?, …（或 settings 对象）",
            H.settings_patch_web_search,
            "把首选改成 doubao 并写入豆包 Key",
            "配置 Tavily 联网搜索",
            "我有 Agent Plan，把 Harness 领的联网 Key 写上",
        ),
        _A(
            "settings.test_web_search",
            "settings",
            "测通联网搜索渠道并可采纳推荐首选",
            "write",
            "query?, engines?, max_results?, adopt_recommended?",
            H.settings_test_web_search,
            "测一下豆包搜索通不通",
            "测通后把推荐引擎设为首选",
        ),
        # appearance（EvoPanel 主题 / 背景 / 液态玻璃）
        _A("appearance.get", "appearance", "查看界面外观设置与可选值", "read", "无", H.appearance_get, "当前主题和背景是啥"),
        _A(
            "appearance.patch",
            "appearance",
            "更新界面外观（主题/色卡/背景/液态玻璃）",
            "write",
            "theme?, accentPalette?, accentCustom?, backgroundImage?, backgroundOpacity?, "
            "liquidGlassEnabled?, liquidGlassPreset?, liquidGlassBlur?, liquidGlassFlowSpeed?, "
            "liquidGlassReadabilityDim?, clearBackground?",
            H.appearance_patch,
            "改成深色+极光液态玻璃",
            "把背景换成本地视频路径",
        ),
        # agents
        _A("agents.list", "agents", "列出智能体角色", "read", "tag?, agent_name?, limit?, offset?, include_soul?", H.agents_list, "有哪些智能体"),
        _A("agents.get", "agents", "查看智能体详情", "read", "name/agent_code", H.agents_get, "main 配了啥"),
        _A("agents.create", "agents", "创建智能体", "write", "agent_code, agent_name?, soul?, skills?, model?…", H.agents_create, "建个文案助手"),
        _A("agents.update", "agents", "更新智能体配置", "write", "name + 要改的字段", H.agents_update, "给文案助手换模型"),
        _A(
            "agents.delete",
            "agents",
            "删除智能体",
            "destructive",
            "name, confirm_cascade?, keep_employee?",
            H.agents_delete,
            "删掉测试智能体",
        ),
        # employees
        _A("employees.list", "employees", "列出智能体员工岗位", "read", "status?, include_archived?", H.employees_list, "现在有哪些员工"),
        _A("employees.get", "employees", "查看员工详情", "read", "agent_code, recent_limit?", H.employees_get, "拆解岗近况"),
        _A("employees.hire", "employees", "雇佣智能体为值班员工", "write", "agent_code, role_name?, heartbeat_rrule?…", H.employees_hire, "把文案助手雇成员工"),
        _A("employees.update", "employees", "更新员工岗位配置", "write", "agent_code + 字段", H.employees_update, "改拆解岗心跳"),
        _A("employees.pause", "employees", "暂停员工值班", "write", "agent_code", H.employees_pause, "让拆解岗先休息"),
        _A("employees.resume", "employees", "恢复员工值班", "write", "agent_code", H.employees_resume, "恢复拆解岗"),
        _A("employees.stop", "employees", "停止员工当前轮次", "write", "agent_code", H.employees_stop, "停掉他手头这轮"),
        _A("employees.archive", "employees", "归档员工岗位", "destructive", "agent_code", H.employees_archive, "归档测试岗"),
        _A(
            "employees.worklog",
            "employees",
            "查看员工某日工作日志（rounds=值班轮次；tasks=台账任务；勿因 round_count=0 判空，请看 task_count/tasks/hint）",
            "read",
            "agent_code, day?, limit?",
            H.employees_worklog,
            "拆解岗今天干了啥",
        ),
        _A(
            "employees.trail",
            "employees",
            "查看员工某一轮值班的工具调用轨迹（steps[] / tool_counts）",
            "read",
            "agent_code, round_id?, max_steps?",
            H.employees_trail,
            "这轮他到底调了哪些工具",
        ),
        # tasks（行政台账；值班推进优先专用工具 tasks）
        _A(
            "tasks.list",
            "tasks",
            "列出协作 Task 台账（行政视角）",
            "read",
            "status?, assignee?, role?, source?",
            H.tasks_list,
            "未结任务有哪些",
        ),
        _A("tasks.get", "tasks", "查看 Task 详情", "read", "task_id, subtask_id?", H.tasks_get, "这个任务怎么样了"),
        _A(
            "tasks.execution_trail",
            "tasks",
            "查看任务/子任务内部工具调用轨迹（steps[]，非状态清单）",
            "read",
            "task_id, subtask_id?, max_steps?",
            H.tasks_execution_trail,
            "这个任务里面具体调了哪些工具",
        ),
        _A(
            "tasks.create",
            "tasks",
            "行政侧创建 Task（值班开单/progress/handlers 结案优先用专用工具 tasks）",
            "write",
            "name, description?, assignee?, role?…",
            H.tasks_create,
            "建个待办给前端岗",
        ),
        _A("tasks.set_state", "tasks", "行政侧变更 Task 状态", "write", "task_id, state, summary?", H.tasks_set_state, "把这单标完成"),
        _A("tasks.delete", "tasks", "删除 Task", "destructive", "task_id", H.tasks_delete, "删掉测试任务"),
        # items（用户个人事项，≠ 可执行 Task；≠ 对话内 todo）
        _A(
            "items.list",
            "items",
            "列出用户事项/备忘（持久化；≠ 对话 todo、≠ Task）",
            "read",
            "status?, tag?, q?, include_done?",
            H.items_list,
            "我有哪些待办事项",
        ),
        _A("items.get", "items", "查看事项详情", "read", "item_id", H.items_get, "这条事项详情"),
        _A(
            "items.create",
            "items",
            "登记用户事项/备忘（记事，不自动开跑；要执行再 items.dispatch）",
            "write",
            "title, notes?, conclusion?, status?, priority?, due_at?, tags?, assignee_intent?",
            H.items_create,
            "帮我记一下周五交报告",
        ),
        _A("items.update", "items", "更新用户事项", "write", "item_id + 字段", H.items_update, "把这条标成进行中"),
        _A("items.delete", "items", "删除用户事项", "destructive", "item_id", H.items_delete, "删掉这条备忘"),
        _A(
            "items.dispatch",
            "items",
            "从事项派发给员工并派生可执行 Task",
            "write",
            "item_id, agent_code, wake_now?, force?, interrupt?",
            H.items_dispatch,
            "让拆解岗处理这条事项",
        ),
        # skills
        _A("skills.list", "skills", "列出技能", "read", "enabled_only?", H.skills_list, "装了哪些技能"),
        _A("skills.get", "skills", "查看技能详情", "read", "name", H.skills_get, "evoflow-admin 技能说啥"),
        _A("skills.enable", "skills", "启用/停用技能", "write", "name, enabled", H.skills_enable, "关掉某技能"),
        _A("skills.install", "skills", "安装技能（path 或市场 slug）", "write", "path 或 slug, owner?", H.skills_install, "装这个技能包"),
        _A("skills.delete", "skills", "删除自定义技能", "destructive", "name", H.skills_delete, "删掉自定义技能"),
        # mcp
        _A("mcp.get", "mcp", "查看 MCP 服务器配置", "read", "无", H.mcp_get, "现在挂了哪些 MCP"),
        _A("mcp.set", "mcp", "整体替换 MCP 配置", "write", "mcp_servers 对象", H.mcp_set, "更新 MCP 配置"),
        # automation
        _A("automation.list", "automation", "列出定时自动化", "read", "无", H.automation_list, "有哪些定时任务"),
        _A("automation.get", "automation", "查看自动化详情", "read", "id", H.automation_get, "这个自动化咋配的"),
        _A("automation.history", "automation", "自动化运行历史", "read", "id, limit?", H.automation_history, "最近跑过几次"),
        _A("automation.create", "automation", "创建定时自动化", "write", "name, prompt, cron/rrule/schedule?", H.automation_create, "每天九点巡检"),
        _A("automation.update", "automation", "更新自动化", "write", "id + 字段", H.automation_update, "改自动化提示词"),
        _A("automation.set_status", "automation", "启用/停用自动化", "write", "id, status(active|paused|…)", H.automation_set_status, "暂停这个定时"),
        _A("automation.delete", "automation", "删除自动化", "destructive", "id", H.automation_delete, "删掉测试定时"),
        # approvals
        _A("approvals.list", "approvals", "列出待审批/审批记录", "read", "status?, limit?", H.approvals_list, "有什么要我批"),
        _A("approvals.approve", "approvals", "同意审批", "write", "id/task_id, comment?", H.approvals_approve, "这个批了"),
        _A("approvals.reject", "approvals", "驳回审批", "write", "id/task_id, reason", H.approvals_reject, "驳回并说明原因"),
        # memory
        _A("memory.agents", "memory", "列出有长期记忆的智能体", "read", "无", H.memory_agents, "谁有记忆"),
        _A("memory.get", "memory", "查看长期记忆", "read", "agent?", H.memory_get, "main 记住了啥"),
        _A("memory.clear", "memory", "清空长期记忆", "destructive", "agent?", H.memory_clear, "清空记忆"),
        _A("memory.delete_fact", "memory", "删除单条记忆事实", "destructive", "fact_id, agent?", H.memory_delete_fact, "忘掉这条"),
        # sessions
        _A("sessions.search", "sessions", "按关键词搜历史会话", "read", "query, max_results?, max_age_days?, search_titles?", H.sessions_search, "上次聊英语单词是哪个会话"),
        # experience
        _A("experience.list", "experience", "列出经验库条目", "read", "query?, category?, limit?", H.experience_list, "经验库有啥"),
        _A("experience.get", "experience", "查看经验详情", "read", "id", H.experience_get, "这条经验细节"),
        _A("experience.save", "experience", "保存经验", "write", "title/content 等字段", H.experience_save, "记一条经验"),
        _A("experience.delete", "experience", "删除经验", "destructive", "id, permanent?", H.experience_delete, "删掉这条经验"),
        # diagnostics（系统已知日志源 + 异常扫描 + 可转发时间线）
        _A(
            "diagnostics.sources",
            "diagnostics",
            "列出系统已知日志源，并标出哪些近期有报错",
            "read",
            "hours?",
            H.diagnostics_sources,
            "有哪些日志？哪些出过错？",
            "系统日志目录在哪",
        ),
        _A(
            "diagnostics.scan",
            "diagnostics",
            "扫描近期 ERROR/异常行",
            "read",
            "hours?, sources?, max_events?",
            H.diagnostics_scan,
            "最近 gateway 有啥报错",
            "扫一下今天的异常日志",
        ),
        _A(
            "diagnostics.timeline",
            "diagnostics",
            "汇总可转发的异常时间线（markdown）",
            "read",
            "hours?, sources?, max_events?, format?",
            H.diagnostics_timeline,
            "导出异常时间线发给别人",
            "把最近报错汇总成时间线",
        ),
        _A(
            "diagnostics.run",
            "diagnostics",
            "综合系统诊断：一次检查全模块健康状态（日志/知识库/模型/员工/定时任务）并输出诊断报告",
            "read",
            "focus?",
            H.diagnostics_run,
            "帮我查一下系统有什么问题",
            "员工跑不起来帮我诊断一下",
            "对话消失了帮我查原因",
            "定时任务没触发帮我看看",
        ),
        # verification（系统验证轮次：进度/结论/异常 + 接口入参出参耗时）
        _A(
            "verification.catalog",
            "verification",
            "查询全平台可验证接口清单（按域/风险/关键词）",
            "read",
            "domain?, risk?, query?, includeVerification?",
            H.verification_catalog,
            "有哪些平台接口要验",
            "只看 items 和 workflow 的接口",
        ),
        _A(
            "verification.start",
            "verification",
            "开启或复用一轮系统验证；可 seed 接口清单为待开始步骤",
            "write",
            "title?, scenario?, roundId?, seed?, domains?, apis?, risks?, resume?, config?",
            H.verification_start,
            "开一轮并初始化全部接口为待开始",
            "用已有 roundId 继续记步骤",
        ),
        _A(
            "verification.init",
            "verification",
            "把接口清单初始化进已有轮次（状态=待开始/pending）",
            "write",
            "roundId?, title?, scenario?, domains?, apis?, risks?, includeVerification?, onlyMissing?",
            H.verification_init,
            "新一轮：把全平台接口初始化成待开始",
            "只初始化 knowledge 和 employees",
        ),
        _A(
            "verification.list",
            "verification",
            "列出验证轮次",
            "read",
            "status?, query?, limit?",
            H.verification_list,
            "最近验证跑了几轮",
        ),
        _A(
            "verification.get",
            "verification",
            "查看一轮验证详情与步骤",
            "read",
            "roundId, includeSteps?",
            H.verification_get,
            "这轮验证进度和结论",
        ),
        _A(
            "verification.step",
            "verification",
            "记录/回填一步验证（同 api 的待开始步骤会就地更新）",
            "write",
            "roundId, feature|api, status?, request?, response?, result?, detail?, exception?, durationMs?, seq?",
            H.verification_step,
            "记 items.create 这一步通过了",
            "记 workflow.run 失败与异常",
        ),
        _A(
            "verification.update",
            "verification",
            "更新轮次进度/状态/结论草稿",
            "write",
            "roundId, status?, progress?, conclusion?, exceptions?, summary?, title?, scenario?",
            H.verification_update,
            "把进度改成 50%",
        ),
        _A(
            "verification.conclude",
            "verification",
            "结束一轮：写结论、终态、异常汇总",
            "write",
            "roundId, conclusion?, status?, exceptions?, summary?, progress?",
            H.verification_conclude,
            "这轮验证结论：通过，有两处告警",
        ),
        _A(
            "verification.delete",
            "verification",
            "删除一轮验证及步骤",
            "destructive",
            "roundId",
            H.verification_delete,
            "删掉测试验证轮次",
        ),
    ]
    return {a.name: a for a in items}


_REGISTRY: dict[str, PlatformAction] | None = None


def get_registry() -> dict[str, PlatformAction]:
    global _REGISTRY
    if _REGISTRY is None:
        _REGISTRY = _build_registry()
    return _REGISTRY


def reset_registry_cache() -> None:
    """Tests only."""
    global _REGISTRY
    _REGISTRY = None


def _domain_catalog_entry(domain: str, actions: list[PlatformAction]) -> dict[str, Any]:
    guide = domain_guide(domain)
    return {
        **guide,
        "count": len(actions),
        "actions": [
            {"name": a.name, "summary": a.summary, "risk": a.risk} for a in actions
        ],
        "action_names": [a.name for a in actions],
    }


def build_catalog(*, domain: str | None = None, detailed: bool = False) -> dict[str, Any]:
    reg = get_registry()
    dom = str(domain or "").strip().lower() or None
    actions = [a for a in reg.values() if not dom or a.domain == dom]
    if not actions and dom:
        return {
            "ok": False,
            "error": f"unknown domain: {dom}",
            "domains": list(PLATFORM_DOMAINS),
            "guides": [domain_guide(d) for d in PLATFORM_DOMAINS],
            "hint": "用 catalog 不带 domain 看域摘要，或指定某一域名看详版。",
        }

    # 无 domain：短目录 = 每域 when/not + 功能清单 + 全部 action 一行摘要
    if not dom and not detailed:
        by_dom: dict[str, list[PlatformAction]] = {}
        for a in actions:
            by_dom.setdefault(a.domain, []).append(a)
        domain_summaries = [
            _domain_catalog_entry(d, by_dom[d])
            for d in PLATFORM_DOMAINS
            if d in by_dom
        ]
        items = [
            {"name": a.name, "domain": a.domain, "risk": a.risk, "summary": a.summary}
            for a in actions
        ]
        return {
            "ok": True,
            "count": len(items),
            "domains": domain_summaries,
            "items": items,
            "routing": (
                "先按 domains[].when 选域，再选 domains[].actions[].name 作为 action。"
                "用户备忘→items；岗位工单推进→专用工具 tasks（或本工具 tasks.* 行政侧）；"
                "对话 checklist→todo。写/破坏性操作须用户确认后 confirm=true。"
            ),
            "hint": (
                "某域详版：action=catalog 且 domain="
                + "|".join(PLATFORM_DOMAINS)
                + "。"
            ),
        }

    guide = domain_guide(dom) if dom else None
    items = [
        {
            "name": a.name,
            "domain": a.domain,
            "risk": a.risk,
            "summary": a.summary,
            "params": a.params,
            "examples": list(a.examples),
        }
        for a in actions
    ]
    out: dict[str, Any] = {
        "ok": True,
        "count": len(items),
        "domains": [dom] if dom else sorted({a.domain for a in actions}),
        "items": items,
        "hint": "按需选择 action；write/destructive 须用户确认后带 confirm=true。",
    }
    if guide:
        out["guide"] = guide
        out["actions"] = [
            {"name": a.name, "summary": a.summary, "risk": a.risk, "params": a.params}
            for a in actions
        ]
        if dom == "workflow":
            from evoflow.admin.platform_workflow_schema import build_workflow_platform_schema

            out["schema"] = build_workflow_platform_schema()
    return out


def build_help(topic: str | None = None) -> dict[str, Any]:
    t = str(topic or "").strip().lower()
    if not t or t in {"", "platform", "all", "*"}:
        cat = build_catalog(detailed=False)
        cat["manual"] = (
            "平台行政统一走 platform。流程：catalog/help 看 domains（含 when + 功能清单）→ "
            "选 action →（写操作向用户确认）→ confirm=true 执行。"
            "易混：items=用户备忘；tasks 域/专用 tasks 工具=协作工单；todo=对话内临时清单。"
        )
        return cat
    if t in {"catalog", "help", "domains"}:
        return build_catalog(detailed=False)

    reg = get_registry()
    if t in reg:
        a = reg[t]
        payload: dict[str, Any] = {
            "ok": True,
            "action": {
                "name": a.name,
                "domain": a.domain,
                "risk": a.risk,
                "summary": a.summary,
                "params": a.params,
                "examples": list(a.examples),
            },
            "guide": domain_guide(a.domain),
            "hint": "确认参数后调用同名 action；write 需 confirm=true。",
        }
        if a.domain == "workflow":
            from evoflow.admin.platform_workflow_schema import build_workflow_platform_schema

            payload["schema"] = build_workflow_platform_schema()
            if a.name == "workflow.schema":
                payload["hint"] = "直接阅读 schema.step / schema.actions 下的示例 JSON。"
        return payload
    if t in {a.domain for a in reg.values()} or t in PLATFORM_DOMAINS:
        return build_catalog(domain=t, detailed=True)

    sug = [name for name in reg if t in name or name.startswith(t)]
    return {
        "ok": False,
        "error": f"unknown help topic: {t}",
        "suggestions": sug[:16] or list(reg.keys())[:16],
        "domains": list(PLATFORM_DOMAINS),
        "guides": [domain_guide(d) for d in PLATFORM_DOMAINS],
        "hint": "先 action=catalog 看目录（含每域 when + 功能清单）。",
    }


def dispatch_platform_action(
    action: str,
    *,
    args_json: str | None = None,
    domain: str | None = None,
    confirm: bool = False,
    principal_id: str = "",
) -> dict[str, Any]:
    act = str(action or "").strip()
    if not act:
        return {
            "ok": False,
            "error": "action is required",
            "hint": "先 platform(action='catalog') 看说明书。",
        }

    key = act.lower()
    if key in {"help", "manual", "说明书"}:
        return build_help(domain or None)
    if key in {"catalog", "list_actions", "目录", "domains"}:
        return build_catalog(domain=domain, detailed=bool(domain))

    reg = get_registry()
    entry = reg.get(act) or reg.get(key)
    if entry is None and "." not in act and domain:
        entry = reg.get(f"{str(domain).strip()}.{act}")
    if entry is None:
        matches = [n for n in reg if n.endswith("." + act) or act in n]
        return {
            "ok": False,
            "error": f"unknown action: {act}",
            "suggestions": matches[:12] or list(reg.keys())[:16],
            "domains": list(PLATFORM_DOMAINS),
            "catalog_hint": "先调用 action=catalog 或 help。",
        }

    try:
        args = _parse_args(args_json)
    except ValidationError as exc:
        return {"ok": False, "error": str(exc), "action": entry.name}

    risk = entry.risk
    if risk in {"write", "destructive"} and not _truthy_confirm(args, confirm):
        if risk == "destructive":
            return {
                "ok": False,
                "error": "destructive_requires_confirm",
                "action": entry.name,
                "risk": risk,
                "summary": entry.summary,
                "args": args,
                "hint": "破坏性操作必须用户明确确认后，带 confirm=true 再调用。",
            }
        return _preview(entry, args)

    if entry.handler is None:
        return {"ok": False, "error": "handler_missing", "action": entry.name}

    # Thread caller identity into handlers that bucket per-user assets
    # (experience.*). Extra key is inert for handlers that ignore it.
    pid = str(principal_id or "").strip()
    if pid:
        args = dict(args or {})
        args.setdefault("principal_id", pid)

    try:
        result = entry.handler(args)
        if not isinstance(result, dict):
            result = {"ok": True, "result": result}
        result.setdefault("ok", True)
        result.setdefault("action", entry.name)
        if result.get("ok") and not result.get("pending_confirm"):
            from evoflow.admin.platform_ui_feedback import build_platform_ui_feedback

            ui = build_platform_ui_feedback(entry, args, result)
            if ui:
                result["ui"] = ui
        return result
    except (AdminError, ValidationError, NotFoundError, ValueError) as exc:
        return {"ok": False, "error": str(exc), "action": entry.name}
    except Exception as exc:
        logger.exception("platform action=%s failed", entry.name)
        return {"ok": False, "error": str(exc), "action": entry.name}


def slugify_vault_name(name: str) -> str:
    base = re.sub(r"[^a-zA-Z0-9_-]+", "-", str(name or "vault").strip()).strip("-").lower()
    return (base or "vault")[:40]
