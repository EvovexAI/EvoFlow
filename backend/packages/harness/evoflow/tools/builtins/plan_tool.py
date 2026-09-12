"""Submit structured plan for collaboration gates (has_plan / plan_guard)."""

# ruff: noqa: E501

from __future__ import annotations

import json
import logging
import re
from typing import Any

from langchain_core.tools import tool
from pydantic import BaseModel, ConfigDict, Field, model_validator

logger = logging.getLogger(__name__)


_PLAN_TOOL_GUIDE_ZH = """
**调用前置条件（三项均成立后才可调用本工具）**：
三项的取证与核对须用 **`subagent` 委派只读子任务**完成，**禁止主智能体亲自**大范围读仓库、检索做摸底（你只下发子任务说明、验收口径，并综合子任务回报）。轻量 `list_agents` 查列表可直接调。

1. **用户需求已清晰**：目标、范围、交付物与验收边界明确。仍有缺口时：对用户用 `ask_clarification`；需从仓库/文档/外部信息取证时，**委派 `subagent` 调研子任务**汇总后再判断，勿带着模糊需求落库。
2. **调研方案已清晰**：写 Plan 前必要的只读摸底（读文件、检索、对照现状等）须已通过 **`subagent` 调研子任务**完成并有书面结论；主智能体不亲自执行摸底。勿在「尚不知如何验证」时硬写步骤。
3. **角色能力已匹配**：须先通过 **`subagent` 子任务**盘点智能体（子任务内可 `list_agents`、对照各角色工具/技能，输出「agent_code → 能做什么」对照表）；你再据表为每步选定 `assigned_agent`。缺合适角色时先与用户确认是否新建，必要时再 **`subagent` 委派**只读子代理协助设计/创建角色，然后写入计划。

**你的角色（计划阶段）**：总编排——任务拆解、选人派活、验收设计、调用本工具落库；**不亲自**做调研取证或能力盘点。planning 阶段 `subagent` **仅用于调研型**子任务，禁止委派执行类（改代码、交付物、shell 等）及 `subagent_type=bash`。

**能力要与任务一致（举例）**：
- 不合理：某智能体只会操作本地文件，却把「联网搜索行业资料」派给他——他缺少联网/检索能力，这一步注定做不好。
- 合理：检索类步骤派给具备搜索/浏览能力的智能体；改仓库、写交付物派给具备代码/工程能力的智能体；纯整理文档可派给以读写文件为主的智能体。

**没有合适的人时**：向用户说明缺哪类能力、会影响哪几步；询问是否愿意新建智能体。若用户同意，用 **`subagent` 委派**只读子任务去设计/创建该角色（你不亲自搭建），待子任务回报角色可用后，再把对应步骤写入计划。

**写计划时**：一步一项可独立执行的工作；前后步骤的输入、输出路径要能对上；验收标准要可客观核对。每一步须同时写好 **执行人** 与 **派发参数**（与 ``supervisor`` ``create_subtasks`` 对齐）：``instruction``、``tools``、``skills``、``work_checklist``、``project_path`` 等；调用本工具后会 **一次性同步创建/更新** 全部子任务，无需再 ``create_subtasks``。对用户只汇报要点，勿在对话里复述整份计划全文。

**修订计划**：同一会话内再次调用本工具会 **更新** 已绑定的主任务（``boundTaskId`` 不变），按 ``steps[].ref`` 对齐已有子任务；若内容变更会撤销执行授权，需用户重新点「开始执行」。请保留上次返回的 ``boundTaskId``；``supervisor(start_execution)`` 请用返回的 ``stepRefToSubtaskId`` 或 ``subtasksSync`` 里的 ``subtaskId``（``Subtask_*``），勿把步骤序号 ``1`` 当成子任务主键（现已支持传 ref ``"1"`` 自动解析）。

**任务分析图（必含）**：填写 ``flowchart_mermaid``，用 mermaid 画出你对**任务对象本身**的分析结果（勿包 ``` 围栏），供后续步骤执行时对照。应是**分析图**，不是「Step1→Step2」的执行顺序图。例如：代码**调用链/模块依赖**、接口与数据流、目录与关键文件关系、业务流程中涉及的系统组件。可选用 ``flowchart`` / ``graph`` / ``sequenceDiagram`` 等；节点写清类名、函数、模块或文件路径。

**落库后流程（概要，详见系统提示 `<plan_workflow>`）**：`plan` 成功 → **立刻停止工具调用**，向用户说明计划已就绪并请其点「开始执行」→ **禁止** `supervisor(start_execution)` / `ask_clarification` 催开始 → 用户点按钮后网关授权并**自动派发首波** → 你用 `monitor_execution_step` 监工 → validation → 关闭主任务。`supervisor(start_execution)` 仅作补派/重试。

各字段怎么填、示例值见下方参数的 examples。须提交 ``steps[]``（JSON）。
""".strip()

# Full payload example for JSON schema (shown to the model in tool definitions).
_PLAN_STEP_EXAMPLE_1: dict[str, Any] = {
    "ref": 1,
    "name": "生成任务1内容",
    "goal": "生成「任务1执行完毕」并写入 outputs/task1.txt",
    "inputs": "用户需求",
    "outputs": "outputs/task1.txt",
    "acceptance": 'read_file("outputs/task1.txt") 包含字符串「任务1执行完毕」',
    "failure": "重试写入；仍失败则上报",
    "assigned_agent": "code-agent",
}

_PLAN_STEP_EXAMPLE_2: dict[str, Any] = {
    "ref": 2,
    "name": "执行任务2",
    "goal": "读取 task1 内容，拼接「 + 任务2执行」写入 outputs/task2.txt",
    "inputs": "outputs/task1.txt",
    "outputs": "outputs/task2.txt",
    "acceptance": 'read_file("outputs/task2.txt") 包含「任务1执行完毕 + 任务2执行」',
    "failure": "重试；上游不存在则回退 Step 1",
    "assigned_agent": "general-purpose",
    "depends_on": ["1"],
}

_PLAN_INPUT_EXAMPLE: dict[str, Any] = {
    "goal": "执行简单任务调度：串行任务1，再并行任务2和任务3，结果写入文件",
    "flowchart_mermaid": ('flowchart LR\n  UI["ChatApp.handleSend"] --> API["tasksAPI.getTask"]\n  API --> Store["ProjectStorage.load_project"]\n  Row --> View["PlanDetailView structured"]'),
    "steps": [
        _PLAN_STEP_EXAMPLE_1,
        _PLAN_STEP_EXAMPLE_2,
        {
            "ref": 3,
            "name": "执行任务3",
            "goal": "读取 task1 内容，拼接「 + 任务3执行」写入 outputs/task3.txt",
            "inputs": "outputs/task1.txt",
            "outputs": "outputs/task3.txt",
            "acceptance": 'read_file("outputs/task3.txt") 包含「任务1执行完毕 + 任务3执行」',
            "failure": "重试；上游不存在则回退 Step 1",
            "assigned_agent": "general-purpose",
            "depends_on": ["1"],
        },
    ],
    "validation": [
        "outputs/task1.txt、outputs/task2.txt、outputs/task3.txt 均存在且非空",
        "task2/task3 内容含 task1 前缀及各自标识",
    ],
    "open_questions": "无",
}


_PLAN_TOOL_DESCRIPTION = "提交结构化执行计划并落库，供协作流程识别方案已定稿。仅当用户需求已清晰、调研方案已清晰、且各步执行人能力已匹配（见下方「调用前置条件」）时才可调用。\n\n" + _PLAN_TOOL_GUIDE_ZH


def _json_loads_if_string(value: Any) -> Any:
    """Parse JSON array/object passed as a string (common model mistake)."""
    if not isinstance(value, str):
        return value
    text = value.strip()
    if not text or text[0] not in "[{":
        return value
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return value


def _coerce_string_list_field(raw: Any) -> list[str]:
    """Accept list, JSON array string, comma-separated string, or single ref token."""
    if raw is None:
        return []
    if isinstance(raw, (int, float)):
        return [str(int(raw))]
    if isinstance(raw, list):
        return [str(x).strip() for x in raw if str(x).strip()]
    if isinstance(raw, str):
        text = raw.strip()
        if not text:
            return []
        loaded = _json_loads_if_string(text)
        if isinstance(loaded, list):
            return [str(x).strip() for x in loaded if str(x).strip()]
        if "," in text or "，" in text:
            return [p.strip() for p in re.split(r"[,，]", text) if p.strip()]
        return [text]
    return [str(raw).strip()] if str(raw).strip() else []


def _coerce_to_str(value: Any) -> str:
    """Normalize step text fields; join list inputs like ``[\"path\"]``."""
    if value is None:
        return ""
    if isinstance(value, str):
        return value.strip()
    if isinstance(value, list):
        return ", ".join(str(x).strip() for x in value if str(x).strip())
    return str(value).strip()


class PlanStepInput(BaseModel):
    """One executable step (1:1 with a collaboration subtask after bind)."""

    ref: int | str | None = Field(
        default=None,
        description="步骤序号（可省略，按数组顺序自动 1,2,3…）",
        examples=[1, 2],
    )
    name: str = Field(description="步骤短标题", examples=["生成任务1内容"])
    goal: str = Field(description="本步要达成的结果", examples=["生成 task1.txt 并写入完成说明"])
    inputs: str = Field(default="", description="输入物/依赖上下文", examples=["用户需求"])
    outputs: str = Field(default="", description="输出物路径或交付描述", examples=["outputs/task1.txt"])
    acceptance: str = Field(default="", description="可客观核对的验收标准")
    failure: str = Field(default="", description="失败时的处理策略")
    assigned_agent: str = Field(
        description="执行人 agent_code（须先 list_agents 对照能力）",
        examples=["general-purpose", "code-agent", "bash"],
    )
    depends_on: list[str] | str | int | None = Field(
        default=None,
        description="上游步骤 ref；并行分支共享同一上游，如 Step2/Step3 都依赖 1",
        examples=[["1"], ["1", "2"], "1"],
    )
    instruction: str = Field(
        default="",
        description="写入 worker_profile.instruction 的补充系统指令（对应 create_subtask 的 instruction）",
    )
    tools: list[str] | str | None = Field(
        default=None,
        description="worker_profile.tools 覆盖列表（如 read_file、write_file、terminal）",
        examples=[["read_file", "write_file", "terminal"], "read_file,write_file"],
    )
    skills: list[str] | str | None = Field(
        default=None,
        description="worker_profile.skills 覆盖列表",
    )
    model: str | None = Field(
        default=None,
        description="worker_profile.model 罕见覆盖；通常省略",
    )
    work_checklist: list[str] | list[dict[str, Any]] | None = Field(
        default=None,
        description="子任务工作清单（对应 create_subtasks 的 work_checklist / work_todos）",
    )
    project_path: str = Field(
        default="",
        description="子任务工作目录 project_path（可选）",
    )
    description: str = Field(
        default="",
        description="子任务描述覆盖；为空时由 goal/inputs/outputs/验收 等自动拼接",
    )
    worker_profile_json: str | dict[str, Any] | None = Field(
        default=None,
        description="高级：完整 worker_profile JSON 对象，与上述字段合并（后者优先）",
    )

    @model_validator(mode="after")
    def _normalize_assigned_agent(self) -> PlanStepInput:
        from evoflow.collab.agent_assignment import resolve_assignable_agent

        code, _display, _warnings = resolve_assignable_agent(self.assigned_agent)
        self.assigned_agent = code
        return self

    @model_validator(mode="before")
    @classmethod
    def _coerce_step_payload(cls, data: Any) -> Any:
        if not isinstance(data, dict):
            return data
        if not str(data.get("assigned_agent") or "").strip():
            for alias in (
                "assignee",
                "assigned_to",
                "assignedAgent",
                "executor",
                "agent",
                "agent_code",
                "subagent_type",
                "subagentType",
                "executor_subagent_type",
                "base_subagent",
            ):
                alt = str(data.get(alias) or "").strip()
                if alt:
                    data["assigned_agent"] = alt
                    break
        if not str(data.get("assigned_agent") or "").strip():
            wp = data.get("worker_profile") or data.get("workerProfile")
            if isinstance(wp, dict):
                for key in ("subagent_type", "base_subagent", "assigned_agent", "assigned_to"):
                    alt = str(wp.get(key) or "").strip()
                    if alt:
                        data["assigned_agent"] = alt
                        break
        if (
            not str(data.get("assigned_agent") or "").strip()
            and str(data.get("name") or "").strip()
            and str(data.get("goal") or "").strip()
        ):
            data["assigned_agent"] = "general-purpose"
        if not str(data.get("name") or "").strip():
            for alias in ("title", "step_name", "stepName", "label"):
                alt = str(data.get(alias) or "").strip()
                if alt:
                    data["name"] = alt
                    break
        if not str(data.get("goal") or "").strip():
            for alias in ("objective", "description", "task", "summary"):
                alt = str(data.get(alias) or "").strip()
                if alt:
                    data["goal"] = alt
                    break
        for key in (
            "name",
            "goal",
            "inputs",
            "outputs",
            "acceptance",
            "failure",
            "assigned_agent",
            "instruction",
            "model",
            "project_path",
            "description",
        ):
            if key in data:
                data[key] = _coerce_to_str(data.get(key))
        for key in ("tools", "skills"):
            if key not in data:
                continue
            raw = data.get(key)
            loaded = _json_loads_if_string(raw)
            if isinstance(loaded, list):
                data[key] = [str(x).strip() for x in loaded if str(x).strip()]
            elif isinstance(raw, str) and raw.strip() and not str(raw).strip().startswith(("[", "{")):
                data[key] = _coerce_string_list_field(raw)
            elif raw is None:
                data[key] = []
        if "work_checklist" in data:
            loaded = _json_loads_if_string(data.get("work_checklist"))
            if loaded is not data.get("work_checklist"):
                data["work_checklist"] = loaded
        wpj = data.get("worker_profile_json")
        if isinstance(wpj, str):
            data["worker_profile_json"] = _json_loads_if_string(wpj)
        dep_raw = data.get("depends_on")
        if dep_raw is None:
            dep_raw = data.get("dependencies")
        if dep_raw is not None:
            if isinstance(dep_raw, int):
                dep_raw = str(dep_raw)
            data["depends_on"] = _coerce_string_list_field(dep_raw)
        if data.get("depends_on") is None:
            data["depends_on"] = []
        ref = data.get("ref")
        if isinstance(ref, str) and ref.strip().isdigit():
            data["ref"] = int(ref.strip())
        return data


class PlanInput(BaseModel):
    """Structured plan input (``steps[]`` required)."""

    model_config = ConfigDict(
        json_schema_extra={"examples": [_PLAN_INPUT_EXAMPLE]},
    )

    goal: str | None = Field(
        default=None,
        description="## Goal：一句话业务目标（有 steps 时必填）",
        examples=["执行简单任务调度：串行任务1，再并行任务2和任务3"],
    )
    steps: list[PlanStepInput] | str | list[dict[str, Any]] | None = Field(
        default=None,
        description="子任务列表（JSON 数组；也接受 JSON 字符串）；每项 1:1 同步为协作侧栏子任务",
        examples=[[_PLAN_STEP_EXAMPLE_1, _PLAN_STEP_EXAMPLE_2]],
    )
    flowchart_mermaid: str | None = Field(
        default=None,
        description=("## Analysis：任务分析图（mermaid 正文，勿包 ```）。画调用链/依赖/数据流等分析结果，勿画 Step 执行顺序图。"),
        examples=[
            "flowchart LR\n  A[入口函数] --> B[核心服务] --> C[存储层]",
            "sequenceDiagram\n  participant U as 用户\n  participant S as 服务\n  U->>S: 请求\n  S-->>U: 响应",
        ],
    )
    validation: list[str] | str | None = Field(
        default=None,
        description="## Validation：全部 Step 完成后的整体验收",
        examples=[
            ["outputs/task1.txt、task2.txt、task3.txt 均存在且非空"],
        ],
    )
    open_questions: str = Field(
        default="无",
        description="## Open Questions；无待定则写「无」",
        examples=["无", "是否允许覆盖已有 outputs/ 下文件？"],
    )
    bound_task_id: str | None = Field(
        default=None,
        description=(
            "修订计划时传入上次 plan() 返回的 boundTaskId（须为本会话已绑定主任务）。"
            "首次提交可省略——同 thread 自动复用占位任务。"
        ),
        examples=["Task_20260602115016_254662"],
    )

    @model_validator(mode="before")
    @classmethod
    def _coerce_plan_payload(cls, data: Any) -> Any:
        if not isinstance(data, dict):
            return data
        data = dict(data)
        data.pop("markdown", None)
        if not str(data.get("bound_task_id") or "").strip() and str(data.get("task_id") or "").strip():
            data["bound_task_id"] = data.get("task_id")
        for junk in ("action", "task_name", "task_description", "authorized_by"):
            data.pop(junk, None)
        for nest_key in ("plan", "payload", "input", "body"):
            inner = data.get(nest_key)
            if isinstance(inner, dict):
                for k, v in inner.items():
                    if k not in data or data.get(k) in (None, "", [], {}):
                        data[k] = v
        if not str(data.get("goal") or "").strip():
            for alias in ("objective", "plan_goal", "planGoal", "summary", "title", "description"):
                alt = str(data.get(alias) or "").strip()
                if alt:
                    data["goal"] = alt
                    break
        if not data.get("steps") and data.get("subtasks"):
            data["steps"] = data.pop("subtasks")
        if not data.get("steps") and data.get("tasks"):
            data["steps"] = data.pop("tasks")
        steps = data.get("steps")
        loaded_steps = _json_loads_if_string(steps)
        if loaded_steps is not steps:
            data["steps"] = loaded_steps
        steps = data.get("steps")
        if isinstance(steps, dict):
            if all(str(k).strip().isdigit() for k in steps.keys()):
                data["steps"] = [steps[k] for k in sorted(steps.keys(), key=lambda x: int(str(x)))]
            else:
                data["steps"] = list(steps.values())
        if isinstance(steps, list):
            fixed_steps: list[Any] = []
            for item in steps:
                if isinstance(item, dict):
                    fixed_steps.append(item)
                    continue
                if isinstance(item, str):
                    loaded = _json_loads_if_string(item.strip())
                    if isinstance(loaded, dict):
                        fixed_steps.append(loaded)
                        continue
                fixed_steps.append(item)
            data["steps"] = fixed_steps
        validation = data.get("validation")
        loaded_validation = _json_loads_if_string(validation)
        if loaded_validation is not validation:
            data["validation"] = loaded_validation
        if not str(data.get("goal") or "").strip() and isinstance(data.get("steps"), list) and data["steps"]:
            first = data["steps"][0]
            if isinstance(first, dict):
                fg = str(first.get("goal") or first.get("name") or "").strip()
                if fg:
                    data["goal"] = fg
        return data

    @model_validator(mode="after")
    def _require_plan_source(self) -> PlanInput:
        if not self.steps:
            raise ValueError("steps is required")
        if not str(self.goal or "").strip():
            raise ValueError("goal is required when steps is provided")
        return self


def _step_ref_to_subtask_map(subtasks_sync: Any) -> dict[str, str]:
    """Build plan step ref -> subtaskId from sync created/updated rows."""
    if not isinstance(subtasks_sync, dict):
        return {}
    out: dict[str, str] = {}
    for key in ("created", "updated"):
        for row in subtasks_sync.get(key) or []:
            if not isinstance(row, dict):
                continue
            ref = str(row.get("ref") or "").strip()
            sid = str(row.get("subtaskId") or row.get("id") or "").strip()
            if ref and sid:
                out[ref] = sid
    return out


def _coerce_steps(steps: list[PlanStepInput] | list[dict[str, Any]] | None) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for item in steps or []:
        if isinstance(item, PlanStepInput):
            out.append(item.model_dump())
        elif isinstance(item, dict):
            out.append(dict(item))
    return out


def _plan_tool_impl(
    goal: str | None = None,
    steps: list[PlanStepInput] | list[dict[str, Any]] | None = None,
    flowchart_mermaid: str | None = None,
    validation: list[str] | str | None = None,
    open_questions: str = "无",
    bound_task_id: str | None = None,
) -> str:
    goal_text = str(goal or "").strip()
    structured_steps = _coerce_steps(steps)  # type: ignore[arg-type]
    if not goal_text:
        return json.dumps({"success": False, "error": "goal is required"}, ensure_ascii=False)
    if not structured_steps:
        return json.dumps({"success": False, "error": "steps is required"}, ensure_ascii=False)

    thread_id: str | None = None
    try:
        from langgraph.config import get_config

        thread_id = (get_config().get("configurable") or {}).get("thread_id")
        thread_id = str(thread_id).strip() if thread_id else None
    except Exception:
        thread_id = None

    bind_meta: dict[str, Any] = {}
    if thread_id:
        bound_hint = str(bound_task_id or "").strip()
        if bound_hint:
            try:
                from evoflow.collab.plan_session_task import assert_thread_plan_task_binding

                bind_err = assert_thread_plan_task_binding(thread_id, bound_hint)
                if bind_err:
                    return json.dumps(
                        {"success": False, "error": bind_err, "boundTaskId": bound_hint},
                        ensure_ascii=False,
                    )
            except ImportError:
                pass
        try:
            from evoflow.collab.plan_session_task import bind_plan_to_thread_task

            bind_meta = bind_plan_to_thread_task(
                thread_id,
                goal=goal_text,
                steps=structured_steps,
                flowchart_mermaid=flowchart_mermaid,
                validation=validation,
                open_questions=open_questions,
            )
        except Exception as e:
            logger.warning("[plan_tool] bind plan to task skipped: %s", e)

    plan_payload = {
        "goal": goal_text,
        "flowchart_mermaid": str(flowchart_mermaid or "").strip(),
        "validation": validation if isinstance(validation, list) else [],
        "open_questions": str(open_questions or "无").strip() or "无",
        "steps": structured_steps,
    }
    bound = bool(bind_meta.get("bound"))
    if thread_id and not bound:
        bind_err = str(bind_meta.get("bindError") or "").strip() or (
            "计划未写入任务表。请完全重启 EvoFlow Gateway 以执行数据库迁移，然后重新提交 plan。"
        )
        return json.dumps(
            {
                "success": False,
                "error": bind_err,
                "plan": plan_payload,
                "goal": goal_text,
                "stepsSubmitted": len(structured_steps),
                "boundPlanPersisted": False,
                "boundPlanReady": False,
                "boundTaskId": "",
            },
            ensure_ascii=False,
        )
    bound_tid = str(bind_meta.get("task_id") or "").strip()
    sync = bind_meta.get("subtasksSync") if isinstance(bind_meta.get("subtasksSync"), dict) else {}
    ref_map = _step_ref_to_subtask_map(sync)
    subtask_ids = list(ref_map.values())
    revised = bool(bind_meta.get("planRevised"))
    # Explicit stop-rail: models often ignore soft wording and call start_execution in the same turn.
    msg = (
        "计划已写入任务表并同步子任务。"
        "【停】须等用户在界面点击「开始执行」授权后，任务才会执行；"
        "本回合及用户点击前禁止调用 supervisor(start_execution) / start_execution / create_subtasks。"
        "用户点开始后由网关自动派发首波；你只需向用户简要说明计划已就绪、请点「开始执行」，然后等待。"
    )
    if revised:
        msg = (
            "计划已修订并同步子任务（执行授权已撤销）。"
            "【停】须等用户重新点击「开始执行」后才会执行；"
            "在此之前禁止 supervisor(start_execution)。"
            "派发/监控时请用 stepRefToSubtaskId 或 subtaskId。"
        )
    return json.dumps(
        {
            "success": True,
            "plan": plan_payload,
            "goal": goal_text,
            "stepsSubmitted": len(structured_steps),
            "message": msg,
            "awaitUserAuthorization": True,
            "doNotStartExecution": True,
            "nextAction": "wait_user_click_start_execution",
            "boundPlanPersisted": True,
            "boundPlanReady": True,
            "boundTaskId": bound_tid,
            "taskId": bound_tid,
            "taskStatus": bind_meta.get("status"),
            "taskProgress": bind_meta.get("progress"),
            "subtasksSync": sync,
            "stepRefToSubtaskId": ref_map,
            "subtaskIds": subtask_ids,
            "created": sync.get("created") or [],
            "updated": sync.get("updated") or [],
            "planRevised": revised,
            "authorizationRevoked": bool(bind_meta.get("authorizationRevoked")),
            "newPlanCycle": bool(bind_meta.get("newCycle")),
            "previousTaskId": str(bind_meta.get("previousTaskId") or "").strip(),
        },
        ensure_ascii=False,
    )


def plan(
    goal: str | None = None,
    steps: list[PlanStepInput] | None = None,
    flowchart_mermaid: str | None = None,
    validation: list[str] | str | None = None,
    open_questions: str = "无",
    bound_task_id: str | None = None,
) -> str:
    """提交 Plan 并同步子任务（结构化 steps）。"""
    return _plan_tool_impl(
        goal=goal,
        steps=steps,
        flowchart_mermaid=flowchart_mermaid,
        validation=validation,
        open_questions=open_questions,
        bound_task_id=bound_task_id,
    )


plan_tool = tool(
    "plan",
    plan,
    args_schema=PlanInput,
    description=_PLAN_TOOL_DESCRIPTION,
    parse_docstring=False,
)
