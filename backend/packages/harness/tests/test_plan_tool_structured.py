"""Structured ``plan`` tool schema and markdown rendering."""

from __future__ import annotations

import json

from evoflow.collab.plan_subtasks_sync import build_plan_markdown, parse_plan_steps
from evoflow.tools.builtins.plan_tool import PlanInput, PlanStepInput, _plan_tool_impl, plan_tool


def test_plan_tool_schema_exposes_structured_fields() -> None:
    schema = plan_tool.args_schema.model_json_schema()  # type: ignore[union-attr]
    props = schema.get("properties") or {}
    assert "goal" in props
    assert "steps" in props
    assert schema.get("examples"), "top-level plan example missing"
    assert props["goal"].get("examples"), "goal field example missing"
    step_props = (schema.get("$defs") or {}).get("PlanStepInput", {}).get("properties") or {}
    for key in ("name", "goal", "inputs", "outputs", "acceptance", "failure", "assigned_agent", "depends_on"):
        assert key in step_props, key
        assert step_props[key].get("examples"), f"{key} field example missing"


def test_build_plan_markdown_no_analysis_section_when_omitted() -> None:
    md = build_plan_markdown(
        goal="调度测试",
        steps=[
            {
                "ref": 1,
                "name": "任务1",
                "goal": "写 task1",
                "inputs": "用户需求",
                "outputs": "outputs/task1.txt",
                "acceptance": "ok",
                "failure": "重试",
                "assigned_agent": "general-purpose",
            },
        ],
        open_questions="无",
    )
    assert "## Analysis" not in md
    assert "## Flowchart" not in md
    assert "```mermaid" not in md


def test_build_plan_markdown_uses_analysis_heading() -> None:
    md = build_plan_markdown(
        goal="分析调用链",
        flowchart_mermaid='flowchart LR\n  A["入口"] --> B["服务"]',
        steps=[
            {
                "ref": 1,
                "name": "改代码",
                "goal": "按分析图修改",
                "inputs": "分析图",
                "outputs": "patch",
                "acceptance": "ok",
                "failure": "重试",
                "assigned_agent": "general-purpose",
            },
        ],
    )
    assert "## Analysis" in md
    assert "flowchart LR" in md


def test_build_plan_markdown_from_steps() -> None:
    md = build_plan_markdown(
        goal="调度测试",
        flowchart_mermaid='flowchart LR\n  Entry["入口"] --> Core["核心逻辑"]',
        steps=[
            {
                "ref": 1,
                "name": "任务1",
                "goal": "写 task1",
                "inputs": "用户需求",
                "outputs": "outputs/task1.txt",
                "acceptance": "read_file ok",
                "failure": "重试",
                "assigned_agent": "general-purpose",
            },
            {
                "ref": 2,
                "name": "任务2",
                "goal": "写 task2",
                "inputs": "outputs/task1.txt",
                "outputs": "outputs/task2.txt",
                "acceptance": "ok",
                "failure": "回退",
                "assigned_agent": "claude-code",
                "depends_on": ["1"],
            },
        ],
        validation=["全部文件存在"],
        open_questions="无",
    )
    assert md.startswith("# Plan")
    parsed = parse_plan_steps(md)
    assert len(parsed) == 2
    assert parsed[0]["assignee"] == "general-purpose"
    assert parsed[1]["assignee"] == "claude-code"
    assert parsed[1]["depends_refs"] == ["1"]


def test_plan_impl_structured_without_markdown() -> None:
    raw = _plan_tool_impl(
        goal="调度测试",
        steps=[
            {
                "name": "任务1",
                "goal": "写 task1",
                "inputs": "用户需求",
                "outputs": "outputs/task1.txt",
                "acceptance": "ok",
                "failure": "重试",
                "assigned_agent": "general-purpose",
            },
        ],
        validation=["ok"],
    )
    data = json.loads(raw)
    assert data["success"] is True
    assert data["stepsSubmitted"] == 1
    assert data["plan"]["goal"] == "调度测试"
    assert data["plan"]["steps"][0]["outputs"] == "outputs/task1.txt"


def test_plan_input_coerces_string_steps_and_list_io() -> None:
    """Reproduce common model mistake: steps as JSON string, inputs/outputs as arrays."""
    steps_json = '[{"name": "生成任务1内容", "goal": "写 task1", "inputs": ["用户需求"], "outputs": ["outputs/task1.txt"], "acceptance": "ok", "failure": "重试", "assigned_agent": "general-purpose", "ref": 1}]'
    payload = PlanInput.model_validate(
        {
            "goal": "执行简单的任务调度测试",
            "steps": steps_json,
            "validation": '["file exists"]',
        }
    )
    assert payload.steps is not None
    assert len(payload.steps) == 1
    assert payload.steps[0].inputs == "用户需求"
    assert payload.steps[0].outputs == "outputs/task1.txt"
    assert payload.validation == ["file exists"]

    step = PlanStepInput.model_validate(
        {
            "name": "x",
            "goal": "g",
            "inputs": ["outputs/a.txt", "outputs/b.txt"],
            "outputs": ["outputs/out.txt"],
            "acceptance": "a",
            "failure": "f",
            "assigned_agent": "general-purpose",
        }
    )
    assert step.inputs == "outputs/a.txt, outputs/b.txt"
    assert step.outputs == "outputs/out.txt"


def test_plan_input_requires_steps() -> None:
    try:
        PlanInput(goal="x")
        raised = False
    except ValueError:
        raised = True
    assert raised


def test_plan_input_requires_goal_with_steps() -> None:
    try:
        PlanInput(steps=[{"name": "x", "goal": "g", "inputs": "i", "outputs": "o", "acceptance": "a", "failure": "f", "assigned_agent": "general-purpose"}])  # type: ignore[arg-type]
        raised = False
    except ValueError:
        raised = True
    assert raised


def test_plan_step_coerces_assignee_alias_and_string_depends_on() -> None:
    payload = PlanInput.model_validate(
        {
            "goal": "文件操作冒烟",
            "steps": [
                {
                    "name": "写文件",
                    "goal": "创建文件",
                    "assignee": "bash",
                },
                {
                    "name": "读文件",
                    "goal": "读取",
                    "assigned_agent": "bash",
                    "depends_on": "1",
                },
                {
                    "name": "列目录",
                    "goal": "列表",
                    "assigned_agent": "bash",
                    "depends_on": "2",
                    "tools": "read_file,list_dir",
                },
            ],
        }
    )
    assert len(payload.steps or []) == 3
    assert payload.steps[0].assigned_agent == "bash"
    assert payload.steps[1].depends_on == ["1"]
    assert payload.steps[2].depends_on == ["2"]
    assert "read_file" in payload.steps[2].tools


def test_plan_step_coerces_subagent_type_alias() -> None:
    payload = PlanInput.model_validate(
        {
            "goal": "调度测试",
            "steps": [
                {
                    "name": "任务1",
                    "goal": "写 task1",
                    "subagent_type": "general-purpose",
                    "tools": ["read_file", "write_to_file"],
                    "depends_on": [],
                },
            ],
        }
    )
    assert payload.steps[0].assigned_agent == "general-purpose"
    assert payload.steps[0].tools == ["read_file", "write_to_file"]


def test_plan_input_strips_supervisor_bleed_and_subtasks_alias() -> None:
    payload = PlanInput.model_validate(
        {
            "goal": "调度测试",
            "action": "start_execution",
            "task_id": "Task_x",
            "subtasks": [
                {
                    "name": "任务1",
                    "goal": "写 task1",
                    "assigned_agent": "general-purpose",
                },
            ],
        }
    )
    assert len(payload.steps or []) == 1


def test_plan_input_strips_legacy_markdown_kwarg() -> None:
    payload = PlanInput.model_validate(
        {
            "goal": "g",
            "markdown": "# Plan\n\n## Goal\nlegacy",
            "steps": [
                {
                    "name": "s1",
                    "goal": "do",
                    "inputs": "in",
                    "outputs": "out",
                    "acceptance": "ok",
                    "failure": "retry",
                    "assigned_agent": "general-purpose",
                },
            ],
        }
    )
    assert not hasattr(payload, "markdown")
