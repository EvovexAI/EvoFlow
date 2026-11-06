"""Platform workflow domain schema — teach agents how to build App steps/parameters."""

from __future__ import annotations

from typing import Any

# Minimal runnable step (linear DAG). Backend normalizes via app_schema.normalize_step.
# Use a real bundled worker code — ``lead``/``main`` are not dispatchable (CORE-WF-04).
_DEFAULT_WORKER = "agent"

WORKFLOW_STEP_MINIMAL: dict[str, Any] = {
    "ref": "s1",
    "name": "收集信息",
    # 本步目标(goal)可空；未写 assigned_agent 时运行时默认通用 agent
    "assigned_agent": _DEFAULT_WORKER,
    # 有能力需求时再挂；留空=本步未声明能力，勿写成「用 Agent 默认能力」
}

WORKFLOW_STEP_CHAIN: list[dict[str, Any]] = [
    {
        "ref": "collect",
        "name": "收集",
        "goal": "收集原始材料",
        "assigned_agent": _DEFAULT_WORKER,
        "skills": ["web-search"],
        "tools": ["web_search", "read_file", "write_file"],
    },
    {
        "ref": "summarize",
        "name": "汇总",
        "goal": "整理成结构化日报",
        "assigned_agent": _DEFAULT_WORKER,
        "depends_on": ["collect"],
        "tools": ["read_file", "write_file"],
        # 前置产出会随连线自动注入，不必在 goal 里再写「请基于上一步…」
    },
]

WORKFLOW_PARAMETER_EXAMPLE: dict[str, Any] = {
    "name": "report_date",
    "label": "报告日期",
    "type": "text",
    "default": "{{report_date}}",
    "required": True,
}

WORKFLOW_CREATE_EXAMPLE: dict[str, Any] = {
    "name": "日报汇总",
    "description": "把今日事项整理成报告",
    "goal": "根据 {{report_date}} 汇总今日工作并输出 Markdown 报告",
    "steps": WORKFLOW_STEP_CHAIN,
    "parameters": [WORKFLOW_PARAMETER_EXAMPLE],
}

WORKFLOW_GENERATE_EXAMPLE: dict[str, Any] = {
    "name": "竞品速览",
    "goal": "针对 {{topic}} 做竞品速览并输出要点列表",
    "steps": [
        {
            "ref": "research",
            "name": "调研",
            "goal": "检索并整理竞品信息",
            "assigned_agent": _DEFAULT_WORKER,
            "skills": ["web-search"],
            "tools": ["web_search", "read_file", "write_file"],
        },
        {
            "ref": "write",
            "name": "成稿",
            "goal": "输出结构化竞品速览",
            "assigned_agent": _DEFAULT_WORKER,
            "depends_on": ["research"],
            "tools": ["read_file", "write_file"],
        },
    ],
    "auto_extract": True,
}


def build_workflow_platform_schema() -> dict[str, Any]:
    """Structured cheat-sheet for platform(action='workflow.schema'|catalog domain=workflow)."""
    return {
        "domain": "workflow",
        "title": "工作流/应用",
        "overview": (
            "工作流 = App 定义（goal=工作流描述 + steps 节点 + 可选 parameters）。"
            "产品语义：工作流只有一份「描述」(API 字段 goal)；每个节点自己的「目标」写在 step.goal。"
            "步骤默认通用智能体（assigned_agent=agent）。"
            "创建/生成时须先查平台可用能力目录，再按节点精细挂载 skills/tools/mcp/knowledge；"
            "不要把节点能力滞空、事后再靠「Agent 默认能力」补。留空只表示本步未声明能力。"
            "创建后 status=draft；发布用 workflow.publish；运行用 workflow.run。"
        ),
        "capability_lookup": {
            "description": (
                "创建/生成工作流前必查（有则挂、无则跳过该维度）。"
                "用真实 id/name 写入 steps[]，勿臆造。"
            ),
            "before_create": [
                "agents.bindings → tools / skills / mcp 可选项（首选一站目录）",
                "skills.list → 已安装技能名",
                "knowledge.list → 知识库 id（有库才挂 knowledge_vault_ids）",
                "mcp.list → 已配置 MCP 服务器名（有才挂 mcp_servers）",
            ],
            "per_step_rule": (
                "每个节点按任务需要显式写 skills / tools / mcp_servers / knowledge_vault_ids；"
                "需要读写文件就写 tools；需要检索就挂 skill/工具；需要私有知识就挂 vault id。"
                "不要写「本步用 Agent 默认能力」这类说明；能力空着就别提默认。"
            ),
        },
        "recommended_paths": [
            {
                "id": "generate",
                "label": "傻瓜式（推荐）",
                "when": "用户只描述了目标和步骤，还没想好参数占位符",
                "actions": [
                    "agents.bindings（或 skills.list / knowledge.list / mcp.list）",
                    "workflow.generate",
                    "workflow.publish",
                    "workflow.run",
                ],
            },
            {
                "id": "create",
                "label": "手工拼装",
                "when": "已有完整 steps/parameters/plan，或要精细控制画布",
                "actions": [
                    "agents.bindings（或 skills.list / knowledge.list / mcp.list）",
                    "workflow.create",
                    "workflow.update",
                    "workflow.publish",
                    "workflow.run",
                ],
            },
            {
                "id": "copy",
                "label": "复制改",
                "when": "已有类似应用",
                "actions": ["workflow.list", "workflow.get", "workflow.duplicate", "workflow.update"],
            },
        ],
        "step": {
            "description": (
                "steps[] 每个元素是一个执行节点。"
                "编排主路径：任务名 + 本步目标(goal，可空) + 本步显式能力。"
                "连线后上游产出自动注入本步，勿在本步目标里再塞「请基于前置步骤…」。"
                "创建时精细设计每步 skills/tools/mcp/knowledge，勿滞空指望默认能力。"
            ),
            "required": ["ref", "name"],
            "recommended": ["goal", "assigned_agent", "skills", "tools"],
            "optional": [
                "goal（本步目标：这一步要做什么，可空）",
                "assigned_agent（默认 agent；勿用 lead/main）",
                "depends_on (string[]，前置节点 ref，构成 DAG)",
                "description（少用；本步说明优先写 name/goal）",
                "skills / tools / mcp_servers / knowledge_vault_ids（本步能力，string[] 或逗号分隔；按需显式填写）",
                "model（本步模型；空=系统默认）",
                "thinking_enabled (bool，本步思考开关)",
                "project_path（本步工作空间；空=工作流默认）",
                "step_type: agent|condition",
                "condition (分支节点时)",
                "input_bindings / input_schema / output_schema",
            ],
            "assigned_agent": (
                "智能体角色 code（须为可派发 worker，如 agent、xiaomi、code-agent）；"
                "不要用 lead/main（不是 worker）。不确定或通用步骤用 agent；"
                "本步能力以本步 skills/tools/mcp/knowledge 字段为准，须显式设计，不必先选员工。"
            ),
            "depends_on_rule": (
                "无依赖=可并行；链式流程用 depends_on 指向前序 ref。"
                "前置结果随边自动传入，不必在提示词里手动引用。"
            ),
            "minimal_example": WORKFLOW_STEP_MINIMAL,
            "linear_chain_example": WORKFLOW_STEP_CHAIN,
        },
        "parameters": {
            "description": "应用级入参，运行 workflow.run 时填入；可用 {{name}} 占位注入 goal/steps",
            "item_fields": {
                "name": "参数键（必填）",
                "label": "展示名",
                "type": "text|textarea|select|number",
                "default": "默认值，常写 {{name}}",
                "required": "bool",
                "options": "select 时的选项列表",
            },
            "example": WORKFLOW_PARAMETER_EXAMPLE,
        },
        "plan": {
            "description": (
                "workflow.create/update 可传 plan 对象；"
                "plan.goal = 工作流描述（产品文案叫「描述」）；steps[].goal = 本步目标"
            ),
            "shape": {"goal": "string（工作流描述）", "steps": "Step[]", "canvas": "object?"},
        },
        "actions": {
            "workflow.create": {
                "required": ["name"],
                "recommended": ["goal", "steps"],
                "optional": ["description", "parameters", "plan", "canvas", "execution_mode", "tags"],
                "example_args": WORKFLOW_CREATE_EXAMPLE,
                "note": (
                    "顶层 goal = 工作流描述；steps[].goal = 各节点目标。"
                    "写 steps 前先 agents.bindings / skills.list / knowledge.list / mcp.list；"
                    "每个节点按需显式挂能力，勿整表滞空。"
                ),
            },
            "workflow.generate": {
                "required": ["name", "goal"],
                "recommended": ["steps"],
                "optional": ["description", "auto_extract", "max_params", "tags", "canvas"],
                "example_args": WORKFLOW_GENERATE_EXAMPLE,
                "note": (
                    "goal 参数 = 工作流描述；"
                    "auto_extract=true 时自动从描述/steps 提取 {{param}} 占位符；"
                    "生成前同样查能力目录，steps 里写清本步目标与 skills/tools/知识库。"
                ),
            },
            "workflow.update": {
                "required": ["appId"],
                "note": "只传要改的字段；改 steps 会 bump 版本",
            },
            "workflow.publish": {"required": ["appId"], "note": "发布前做 DAG/引用校验，失败会返回 errors"},
            "workflow.run": {
                "required": ["appId"],
                "optional": ["parameters"],
                "example_args": {"appId": "App_xxx", "parameters": {"report_date": "2026-08-22"}},
            },
        },
        "hints": [
            "不熟结构：先 platform(action='workflow.schema') 或 catalog domain=workflow",
            "建流前查能力：agents.bindings（工具/技能/MCP）+ skills.list + knowledge.list + mcp.list",
            "参考现成应用：workflow.list → workflow.get 看 steps_preview",
            "简单线性流程：至少 1 个 step；工作流描述(goal)可空（给人看）；节点任务名必填、本步目标可空；默认通用 agent",
            "每个节点精细设计本步目标 + skills/tools/mcp_servers/knowledge_vault_ids/model/thinking_enabled",
            "能力字段留空=本步未声明，不要解释成「用 Agent 默认能力」",
            "前置步骤靠连线自动带结果，不要在本步目标里写「请基于上一步」",
            "写/删/发布须用户确认后 confirm=true",
        ],
    }
