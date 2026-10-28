"""平台行政：单一注册表 + 说明书（catalog）+ 分发执行。

通用内置工具 ``platform`` 的后端（EvoFlow / 小V 等均可挂载）。
能力只加注册条目，不新增工具名。Handler 见 ``platform_handlers.py``。
"""

from __future__ import annotations

import json
import logging
import re
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from evoflow.admin import platform_handlers as H
from evoflow.admin.errors import AdminError, NotFoundError, ValidationError

logger = logging.getLogger(__name__)

Handler = Callable[[dict[str, Any]], dict[str, Any]]

# Domains shown in catalog / help (keep in sync with registry)
PLATFORM_DOMAINS = (
    "knowledge",
    "workflow",
    "settings",
    "assets",
    "agents",
    "employees",
    "tasks",
    "items",
    "skills",
    "extensions",
    "plugins",
    "mcp",
    "org",
    "channels",
    "automation",
    "approvals",
    "sessions",
    "diagnostics",
    "verification",
    "appearance",
    "ui",
    "media",
    "eval",
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
        "not": "不是定时自动化（用 automation）；不是岗位 Task 板；不是侧栏 Agent应用网页（用 extensions）",
    },
    "settings": {
        "title": "设置（模型/联网搜索）",
        "when": (
            "改默认模型、增删/更新模型配置；或帮用户配置/测通「联网搜索」"
            "（Agent Plan 官方用套餐专属 Key 调豆包搜索并自动接通；也可独立豆包/博查/Tavily）。"
            "用户说设置页太复杂、不会配搜索、豆包搜不通、Plan 联网怎么填时，优先在此域用对话代配；"
            "查系统是否已配置/可联网时也可读 diagnostics.status 的 web_search 段。"
        ),
        "not": "不是用户画像（用 assets.*_profile / 资产中心）；不是 IM 渠道（用 channels）；不是临时搜一句网页（那用 web_search）；配好后搜网页仍用 web_search",
    },
    "assets": {
        "title": "资产中心",
        "when": "用户画像；或 Asset Hub 初始化/迁移/导出导入 .evoflow-pack 时",
        "not": "日常读写记忆笔记优先对话内 assets 工具；资源包整套场景用 org.*；旧 platform memory.* 已退役",
    },
    "agents": {
        "title": "智能体角色",
        "when": "CRUD 智能体角色（soul/skills/capability_pack）；绑能力前先 agents.bindings → packs",
        "not": "雇成值班岗用 employees；勿把 bindings.tools 全表灌入；勿省略 tools 指望拿到全部工具",
    },
    "employees": {
        "title": "智能体员工岗位",
        "when": (
            "看名册汇总/跨岗看板/单岗近况（org_status、board_overview、brief）、"
            "雇佣/暂停/恢复/唤醒/派新活/删除员工、改心跳、看工作日志、迁移旧事项到 Task、"
            "为岗位扫码绑飞书/企微（绑定本岗 AI 员工）时；新建优先 capability_pack=duty。"
            "新目标用 employees.dispatch；已有 Task / 卡住用 employees.wake；"
            "要跟岗对话用 employees.chat_send，看近几条用 employees.messages；"
            "create/hire 后读 assistant_guide.say_to_user 告诉用户怎么用；"
            "绑渠道用 employees.bind_channel_*（不是 channels.registration_*）"
        ),
        "not": "改角色模板用 agents；开可执行工单用 tasks / items.dispatch；禁止 tools:null 灌全表；全局主机器人用 channels",
    },
    "tasks": {
        "title": "协作任务台账（行政视角）",
        "when": "从行政侧列/查/建/改进度与状态/清理噪音或僵尸任务时",
        "not": ("值班过程中开单/带 handlers 结案也可优先用专用工具 tasks；用户备忘录用 items；对话 checklist 用 todo"),
    },
    "items": {
        "title": "用户事项/备忘",
        "when": "用户要记待办、备忘、截止日期；或把事项派给员工派生 Task 时",
        "not": "不自动开跑；对话内临时勾选用 todo；岗位执行中的工单用 tasks",
    },
    "skills": {
        "title": "技能",
        "when": "列出/查看/启用/安装/删除技能时",
        "not": "不是 MCP 服务器配置（用 mcp）；不是插件市场（用 plugins）；不是侧栏 Agent应用（用 extensions）",
    },
    "extensions": {
        "title": "Agent应用",
        "when": "侧栏 Agent应用（#/extensions）：列出/安装远程入口或本地目录、启用/禁用、卸载时",
        "not": "不是工作流 App（用 workflow）；不是插件市场（用 plugins）；不是技能包（用 skills）",
    },
    "plugins": {
        "title": "插件",
        "when": "插件市场：总览/安装/启停/更新/卸载插件，或添加/刷新/移除 marketplace 时",
        "not": "不是技能包（用 skills）；不是 MCP 直配（用 mcp）；不是侧栏 Agent应用网页（用 extensions）",
    },
    "mcp": {
        "title": "MCP",
        "when": "列出/增删/测通/整表替换 MCP 服务器，或 OAuth login/logout 时",
        "not": "不是技能包安装（用 skills）；不是插件市场（用 plugins）",
    },
    "org": {
        "title": "资源包",
        "when": "安装/预检/列出/卸载/导出组织资源包，或浏览/安装资源市场 pack 时",
        "not": "不是单个技能/插件/Agent应用安装（用 skills/plugins/extensions）；不是 Asset Hub 备份（用 evoflow assets）",
    },
    "channels": {
        "title": "IM 渠道",
        "when": "查看/配置/启停飞书·企微·钉钉·微信渠道，扫码注册，或查推送目标时",
        "not": "不是模型/联网搜索（用 settings）；不是定时推送任务本身（用 automation）",
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
    "sessions": {
        "title": "会话与上下文",
        "when": (
            "查当前对话状态/上下文占用用 sessions.status；"
            "主动压缩上下文用 sessions.compact（confirm=true）；"
            "按关键词检索历史会话用 sessions.search"
        ),
        "not": "不是当前对话内 todo；不是系统级端口/目录（用 diagnostics.status）",
    },
    "diagnostics": {
        "title": "日志与异常诊断",
        "when": (
            "查当前系统运行状态（端口/前后端/服务是否就绪/数据目录/安装目录）用 diagnostics.status；"
            "系统报错、启动失败、任务跑挂；要知道有哪些日志源、哪些源有报错、汇总可转发的异常时间线时"
        ),
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
    "ui": {
        "title": "右侧面板",
        "when": (
            "要在右侧打开/关闭面板时：工作流图、节点进度、员工执行过程、网页内嵌、产物等。"
            "用户要盯进度时用 ui.show（勿对每次写操作都开）"
        ),
        "not": "不是改主题/液态玻璃（用 appearance）；不是跳页面路由（用反馈卡 CTA）",
    },
    "media": {
        "title": "生图/生视频",
        "when": (
            "用户要生成图片或视频时：先 media.catalog 看可用厂商与 Agent Plan 档位，"
            "再 media.generate_image / media.generate_video（写操作 confirm=true）；"
            "视频提交后用 media.task_wait 等结果。默认火山方舟 jimeng（Seedream/Seedance）。"
        ),
        "not": "不是改媒体 API Key（设置页）；不是朗读/语音输入（创意媒体 TTS/ASR）；不要再调已退役的 media_* 独立工具名",
    },
    "eval": {
        "title": "评测中心",
        "when": "跑场景/观测评测、列用例与历史、查看某次 run 进度或详情时",
        "not": "不是系统验证轮次（用 verification）；不是只扫日志（用 diagnostics）",
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
        "hint": (f"这是{action.risk}操作，尚未执行。向用户复述将要做的事；用户确认后再次调用 platform(action={action.name!r}, args_json=..., confirm=true)。"),
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
        _A("knowledge.search", "knowledge", "检索自有知识库（默认 hybrid 多库扇出）", "read", "query, vaultId?/kbId?, top_k?, mode?", H.knowledge_search, "怎么配置 MCP"),
        _A("knowledge.create", "knowledge", "新建平台自有知识库", "write", "name, description?, embeddingModelRef?", H.knowledge_create, "建个英语单词库"),
        _A("knowledge.enable", "knowledge", "启用/停用 Obsidian Vault（遗留）", "write", "vaultId, enabled", H.knowledge_enable, "关掉某 Vault"),
        _A("knowledge.ingest", "knowledge", "写入一篇笔记", "write", "title, content, vaultId?/kbId?, summary?, tags?", H.knowledge_ingest, "把大纲写进库"),
        _A("knowledge.notes", "knowledge", "列出库内笔记", "read", "vaultId?/kbId?, prefix?, limit?", H.knowledge_notes, "英语库里有哪些笔记"),
        _A("knowledge.note_get", "knowledge", "读取一篇笔记", "read", "path, vaultId?/kbId?", H.knowledge_note_get, "打开某篇笔记"),
        _A("knowledge.note_delete", "knowledge", "删除一篇笔记", "destructive", "path, vaultId?/kbId?", H.knowledge_note_delete, "删掉这篇笔记"),
        _A(
            "knowledge.delete",
            "knowledge",
            "删除平台自有知识库（软删；内置库不可删）",
            "destructive",
            "kbId",
            H.knowledge_delete,
            "删掉验证用临时知识库",
        ),
        _A("knowledge.requeue", "knowledge", "重排队卡住的索引任务", "write", "kbId?, limit?", H.knowledge_requeue, "processing 一直不完成"),
        _A(
            "knowledge.reindex",
            "knowledge",
            "整库重索引（可改向量模型；force 默认 false，true=强制全量重建）",
            "write",
            "kbId, embeddingModelRef?, force?",
            H.knowledge_reindex,
            "改成 local 再重建向量",
            "force=true 全量重建",
        ),
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
        _A(
            "workflow.recover",
            "workflow",
            "从断点/失败节点续跑（读库纠状态后重派）",
            "write",
            "runId|taskId, reason?",
            H.workflow_recover,
            "服务重启后从这个节点接着跑",
        ),
        _A("workflow.run_status", "workflow", "查看运行状态", "read", "runId", H.workflow_run_status, "那个运行到哪了"),
        _A("workflow.list_runs", "workflow", "查看应用运行历史", "read", "appId, limit?, page?", H.workflow_list_runs, "这个应用跑过几次"),
        # settings
        _A("settings.list_models", "settings", "列出模型与默认模型", "read", "无", H.settings_list_models, "有哪些模型"),
        _A("settings.get_default_model", "settings", "查看默认模型", "read", "无", H.settings_get_default_model, "默认模型是啥"),
        _A("settings.set_default_model", "settings", "设置默认模型", "write", "model", H.settings_set_default_model, "默认改成 glm-5.2"),
        _A("settings.get_model", "settings", "查看单个模型配置", "read", "model", H.settings_get_model, "glm 怎么配的"),
        _A("settings.create_model", "settings", "新增模型配置", "write", "name/model/base_url/api_key 等", H.settings_create_model, "加一个新模型"),
        _A(
            "settings.update_model",
            "settings",
            "更新已有模型配置（改 Key/地址/参数；掩码 **** 的 api_key 会忽略）",
            "write",
            "model + 要改的字段（base_url?, api_key?, temperature?…）",
            H.settings_update_model,
            "把 glm 的 Key 换成新的",
            "改一下模型的 base_url",
        ),
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
        _A("assets.init", "assets", "初始化 Asset Hub 目录树与内置 vault", "write", "无", H.assets_init, "初始化资产中心目录"),
        _A(
            "assets.migrate",
            "assets",
            "把遗留 SQLite 记忆/经验迁移到资产文件",
            "write",
            "only?=all|experience|memory|slim|agent-memory, dry_run?",
            H.assets_migrate,
            "迁移旧记忆到资产中心",
            "先 dry_run 看会迁什么",
        ),
        _A(
            "assets.export",
            "assets",
            "导出实体资产为 .evoflow-pack",
            "write",
            "entity_type?=user|agent|employee, entity_id?, output?",
            H.assets_export,
            "导出我的用户资产包",
        ),
        _A(
            "assets.import",
            "assets",
            "导入 .evoflow-pack 到指定实体",
            "write",
            "pack, entity_type, entity_id, conflict?=skip|rename|overwrite",
            H.assets_import,
            "把这个资产包导入到 agent xxx",
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
            "我有 Agent Plan，帮我接通豆包联网搜索",
            "套餐 Key 已经配了，联网搜索通了吗",
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
        # appearance（EvoPanel 主题 / 背景 / 液态玻璃；读设置走 HTTP，platform 仅 patch）
        _A(
            "appearance.patch",
            "appearance",
            "更新界面外观（主题/色卡/背景/液态玻璃）",
            "write",
            "theme?, accentPalette?, accentCustom?, backgroundImage?, backgroundOpacity?, liquidGlassEnabled?, liquidGlassPreset?, liquidGlassBlur?, liquidGlassFlowSpeed?, liquidGlassReadabilityDim?, clearBackground?",
            H.appearance_patch,
            "改成深色+极光液态玻璃",
            "把背景换成本地视频路径",
        ),
        # ui（右侧面板；原独立 panel_set 工具已并入）
        _A(
            "ui.show",
            "ui",
            "打开右侧面板（进度/网页/产物等；读操作无需 confirm）",
            "read",
            "kind, data?, title?, layout?",
            H.ui_show,
            "打开任务工作流图 kind=collab-workflow data.mainTaskId",
            "打开员工执行过程 kind=employeeProcess data.taskId+agentCode",
            "打开节点进度 kind=collabSubtaskTranscript",
        ),
        _A(
            "ui.hide",
            "ui",
            "关闭右侧面板",
            "read",
            "无",
            H.ui_hide,
            "把右侧面板收起来",
        ),
        # media（生图 / 生视频；默认火山 Agent Plan / jimeng）
        _A(
            "media.catalog",
            "media",
            "查看生图/生视频能力目录（厂商、档位、同步/异步接口与传参）",
            "read",
            "tier_id?",
            H.media_catalog,
            "现在能生图生视频吗",
            "Agent Plan 支持哪些 Seedream/Seedance",
        ),
        _A(
            "media.status",
            "media",
            "检查生图/生视频是否已配置可用",
            "read",
            "无",
            H.media_status,
            "火山生图 Key 配好了吗",
        ),
        _A(
            "media.generate_image",
            "media",
            "生成图片（提交+轮询+落盘，一次返回路径）",
            "write",
            "prompt, model?, mode?, aspect_ratio?, reference_image_urls?, provider?, max_wait_seconds?",
            H.media_generate_image,
            "画一张暗色科技风产品海报 16:9",
            "用 doubao-seedream-5-0-pro 出首帧",
            "用上一张参考图做 image2image",
        ),
        _A(
            "media.generate_video",
            "media",
            "提交生视频任务（异步；再用 media.task_wait）",
            "write",
            "prompt, model?, mode?, first_frame_url?, last_frame_url?, duration?, resolution?, aspect_ratio?, generate_audio?, watermark?, seed?, provider?",
            H.media_generate_video,
            "用刚生成的图做 5 秒 image2video 并带口播",
            "指定 model=doubao-seedance-2.0 resolution=720p",
        ),
        _A(
            "media.task_wait",
            "media",
            "等待生视频/生图异步任务完成并落盘",
            "read",
            "task_id, provider?, media_kind?, max_wait_seconds?",
            H.media_task_wait,
            "等刚才的视频任务出片",
        ),
        _A(
            "ui.update",
            "ui",
            "更新已打开的右侧面板内容",
            "read",
            "kind, data?, title?, layout?",
            H.ui_update,
            "刷新节点进度面板数据",
        ),
        # agents
        _A("agents.list", "agents", "列出智能体角色", "read", "tag?, agent_name?, limit?, offset?, include_soul?", H.agents_list, "有哪些智能体"),
        _A("agents.get", "agents", "查看智能体详情", "read", "name/agent_code", H.agents_get, "main 配了啥"),
        _A(
            "agents.bindings",
            "agents",
            "可绑定能力包 packs + 工具/技能/MCP/知识库（创建前先查；优先选 pack）",
            "read",
            "include_disabled_skills?",
            H.agents_bindings,
            "建角色前有哪些能力包和工具可绑",
        ),
        _A(
            "agents.create",
            "agents",
            "创建智能体（优先 capability_pack；省略 tools→空；tools:null 须 confirm_inherit_all）",
            "write",
            "agent_code, capability_pack?, tools_extra?, tools?, confirm_inherit_all?, confirm_wide_tools?, skills?, mcp_servers?, knowledge_vault_ids?, model?…",
            H.agents_create,
            "建个文案助手用 capability_pack=writer",
        ),
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
        _A("employees.list", "employees", "列出智能体员工岗位", "read", "status?", H.employees_list, "现在有哪些员工"),
        _A(
            "employees.org_status",
            "employees",
            "名册汇总：人数、忙闲、待审批（不含小V自身）",
            "read",
            "无",
            H.employees_org_status,
            "现在有多少员工、谁空闲",
        ),
        _A(
            "employees.board_overview",
            "employees",
            "跨岗未结看板 + stuck_candidates（催办前先看）",
            "read",
            "limit_per_role?",
            H.employees_board_overview,
            "各岗未结任务卡在哪",
        ),
        _A(
            "employees.brief",
            "employees",
            "单岗近况简报：忙闲、未结任务、轨迹摘要",
            "read",
            "agent_code/role_name, include_trail?, task_limit?",
            H.employees_brief,
            "拆解岗最近在干嘛",
            "文案助手进度怎么样",
        ),
        _A("employees.get", "employees", "查看员工详情", "read", "agent_code, recent_limit?", H.employees_get, "拆解岗近况"),
        _A(
            "employees.hire",
            "employees",
            "雇佣智能体为值班员工（下属务必带 reports_to=上级agent_code；顶级可空）",
            "write",
            "agent_code, role_name?, reports_to?, workspace_path?, department?, heartbeat_rrule?…",
            H.employees_hire,
            "把文案助手雇成员工 reports_to=tech-lead",
        ),
        _A(
            "employees.create",
            "employees",
            "一次创建员工（下属必带 reports_to；职责只写正常流转+handlers，禁止写「等用户审核」——审核由系统在 handlers 交工时卡住）",
            "write",
            "role_name, reports_to?, workspace_path?, department?, responsibilities?, system_prompt?, capability_pack?, tools_extra?, tools?, confirm_inherit_all?, agent_code?, skills?, mcp_servers?, knowledge_vault_ids?…",
            H.employees_create,
            "加前端开发 reports_to=dev-tech-director workspace_path=…",
        ),
        _A(
            "employees.update",
            "employees",
            "更新员工岗位配置（可补 reports_to / workspace_path）",
            "write",
            "agent_code + reports_to? + workspace_path? + 其它字段",
            H.employees_update,
            "给前端挂上级 reports_to=dev-tech-director",
        ),
        _A("employees.pause", "employees", "暂停员工值班", "write", "agent_code", H.employees_pause, "让拆解岗先休息"),
        _A("employees.resume", "employees", "恢复员工值班", "write", "agent_code", H.employees_resume, "恢复拆解岗"),
        _A("employees.stop", "employees", "停止员工当前轮次（含对话轮）", "write", "agent_code", H.employees_stop, "停掉他手头这轮"),
        _A(
            "employees.chat_send",
            "employees",
            "打开/续聊员工对话：发一条消息并拉开右栏对话页（可多次调用续聊）",
            "write",
            "agent_code/role_name, message, session_key?, task_id?, source?",
            H.employees_chat_send,
            "跟拆解岗说：先列三步计划",
            "继续问文案助手刚才那个标题再短一点",
        ),
        _A(
            "employees.messages",
            "employees",
            "查看员工对话近几条消息 / 最后一条助手回复（不跟流，读结果用）",
            "read",
            "agent_code/role_name, session_key?, task_id?, limit?",
            H.employees_messages,
            "拆解岗最后回了什么",
            "看看他对话里近几条消息",
        ),
        _A(
            "employees.delete",
            "employees",
            "删除员工岗位（可选一并删除智能体）",
            "destructive",
            "agent_code, delete_agent?",
            H.employees_delete,
            "删掉验证用员工岗位",
        ),
        _A(
            "employees.worklog",
            "employees",
            "查看员工某日/近N日工作日志（rounds=值班轮次；tasks=台账任务；勿因 round_count=0 判空，请看 task_count/tasks/hint）",
            "read",
            "agent_code, day?, days?, limit?",
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
        _A(
            "employees.dispatch",
            "employees",
            "把新目标派给指定员工（后台值班轮；小V/前台 source=xiaomi）",
            "write",
            "agent_code/role_name, goal, description?, source?, from_agent?, task_id?, priority?",
            H.employees_dispatch,
            "派给拆解岗：把这份需求拆成子任务",
            "让文案助手写个标题",
        ),
        _A(
            "employees.wake",
            "employees",
            "唤醒员工（按 agent_code 或 role_name；可带 goal/task）",
            "write",
            "target/agent_code/role_name, goal?, task_id?, from_agent?, priority?, resume_round?, fresh_round?",
            H.employees_wake,
            "叫醒拆解岗处理一下",
            "@文案助手 帮我写个标题",
        ),
        _A(
            "employees.migrate",
            "employees",
            "把可执行旧事项(initiatives)迁移为 Task（可 dry_run）",
            "write",
            "agent_code?, dry_run?",
            H.employees_migrate,
            "把旧事项迁成任务台账",
        ),
        _A(
            "employees.bind_channel_begin",
            "employees",
            "为指定员工发起飞书/企微扫码，绑定本岗 AI 员工",
            "write",
            "agent_code, channel?=feishu|wecom",
            H.employees_bind_channel_begin,
            "给拆解岗出飞书二维码绑定",
        ),
        _A(
            "employees.bind_channel_poll",
            "employees",
            "轮询员工渠道扫码状态（对话卡通常会自动轮询；仅兜底）",
            "read",
            "session_id, channel?, agent_code?",
            H.employees_bind_channel_poll,
            "飞书扫码好了没",
        ),
        _A(
            "employees.bind_channel_apply",
            "employees",
            "把扫码凭证绑到本岗 AI 员工（勿用 channels.registration_apply）",
            "write",
            "agent_code, session_id, channel?=feishu|wecom",
            H.employees_bind_channel_apply,
            "扫码完成，绑到拆解岗",
        ),
        # tasks（行政台账；值班推进优先专用工具 tasks）
        _A(
            "tasks.list",
            "tasks",
            "列出协作 Task 台账（行政视角；默认不含子任务，limit 默认 50、上限 200）",
            "read",
            "status?, assignee?, role?, source?, limit?, offset?, include_subtasks?",
            H.tasks_list,
            "未结任务有哪些",
            "最近 5 条主任务",
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
        _A(
            "tasks.set_state",
            "tasks",
            "行政侧变更 Task 状态（合法流转：pending→executing→completed 等；非法时错误含 next_states）",
            "write",
            "task_id, state=pending|planned|executing|waiting_user|awaiting_close|completed|failed|cancelled|…, summary?",
            H.tasks_set_state,
            "把这单标完成",
            "先改成 executing 再 completed",
        ),
        _A("tasks.delete", "tasks", "删除 Task", "destructive", "task_id", H.tasks_delete, "删掉测试任务"),
        _A(
            "tasks.progress",
            "tasks",
            "更新 Task 进度（0-100；可顺带改 status）",
            "write",
            "task_id, progress, status?, subtask_id?",
            H.tasks_progress,
            "把这单进度改成 60",
        ),
        _A(
            "tasks.cleanup_noise",
            "tasks",
            "清理噪音任务（默认 dry_run；apply=true 才真正删）",
            "write",
            "apply?/dry_run?, stuck_days?, limit?",
            H.tasks_cleanup_noise,
            "先预览噪音任务",
            "清理卡住的噪音任务",
        ),
        _A(
            "tasks.reclaim_zombies",
            "tasks",
            "回收僵尸任务（默认 dry_run；apply=true 才执行）",
            "write",
            "apply?/dry_run?, stuck_days?, awaiting_close_days?, limit?",
            H.tasks_reclaim_zombies,
            "回收僵尸任务先预览",
        ),
        # items（用户个人事项，≠ 可执行 Task；≠ 对话内 todo）
        _A(
            "items.list",
            "items",
            "列出用户事项/备忘（持久化；≠ 对话 todo、≠ Task）",
            "read",
            "status?, priority?, tag?, q?, include_done?, page?, page_size?/limit?",
            H.items_list,
            "我有哪些待办事项",
            "只要高优先级未完成",
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
        _A("skills.install", "skills", "安装技能（path 或市场 slug；本地 path 可 link=true 挂载）", "write", "path 或 slug, owner?, link?", H.skills_install, "装这个技能包"),
        _A(
            "skills.import_orphans",
            "skills",
            "把非生效技能根里「生效根没有」的 custom 技能复制进当前生效根（不删除源）",
            "write",
            "无（confirm=true 执行；默认 dry-run）",
            H.skills_import_orphans,
            "把装错目录的技能导入生效根",
            "非生效根有技能但不加载",
        ),
        _A("skills.delete", "skills", "删除自定义技能", "destructive", "name", H.skills_delete, "删掉自定义技能"),
        # extensions（Agent应用 / UI 扩展）
        _A(
            "extensions.list",
            "extensions",
            "列出已安装的 Agent应用（侧栏扩展）",
            "read",
            "无",
            H.extensions_list,
            "装了哪些 Agent应用",
            "侧栏有哪些扩展网页",
        ),
        _A(
            "extensions.get",
            "extensions",
            "查看单个 Agent应用详情",
            "read",
            "id",
            H.extensions_get,
            "这个 Agent应用配了啥",
        ),
        _A(
            "extensions.install",
            "extensions",
            "安装 Agent应用：远程入口(id+url) / 本地目录(path) / 直接登记(manifest)",
            "write",
            "path? 或 id+url/entry? 或 manifest(+install_path?), link?, name?",
            H.extensions_install,
            "把这个网址挂成 Agent应用",
            "安装本地目录里的 Agent应用",
        ),
        _A(
            "extensions.enable",
            "extensions",
            "启用/禁用 Agent应用",
            "write",
            "id, enabled",
            H.extensions_enable,
            "先禁用这个 Agent应用",
        ),
        _A(
            "extensions.uninstall",
            "extensions",
            "卸载 Agent应用（folder-link 只摘登记不删源目录）",
            "destructive",
            "id",
            H.extensions_uninstall,
            "卸掉这个 Agent应用",
        ),
        # plugins（插件市场）
        _A(
            "plugins.overview",
            "plugins",
            "插件总览：市场 + 可装 + 已装",
            "read",
            "无",
            H.plugins_overview,
            "插件市场里有啥",
            "现在装了哪些插件",
        ),
        _A(
            "plugins.list",
            "plugins",
            "列出已安装插件",
            "read",
            "无",
            H.plugins_list,
            "已装插件列表",
        ),
        _A(
            "plugins.describe",
            "plugins",
            "查看插件组件（commands/skills/MCP 等）",
            "read",
            "marketplace, name",
            H.plugins_describe,
            "这个插件带了哪些技能和命令",
        ),
        _A(
            "plugins.install",
            "plugins",
            "从市场安装插件",
            "write",
            "marketplace, pluginName/name, scope?",
            H.plugins_install,
            "装 hello-command 官方插件",
        ),
        _A(
            "plugins.enable",
            "plugins",
            "启用/禁用已装插件",
            "write",
            "pluginId, enabled",
            H.plugins_enable,
            "关掉某个插件",
        ),
        _A(
            "plugins.update",
            "plugins",
            "更新已装插件到市场最新",
            "write",
            "pluginId",
            H.plugins_update,
            "更新这个插件",
        ),
        _A(
            "plugins.restore",
            "plugins",
            "恢复内置插件（卸过可再装回）",
            "write",
            "pluginId",
            H.plugins_restore,
            "把内置插件装回来",
        ),
        _A(
            "plugins.uninstall",
            "plugins",
            "卸载插件",
            "destructive",
            "pluginId, removeCache?",
            H.plugins_uninstall,
            "卸掉这个插件",
        ),
        _A(
            "plugins.marketplace_add",
            "plugins",
            "添加插件市场源",
            "write",
            "source",
            H.plugins_marketplace_add,
            "加一个本地/远程插件市场",
        ),
        _A(
            "plugins.marketplace_remove",
            "plugins",
            "移除插件市场源",
            "destructive",
            "marketplace/id",
            H.plugins_marketplace_remove,
            "去掉这个插件市场",
        ),
        _A(
            "plugins.marketplace_refresh",
            "plugins",
            "刷新插件市场目录（可指定 id；省略则刷新全部）",
            "write",
            "marketplace?",
            H.plugins_marketplace_refresh,
            "刷新官方插件市场",
        ),
        # mcp
        _A("mcp.get", "mcp", "查看 MCP 服务器配置（整表）", "read", "无", H.mcp_get, "现在挂了哪些 MCP"),
        _A("mcp.list", "mcp", "列出 MCP 服务器与运行状态", "read", "servers?/names?", H.mcp_list, "MCP 通不通、有哪些工具"),
        _A(
            "mcp.add",
            "mcp",
            "新增或更新单个 MCP 服务器",
            "write",
            "server/name, document|config|url|command+args…",
            H.mcp_add,
            "加一个 filesystem MCP",
            "挂上 github MCP",
        ),
        _A("mcp.remove", "mcp", "删除单个 MCP 服务器", "destructive", "server/name", H.mcp_remove, "删掉不用的 MCP"),
        _A("mcp.test", "mcp", "测通单个 MCP（连上并列工具）", "write", "server/name", H.mcp_test, "测一下这个 MCP 通不通"),
        _A("mcp.login", "mcp", "刷新 HTTP MCP 的 OAuth 登录", "write", "server/name", H.mcp_login, "给这个 MCP 重新登录"),
        _A("mcp.logout", "mcp", "清除 MCP OAuth 缓存（提示级）", "write", "server/name", H.mcp_logout, "退出这个 MCP 登录"),
        _A("mcp.set", "mcp", "整体替换 MCP 配置", "write", "mcp_servers 对象", H.mcp_set, "更新 MCP 配置"),
        # org（资源包）
        _A(
            "org.preflight",
            "org",
            "预检资源包（不安装）",
            "read",
            "source|path, workspace?, id_prefix?",
            H.org_preflight,
            "先检查这个资源包能不能装",
        ),
        _A(
            "org.install",
            "org",
            "安装资源包（本地目录/zip/市场路径）",
            "write",
            "source|path|url, workspace?, id_prefix?, conflict?",
            H.org_install,
            "装这个内容运营资源包",
        ),
        _A("org.list", "org", "列出已装资源包实例", "read", "status?=active|uninstalled|all", H.org_list, "装过哪些资源包"),
        _A("org.get", "org", "查看资源包实例详情", "read", "org_instance_id", H.org_get, "这个资源包装了啥"),
        _A(
            "org.uninstall",
            "org",
            "卸载资源包实例",
            "destructive",
            "org_instance_id, keep_primitives?, delete_workspace?",
            H.org_uninstall,
            "卸掉这个资源包",
        ),
        _A(
            "org.export",
            "org",
            "导出本地员工/应用等为资源包",
            "write",
            "pack?, include?|employees+apps, output.dir|output_dir, zip?",
            H.org_export,
            "把拆解岗和日报工作流导出成资源包",
        ),
        _A("org.market_catalog", "org", "拉取资源市场目录", "read", "无", H.org_market_catalog, "资源市场有哪些包"),
        _A(
            "org.market_install",
            "org",
            "按市场相对路径安装资源包",
            "write",
            "path, workspace?, repo?",
            H.org_market_install,
            "从市场装 packs/content-ops",
        ),
        # channels（IM）
        _A("channels.list", "channels", "列出 IM 渠道状态", "read", "无", H.channels_list, "飞书渠道开了吗"),
        _A("channels.get", "channels", "查看单个渠道配置与运行状态", "read", "name", H.channels_get, "飞书怎么配的"),
        _A(
            "channels.set_config",
            "channels",
            "更新渠道配置（默认 merge）",
            "write",
            "name, config|字段…, merge?",
            H.channels_set_config,
            "写入飞书 app_id/app_secret",
        ),
        _A(
            "channels.enable",
            "channels",
            "启用/禁用渠道",
            "write",
            "name, enabled",
            H.channels_enable,
            "先关掉微信渠道",
        ),
        _A("channels.restart", "channels", "重启渠道", "write", "name", H.channels_restart, "重启飞书渠道"),
        _A(
            "channels.push_targets",
            "channels",
            "列出可推送的 IM 会话目标",
            "read",
            "limit?",
            H.channels_push_targets,
            "能往哪些群推结果",
        ),
        _A(
            "channels.registration_begin",
            "channels",
            "开始扫码注册（飞书/微信/企微/钉钉）",
            "write",
            "name?=feishu|weixin|wecom|dingtalk",
            H.channels_registration_begin,
            "帮我扫码接入飞书",
        ),
        _A(
            "channels.registration_poll",
            "channels",
            "轮询扫码注册状态",
            "read",
            "session_id, name?",
            H.channels_registration_poll,
            "扫码好了没",
        ),
        _A(
            "channels.registration_apply",
            "channels",
            "把扫码拿到的凭证写入并尝试启动渠道",
            "write",
            "session_id, name?, enabled?, agent_code?",
            H.channels_registration_apply,
            "扫码完成，写入飞书凭证",
        ),
        # automation
        _A("automation.list", "automation", "列出定时自动化", "read", "无", H.automation_list, "有哪些定时任务"),
        _A("automation.get", "automation", "查看自动化详情", "read", "id", H.automation_get, "这个自动化咋配的"),
        _A("automation.history", "automation", "自动化运行历史", "read", "id, limit?", H.automation_history, "最近跑过几次"),
        _A("automation.create", "automation", "创建定时自动化", "write", "name, prompt, cron/rrule/schedule?", H.automation_create, "每天九点巡检"),
        _A("automation.update", "automation", "更新自动化", "write", "id + 字段", H.automation_update, "改自动化提示词"),
        _A("automation.set_status", "automation", "启用/停用自动化", "write", "id, status(active|paused|…)", H.automation_set_status, "暂停这个定时"),
        _A("automation.delete", "automation", "删除自动化", "destructive", "id", H.automation_delete, "删掉测试定时"),
        # approvals
        _A(
            "approvals.list",
            "approvals",
            "列出审批（默认 pending；传 status=all 看全部）",
            "read",
            "status?, limit?",
            H.approvals_list,
            "有什么要我批",
        ),
        _A("approvals.approve", "approvals", "同意审批", "write", "id/task_id, comment?", H.approvals_approve, "这个批了"),
        _A("approvals.reject", "approvals", "驳回审批", "write", "id/task_id, reason", H.approvals_reject, "驳回并说明原因"),
        # sessions
        _A("sessions.search", "sessions", "按关键词搜历史会话", "read", "query, max_results?, max_age_days?, search_titles?", H.sessions_search, "上次聊英语单词是哪个会话"),
        _A(
            "sessions.status",
            "sessions",
            "查看当前（或指定）对话状态：运行态、消息数、上下文占用、是否已压缩",
            "read",
            "session_key?/thread_id?（默认当前对话）",
            H.sessions_status,
            "当前对话上下文用了多少",
            "这个会话还在跑吗",
            "上下文占用到百分之几了",
        ),
        _A(
            "sessions.compact",
            "sessions",
            "主动压缩当前（或指定）对话上下文（与 /compact 同引擎；需 confirm=true）",
            "write",
            "session_key?/thread_id?, confirm=true",
            H.sessions_compact,
            "帮我压缩一下上下文",
            "上下文太满了，压缩当前对话",
        ),
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
            "综合系统诊断（日志/知识库/模型/员工/定时）；focus 可只跑对应模块：logs|knowledge|models|employees|automation 或中文别名",
            "read",
            "focus?=logs|knowledge|models|employees|automation|员工|对话|定时|知识库|模型",
            H.diagnostics_run,
            "帮我查一下系统有什么问题",
            "员工跑不起来帮我诊断一下",
            "定时任务没触发帮我看看",
        ),
        _A(
            "diagnostics.status",
            "diagnostics",
            "查看当前系统运行状态（系统端口、前后端端口、服务状态、数据目录、安装目录）",
            "read",
            "无",
            H.diagnostics_status,
            "系统现在运行状态怎么样",
            "前后端端口是多少",
            "数据目录和安装目录在哪",
            "当前服务跑在哪个端口",
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
        # eval（评测中心）
        _A(
            "eval.cases",
            "eval",
            "列出评测用例",
            "read",
            "category?=scenario|business|security|performance",
            H.eval_cases,
            "有哪些评测场景",
        ),
        _A(
            "eval.run",
            "eval",
            "启动一次评测（默认同步等结果；async=true 可后台跑）",
            "write",
            "mode?=smoke|full|scenario|observational|…, name?, days?, async?, wait?",
            H.eval_run,
            "跑一轮 smoke 评测",
        ),
        _A("eval.runs", "eval", "列出近期评测运行", "read", "limit?, offset?, type?, status?", H.eval_runs, "最近评测跑了几次"),
        _A("eval.get", "eval", "查看某次评测详情", "read", "run_id", H.eval_get, "这次评测结果怎么样"),
        _A("eval.progress", "eval", "查看评测进度", "read", "run_id", H.eval_progress, "评测跑到哪了"),
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
        "actions": [{"name": a.name, "summary": a.summary, "risk": a.risk} for a in actions],
        "action_names": [a.name for a in actions],
    }


def build_catalog(
    *,
    domain: str | None = None,
    detailed: bool = False,
    summary: bool = False,
) -> dict[str, Any]:
    """Build platform catalog.

    - No domain + not detailed: domain guides + one-line action list (default).
    - ``summary=True``: only ``name`` + ``risk`` (+ domain) — cheap probe mode (DEF-04).
    - domain set + detailed: full params/examples for that domain.
    """
    reg = get_registry()
    dom = str(domain or "").strip().lower() or None
    actions = [a for a in reg.values() if not dom or a.domain == dom]
    if not actions and dom:
        return {
            "ok": False,
            "error": f"unknown domain: {dom}",
            "domains": list(PLATFORM_DOMAINS),
            "guides": [domain_guide(d) for d in PLATFORM_DOMAINS],
            "hint": "用 catalog 不带 domain 看域摘要，或指定某一域名看详版；也可 args_json 传 domain。",
        }

    if summary:
        items = [{"name": a.name, "domain": a.domain, "risk": a.risk} for a in actions]
        return {
            "ok": True,
            "mode": "summary",
            "count": len(items),
            "domain": dom,
            "items": items,
            "hint": "摘要模式只含 name/risk；详版：catalog + domain=…（勿传 summary）。",
        }

    # 无 domain：短目录 = 每域 when/not + 功能清单 + 全部 action 一行摘要
    if not dom and not detailed:
        by_dom: dict[str, list[PlatformAction]] = {}
        for a in actions:
            by_dom.setdefault(a.domain, []).append(a)
        domain_summaries = [_domain_catalog_entry(d, by_dom[d]) for d in PLATFORM_DOMAINS if d in by_dom]
        items = [{"name": a.name, "domain": a.domain, "risk": a.risk, "summary": a.summary} for a in actions]
        return {
            "ok": True,
            "count": len(items),
            "domains": domain_summaries,
            "items": items,
            "routing": ("先按 domains[].when 选域，再选 domains[].actions[].name 作为 action。用户备忘→items；岗位工单推进→专用工具 tasks（或本工具 tasks.* 行政侧）；对话 checklist→todo。写/破坏性操作须用户确认后 confirm=true。"),
            "hint": (
                "某域详版：action=catalog 且 domain="
                + "|".join(PLATFORM_DOMAINS)
                + "（domain 可用工具参数或 args_json）。摘要：args_json 传 summary=true。"
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
        out["actions"] = [{"name": a.name, "summary": a.summary, "risk": a.risk, "params": a.params} for a in actions]
        if dom == "workflow":
            from evoflow.admin.platform_workflow_schema import build_workflow_platform_schema

            out["schema"] = build_workflow_platform_schema()
    return out


def build_help(topic: str | None = None) -> dict[str, Any]:
    t = str(topic or "").strip().lower()
    if not t or t in {"", "platform", "all", "*"}:
        cat = build_catalog(detailed=False)
        cat["manual"] = "平台行政统一走 platform。流程：catalog/help 看 domains（含 when + 功能清单）→ 选 action →（写操作向用户确认）→ confirm=true 执行。易混：items=用户备忘；tasks 域/专用 tasks 工具=协作工单；todo=对话内临时清单。"
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
    session_key: str = "",
    thread_id: str = "",
) -> dict[str, Any]:
    act = str(action or "").strip()
    if not act:
        return {
            "ok": False,
            "error": "action is required",
            "hint": "先 platform(action='catalog') 看说明书。",
        }

    key = act.lower()
    # Parse args early so catalog/help can take domain/summary from args_json (DEF-04).
    try:
        early_args = _parse_args(args_json) if key in {"help", "manual", "说明书", "catalog", "list_actions", "目录", "domains"} else None
    except ValidationError as exc:
        return {"ok": False, "error": str(exc), "action": act}

    if key in {"help", "manual", "说明书"}:
        topic = domain or (str(early_args.get("domain") or early_args.get("topic") or "").strip() if early_args else "") or None
        return build_help(topic)
    if key in {"catalog", "list_actions", "目录", "domains"}:
        args = early_args or {}
        dom_raw = domain or args.get("domain") or args.get("domains")
        if isinstance(dom_raw, (list, tuple)):
            dom_raw = dom_raw[0] if dom_raw else None
        dom = str(dom_raw or "").strip() or None
        summary = bool(args.get("summary")) or str(args.get("mode") or "").strip().lower() == "summary"
        detailed_flag = args.get("detailed")
        if detailed_flag is None:
            detailed = bool(dom) and not summary
        else:
            detailed = bool(detailed_flag) and not summary
        return build_catalog(domain=dom, detailed=detailed, summary=summary)

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

    # Thread principal / current conversation into handlers (extra keys are
    # inert when unused). Task「责任人」uses ambient ContextVar, not args.
    args = dict(args or {})
    pid = str(principal_id or "").strip()
    if pid:
        args.setdefault("principal_id", pid)
    sk = str(session_key or "").strip()
    if sk:
        args.setdefault("session_key", sk)
    tid = str(thread_id or "").strip()
    if tid:
        args.setdefault("thread_id", tid)

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
