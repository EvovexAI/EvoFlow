"""Platform workflow domain schema — teach agents how to build App steps/parameters."""

from __future__ import annotations

from typing import Any

# Minimal runnable step (linear DAG). Backend normalizes via app_schema.normalize_step.
WORKFLOW_STEP_MINIMAL: dict[str, Any] = {
    "ref": "s1",
    "name": "收集信息",
    "goal": "汇总用户给出的今日工作要点",
    "assigned_agent": "lead",
}

WORKFLOW_STEP_CHAIN: list[dict[str, Any]] = [
    {
        "ref": "collect",
        "name": "收集",
        "goal": "收集原始材料",
        "assigned_agent": "lead",
    },
    {
        "ref": "summarize",
        "name": "汇总",
        "goal": "整理成结构化日报",
        "assigned_agent": "lead",
        "depends_on": ["collect"],
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
            "assigned_agent": "lead",
        },
        {
            "ref": "write",
            "name": "成稿",
            "goal": "输出结构化竞品速览",
            "assigned_agent": "lead",
            "depends_on": ["research"],
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
            "工作流 = App 定义（goal + steps 节点 + 可选 parameters）。"
            "创建后 status=draft；发布用 workflow.publish；运行用 workflow.run。"
        ),
        "recommended_paths": [
            {
                "id": "generate",
                "label": "傻瓜式（推荐）",
                "when": "用户只描述了目标和步骤，还没想好参数占位符",
                "actions": ["workflow.generate", "workflow.publish", "workflow.run"],
            },
            {
                "id": "create",
                "label": "手工拼装",
                "when": "已有完整 steps/parameters/plan，或要精细控制画布",
                "actions": ["workflow.create", "workflow.update", "workflow.publish", "workflow.run"],
            },
            {
                "id": "copy",
                "label": "复制改",
                "when": "已有类似应用",
                "actions": ["workflow.list", "workflow.get", "workflow.duplicate", "workflow.update"],
            },
        ],
        "step": {
            "description": "steps[] 每个元素是一个执行节点（agent 步骤）",
            "required": ["ref", "name", "goal", "assigned_agent"],
            "optional": [
                "depends_on (string[]，前置节点 ref，构成 DAG)",
                "description",
                "tools (string[] 或逗号分隔)",
                "skills (string[] 或逗号分隔)",
                "step_type: agent|condition",
                "condition (分支节点时)",
                "input_bindings / input_schema / output_schema",
            ],
            "assigned_agent": (
                "智能体角色 code，如 lead、researcher；不确定时先用 lead，"
                "或 workflow.get 参考已有应用"
            ),
            "depends_on_rule": "无依赖=可并行；链式流程用 depends_on 指向前序 ref",
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
            "description": "workflow.create/update 可传 plan 对象，等价于 goal_template+steps+canvas",
            "shape": {"goal": "string", "steps": "Step[]", "canvas": "object?"},
        },
        "actions": {
            "workflow.create": {
                "required": ["name"],
                "recommended": ["goal", "steps"],
                "optional": ["description", "parameters", "plan", "canvas", "execution_mode", "tags"],
                "example_args": WORKFLOW_CREATE_EXAMPLE,
            },
            "workflow.generate": {
                "required": ["name", "goal"],
                "recommended": ["steps"],
                "optional": ["description", "auto_extract", "max_params", "tags", "canvas"],
                "example_args": WORKFLOW_GENERATE_EXAMPLE,
                "note": "auto_extract=true 时自动从 goal/steps 提取 {{param}} 占位符",
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
            "参考现成应用：workflow.list → workflow.get 看 steps_preview",
            "简单线性流程：至少 1 个 step，assigned_agent 必填",
            "写/删/发布须用户确认后 confirm=true",
        ],
    }
