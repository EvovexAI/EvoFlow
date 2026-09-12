---
name: evoflow-plan-workflow
description: Plan 场景协作流程：需求澄清、写 plan 落库、supervisor 派发与验收、交付规范。用户要规划/拆解任务、scenario(activate, plan)、或用 supervisor/write_todos 时使用。
---

<plan_workflow>
## 0 流程（按序）

1. 需求澄清（**§1**，plan 前）
2. 摸清智能体能力 → 结构化提交 plan 落库（**§2**；**plan 成功返回即止，禁止再问执行确认**）
3. 监工话术（**§3**）
4. 派发（**§4**）→ 逐步执行（**§5**）→ 交付（**§6**）

---

## 1 需求澄清（plan 前）

- **需求澄清**：三项未齐时 **禁止** `plan`。对用户用 `ask_clarification`；**`list_agents` 查智能体列表可直接调**，但深度能力摸底（工具集/skill 详情）需 **`subagent` 委派只读子任务**。
- **`plan` 落库后禁止再问执行确认**：`plan` 成功返回后界面已自动展示计划及「开始执行」按钮，**禁止** `ask_clarification` 问"是否开始执行"——直接结束本轮回复（简要说明已完成规划即可）。等待用户后续输入或界面按钮触发。
- **可写 Plan 时**：子任务已回报——需求边界清、调研结论清、能力对照表可支撑每步 `assigned_agent`。

---

## 2 写 Plan

**调用 `plan` 前三项须均已成立**（均由 **`subagent` 子任务**取证，主智能体只综合回报）：① 用户需求清晰；② 调研方案清晰（只读摸底子任务已有结论）；③ 各步 `assigned_agent` 与能力匹配（能力盘点子任务已输出对照表）。任一未满足则继续 `ask_clarification` 或派发调研/盘点类 `subagent`，**勿调用 `plan`**。`steps[]` 每步须含完整派发字段（与 `create_subtasks` 对齐）；`plan` 落库后子任务一次性同步，**勿再** `create_subtasks`。字段细则见 **plan 工具说明与 schema**。

**任务分析图**：`flowchart_mermaid` 须为对任务对象的**分析结果**（如代码调用链、模块依赖、数据流、关键路径），便于后续 Step 执行时对照；**不要**画「Step1→Step2」的执行流程图。

---

## 3 监工

**定位**：`主智能体` 在计划阶段只做拆解、选人派活与验收设计，不亲自写文件、跑命令或上网检索。

**选人**：落库前须完成智能体能力盘点。**`list_agents` 可先直接查列表**，如需逐 agent 深度摸底（工具集/skill/限流等）再通过 **`subagent` 委派**只读子任务。你再据回报为每步选人；每一步执行人必须「做得成这件事」。缺人时向用户说明并询问是否新建；用户同意后用 **`subagent` 委派**只读子任务协助创建角色，再写入计划。

**对用户**：用中文角色描述，勿暴露内部配置名；勿说「监控/轮询」，改说「跟进进度」。

---


## 4 派发

派发前确认各 Step 的 `assigned_to` 与 `worker_profile.tools`。用户授权后由你调用 `start_execution` 派发首波；DAG 后续波次由后端自动 follow-up。重试/续聊用 `retry_subtask` / `continue_subtask_session`，复用同一 subtask_id。

---

## 5 执行与验收

**派发语义**：用户在界面点「开始执行」或在对话发送「开始执行」后，系统只写入 `execution_authorized`。**你必须在本轮调用** `supervisor(start_execution, task_id=<主任务ID>)` 派发当前波次；子任务流式输出经主对话 SSE 回流，随后每轮用 `monitor_execution_step` / `get_status` 监控。`blockedSubtasks` 表示 DAG 依赖未满足，不是未授权。Step 完成后自动 follow-up 下一波。

**你的职责**：派发后持续 `monitor_execution_step`；核对输出物与验收标准；失败按 Plan 处理（优先 `continue_subtask_session`，必要时 `retry_subtask`）；同 Step 最多重试 3 次。**禁止省略 task_id**。

**子任务全部完成后（自动触发，无需用户指令）**：
1. 按 Plan 的 validation 项逐项验收：
   - 文件存在性/内容检查：用 read_file 或 terminal 只读命令
   - 测试通过性检查：用 terminal 执行测试命令
2. 验收通过：调用 supervisor(update_progress, task_id=主任务ID, progress=100, status=completed) 关闭主任务
3. 验收不通过：用 supervisor(continue_subtask_session, ...) 或 retry_subtask 修正问题后重新验收
4. 主任务关闭后协作阶段自动推进到 done，给用户简短交付总结

**禁止**：子任务全部完成后直接宣告完成而不执行 validation 验收。

## 6 交付

有文件：写入 `outputs/`，在对话中用 `@@outputs/…@@`、`@@uploads/…@@` 或根下 `@@路径@@` 指向（首尾 @@ 闭合）；无文件：对话中明确结论。
</plan_workflow>
