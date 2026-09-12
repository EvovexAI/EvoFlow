"""Industry-aligned eval case specifications (SSOT for catalog + seeds + UI).

Layers (pyramid):
  L0 — component/deterministic validators
  L1 — single-module integration
  L2 — cross-entity business scenarios (happy / alt / negative)
  L3 — live LLM via Gateway HTTP (wake / workflow run); gated by EVOFLOW_EVAL_LIVE_LLM=1

Priorities: P0 release gate · P1 scenario pack · P2 exploratory
Flows: happy | alt | negative | boundary | state_machine
"""

from __future__ import annotations

from typing import Any, Literal, TypedDict

FlowType = Literal["happy", "alt", "negative", "boundary", "state_machine"]
Priority = Literal["P0", "P1", "P2"]
Level = Literal["L0", "L1", "L2", "L3"]


class CaseDesign(TypedDict, total=False):
    priority: Priority
    flow: FlowType
    technique: str
    persona: str
    preconditions: list[str]
    steps: list[str]
    expected: list[str]
    cleanup: str
    risk: str
    implemented: bool  # False = design-only / L3 placeholder


class CaseSpec(TypedDict, total=False):
    id: str
    name: str
    module: str
    category: str
    level: Level
    handler: str
    description: str
    design: CaseDesign
    enabled: bool


FLOW_LABELS: dict[str, str] = {
    "happy": "基本流",
    "alt": "备选流",
    "negative": "异常流",
    "boundary": "边界值",
    "state_machine": "状态机",
}

PRIORITY_LABELS: dict[str, str] = {
    "P0": "发版门禁",
    "P1": "场景包",
    "P2": "探索",
}

LEVEL_LABELS: dict[str, str] = {
    "L0": "组件校验",
    "L1": "模块集成",
    "L2": "业务场景",
    "L3": "真 LLM / Gateway",
}


def _d(
    *,
    priority: Priority,
    flow: FlowType,
    technique: str,
    persona: str,
    preconditions: list[str],
    steps: list[str],
    expected: list[str],
    risk: str,
    cleanup: str = "临时 EVOFLOW_HOME 隔离库，用例结束自动销毁",
    implemented: bool = True,
) -> CaseDesign:
    return {
        "priority": priority,
        "flow": flow,
        "technique": technique,
        "persona": persona,
        "preconditions": preconditions,
        "steps": steps,
        "expected": expected,
        "cleanup": cleanup,
        "risk": risk,
        "implemented": implemented,
    }


def _spec(
    case_id: str,
    name: str,
    module: str,
    level: Level,
    handler: str,
    description: str,
    design: CaseDesign,
    *,
    enabled: bool = True,
) -> CaseSpec:
    return {
        "id": case_id,
        "name": name,
        "module": module,
        "category": "scenario",
        "level": level,
        "handler": handler,
        "description": description,
        "design": design,
        "enabled": enabled,
    }


# ---------------------------------------------------------------------------
# Full catalog
# ---------------------------------------------------------------------------

CASE_CATALOG: list[CaseSpec] = [
    # ── 知识库 ──────────────────────────────────────────────
    _spec(
        "sc_knowledge_fs_search",
        "【知识库·基本流】写入后全文召回",
        "knowledge",
        "L1",
        "eval.scenario.knowledge_fs_search",
        "vault → remember → fulltext recall 命中唯一词",
        _d(
            priority="P0",
            flow="happy",
            technique="scenario",
            persona="知识管理员",
            preconditions=["干净评测库", "可创建 managed vault"],
            steps=[
                "创建知识库 vault",
                "写入含唯一检索词的笔记",
                "用该词做 fulltext recall",
            ],
            expected=["vault_id 非空", "recall 命中含唯一词", "无 mock"],
            risk="召回失败则员工/小V 知识检索不可用",
        ),
    ),
    _spec(
        "sc_module_knowledge",
        "【知识库·基本流】Vault 与笔记 CRUD",
        "knowledge",
        "L1",
        "eval.scenario.module_knowledge",
        "创建 vault → remember → list/get → delete 后不可读",
        _d(
            priority="P0",
            flow="happy",
            technique="scenario",
            persona="知识管理员",
            preconditions=["干净评测库"],
            steps=["创建 vault", "写入笔记", "列表与 get", "删除并确认不可读"],
            expected=["CRUD 全链路可审计", "删除后 get 失败"],
            risk="知识库主路径损坏",
        ),
    ),
    _spec(
        "sc_module_knowledge_detail",
        "【知识库·备选/边界】启停、前缀、召回、删除",
        "knowledge",
        "L1",
        "eval.scenario.module_knowledge_detail",
        "enable 切换；list(prefix)；召回；删除边界",
        _d(
            priority="P1",
            flow="boundary",
            technique="boundary+alt",
            persona="知识管理员",
            preconditions=["已有 vault 能力"],
            steps=["切换 vault 启停", "按前缀列出", "召回", "删除笔记"],
            expected=["启停可观测", "前缀列表正确", "删除后不可见"],
            risk="过滤/启停边界易漏测",
        ),
    ),
    _spec(
        "sc_knowledge_recall_negative",
        "【知识库·异常流】空查询与错误 vault",
        "knowledge",
        "L1",
        "eval.scenario.knowledge_recall_negative",
        "空 query / 不存在 vault_id 时行为明确（拒绝或空结果，不抛未处理异常）",
        _d(
            priority="P1",
            flow="negative",
            technique="equivalence+negative",
            persona="知识管理员",
            preconditions=["可创建 vault"],
            steps=["对存在 vault 发空查询", "对伪造 vault_id 查询"],
            expected=["不崩溃", "空查询无脏命中或明确错误", "错 vault 空结果或 ValidationError"],
            risk="异常输入导致 500 或串库",
        ),
    ),
    _spec(
        "sc_knowledge_agent_recall_trajectory",
        "【知识库·L3规划】员工绑库后运行时召回",
        "knowledge",
        "L3",
        "",
        "（规划）雇佣挂 knowledge_vault_ids 后 Lead 工具召回命中 — 需真 LLM",
        _d(
            priority="P2",
            flow="happy",
            technique="trajectory",
            persona="值班员工",
            preconditions=["LLM 可用", "员工已绑 vault"],
            steps=["派发目标要求引用笔记", "追踪 tool 轨迹含 knowledge/recall"],
            expected=["轨迹含预期工具", "终态引用正确"],
            risk="配置正确但运行时未召回",
            implemented=False,
        ),
        enabled=False,
    ),
    # ── 智能体 CRUD + 智能体员工 ─────────────────────────────
    _spec(
        "sc_module_agents",
        "【智能体·基本流】CRUD",
        "agents",
        "L1",
        "eval.scenario.module_agents",
        "创建 → get → update → list 可见",
        _d(
            priority="P0",
            flow="happy",
            technique="scenario",
            persona="系统管理员",
            preconditions=["干净评测库"],
            steps=["创建智能体", "读取", "更新字段", "列表可见"],
            expected=["agent_code 持久化", "更新字段可读回"],
            risk="智能体主数据损坏",
        ),
    ),
    _spec(
        "sc_employee_lifecycle",
        "【智能体员工·状态机】雇佣暂停恢复与工作日志",
        "employees",
        "L1",
        "eval.scenario.employee_lifecycle",
        "hire → pause → resume → worklog 形态",
        _d(
            priority="P0",
            flow="state_machine",
            technique="state_machine",
            persona="人力/管理员",
            preconditions=["智能体已创建"],
            steps=["雇佣为岗位", "暂停", "恢复", "查看 worklog"],
            expected=["status 转换正确", "worklog 结构合法"],
            risk="值班岗位状态错乱",
        ),
    ),
    _spec(
        "sc_module_agents_detail",
        "【智能体·异常/边界】非法名与 skills/tags",
        "agents",
        "L1",
        "eval.scenario.module_agents_detail",
        "非法 agent_code 拒绝；skills/tags 持久化",
        _d(
            priority="P1",
            flow="negative",
            technique="boundary+negative",
            persona="系统管理员",
            preconditions=["干净评测库"],
            steps=["提交非法 agent_code", "合法创建并写 skills/tags", "再更新"],
            expected=["非法名被拒绝", "skills/tags 可读回"],
            risk="脏数据进入 agent 表",
        ),
    ),
    _spec(
        "sc_employee_hire_duplicate",
        "【智能体员工·异常流】重复雇佣冲突",
        "employees",
        "L1",
        "eval.scenario.employee_hire_duplicate",
        "同一 agent_code 二次 hire 必须 Conflict/明确失败",
        _d(
            priority="P1",
            flow="negative",
            technique="negative",
            persona="人力/管理员",
            preconditions=["智能体已雇佣"],
            steps=["再次 hire 同一 code"],
            expected=["抛 ConflictError 或 ok=false", "原岗位仍在"],
            risk="重复岗位覆盖配置",
        ),
    ),
    _spec(
        "sc_employee_task_runtime_contract",
        "【智能体员工·账本】提示词工具与值班 brief 合同（无 LLM）",
        "employees",
        "L2",
        "eval.scenario.employee_task_runtime_contract",
        "[ledger/no_llm] 冻结 system_prompt/tools → hire 挂库 → duty brief + resolve tools 对账",
        _d(
            priority="P0",
            flow="happy",
            technique="runtime_contract",
            persona="人力/能力管理员",
            preconditions=["干净评测库", "可创建 vault"],
            steps=[
                "创建智能体并写入 system_prompt/soul/tools",
                "hire 并挂 knowledge_vault_ids",
                "组装 duty brief",
                "resolve 工具集",
            ],
            expected=[
                "prompt/soul 可读回含约定 token",
                "tools 白名单生效且不含禁工具",
                "duty brief 含岗位/职责/工作指南",
            ],
            risk="页面配置正确但值班提示词/工具不一致",
        ),
    ),
    _spec(
        "sc_employee_task_dispatch_ledger",
        "【智能体员工·账本】派发账本与 wake 就绪快照（无 LLM）",
        "employees",
        "L2",
        "eval.scenario.employee_task_dispatch_ledger",
        "[ledger/no_llm] dispatch(wake_now=False) 落 task，快照若 wake 将使用的 prompt/tools",
        _d(
            priority="P0",
            flow="happy",
            technique="runtime_contract",
            persona="最终用户/值班调度",
            preconditions=["员工已雇佣且 tools 已冻结"],
            steps=["create_item", "dispatch wake_now=False", "核对 source_ref", "记录 wake 就绪快照"],
            expected=["task 指派正确", "source_ref=item:…", "duty brief/tools 快照非空"],
            risk="账本绿但员工运行时合同不可用",
        ),
    ),
    _spec(
        "sc_employee_task_work_item_gate",
        "【智能体员工·账本】工作项审批门（无 LLM）",
        "employees",
        "L2",
        "eval.scenario.employee_task_work_item_gate",
        "[ledger/no_llm] create_role_work_item → 审批通过/拒绝与 initiative 一致",
        _d(
            priority="P0",
            flow="state_machine",
            technique="state_machine",
            persona="值班员工/审批人",
            preconditions=["已雇佣且 APPROVAL_FOR_ALL"],
            steps=["创建工作项", "request_approval", "approve", "另建一项 reject"],
            expected=["APPROVED/REJECTED 与 DB 对账", "duty brief 可读"],
            risk="审批台账与任务状态分叉",
        ),
    ),
    _spec(
        "sc_employee_task_tool_binding_negative",
        "【智能体员工·账本】工具白名单与未知技能（无 LLM）",
        "employees",
        "L2",
        "eval.scenario.employee_task_tool_binding_negative",
        "[ledger/no_llm] 仅绑定 read：禁工具不得 resolve；未知 skill 更新失败",
        _d(
            priority="P1",
            flow="negative",
            technique="negative+boundary",
            persona="能力管理员",
            preconditions=["干净评测库"],
            steps=["create_agent tools=[read]", "resolve 工具", "update 未知 skill"],
            expected=["禁工具不在 resolve 结果", "未知 skill 被拒绝且未持久化"],
            risk="显示有工具/技能、运行时串台",
        ),
    ),
    _spec(
        "sc_employee_task_pause_blocks_dispatch_intent",
        "【智能体员工·账本】暂停态派发可审计（无 LLM）",
        "employees",
        "L2",
        "eval.scenario.employee_task_pause_blocks_dispatch_intent",
        "[ledger/no_llm] pause 后仍可建 task 时 role.status=paused；resume 后 active",
        _d(
            priority="P1",
            flow="alt",
            technique="state_machine",
            persona="人力/值班调度",
            preconditions=["员工已雇佣"],
            steps=["pause", "dispatch", "核对岗位仍 paused", "resume"],
            expected=["paused 期间岗位状态可对账", "resume 后 active"],
            risk="暂停岗位仍被当成在值班",
        ),
    ),
    _spec(
        "sc_employee_task_live_wake",
        "【智能体员工·L3真跑】dispatch wake 调系统 LLM",
        "employees",
        "L3",
        "eval.scenario.employee_task_live_wake",
        "HTTP 建员工+事项 → POST dispatch(wake_now=true) → 轮询任务/busy 直至真 LLM 证据",
        _d(
            priority="P1",
            flow="happy",
            technique="live_llm_gateway",
            persona="最终用户/值班调度",
            preconditions=["Gateway 已启动", "EVOFLOW_EVAL_LIVE_LLM=1", "主模型可用"],
            steps=[
                "POST /api/agents + /api/proactive/roles",
                "POST /api/items",
                "POST /api/items/{id}/dispatch wake_now=true",
                "轮询 GET /api/tasks 与 /busy",
            ],
            expected=["dispatched", "source_ref=item:…", "真 LLM 终态或报告证据", "禁止 inject"],
            risk="账本绿但员工不干活",
            implemented=True,
        ),
    ),
    _spec(
        "sc_employee_task_pause_rejects_wake",
        "【智能体员工·安全】暂停态拒绝 dispatch_task",
        "employees",
        "L2",
        "eval.scenario.employee_task_pause_rejects_wake",
        "pause 后 ProactiveRunner.dispatch_task 必须失败（不得当真在岗 wake）",
        _d(
            priority="P0",
            flow="negative",
            technique="safety",
            persona="人力/值班调度",
            preconditions=["员工已雇佣"],
            steps=["pause", "dispatch_task", "断言 ok=false"],
            expected=["role=paused", "dispatch 被拒"],
            risk="暂停岗仍被叫醒干活",
        ),
    ),
    _spec(
        "sc_employee_task_busy_mutex",
        "【智能体员工·安全】busy 互斥",
        "employees",
        "L2",
        "eval.scenario.employee_task_busy_mutex",
        "占用 busy 槽后二次派发返回 busy，结束后释放",
        _d(
            priority="P0",
            flow="boundary",
            technique="safety",
            persona="值班调度",
            preconditions=["员工已雇佣"],
            steps=["_reserve_role", "二次 dispatch_task", "_end_role"],
            expected=["busy=true 或 ok=false", "结束后不 busy"],
            risk="并发叠跑污染轨迹",
        ),
    ),
    _spec(
        "sc_employee_task_already_done_skip",
        "【智能体员工·重试】结案防重派",
        "employees",
        "L2",
        "eval.scenario.employee_task_already_done_skip",
        "related 已 completed 时 dispatch 返回 skipped/already_done",
        _d(
            priority="P1",
            flow="alt",
            technique="retry",
            persona="值班调度",
            preconditions=["可建工作项"],
            steps=["建工作项并 completed", "dispatch related", "断言 skipped"],
            expected=["ok+skipped/already_done"],
            risk="结案任务被反复唤醒",
        ),
    ),
    _spec(
        "sc_employee_task_org_collab_gate",
        "【智能体员工·协同】同组织可协作、跨组织禁派发",
        "employees",
        "L2",
        "eval.scenario.employee_task_org_collab_gate",
        "同组织平级/上下级可派发叫醒；不同 workspace 组织禁止互派；真人用户与小V（系统前台）不限",
        _d(
            priority="P0",
            flow="boundary",
            technique="safety",
            persona="组织负责人",
            preconditions=["可雇佣多名员工并设置 workspace/reports_to"],
            steps=["雇同组织 mgr+peers", "雇外组织员工", "校验派发门禁"],
            expected=["平级允许", "上级→下级允许", "跨组织拒绝", "user 允许", "xiaomi 允许"],
            risk="跨组织乱叫醒或同组织无法协作",
        ),
    ),
    # ── 技能 ───────────────────────────────────────────────
    _spec(
        "sc_module_skills",
        "【技能·基本流】启停并绑定智能体",
        "skills",
        "L1",
        "eval.scenario.module_skills",
        "list → disable/enable → bind skills 到 agent",
        _d(
            priority="P0",
            flow="happy",
            technique="scenario",
            persona="能力管理员",
            preconditions=["技能目录非空"],
            steps=["列出技能", "禁用再启用", "绑定到智能体"],
            expected=["enabled_only 排除禁用项", "agent.skills 含目标名"],
            risk="技能开关与绑定不一致",
        ),
    ),
    _spec(
        "sc_module_skills_detail",
        "【技能·备选流】查询形态与自定义安装删除",
        "skills",
        "L1",
        "eval.scenario.module_skills_detail",
        "get_skill；install_from_directory → delete",
        _d(
            priority="P1",
            flow="alt",
            technique="scenario",
            persona="能力管理员",
            preconditions=["可写临时技能目录"],
            steps=["get 已有技能", "从目录安装自定义", "删除自定义"],
            expected=["get 形态稳定", "安装后可见", "删除后不可见"],
            risk="自定义技能残留污染",
        ),
    ),
    _spec(
        "sc_skills_bind_unknown",
        "【技能·异常流】绑定不存在的技能名",
        "skills",
        "L1",
        "eval.scenario.skills_bind_unknown",
        "绑定不存在的 skill 名必须 ValidationError，且不得持久化",
        _d(
            priority="P1",
            flow="negative",
            technique="negative",
            persona="能力管理员",
            preconditions=["智能体可创建"],
            steps=["创建智能体", "绑定不存在的 skill 名", "再 get"],
            expected=["ValidationError", "agent.skills 不含幽灵名"],
            risk="幽灵技能导致运行时静默缺能力",
            implemented=True,
        ),
    ),
    _spec(
        "sc_skills_disabled_not_in_enabled_only",
        "【技能·备选流】禁用后仅启用列表不可见（设计对照）",
        "skills",
        "L1",
        "eval.scenario.module_skills",
        "设计条目：与 sc_module_skills 同路径，不单独跑（enabled=0）",
        _d(
            priority="P1",
            flow="alt",
            technique="alt",
            persona="能力管理员",
            preconditions=["至少一条非 custom 技能"],
            steps=["禁用技能", "list(enabled_only=True)"],
            expected=["该技能不在启用列表"],
            risk="前端仍展示已禁用技能",
            implemented=True,
        ),
        enabled=False,
    ),
    # ── MCP ────────────────────────────────────────────────
    _spec(
        "sc_module_mcp",
        "【MCP·基本流】配置往返与绑定",
        "mcp",
        "L1",
        "eval.scenario.module_mcp",
        "set/get config → agent 绑定 → 解绑 → 清空（不 spawn 进程）",
        _d(
            priority="P0",
            flow="happy",
            technique="scenario",
            persona="集成管理员",
            preconditions=["干净评测库"],
            steps=["写入假 MCP server", "绑到智能体", "解绑", "清空配置"],
            expected=["配置可读回", "绑定/解绑正确", "无进程拉起"],
            risk="MCP 配置面损坏",
        ),
    ),
    _spec(
        "sc_mcp_binding_boundary",
        "【MCP·L0】工具 allowlist 过滤",
        "mcp",
        "L0",
        "eval.scenario.mcp_binding_boundary",
        "_filter_tools_by_mcp_servers 仅放行绑定 server 的工具",
        _d(
            priority="P0",
            flow="boundary",
            technique="unit-like",
            persona="运行时安全",
            preconditions=["无"],
            steps=["构造多 server 工具名", "按 allowlist 过滤"],
            expected=["未绑定 server 工具被剔除"],
            risk="越权工具暴露",
        ),
    ),
    _spec(
        "sc_module_mcp_detail",
        "【MCP·边界】字段持久化与 None/[]/list 语义",
        "mcp",
        "L1",
        "eval.scenario.module_mcp_detail",
        "stdio 字段 roundtrip；mcp_servers=None/[name]/[]",
        _d(
            priority="P1",
            flow="boundary",
            technique="boundary",
            persona="集成管理员",
            preconditions=["干净评测库"],
            steps=["写完整 stdio 字段", "分别设 None/列表/空列表", "读回"],
            expected=["字段不丢", "三种语义可区分"],
            risk="空绑定被误读成全开",
        ),
    ),
    _spec(
        "sc_mcp_unbind_clears_surface",
        "【MCP·备选流】解绑后绑定面为空（设计对照）",
        "mcp",
        "L1",
        "eval.scenario.module_mcp",
        "设计条目：与 sc_module_mcp 同路径，不单独跑（enabled=0）",
        _d(
            priority="P1",
            flow="alt",
            technique="alt",
            persona="集成管理员",
            preconditions=["已绑定 MCP"],
            steps=["update_agent(mcp_servers=[])", "get_agent"],
            expected=["mcp_servers 为空列表"],
            risk="解绑后仍注入工具",
        ),
        enabled=False,
    ),
    # ── 工作流 ─────────────────────────────────────────────
    _spec(
        "sc_module_workflow",
        "【工作流·基本流】保存列表开跑",
        "workflow",
        "L1",
        "eval.scenario.module_workflow",
        "validate → save → list/get → run 产生 task/run（不等 LLM）",
        _d(
            priority="P0",
            flow="happy",
            technique="scenario",
            persona="流程设计师",
            preconditions=["干净评测库"],
            steps=["校验定义", "保存 App", "列表/get", "run_app"],
            expected=["定义合法", "出现 task_id 或 run_id"],
            risk="工作流无法开跑",
        ),
    ),
    _spec(
        "sc_workflow_dag_validate",
        "【工作流·L0异常】DAG 环与悬空边",
        "workflow",
        "L0",
        "eval.scenario.workflow_dag_validate",
        "非法依赖图必须校验失败",
        _d(
            priority="P0",
            flow="negative",
            technique="negative",
            persona="流程设计师",
            preconditions=["无"],
            steps=["提交含环 DAG", "提交悬空依赖"],
            expected=["校验失败且有 errors"],
            risk="非法图进入执行引擎",
        ),
    ),
    _spec(
        "sc_workflow_rollup_stub",
        "【工作流·账本】官方 outcome 完结 rollup（无 LLM）",
        "workflow",
        "L1",
        "eval.scenario.workflow_rollup_stub",
        "[ledger/no_llm] run_app_workflow 后经 apply_subtask_outcome_report 完结并 rollup",
        _d(
            priority="P1",
            flow="alt",
            technique="official_outcome",
            persona="流程设计师",
            preconditions=["可 run_app_workflow"],
            steps=["开跑", "官方 outcome 完结子任务", "sync/rollup", "检查主任务完结"],
            expected=["主任务 completed", "rollup 可观测"],
            risk="子任务完成后主任务悬挂",
        ),
    ),
    _spec(
        "sc_workflow_task_step_binding",
        "【工作流·任务处理·账本】步骤 agent/tools/instruction 绑定（无 LLM）",
        "workflow",
        "L2",
        "eval.scenario.workflow_task_step_binding",
        "[ledger/no_llm] 两步不同 agent_code/tools/instruction → run 后 worker_profile 对账",
        _d(
            priority="P0",
            flow="happy",
            technique="runtime_contract",
            persona="流程设计师",
            preconditions=["两步智能体已创建"],
            steps=["save_app", "run_app_workflow auto_authorize", "核对子任务 worker_profile"],
            expected=["步骤绑定一致", "execution_authorized", "app_run 存在"],
            risk="步骤配置与运行时 worker 不一致",
        ),
    ),
    _spec(
        "sc_workflow_task_official_outcome_rollup",
        "【工作流·任务处理·账本】官方 outcome 汇总（无 LLM）",
        "workflow",
        "L2",
        "eval.scenario.workflow_task_official_outcome_rollup",
        "[ledger/no_llm] 官方 outcome 写报告 token → sync → 主任务 completed + rollup",
        _d(
            priority="P0",
            flow="happy",
            technique="official_outcome",
            persona="流程设计师",
            preconditions=["可 run_app_workflow"],
            steps=["开跑", "逐步 official completed", "sync", "检查报告与主任务"],
            expected=["报告含约定 token", "主任务 completed", "rollup 子任务存在"],
            risk="假绿：手改 storage 冒充执行",
        ),
    ),
    _spec(
        "sc_workflow_task_step_fail_halts",
        "【工作流·任务处理·账本】首步失败不伪绿（无 LLM）",
        "workflow",
        "L2",
        "eval.scenario.workflow_task_step_fail_halts",
        "[ledger/no_llm] 第一步 official failed 后主任务不得 completed，下游不得伪装完成",
        _d(
            priority="P1",
            flow="negative",
            technique="negative",
            persona="流程设计师",
            preconditions=["两步工作流"],
            steps=["开跑", "官方 fail 步骤1", "检查步骤2与主任务"],
            expected=["步骤1 failed", "步骤2未假完成", "主任务非 completed"],
            risk="失败步骤被当成全绿",
        ),
    ),
    _spec(
        "sc_workflow_task_inherit_agent_tools",
        "【工作流·任务处理·账本】步骤无 tools 继承智能体（无 LLM）",
        "workflow",
        "L2",
        "eval.scenario.workflow_task_inherit_agent_tools",
        "[ledger/no_llm] step 不写 tools 时 worker allowlist 继承 agent 工具集",
        _d(
            priority="P1",
            flow="boundary",
            technique="boundary",
            persona="流程设计师",
            preconditions=["agent 已配置 tools"],
            steps=["step 省略 tools", "run", "resolve_worker_tool_allowlist"],
            expected=["继承含 agent tools", "profile 无错误覆盖"],
            risk="步骤省略 tools 时落到全局工具集",
        ),
    ),
    _spec(
        "sc_workflow_task_param_render",
        "【工作流·任务处理·账本】参数渲染进目标文案（无 LLM）",
        "workflow",
        "L2",
        "eval.scenario.workflow_task_param_render",
        "[ledger/no_llm] parameters 渲染进 goal/instruction，不得残留 {topic}",
        _d(
            priority="P1",
            flow="alt",
            technique="scenario",
            persona="流程设计师",
            preconditions=["App 参数含 topic"],
            steps=["run_app_workflow 带 topic", "检查子任务文案"],
            expected=["含渲染后主题", "无 {topic} 字面量"],
            risk="工人收到未渲染占位符",
        ),
    ),
    _spec(
        "sc_workflow_task_live_run",
        "【工作流·任务处理·L3真跑】HTTP run 调系统 LLM",
        "workflow",
        "L3",
        "eval.scenario.workflow_task_live_run",
        "HTTP 保存/发布 App → POST /api/apps/{id}/run → 轮询子任务真实报告（禁止 inject outcome）",
        _d(
            priority="P1",
            flow="happy",
            technique="live_llm_gateway",
            persona="流程设计师",
            preconditions=["Gateway 已启动", "EVOFLOW_EVAL_LIVE_LLM=1", "主模型可用"],
            steps=[
                "POST /api/apps",
                "POST /api/apps/{id}/publish",
                "POST /api/apps/{id}/run",
                "轮询 GET /api/tasks 与 subtasks",
            ],
            expected=["task_id", "子任务真实报告", "主任务终态或两步均有报告", "无 inject"],
            risk="账本绿但工人未真跑",
            implemented=True,
        ),
    ),
    _spec(
        "sc_workflow_task_cancel_run",
        "【工作流·控制面】cancel_run 取消主任务与 run",
        "workflow",
        "L2",
        "eval.scenario.workflow_task_cancel_run",
        "开跑后 cancel_run：主任务/子任务/app_run 均为 cancelled",
        _d(
            priority="P0",
            flow="alt",
            technique="state_machine",
            persona="流程设计师",
            preconditions=["可 run_app_workflow"],
            steps=["run", "cancel_run", "核对状态"],
            expected=["main cancelled", "app_run cancelled", "无开放子任务"],
            risk="取消后子任务仍执行",
        ),
    ),
    _spec(
        "sc_workflow_publish_rejects_cycle",
        "【工作流·安全】环依赖不得发布",
        "workflow",
        "L2",
        "eval.scenario.workflow_publish_rejects_cycle",
        "含环 DAG validate 失败，不得变为 published",
        _d(
            priority="P0",
            flow="negative",
            technique="safety",
            persona="流程设计师",
            preconditions=["可 save_app"],
            steps=["保存环图", "validate", "断言未 published"],
            expected=["valid=false", "status≠published"],
            risk="非法图进入执行引擎",
        ),
    ),
    _spec(
        "sc_workflow_task_retry_unblocks_downstream",
        "【工作流·重试】上游失败后重试解阻下游",
        "workflow",
        "L2",
        "eval.scenario.workflow_task_retry_unblocks_downstream",
        "步骤1 failed → 步骤2 不伪绿 → requeue + 双方 completed",
        _d(
            priority="P1",
            flow="alt",
            technique="retry",
            persona="流程设计师",
            preconditions=["两步依赖工作流"],
            steps=["开跑", "fail 1", "requeue", "complete 1+2"],
            expected=["下游未假完成", "最终双方 completed"],
            risk="重试成功但下游永久卡住",
        ),
    ),
    _spec(
        "sc_module_workflow_detail",
        "【工作流·异常流】缺必填参数与删除",
        "workflow",
        "L1",
        "eval.scenario.module_workflow_detail",
        "缺参拒绝；带参 run；delete_app",
        _d(
            priority="P1",
            flow="negative",
            technique="negative+boundary",
            persona="流程设计师",
            preconditions=["已保存含必填参数的 App"],
            steps=["缺参 run", "带参 run", "删除 App"],
            expected=["缺参失败", "带参产生 run", "删除后不可 get"],
            risk="参数门禁失效或删除残留",
        ),
    ),
    # ── 任务中心 ───────────────────────────────────────────
    _spec(
        "sc_module_tasks",
        "【任务中心·基本流】列表与合法完结",
        "tasks",
        "L1",
        "eval.scenario.module_tasks",
        "创建任务 → 列表可见 → 合法路径完结",
        _d(
            priority="P0",
            flow="happy",
            technique="scenario",
            persona="协作主管",
            preconditions=["干净评测库"],
            steps=["创建任务", "列表", "迁到可完结状态并完成"],
            expected=["列表含该任务", "终态 completed"],
            risk="任务主路径不可用",
        ),
    ),
    _spec(
        "sc_task_inbox_transitions",
        "【任务中心·L0状态机】inbox 合法/非法迁移",
        "tasks",
        "L0",
        "eval.scenario.task_inbox_transitions",
        "inbox→pending 合法；inbox→executing 拦截",
        _d(
            priority="P0",
            flow="state_machine",
            technique="state_machine",
            persona="协作主管",
            preconditions=["可创建 inbox 任务"],
            steps=["合法迁移", "非法迁移"],
            expected=["合法成功", "非法被拒"],
            risk="状态机被绕过",
        ),
    ),
    _spec(
        "sc_approval_ledger",
        "【任务中心·基本/备选】审批通过与拒绝台账",
        "tasks",
        "L1",
        "eval.scenario.approval_ledger",
        "request_approval 后 approve 与 reject 双轨，approval↔initiative 一致",
        _d(
            priority="P0",
            flow="happy",
            technique="scenario+alt",
            persona="审批人",
            preconditions=["岗位 autonomy=approval_for_all"],
            steps=["创建 work_item", "申请审批", "通过一条", "拒绝另一条"],
            expected=["通过侧双表 APPROVED", "拒绝侧双表 REJECTED"],
            risk="审批台账漂移",
        ),
    ),
    _spec(
        "sc_module_tasks_detail",
        "【任务中心·边界】source 过滤与非法完结",
        "tasks",
        "L1",
        "eval.scenario.module_tasks_detail",
        "source=chat/workflow 过滤；pending→completed 非法；executing→completed 合法",
        _d(
            priority="P1",
            flow="boundary",
            technique="boundary+state_machine",
            persona="协作主管",
            preconditions=["可创建多 source 任务"],
            steps=["按 source 过滤", "尝试非法完结", "合法完结"],
            expected=["过滤正确", "非法失败", "合法成功"],
            risk="看板过滤错乱或非法完结",
        ),
    ),
    # ── 待办 ───────────────────────────────────────────────
    _spec(
        "sc_module_items",
        "【待办·基本流】创建完结隐藏",
        "items",
        "L1",
        "eval.scenario.module_items",
        "create → list → done → include_done=false 隐藏",
        _d(
            priority="P0",
            flow="happy",
            technique="scenario",
            persona="最终用户",
            preconditions=["干净评测库"],
            steps=["创建待办", "列表命中", "标 done", "未含 done 列表不可见"],
            expected=["id 非空", "done 后默认列表隐藏"],
            risk="个人事项主路径损坏",
        ),
    ),
    _spec(
        "sc_item_dispatch_link",
        "【待办·基本流】派发联动协作任务",
        "items",
        "L2",
        "eval.scenario.item_dispatch_link",
        "create agent+hire → item → dispatch(wake=false) → source_ref=item:id",
        _d(
            priority="P0",
            flow="happy",
            technique="scenario",
            persona="最终用户",
            preconditions=["可创建智能体并雇佣"],
            steps=["雇佣派发员", "创建事项", "dispatch", "核对 linked_task_ids 与 source_ref"],
            expected=["task_id 回写 item", "source_ref=item:{id}"],
            risk="事项与任务断链",
        ),
    ),
    _spec(
        "sc_module_items_detail",
        "【待办·边界】优先级停放与 done 过滤",
        "items",
        "L1",
        "eval.scenario.module_items_detail",
        "priority 过滤；parked；done 对 include_done=false 隐藏",
        _d(
            priority="P1",
            flow="boundary",
            technique="boundary",
            persona="最终用户",
            preconditions=["可写多项待办"],
            steps=["按 priority 过滤", "park", "done 过滤"],
            expected=["过滤器生效"],
            risk="看板漏项/多项",
        ),
    ),
    _spec(
        "sc_item_dispatch_unknown_agent",
        "【待办·异常流】派发到不存在岗位的行为明确",
        "items",
        "L2",
        "eval.scenario.item_dispatch_unknown_agent",
        "仅有 agent 未 hire（或幽灵 code）：仍可建 task 但 assigned_role 空，行为可审计",
        _d(
            priority="P1",
            flow="negative",
            technique="negative",
            persona="最终用户",
            preconditions=["待办已创建", "目标 code 无岗位"],
            steps=["dispatch(wake_now=false)", "get_task"],
            expected=["产生 task_id", "assigned_role 为空或与未雇佣一致", "source_ref 仍正确"],
            risk="静默派发到空岗导致无人值守",
        ),
    ),
    # ── 平台门禁 ───────────────────────────────────────────
    _spec(
        "sc_platform_confirm_preview",
        "【平台·基本流】confirm 预览不落库",
        "platform",
        "L1",
        "eval.scenario.platform_confirm_preview",
        "items.create confirm=false 预览；true 落库",
        _d(
            priority="P0",
            flow="happy",
            technique="scenario",
            persona="行政写操作调用方",
            preconditions=["platform registry 可用"],
            steps=["confirm=false 创建", "list 仍为空", "confirm=true", "list≥1"],
            expected=["预览不落库", "确认后落库"],
            risk="未确认写操作污染数据",
        ),
    ),
    _spec(
        "sc_plan_guard_phase",
        "【平台·异常流】PlanGuard 未激活阻断副作用",
        "platform",
        "L0",
        "eval.scenario.plan_guard_phase",
        "无 workspace activation 时副作用工具返回 error ToolMessage",
        _d(
            priority="P0",
            flow="negative",
            technique="negative",
            persona="协作会话",
            preconditions=["PlanGuard middleware"],
            steps=["在未激活 phase 调副作用工具"],
            expected=["工具被拦", "不执行 handler"],
            risk="未授权阶段误写",
        ),
    ),
    _spec(
        "sc_exec_authorize_gate",
        "【平台·异常流】模型不可自授执行权",
        "platform",
        "L0",
        "eval.scenario.exec_authorize_gate",
        "model 授权失败；user 授权成功 → execution_authorized",
        _d(
            priority="P0",
            flow="negative",
            technique="negative",
            persona="安全门禁",
            preconditions=["可构造待授权任务"],
            steps=["以 model 身份授权", "以 user 身份授权"],
            expected=["model 失败", "user 成功且门闩打开"],
            risk="模型自授执行权",
        ),
    ),
    _spec(
        "sc_platform_confirm_reject_path",
        "【平台·备选流】仅预览不确认则数据不变（设计对照）",
        "platform",
        "L1",
        "eval.scenario.platform_confirm_preview",
        "设计条目：与 confirm_preview 同路径，不单独跑（enabled=0）",
        _d(
            priority="P1",
            flow="alt",
            technique="alt",
            persona="行政写操作调用方",
            preconditions=["platform registry"],
            steps=["多次 confirm=false", "从不 confirm=true"],
            expected=["库中无对应 item"],
            risk="预览路径误写入",
        ),
        enabled=False,
    ),
    # ── 跨模块 ─────────────────────────────────────────────
    _spec(
        "sc_cross_module_saga",
        "【跨模块·基本流】配置→派发→工作流→审批通过",
        "cross",
        "L2",
        "eval.scenario.cross_module_saga",
        "知识库+MCP+技能→智能体雇佣→confirm 待办→派发→工作流→任务中心→审批通过",
        _d(
            priority="P0",
            flow="happy",
            technique="saga",
            persona="实施顾问 / 管理员",
            preconditions=["干净隔离库", "技能目录可用"],
            steps=[
                "建知识库并召回",
                "配 MCP、启技能、建智能体并雇佣挂库",
                "confirm 门禁建待办并派发",
                "保存并开跑工作流",
                "任务中心可见两条任务",
                "审批通过台账一致",
            ],
            expected=["十条检查点全过", "各模块 id 可审计串联"],
            risk="模块单测绿但主链断",
        ),
    ),
    _spec(
        "sc_cross_module_saga_reject",
        "【跨模块·备选流】审批拒绝台账",
        "cross",
        "L2",
        "eval.scenario.cross_module_saga_reject",
        "配岗后 work_item 审批拒绝：approval 与 initiative 均为 REJECTED",
        _d(
            priority="P1",
            flow="alt",
            technique="saga+alt",
            persona="审批人",
            preconditions=["可雇佣 approval_for_all 岗位"],
            steps=["雇佣", "建 work_item", "申请审批", "拒绝"],
            expected=["ApprovalStatus.REJECTED", "InitiativeStatus.REJECTED"],
            risk="拒绝后状态不一致导致误续跑",
        ),
    ),
    _spec(
        "sc_cross_module_saga_no_hire",
        "【跨模块·异常流】未雇佣派发行为明确",
        "cross",
        "L2",
        "eval.scenario.cross_module_saga_no_hire",
        "仅 create_agent 不 hire：dispatch 仍建 task，但无岗位名，可审计",
        _d(
            priority="P1",
            flow="negative",
            technique="saga+negative",
            persona="最终用户",
            preconditions=["智能体存在但未雇佣"],
            steps=["建待办", "dispatch 到该 agent", "检查 task"],
            expected=["task 存在", "assigned_role 空", "source_ref=item:…"],
            risk="以为已派岗实际无人值班",
        ),
    ),
    _spec(
        "sc_cross_module_wake_trajectory",
        "【跨模块·L3规划】dispatch wake 真跑轨迹",
        "cross",
        "L3",
        "",
        "（规划）wake_now=True 后 Lead 工具轨迹与任务完结 — 需真 LLM",
        _d(
            priority="P2",
            flow="happy",
            technique="trajectory",
            persona="值班员工",
            preconditions=["LLM", "已雇佣"],
            steps=["dispatch wake_now=true", "采集 trajectory", "断言工具与完结"],
            expected=["轨迹匹配参考或 judge 及格", "任务进入可观测终态"],
            risk="账本绿但员工不干活",
            implemented=False,
        ),
        enabled=False,
    ),
]


def catalog_by_id() -> dict[str, CaseSpec]:
    return {str(c["id"]): c for c in CASE_CATALOG}


def catalog_by_module() -> dict[str, list[CaseSpec]]:
    out: dict[str, list[CaseSpec]] = {}
    for c in CASE_CATALOG:
        out.setdefault(str(c["module"]), []).append(c)
    return out


def design_params(spec: CaseSpec) -> dict[str, Any]:
    """params_json payload for DB seed."""
    design = dict(spec.get("design") or {})
    return {
        "module": spec["module"],
        "priority": design.get("priority") or "P1",
        "flow": design.get("flow") or "happy",
        "design": design,
    }


def is_smoke_case(case: dict[str, Any]) -> bool:
    """P0 and (L0|L1) or selected P0 L2 deep / saga ids."""
    cid = str(case.get("id") or case.get("case_id") or "")
    level = str(case.get("level") or "L1").upper()
    params = case.get("params") if isinstance(case.get("params"), dict) else {}
    design = params.get("design") if isinstance(params.get("design"), dict) else {}
    priority = str(
        case.get("priority")
        or params.get("priority")
        or design.get("priority")
        or ("P0" if level in ("L0", "L1") and not cid.endswith("_detail") else "P1")
    ).upper()
    if priority != "P0":
        return False
    if level in ("L0", "L1"):
        return True
    # L2 P0: saga + deep employee/workflow task packs
    if level == "L2" and cid in {
        "sc_cross_module_saga",
        "sc_item_dispatch_link",
        "sc_employee_task_runtime_contract",
        "sc_employee_task_dispatch_ledger",
        "sc_employee_task_work_item_gate",
        "sc_workflow_task_step_binding",
        "sc_workflow_task_official_outcome_rollup",
    }:
        return True
    return False


def module_case_design_view() -> dict[str, list[dict[str, str]]]:
    """Compat view for older MODULE_CASE_DESIGN consumers."""
    out: dict[str, list[dict[str, str]]] = {}
    for c in CASE_CATALOG:
        if not (c.get("design") or {}).get("implemented", True) and not c.get("handler"):
            focus = "（规划）" + str(c.get("description") or "")
        else:
            d = c.get("design") or {}
            focus = f"{FLOW_LABELS.get(str(d.get('flow')), d.get('flow'))} · {d.get('risk', '')}"[
                :80
            ]
        out.setdefault(str(c["module"]), []).append(
            {
                "id": str(c["id"]),
                "level": str(c["level"]),
                "focus": focus,
                "priority": str((c.get("design") or {}).get("priority") or ""),
                "flow": str((c.get("design") or {}).get("flow") or ""),
            }
        )
    return out
