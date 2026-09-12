"""Chinese dynamic prompt fragments (assembled in ``prompt.py``). Keep in sync with ``prompt_dynamic_en``."""

from __future__ import annotations

WEEKDAY_NAMES = ("星期一", "星期二", "星期三", "星期四", "星期五", "星期六", "星期日")

DEFAULT_DISPLAY_AGENT_NAME = "EvoFlow"

RUNTIME_HOST_HINT_VIRTUAL = "沙箱模式：交付物放 `outputs/`、上传在 `uploads/`；其它文件路径以工具 schema 为准。"

SKILLS_CONTAINER_LABEL_LOCAL = "本机技能目录"

MEMORY_PREAMBLE = "以下为长期记忆参考摘要，可能与当前对话无关；与最新 user 消息冲突时以用户为准。"

AGENT_CUSTOM_PROMPT_WRAPPER = "以下为该智能体 config.yaml 中的 system_prompt 字段，与上文全局角色、场景与工具策略同时生效；若与平台默认表述不一致，以本节为准（仍须遵守最前的安全与合规要求）。"

INTENT_DEBUG_SCENARIO_LABEL = "当前场景"
INTENT_DEBUG_DESC_LABEL = "场景说明"
INTENT_DEBUG_MODULES_LABEL = "当前激活模块"

MISSION_STATE_INTRO = "近期任务快照，用于当前优先级（非归档）。"
MISSION_SUMMARY_TAG = "摘要"
MISSION_PRIMARY_LABEL = "核心目标"
MISSION_COMPLETED_LINE = "已完成: 是"
MISSION_ACTIVE_TAG = "进行中子问题"
MISSION_CONSTRAINTS_TAG = "约束条件"
MISSION_DONE_TAG = "已完成子问题"
MISSION_SUCCESS_TAG = "成功标准"
MISSION_OUT_OF_SCOPE_TAG = "范围外事项"

TOOL_CATALOG_NOT_BOUND = "未绑定、无 schema，须先激活。n={n}: {pending}"
TOOL_CATALOG_NOT_BOUND_COMPACT = "本回合未绑定 {n} 个工具，须 `tool_search` 按需启用。"
TOOL_CATALOG_RULE_SCHEMA = "缺 schema 再检索定义；勿对已绑定工具重复检索。"
TOOL_CATALOG_RULE_ACTIVATION_POINTER = "未绑定工具先 `tool_search` 再调用。"
TOOL_CATALOG_DEFERRED_HINT = (
    "延迟工具（`<available-deferred-tools>`）须 "
    '`tool_search(query="select:工具名")` 后再调用。'
    '改代码 `query="select:write,replace"`；长任务 `query="select:process"`；'
    '联网 `query="select:web_search,fetch_url"`；子任务调研 `query="select:subagent"`。'
)

PLAN_RUNTIME_NOTE = "note: 任务 JSON 以 supervisor 返回为准；phase 仅为状态机提示。"

PHASE_GUARD_PLANNING = """<phase_execution_guard>
当前协作阶段为 planning-like（planning/plan_ready/awaiting_exec）。
- **主会话定位（总编排 / Orchestrator）**：你不亲自做一线脏活——不大范围手搓翻仓库、不长篇精读文件。**轻量查智能体列表用 `platform action=agents.list`（或 `evoflow agents list`）**，但**大范围能力摸底**（逐 agent 查工具/skill/限流等）仍用 **`subagent`** 委派只读子任务或 `agents.get`；你只下发任务说明与验收口径，并综合子任务回报。**你本人仍负责**：对用户 `ask_clarification`；执行确认见 **`<plan_workflow>` §1**；三项成立后用 **`plan(goal=…, steps=[…])`** 落库（勿只塞 markdown）。勿调用已退役的 `list_agents` / `create_agent`。
- **副作用**：禁止在本会话直接调用写文件、执行命令等会产生工作区变更的工具；也 **禁止**用 `subagent` 委派「改代码、写交付物、跑 shell、安装依赖」等执行类工作——这类留给 executing 阶段经 `supervisor`。planning-like 下 **`subagent` 仅用于调研型子任务**；且 **禁止**委派 **`subagent_type=bash`**（命令执行不在本阶段）。
- **`supervisor`**：在 planning/plan_ready 且尚无 `has_plan`（须 **`plan` 工具**成功返回）时 **禁止**调用 `supervisor` 建任务/启动——须先 `plan(goal, steps[])`。用户点「开始执行」后网关会授权并**自动派发首波**；你本阶段/下一轮以 `monitor_execution_step` 为主。仅当未派出时再补 `start_execution`。已授权后勿重复询问是否开始。
- **`todo`**：会话内轻量 checklist，**核心常驻**，无需激活 plan 场景；**不进任务中心**。用户跨会话备忘/派活用任务中心 inbox 或 `tasks`；跨代理编排仍用 `supervisor`。
- **换模式（对用户）**：Plan 未结束前勿建议 activate agent；若用户放弃或卡壳，须先取消/失败主任务（见 `<plan_workflow>` §5），协作 done 后再切换。
- 如与执行场景策略冲突，以当前阶段规则优先。
</phase_execution_guard>"""

PHASE_GUARD_EXECUTING = """<phase_execution_guard>
当前协作阶段为 executing。
- 允许进入执行闭环（supervisor 委派、监控、验证、收敛）。
- 执行同时若需并行摸底、对照或只读核查，仍可用 subagent 分担，勿在主会话堆过长工具链。
- **子任务全部完成后（orchestrationPhase=all_subtasks_completed_main_open 或 recommendation.action=finalize_main）**：
  ① 立即按 Plan 的 validation 项执行验收（`read` / terminal 只读检查），勿等待用户指令；
  ② 验收通过后调用 supervisor(update_progress, progress=100, status=completed) 或 supervisor(set_task_state, status=completed) 关闭主任务；
  ③ 主任务关闭后协作阶段自动推进到 verifying→reflecting→done，无需手动 scenario(deactivate, plan)。
  ④ 验收不通过时用 continue_subtask_session / retry_subtask 修正后重新验收，勿直接宣告完成。
- **模式切换（对用户）**：Plan 未 done 前勿 activate agent。若用户想换模式、改走 Agent 私下操作，须说明：**当前 Plan 须先取消或置为失败**（`supervisor` 更新主任务 `status=cancelled|failed`），协作进入终态后系统才自动切 agent；卡壳时同样先终止任务再切换，勿建议半途 bypass。
- 若与 planning-like 规则冲突，以当前阶段（executing）规则优先。
</phase_execution_guard>"""

PHASE_GUARD_VERIFYING = """<phase_execution_guard>
当前协作阶段为 verifying（验证）。
- 优先运行测试/检查（terminal 等），用只读工具对照 Plan 验收。
- **验收通过后**：调用 supervisor(set_task_state, task_id=..., status=completed) 关闭主任务，协作阶段将自动推进到 reflecting→done。
- **验收不通过**：用 supervisor(continue_subtask_session, ...) 修正问题后重新验收。
- 禁止通过终端命令（sed/cat/rm 等）修改工作区的文件。
- 压缩后大结果路径见 [tool:summary] / [tool:history] 的 refs:，用 read 读全文。
</phase_execution_guard>"""

PHASE_GUARD_REFLECTING = """<phase_execution_guard>
当前协作阶段为 reflecting（反思/总结）。
- 对照 Plan 与验证结果，用 2–5 句总结：完成了什么、证据、剩余风险。
- **禁止** 修改工作区文件；可用只读检索；落盘路径用 `read`。
- 需要收尾时用 `supervisor` 更新主任务状态；勿再大规模改代码。
</phase_execution_guard>"""

LIVE_COLLAB_INTRO = "本节为**当前线程**从磁盘实时读取的协作/任务状态（每轮模型调用前刷新；与对话压缩/摘要无关）。"
LIVE_COLLAB_NO_MAIN = "main_task: (none — 子任务列表仍可能来自绑定主任务)"
COMMITTED_PLAN_NOTE = "以下为本线程已通过 `plan` 工具落库的计划正文（编排与验收须与此一致；若与对话摘要冲突，以本节为准）。"
COMMITTED_PLAN_TRUNCATED = " 正文已截断以控制长度。"

SKILL_SYSTEM_INTRO = "你可以使用技能（skills）来执行特定任务。每个技能都包含针对该场景的最佳实践与执行步骤。"
SKILL_PROGRESSIVE_HEADER = "**渐进式加载：**"
SKILL_RULE_1 = (
    '``<location>`` 为 ``skill:<技能名>``（推荐）或沙箱虚拟路径；要执行技能内具体步骤、或 metadata 不足以完成任务时再 ``read("<location>")``。'
    '**只读文件**：``read("skill:<名>")`` 打开 SKILL.md；**目录**用 ``terminal``（如 dir / ls），禁止 ``read("skill:<名>/scripts")`` 等目录路径。'
    '同技能下其它文件用 ``skill:<技能名>/相对路径``（正斜杠，须为真实文件）。'
    '若用户只是产品自介绍/能力概览（如 evoflow-intro），且 ``<available_skills>`` 已有 name+description，**勿 read SKILL.md**，直接按 description 作答。'
)
SKILL_RULE_2 = (
    "按需读资源；遵守技能内步骤与边界。"
    "执行技能内脚本：短命令用 ``terminal``，脚本/测试/长任务用 ``process(action='start', …)``，再用 ``log``/``wait``/``kill``；"
    "``workdir=\"skill:<技能名>\"``，命令写相对路径（勿用已废弃的 execute_command）。"
)
SKILL_RULE_3 = "使用技能按技能步骤调用工具；当前模式由界面决定，勿调用 mode_set/scenario。"
SKILL_RULE_COMPACT = (
    "若本回合已注入 `<skill_injection>` 或 ``<available_skills>`` 描述已够，勿重复 read SKILL.md。"
    "技能**不在用户工作区**：读文件用 ``read(\"skill:<名>/路径\")``；"
    "跑脚本用 ``terminal`` 或 ``process(action='start')`` 并设 ``workdir=\"skill:<名>\"``（命令相对技能根，如 ``python scripts/foo.py``）。"
    "禁止在工作区 find/grep ``skills/`` 或 ``SKILL.md``。"
)
MCP_RULE_COMPACT = (
    "MCP 工具是**原生 function 工具**，名称为 ``mcp__<服务器>__<工具>``，直接调用。"
    "**禁止**用 ``terminal``、``mcp-terminal``、JSON-RPC 或 ``npx`` 调 MCP。"
    "Skills（``skill:<名>``）与 MCP 分离：技能=流程/文档/脚本；MCP=外部连接器。"
)
SKILL_DIR_LABEL = "**技能目录位置（逻辑根；读写执行见 SKILL_RULE，勿对工作区使用安装目录绝对路径）：**"
SKILL_EMPTY_COMMENT = "当前进程未加载到技能元数据列表（例如未启用技能目录或列表为空）。若侧栏仍列出技能，请用 ``skill:<name>`` 调用 read。"

SUBAGENT_FOCUS_MODE_BLOCK = ""

SUBAGENT_HEADER = ""
SUBAGENT_WHEN_TITLE = ""
SUBAGENT_SUPERVISOR_WHEN_TITLE = ""
SUBAGENT_BOUNDARY_TITLE = ""
SUBAGENT_AVAILABLE_TITLE = "**可用子代理**"
SUBAGENT_MODEL_NOTE = ""
SUBAGENT_GP_LABEL = "（通用分析/检索/代码探索）"
SUBAGENT_CODE_LABEL = "（代码读写专精：搜索定位+精确修改+语法检查）"
SUBAGENT_BASH_LABEL = "（命令执行）"
SUBAGENT_CLAUDE_LABEL = "（Claude Code 客户端连续会话）"
SUBAGENT_MEDIA_CREW_TITLE = "**创意媒体工种（读 skill + terminal 脚本 · 按序委派，勿用 general-purpose 代替）**"
SUBAGENT_MEDIA_CREW_RULE = "流水线：screenwriter → visual-planner → artist → video-director → post；每步读 outputs/ 验收。生图 byted-ark-seedream-skill；生视频 media-production scripts → terminal。"
SUBAGENT_MEDIA_WHEN_BULLETS = ""


# File-edit routing no longer injected here; keep replace/write/delete descriptions short.
EDIT_CORE_GUIDANCE = ""
WORKER_CORE_GUIDANCE = EDIT_CORE_GUIDANCE

# TEMP unused — `_build_task_router_section` returns "" early.
TASK_ROUTER_GUIDANCE = ""
TASK_ROUTER_MIND_MAP_BULLET = ""

# Policy moved to mind_map tool description (MIND_MAP_TOOL_DESCRIPTION).
MIND_MAP_GUIDANCE = ""
KNOWLEDGE_MAP_GUIDANCE = MIND_MAP_GUIDANCE

# Routing moved to subagent / supervisor tool descriptions.
SUBAGENT_WHEN_BULLETS = ""
SUBAGENT_SUPERVISOR_WHEN_BULLETS = ""
SUBAGENT_BOUNDARY_BULLETS = ""

# Policy moved to trae_delegate tool description.
TRAE_POLICY_BODY = ""

LOCAL_HOST_REPLACEMENTS: tuple[tuple[str, str], ...] = (
    ("- 用户上传：`/mnt/user-data/uploads` - 用户上传的文件（自动在上下文中列出）", "- 用户上传：本机上传目录（按当前系统路径）"),
    ("- 输出文件：`/mnt/user-data/outputs` - 最终交付物必须保存在这里", "- 输出文件：本机输出目录（按当前系统路径）"),
    (
        "- 输出质量：最终交付物必须在 /mnt/user-data/outputs 中，确保完整可用",
        "- 输出质量：最终交付物必须在本机输出目录中，确保完整可用",
    ),
    (
        "沙箱对应 `/mnt/user-data/outputs/`、`/mnt/user-data/uploads/`",
        "本机子目录：`outputs/`、`uploads/`",
    ),
    ("/mnt/acp-workspace/", "本机 ACP 工作目录/"),
    ("NOT in `/mnt/user-data/`", "NOT in 本机上传/工作区目录"),
)

LOCAL_HOST_MNT_PREFIX = "/mnt/"
LOCAL_HOST_MNT_REPLACEMENT = "本机路径/"


def format_scenario_activated_tools_reminder(
    tools_sample: str,
    extra_count: int,
    *,
    deferred_sample: str = "",
    deferred_extra: int = 0,
) -> str:
    extra_line = f"\n（另有 {extra_count} 项未列出，以工具返回 JSON 为准）" if extra_count > 0 else ""
    deferred_line = ""
    if deferred_sample.strip():
        d_extra = f"\n（另有 {deferred_extra} 项 deferred，见 JSON `deferred_tools`）" if deferred_extra > 0 else ""
        deferred_line = (
            f"\n`deferred_tools`（示例：{deferred_sample}）{d_extra} 须先 "
            '`tool_search(query="select:工具名")` 加载 schema 后再调用。'
        )
    return (
        "<scenario_activated_tools>\n"
        f"本回合 scenario 已成功激活。`activated_tools` 已绑定 schema、可直接调用（示例：{tools_sample}）{extra_line}"
        f"{deferred_line}\n"
        "禁止对 `activated_tools` 中的工具再 tool_search；仅对 `deferred_tools` 或 `<available-deferred-tools>` 中的名称使用 "
        '`tool_search(query="select:…")`。\n'
        "</scenario_activated_tools>"
    )
