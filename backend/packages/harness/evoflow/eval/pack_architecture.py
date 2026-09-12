"""评测体系 SSOT：智能体员工 / 工作流两套业务的可验证维度矩阵。

不是用例清单本身（用例在 ``case_spec``），而是：
- 业务阶段（流转节点）
- 横切能力（状态机 / 重试 / 安全隔离 / 终态产出）
- 每条能力绑定的 case_id（已实现或规划）

UI「智能体员工 / 工作流」独立页用此渲染覆盖度；CI 用
``assert_architecture_coverage`` 防止矩阵空挂。
"""

from __future__ import annotations

from typing import Any, Literal, TypedDict

PackId = Literal["employees", "workflow"]
Coverage = Literal["implemented", "partial", "planned"]


class ArchCapability(TypedDict, total=False):
    id: str
    title: str
    dimension: str  # flow | state | retry | safety | isolation | outcome
    stage: str
    description: str
    case_ids: list[str]
    coverage: Coverage
    risk: str


class ArchStage(TypedDict):
    id: str
    title: str
    summary: str


class PackArchitecture(TypedDict):
    pack: PackId
    title: str
    principle: str
    stages: list[ArchStage]
    capabilities: list[ArchCapability]


# ───────────────────────────────── 智能体员工 ─────────────────────────────────

EMPLOYEE_STAGES: list[ArchStage] = [
    {
        "id": "hire",
        "title": "雇佣 / 配置冻结",
        "summary": "Agent 存在 → hire 岗位 → system_prompt/tools/vault 注入 duty brief",
    },
    {
        "id": "dispatch",
        "title": "事项派发",
        "summary": "create_item → dispatch → Task(source_ref=item:…)；可选 wake_now",
    },
    {
        "id": "gate",
        "title": "门禁与互斥",
        "summary": "active/paused、busy 锁、上班时间、预算、autonomy×risk 审批",
    },
    {
        "id": "think_act",
        "title": "值班 think / 执行",
        "summary": "ProactiveEngine.think → work_item / initiative → ExecutionBridge",
    },
    {
        "id": "outcome",
        "title": "终态与对账",
        "summary": "Task/initiative 终态、work-board SSOT、审批台账、可观测证据",
    },
]

EMPLOYEE_CAPABILITIES: list[ArchCapability] = [
    {
        "id": "emp.cfg.runtime_contract",
        "title": "提示词 / 工具 / duty brief 合同",
        "dimension": "isolation",
        "stage": "hire",
        "description": "冻结配置后 brief 与 resolve tools 对账，禁止显示与运行时分叉",
        "case_ids": ["sc_employee_task_runtime_contract", "sc_employee_task_tool_binding_negative"],
        "coverage": "implemented",
        "risk": "页面配置正确但值班合同不一致",
    },
    {
        "id": "emp.flow.lifecycle",
        "title": "雇佣暂停恢复生命周期",
        "dimension": "state",
        "stage": "hire",
        "description": "hire → pause → resume；重复 hire 冲突",
        "case_ids": ["sc_employee_lifecycle", "sc_employee_hire_duplicate"],
        "coverage": "implemented",
        "risk": "岗位状态错乱或重复覆盖",
    },
    {
        "id": "emp.flow.dispatch_ledger",
        "title": "事项→任务账本",
        "dimension": "flow",
        "stage": "dispatch",
        "description": "wake=false 落库；source_ref / assigned / linked_task_ids",
        "case_ids": ["sc_employee_task_dispatch_ledger", "sc_item_dispatch_link"],
        "coverage": "implemented",
        "risk": "派发账本绿但无人可值班",
    },
    {
        "id": "emp.gate.pause_wake",
        "title": "暂停态拒绝真 wake",
        "dimension": "safety",
        "stage": "gate",
        "description": "paused 时 wake/dispatch_task 不得当作在岗执行；ledger 仍可审计",
        "case_ids": [
            "sc_employee_task_pause_blocks_dispatch_intent",
            "sc_employee_task_pause_rejects_wake",
        ],
        "coverage": "implemented",
        "risk": "暂停岗仍被叫醒干活",
    },
    {
        "id": "emp.gate.busy",
        "title": "busy 互斥",
        "dimension": "safety",
        "stage": "gate",
        "description": "同岗 in-flight 时二次派发返回 busy，不得叠跑",
        "case_ids": ["sc_employee_task_busy_mutex"],
        "coverage": "implemented",
        "risk": "并发叠跑污染轨迹",
    },
    {
        "id": "emp.gate.approval",
        "title": "工作项审批门",
        "dimension": "state",
        "stage": "gate",
        "description": "APPROVED/REJECTED 与 initiative/task 桥一致",
        "case_ids": ["sc_employee_task_work_item_gate", "sc_approval_ledger"],
        "coverage": "implemented",
        "risk": "审批台账与任务状态分叉",
    },
    {
        "id": "emp.retry.already_done",
        "title": "已结案防重派",
        "dimension": "retry",
        "stage": "dispatch",
        "description": "目标引用已完结 Task 时 skipped/already_done，不造幽灵任务",
        "case_ids": ["sc_employee_task_already_done_skip"],
        "coverage": "implemented",
        "risk": "结案任务被反复唤醒",
    },
    {
        "id": "emp.outcome.live_wake",
        "title": "真 wake LLM 终态",
        "dimension": "outcome",
        "stage": "outcome",
        "description": "Gateway HTTP wake_now=true，轮询终态/报告证据（禁止 inject）",
        "case_ids": ["sc_employee_task_live_wake"],
        "coverage": "implemented",
        "risk": "账本绿但员工不干活",
    },
    {
        "id": "emp.collab.org_gate",
        "title": "多组织协同门禁",
        "dimension": "safety",
        "stage": "dispatch",
        "description": "同组织平级/上下级可派发叫醒；跨组织禁止；真人用户与小V（系统前台）不限",
        "case_ids": ["sc_employee_task_org_collab_gate"],
        "coverage": "implemented",
        "risk": "跨组织乱叫醒或同组织无法协作",
    },
    {
        "id": "emp.isolation.schedule_budget",
        "title": "上班时间 / 预算熔断",
        "dimension": "isolation",
        "stage": "gate",
        "description": "off-hours 跳过巡检；日/次预算超限 skip 或 pause",
        "case_ids": ["sc_employee_task_work_hours_skip", "sc_employee_task_budget_fuse"],
        "coverage": "planned",
        "risk": "非工作时段或超额仍自动干活",
    },
]


# ───────────────────────────────── 工作流 ─────────────────────────────────

WORKFLOW_STAGES: list[ArchStage] = [
    {
        "id": "define",
        "title": "定义 / 发布",
        "summary": "steps+depends_on → validate → publish；非法 DAG 拒绝",
    },
    {
        "id": "run",
        "title": "开跑 / 授权",
        "summary": "render_plan → sync subtasks → auto_authorize → dispatch",
    },
    {
        "id": "bind",
        "title": "节点绑定与隔离",
        "summary": "assigned_agent / tools / instruction / 参数渲染 / allowlist 继承",
    },
    {
        "id": "dag",
        "title": "依赖推进与失败",
        "summary": "上游 completed+reported 才放行；失败下游 waiting_dispatch 不伪绿",
    },
    {
        "id": "control",
        "title": "取消 / 暂停 / 重试",
        "summary": "cancel/pause/resume run；requeue_failed 后下游解阻",
    },
    {
        "id": "outcome",
        "title": "Outcome / Rollup / 完结",
        "summary": "官方 outcome → sync 主任务 → rollup → app_run 对账",
    },
]

WORKFLOW_CAPABILITIES: list[ArchCapability] = [
    {
        "id": "wf.define.validate",
        "title": "DAG 校验与发布门禁",
        "dimension": "safety",
        "stage": "define",
        "description": "环/悬空边校验失败；publish 422；缺参拒绝开跑",
        "case_ids": [
            "sc_workflow_dag_validate",
            "sc_module_workflow_detail",
            "sc_workflow_publish_rejects_cycle",
        ],
        "coverage": "implemented",
        "risk": "非法图进入执行引擎",
    },
    {
        "id": "wf.flow.run_authorize",
        "title": "开跑与授权",
        "dimension": "flow",
        "stage": "run",
        "description": "run 产生 task/run；execution_authorized；app_run 存在",
        "case_ids": ["sc_module_workflow", "sc_workflow_task_step_binding"],
        "coverage": "implemented",
        "risk": "工作流无法开跑或未授权",
    },
    {
        "id": "wf.bind.profile",
        "title": "步骤绑定与工具继承",
        "dimension": "isolation",
        "stage": "bind",
        "description": "worker_profile agent/tools/instruction；省略 tools 继承 Agent",
        "case_ids": [
            "sc_workflow_task_step_binding",
            "sc_workflow_task_inherit_agent_tools",
            "sc_workflow_task_param_render",
        ],
        "coverage": "implemented",
        "risk": "步骤配置与运行时 worker 不一致",
    },
    {
        "id": "wf.dag.fail_halt",
        "title": "上游失败不伪绿",
        "dimension": "state",
        "stage": "dag",
        "description": "步骤1 failed → 步骤2 未假完成 → 主任务非 completed",
        "case_ids": ["sc_workflow_task_step_fail_halts"],
        "coverage": "implemented",
        "risk": "失败步骤被当成全绿",
    },
    {
        "id": "wf.control.cancel_pause",
        "title": "取消 / 暂停运行",
        "dimension": "state",
        "stage": "control",
        "description": "cancel_run / pause_run 后主任务与 app_run 状态一致",
        "case_ids": ["sc_workflow_task_cancel_run"],
        "coverage": "partial",
        "risk": "取消后子任务仍执行",
    },
    {
        "id": "wf.retry.unblock",
        "title": "失败重试解阻下游",
        "dimension": "retry",
        "stage": "control",
        "description": "上游 failed→requeue→completed 后下游离开 waiting_dispatch",
        "case_ids": ["sc_workflow_task_retry_unblocks_downstream"],
        "coverage": "implemented",
        "risk": "重试成功但下游永久卡住",
    },
    {
        "id": "wf.outcome.rollup",
        "title": "官方 outcome 与 rollup",
        "dimension": "outcome",
        "stage": "outcome",
        "description": "apply_subtask_outcome_report → 主 completed + rollup 可观测",
        "case_ids": [
            "sc_workflow_task_official_outcome_rollup",
            "sc_workflow_rollup_stub",
        ],
        "coverage": "implemented",
        "risk": "假绿：手改 storage 冒充执行",
    },
    {
        "id": "wf.outcome.live_run",
        "title": "真 LLM 工作流终态",
        "dimension": "outcome",
        "stage": "outcome",
        "description": "HTTP publish+run，工人真跑报告（禁止 inject）",
        "case_ids": ["sc_workflow_task_live_run"],
        "coverage": "implemented",
        "risk": "账本绿但工人未真跑",
    },
]


PACKS: dict[PackId, PackArchitecture] = {
    "employees": {
        "pack": "employees",
        "title": "智能体员工评测体系",
        "principle": (
            "按「雇佣→派发→门禁→think/执行→终态」验证；"
            "账本场景证明状态机与隔离；L3 证明真 LLM 产出；禁止 inject 冒充 wake。"
        ),
        "stages": EMPLOYEE_STAGES,
        "capabilities": EMPLOYEE_CAPABILITIES,
    },
    "workflow": {
        "pack": "workflow",
        "title": "工作流评测体系",
        "principle": (
            "按「定义→开跑→节点绑定→DAG 推进→控制面→outcome/rollup」验证；"
            "官方 outcome API 写终态；依赖未满足不得伪绿；控制面与 app_run 对账。"
        ),
        "stages": WORKFLOW_STAGES,
        "capabilities": WORKFLOW_CAPABILITIES,
    },
}


def get_pack_architecture(pack: PackId | str) -> PackArchitecture:
    key = str(pack or "").strip()
    if key not in PACKS:
        raise KeyError(f"unknown eval pack: {pack}")
    return PACKS[key]  # type: ignore[index]


def pack_architecture_view(pack: PackId | str) -> dict[str, Any]:
    """JSON-serializable view for Gateway / Eval UI."""
    arch = get_pack_architecture(pack)
    caps = list(arch["capabilities"])
    counts = {"implemented": 0, "partial": 0, "planned": 0}
    for c in caps:
        counts[str(c.get("coverage") or "planned")] = (
            counts.get(str(c.get("coverage") or "planned"), 0) + 1
        )
    return {
        "pack": arch["pack"],
        "title": arch["title"],
        "principle": arch["principle"],
        "stages": arch["stages"],
        "capabilities": caps,
        "coverage_counts": counts,
        "capability_total": len(caps),
    }


def list_pack_architectures() -> dict[str, Any]:
    return {
        "packs": [pack_architecture_view(p) for p in ("employees", "workflow")],
    }


def assert_architecture_coverage() -> None:
    """Guard: every capability lists case_ids; implemented ones exist in CASE_CATALOG."""
    from evoflow.eval.case_spec import catalog_by_id

    by_id = catalog_by_id()
    for pack_id, arch in PACKS.items():
        assert arch["stages"], f"{pack_id} missing stages"
        assert arch["capabilities"], f"{pack_id} missing capabilities"
        for cap in arch["capabilities"]:
            ids = list(cap.get("case_ids") or [])
            assert ids, f"{pack_id}/{cap.get('id')} has no case_ids"
            if cap.get("coverage") == "implemented":
                missing = [i for i in ids if i not in by_id]
                assert not missing, f"{pack_id}/{cap.get('id')} missing cases: {missing}"


__all__ = [
    "EMPLOYEE_CAPABILITIES",
    "EMPLOYEE_STAGES",
    "PACKS",
    "WORKFLOW_CAPABILITIES",
    "WORKFLOW_STAGES",
    "assert_architecture_coverage",
    "get_pack_architecture",
    "list_pack_architectures",
    "pack_architecture_view",
]
