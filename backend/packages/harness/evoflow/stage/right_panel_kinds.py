"""右栏（Right Stage）面板类型清单 —— **唯一真源**。

【self-evolution-bot · 2026-11-20 · 第87轮 · 模型:deepseek-v4.1-flash-1017】
改了什么：新建本文件，把「右栏支持哪些 kind、每种需要哪些字段、谁能触发」从
散落三处（stage_tool._build_progress_surface / platform_ui_feedback 的 autoOpen
白名单 / 前端 open-progress-from-panel-set.ts 的重复校验）收敛成一份声明式表。
为什么：用户反馈「右栏对不齐、莫名其妙打开东西」，根因是同一条规则被前后端各写
一遍且已经不一致（后端要求 employeeProcess 必须有 taskId，前端只查 agentCode）。
现在后端是唯一真源，前端通过 GET /api/ui/right-stage/kinds 读取，并有测试保证
不会漂移。模型侧通过 platform action=ui.kinds 读到同一份清单，才知道能开什么、
每种怎么传参。

设计边界（用户 2026-11-20 定）：
1. **只读动作永不自动弹右栏** —— 要有通知就够了，不要让右栏自己展开。
2. **模型只能「申请展示」，不能抢用户视线** —— 除用户亲手点开外，一律不自动展开。
3. 类型清单必须可被模型查询，否则模型不知道支持什么、怎么传参。

本文件不含任何渲染逻辑，只声明契约；渲染仍由前端各自 pane 负责。
"""

from __future__ import annotations

from typing import Any, Final, Literal

# ── 触发者语义 ────────────────────────────────────────────────────────────────
# user      = 用户点击（可 forceExpand 抢焦点，撑开右栏）
# agent     = 模型调 ui.show 申请展示（只写标签，不自动撑开；用户点了才展开）
# auto      = 系统按事件自动打开（仅限「真在办事」的动作；只读一律不自动开）
TriggerKind = Literal["user", "agent", "auto"]

# 「真在办事」才允许自动打开的动作：写操作 / 长任务 / 需要盯进度的。
# 只读动作（*.get / *.list / *.brief / *.status / *.overview / *.departments /
# *.messages）**一律不在此列** —— 用户 2026-11-20：有通知就够了，别自动展开。
AUTO_OPEN_ACTIONS: Final[frozenset[str]] = frozenset(
    {
        "employees.wake",
        "employees.dispatch",
        "employees.resume",
        "employees.chat_send",
        # 【self-evolution-bot · 2026-11-20 · 第88轮 · 模型:deepseek-v4.1-flash-1017】
        # 改了什么：补进 6 个原本写死在调用点里的写动作。
        # 为什么：platform_ui_feedback 里有两处私有 auto=True 集合
        # （tasks.create/set_state/get、employees.create/hire/update/get/brief），
        # 与真源并存。把它们收进真源才能只留一份判据；同时**只收写动作**，
        # get/brief 这两个纯只读留在 READ_ONLY_ACTIONS 里不再自动展开。
        # 注意：只收 platform_actions 里**真实注册**的动作名——重启后我核出
        # "tasks.update" 根本不存在于注册表（只有 set_state），那是一条死条目，已删。
        "employees.create",
        "employees.hire",
        "employees.update",
        "tasks.create",
        "tasks.set_state",
        "items.dispatch",
        "workflow.run",
        "workflow.resume",
        "workflow.recover",
    }
)

# 纯只读动作：只发通知卡（可点），**永不 autoOpen**。
READ_ONLY_ACTIONS: Final[frozenset[str]] = frozenset(
    {
        "employees.get",
        "employees.brief",
        "employees.list",
        "employees.departments",
        "employees.org_status",
        "employees.board_overview",
        "employees.messages",
        "tasks.get",
        "tasks.list",
        "tasks.execution_trail",
        "items.get",
        "items.list",
        # 【self-evolution-bot · 2026-11-20 · 第88轮 · 模型:deepseek-v4.1-flash-1017】
        # 改了什么：补进 9 个「注册表里 risk=read 但当初没登记」的动作。
        # 为什么：新加的门禁 test_read_only_list_covers_every_read_risk_action 抓出来的。
        # 它们此前行为上正确（不在白名单 → should_auto_open 返 False），
        # 但属于「靠兜底巧合正确」：真源里查不到它们，下一个维护者没法确认这是有意还是漏了。
        "employees.bind_channel_poll",
        "employees.trail",
        "employees.worklog",
        "workflow.get",
        "workflow.list",
        "workflow.list_runs",
        "workflow.revisions",
        "workflow.run_status",
        "workflow.schema",
    }
)


def should_auto_open(action: str) -> bool:
    """动作是否允许自动展开右栏。

    唯一判据是白名单命中；只读动作显式排除（即使将来有人把它塞进白名单，
    这里也必须返回 False —— 用户明确要求只读不要自动弹）。
    """
    act = str(action or "").strip()
    if not act or act in READ_ONLY_ACTIONS:
        return False
    return act in AUTO_OPEN_ACTIONS


# ── 面板类型契约 ──────────────────────────────────────────────────────────────


def _kind(
    *,
    kind: str,
    label: str,
    trigger: TriggerKind,
    layout: str,
    required: tuple[str, ...] = (),
    optional: tuple[str, ...] = (),
    description: str,
    example: dict[str, Any] | None = None,
) -> dict[str, Any]:
    spec: dict[str, Any] = {
        "kind": kind,
        "label": label,
        "trigger": trigger,
        "layout": layout,
        "required": list(required),
        "optional": list(optional),
        "description": description,
    }
    if example is not None:
        spec["example"] = example
    return spec


# 用户 2026-11-20：这份表就是「模型该读的东西」。新增 kind 必须落在这里，
# 而不是只在前端 render-right-stage-body.tsx 里加一个 if 分支。
RIGHT_PANEL_KINDS: Final[tuple[dict[str, Any], ...]] = (
    _kind(
        kind="collab-workflow",
        label="协作工作流图",
        trigger="agent",
        layout="wide",
        required=("data.mainTaskId",),
        optional=("data.leadThreadId", "title", "layout"),
        description="多节点协作任务的实时流程图。用主任务 id 打开。",
        example={"kind": "collab-workflow", "data": {"mainTaskId": "<task_id>"}},
    ),
    _kind(
        kind="collabSubtaskTranscript",
        label="协作节点进度",
        trigger="agent",
        layout="wide",
        required=("data.mainTaskId", "data.subtaskId"),
        optional=("data.leadThreadId", "data.status", "title"),
        description="工作流里单个节点的会话过程。需要主任务 + 子任务两个 id。",
        example={
            "kind": "collabSubtaskTranscript",
            "data": {"mainTaskId": "<task_id>", "subtaskId": "<subtask_id>"},
        },
    ),
    _kind(
        kind="employeeProcess",
        label="员工执行过程",
        trigger="agent",
        layout="wide",
        required=("data.agentCode",),
        optional=("data.taskId", "data.roleName", "data.roundId", "data.busy", "title"),
        description=(
            "某个员工/岗位的实时对话与执行过程，可续聊。"
            "taskId 可省略（跟岗场景只有 agent 也能量开），后端会自动补齐。"
        ),
        example={"kind": "employeeProcess", "data": {"agentCode": "<agent_code>"}},
    ),
    _kind(
        kind="sessionRuntime",
        label="本会话运行中",
        trigger="agent",
        layout="wide",
        required=("data.sessionKey",),
        optional=("data.focusKind", "data.works"),
        description="当前会话下正在跑的子工作列表；点某一行可下钻到对应过程。",
        example={"kind": "sessionRuntime", "data": {"sessionKey": "<session_key>"}},
    ),
    _kind(
        kind="web-embed",
        label="网页内嵌",
        trigger="agent",
        layout="wide",
        required=("data.url",),
        optional=("title", "layout"),
        description=(
            "在右栏内嵌打开一个网页（完整 URL，含 https://）。"
            "要给用户看网页时用这个，而不是只在聊天里贴链接。"
        ),
        example={"kind": "web-embed", "data": {"url": "https://example.com"}},
    ),
    _kind(
        kind="shell-page",
        label="平台内嵌页",
        trigger="agent",
        layout="wide",
        required=("data.path",),
        optional=("data.mountId", "data.focusId", "data.entityLabel", "title"),
        description=(
            "把 EvoPanel 自己的页面嵌进右栏，如 /tasks、/tasks/items、/proactive。"
            "path 必须是站内路径（以 / 开头），不要传外网 URL（外网用 web-embed）。"
        ),
        example={"kind": "shell-page", "data": {"path": "/tasks", "title": "任务"}},
    ),
    _kind(
        kind="artifacts",
        label="本轮产物",
        trigger="user",
        layout="wide",
        required=("data.items",),
        optional=("title",),
        description=(
            "【已退役，勿用】产物改由侧栏 Info Rail 承载；右栏会直接拒收这个 kind。"
        ),
    ),
    _kind(
        kind="mind-map",
        label="思维导图",
        trigger="user",
        layout="narrow",
        description="知识图谱/思维导图视图，无必需入参。",
        example={"kind": "mind-map", "data": {}},
    ),
    _kind(
        kind="news-dashboard",
        label="资讯面板",
        trigger="user",
        layout="wide",
        description="资讯聚合视图，无必需入参。",
    ),
)


def kind_specs() -> list[dict[str, Any]]:
    """返回全部面板类型契约（供 API / 模型查询）。"""
    return [dict(spec) for spec in RIGHT_PANEL_KINDS]


def kind_map() -> dict[str, dict[str, Any]]:
    return {str(spec["kind"]): spec for spec in RIGHT_PANEL_KINDS}


def contract_for(kind: str) -> dict[str, Any] | None:
    """按 kind 取契约；未知 kind 返回 None。"""
    return kind_map().get(str(kind or "").strip())


def required_fields(kind: str) -> list[str]:
    spec = contract_for(kind)
    return list(spec.get("required") or []) if spec else []


def missing_fields(kind: str, data: dict[str, Any] | None) -> list[str]:
    """校验 data 是否满足该 kind 的必填字段（点号路径，如 data.mainTaskId）。

    【self-evolution-bot · 2026-11-20 · 第87轮 · 模型:deepseek-v4.1-flash-1017】
    改了什么：新增统一校验入口，替代 stage_tool 里逐个 if 分支各写一份。
    为什么：前后端各写一遍已漂移（前端 employeeProcess 只查 agentCode）。
    现在只有这一处算数。
    """
    spec = contract_for(kind)
    if not spec:
        return []
    payload = data if isinstance(data, dict) else {}
    missing: list[str] = []
    for path in spec.get("required") or []:
        parts = str(path).split(".")
        # 契约里带 data. 前缀，实际校验时剥掉，支持同义键兜底由调用方处理。
        key = parts[-1]
        if not str(payload.get(key) or "").strip():
            missing.append(str(path))
    return missing


# ── 合法 kind 集合：契约 ∪ 前端渲染层实际支持 ────────────────────────────────
#
# 【self-evolution-bot · 2026-11-21 · 第104轮 · 模型:deepseek-v4.1-flash-1017】
# 改了什么：新增 FRONTEND_ONLY_KINDS / KNOWN_KINDS / is_known_kind / unknown_kind_message，
#   并让 platform ui.show / ui.update 在建签前做白名单校验。
# 为什么（本轮真机实测）：`ui.show(kind="not-a-kind")` 返回 **ok:true**，
#   surface.id="primary"，审计日志还记了一条 emit sent。而前端
#   render-right-stage-body.tsx 对未知 kind 走到末尾 `return null` ——
#   用户看到的是一个**空白页签**，还把原来那一页顶掉了。工具说成功、屏幕是空的，
#   正是本仓库反复出现的那类「契约写了、代码没执行」。
# 设计边界（别照抄契约去做白名单）：
#   契约 RIGHT_PANEL_KINDS 只列「模型可申请」的 8 种，而 apply_right_panel 还被
#   内部调用方（写文件流、终端、子代理输出、旧 CTA）使用，它们传的 write / file /
#   terminal … 均不在契约里。若直接拿契约当门禁，会把这些合法调用一起打死。
#   所以合法集合 = 契约 ∪ 前端真能渲染的内部 kind；校验只挂在**模型入口**，
#   不进 apply_right_panel，内部链路不受影响。
FRONTEND_ONLY_KINDS: Final[frozenset[str]] = frozenset(
    {
        # render-right-stage-body.tsx 有真实分支的内部签
        "write",
        "file",
        "asset",
        "codeViewer",
        "terminal",
        "interactive-terminal",
        "workspace-browse",
        "summary",
        "subagentTranscript",
        "v4Session",
        "mind-map",
        # 前端另有专门通道渲染、但模型也可能直接 show 的
        "web-embed",
        "shell-page",
        "news-dashboard",
        "browser",
        "screenshot",
        "xiaomi",
        "platform-feedback",
        "artifacts",
    }
)


def KNOWN_KINDS() -> frozenset[str]:  # noqa: N802 - 与既有 kind_specs() 命名保持一致的只读集合
    """全部合法 kind（契约 ∪ 前端内部签）。用函数而非常量，避免 import 期耦合。"""
    return frozenset(kind_map().keys()) | FRONTEND_ONLY_KINDS


def is_known_kind(kind: str) -> bool:
    """这个 kind 是否被支持（调用方应先过 _normalize_panel_kind 归一别名）。"""
    return str(kind or "").strip() in KNOWN_KINDS()


def unknown_kind_message(kind: str) -> str:
    """未知 kind 的报错文案：点名可用清单 + 指路 ui.kinds，别让模型下一轮再猜。"""
    supported = sorted(kind_map().keys())
    return (
        f"unknown right-panel kind: {str(kind or '').strip()!r}. "
        f"Supported kinds: {', '.join(supported)}. "
        "Call platform action=ui.kinds to read each kind's required fields; "
        "for an external page use kind=web-embed with data.url, "
        "for an in-app page use kind=shell-page with data.path."
    )


# ── 只读动作 → 通知卡（永不自动展开）─────────────────────────────────────────


def describe_for_prompt() -> str:
    """给模型看的一行摘要，拼进 platform 工具描述。"""
    lines: list[str] = []
    for spec in RIGHT_PANEL_KINDS:
        if spec["kind"] == "artifacts":
            continue
        req = " , ".join(spec.get("required") or []) or "无必需字段"
        lines.append(f"- {spec['kind']}（{spec['label']}）必需：{req}")
    return "\n".join(lines)
