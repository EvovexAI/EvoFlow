"""Subtask reporting ceremony mode: full (Lead collab) vs light (App workflow).

Workflow steps re-used the Lead collab contract (checklist + mid progress + peer),
which adds several LLM rounds for short text steps. Light mode keeps a single
mandatory ``done`` and treats the rest as optional.
"""

from __future__ import annotations

from typing import Any, Literal

ReportingMode = Literal["full", "light"]

_LIGHT_ALIASES = frozenset({"light", "minimal", "slim", "lite"})
_FULL_ALIASES = frozenset({"full", "strict", "ceremony"})


def resolve_subtask_reporting_mode(
    *,
    subtask_row: dict[str, Any] | None = None,
    main_task: dict[str, Any] | None = None,
) -> ReportingMode:
    """Decide reporting ceremony for one subtask worker.

    Precedence:
    1. ``worker_profile.reporting_mode`` / ``ceremony`` explicit override
    2. rollup step → light
    3. app/workflow sourced main task (``source_app_id``) → light
    4. otherwise full (Lead-supervised collab)
    """
    wp = subtask_row.get("worker_profile") if isinstance(subtask_row, dict) else None
    if not isinstance(wp, dict):
        wp = {}

    explicit = str(wp.get("reporting_mode") or wp.get("ceremony") or "").strip().lower()
    if explicit in _LIGHT_ALIASES:
        return "light"
    if explicit in _FULL_ALIASES:
        return "full"

    if isinstance(subtask_row, dict):
        ref = str(subtask_row.get("ref") or "").strip()
        if bool(subtask_row.get("is_rollup_step")) or bool(wp.get("is_rollup_step")) or ref == "__rollup__":
            return "light"

    if isinstance(main_task, dict) and str(main_task.get("source_app_id") or "").strip():
        return "light"

    return "full"


def format_subtask_progress_mandate_block(*, mode: ReportingMode = "full") -> str:
    """Inject into collab subtask worker system prompt."""
    if mode == "light":
        return """## 子任务进度（轻量模式：可选）

本步为工作流/短任务轻量契约：**不必**维护 checklist，**不必**在每个里程碑调用 `progress`。

- 收尾前**必须**调用一次 `done`（见终态说明）
- 若步骤很长或需要侧栏可见进度，可偶尔调用 `progress`；短文本生成可直接跳到 `done`
- 聊天文字不会更新 UI 进度条——只有工具写入才会

**禁止**：用散文代替 `done`。"""

    return """## 子任务进度上报（强制，执行过程中）

协作侧栏与工作流 DAG 的**进度条与状态灯**只认存储里的 `progress`（0–100）与 `status`。聊天文字**不会**更新 UI。

**你必须主动上报（按完成度估算百分比）**
- 开始实质性工作前：`progress(progress=5~15, current_step="…")`，并确保 checklist 已 `set`
- 每完成一个关键里程碑（或 checklist 一项 `completed` 后）：再次调用，进度单调递增（建议 20→50→80…）
- 若在用 `checklist`：每次 `update` 完成项后 checklist 会自动折算进度；**仍建议在阶段边界再调一次** `progress` 写清 `current_step`
- 收尾前：`done` 会把终态设为 100%（completed）或保留末次进度（failed/blocked）

**参数**
- `progress`（必填）：0–100 整数，反映**本子任务**整体完成度（不是主任务）
- `current_step`（强烈建议）：正在做什么（一句话，供 Lead / UI）
- `status`（可选）：`in_progress`；终态请用 `done`

**禁止**
- 全程 0% 或只在最后一步才上报
- 用主会话 prose 代替工具调用

**与主任务区分**
- **本子任务**：你可上报到 100%，并用 `done` 设为 `completed`（或 failed/blocked）。
- **主任务（整体）**：执行期进度由后端从子任务汇总（主任务自动上限 99%）；主任务 `completed` + 100% **仅 Lead** 在 Plan 验收后写入。"""


def format_subtask_outcome_mandate_block(*, mode: ReportingMode = "full") -> str:
    """Inject into collab subtask worker system prompt."""
    if mode == "light":
        return """## 子任务终态上报（强制，唯一必做仪式）

回合结束 ≠ 子任务完成。收尾前必须调用 **`done` 一次**：

- 达成 → `outcome="completed"`，`summary` 写清结论与交付物
- 失败 → `outcome="failed"`，说明原因
- 阻塞 → `outcome="blocked"`

**禁止**只在对话里写「已完成」；未调用本工具结束回合会被标为失败。

可选：`outputs` / `evidence_paths`。checklist 与中途 progress **不是**本模式的要求。
调用成功后下游即可启动；勿在 `done` 之后再做实质性工作。"""

    return """## 子任务终态上报（强制，最后一环）

你的 LangGraph 回合**结束不等于子任务完成**。必须在收尾前调用工具 **`done`** 一次，写入协作侧栏的真实状态与任务汇报。

**何时调用（结束前必做）**
- 目标达成、验收通过 → `outcome="completed"`，`summary` 写清产出路径、验收证据、结论
- 无法完成、验收失败、缺权限/缺信息 → `outcome="failed"`，`summary` + `error` 说明原因与已尝试步骤
- 被阻塞需 Lead 决策 → `outcome="blocked"`
- 主动放弃/范围取消 → `outcome="cancelled"`

**禁止**
- 只在对话里写「已完成 / 失败」而不调工具
- 未调用本工具就结束回合（系统会把子任务标为失败：`未调用 done`）

**参数**
- `summary`（必填）：**子任务完成汇报**（给 Lead / 协作侧栏），写清做了什么与验收结论
- `error`（`failed`/`blocked` 时建议填写）
- `outputs`（推荐）：结构化产出 `[{type,key,value,label?}]`，type=`file|url|text|other`
- `evidence_paths`（兼容旧参）：文件路径列表，等价于 `type=file` 的 outputs

**与智能体记忆区分**
- 本工具的 `summary` / `outputs` 写入协作子任务交工字段，是侧栏与验收的唯一依据
- 执行过程中的 `task_memory.output_summary` 仅为**智能体工作记忆**，不能代替本工具

**与 DAG / 下游子任务**
- 本工具返回成功后，协作状态即视为**已完成**，下游依赖子任务可以立即并行启动
- 你在此之后输出的简短收尾文字仅用于会话展示，**不会**阻塞下游；请勿在调用本工具后再做新的实质性工作

可先使用 `checklist` 记录步骤，并用 `progress` 在阶段边界上报 0–100 进度；**终态以 `done` 为准**。"""


__all__ = [
    "ReportingMode",
    "format_subtask_outcome_mandate_block",
    "format_subtask_progress_mandate_block",
    "resolve_subtask_reporting_mode",
]
