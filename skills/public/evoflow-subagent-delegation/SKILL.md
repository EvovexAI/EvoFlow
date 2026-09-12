---
name: evoflow-subagent-delegation
description: subagent 与 supervisor 选型、委派边界、并行上限与媒体工种流水线。用户要委派调研/检索/并行探索，或 plan 落库后用 supervisor 编排时使用；工作区代码检索改写仍用 worker（见 workspace-code-workflow）。
---

# Subagent 委派

**何时读**：要用 `subagent` 或 `supervisor` 前读全文；简单 workspace 代码任务勿读，直接用 **workspace-code-workflow** + `worker`。

子代理协作已启用。核心工具 **`subagent`** 把子问题交给专用子智能体在独立上下文中完成（默认流式回报）；协作计划落库后的批量执行与状态机仍用 **`supervisor`**。

## 什么时候用 `subagent`（直接委派，优先）

- **分工（强制）**：工作区内「找代码在哪 / 改哪些文件」→ **`worker`**（读 **workspace-code-workflow**）；跨域调研、联网取证、日志/报错长链排查、边界模糊的子问题 → **`subagent`**。勿用 `subagent` 代替 `worker` 做简单检索或单文件改写。
- **多委派、少亲自干**：适合 `subagent` 的子问题用 `subagent`（`description` + `prompt` + `subagent_type`），勿在主会话长链 `read` / `search_*` / `bash`。
- **并行**：独立子问题可同轮并行多只 `subagent`（单轮不超过 5）；各只写清验收口径与交付格式，主会话再综合。
- **选型**：`general-purpose` 分析/跨步骤探索；`bash` 仅确需命令时；Claude Code → `subagent_type=claude-code`（`prompt` 只写用户目标）。
- **planning-like**：只读调研、能力盘点、需求取证 → 仅 `subagent`；禁止委派改代码/交付物/shell；此阶段禁止 `subagent_type=bash`。
- **非 plan 场景**（如 workspace）：检索改写 → **`worker`**；已知路径 → `read`；大范围架构对照 → `subagent`。
- **创意媒体**：生图读 **byted-ark-seedream-skill**；生视频/短片读 **media-production**；其它厂商读 **agnes-media-generation** / **wan-media-generation** / **kling-media-generation**。完整流水线用 `subagent_type=media-*`；执行靠 **terminal** + 技能脚本。

## 什么时候用 `supervisor`（协作编排）

- **能力匹配（强制）**：`list_agents` 确认 Step 执行人；需写文件/终端时用 `list_assignable_tools` 配 `worker_profile.tools`。
- 创建/跟踪主任务与子任务、进度、重试、生命周期 API（create/start/get_status/update_progress/complete）。
- 并行子任务过多（>5）时分批创建与启动。
- executing 阶段 Claude Code 连续协作：`assigned_agent="claude-code"`。
- 派发 prompt 含 PUA 约束：先验证再完成、失败换方案、禁止无证据归因。

## 主智能体边界

- 澄清、拆解、调度、验收；**脏活优先 `subagent`**，勿默认通读整个仓库。
- plan 落库后的执行闭环 → `supervisor`；planning-like 摸底 → `subagent`。
- 澄清与执行确认见 **evoflow-plan-workflow** §1。

## 可用子代理（常见）

- `general-purpose` — 通用分析/检索/代码探索
- `claude-code` — Claude Code 连续会话
- `media-*` — 媒体工种流水线（screenwriter → visual-planner → artist → video-director → post）；完整列表以 `subagent` 工具 schema 为准

**模型（勿配）**：子任务 `worker_profile` 不要填 `model`；除非用户明确要求单独换模型。

## Plan 协作未开启时

优先 `subagent` 委派；需要 `plan` / `supervisor` 时先 `scenario(activate, plan)` 并读 **evoflow-plan-workflow**。
