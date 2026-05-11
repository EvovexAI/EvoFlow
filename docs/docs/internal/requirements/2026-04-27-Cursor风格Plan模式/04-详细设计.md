# 详细设计：PlanGuard、工具契约、主↔子通信协议

## 0. 与现有场景体系对齐（先决约束）

- 不新增 `plan` 业务场景，不拆 `execute/web/manage/...`。
- `plan` 仅作为 `collab_phase`（阶段层）能力叠加到现有场景之上。
- 单场景下，继续使用“该场景限定工具”策略；phase 仅做进一步收紧。

工具决策统一算法：

1. 取 `scenario_tools`（由现有场景系统给出）  
2. 取 `phase_tools`（由 phase 门禁给出）  
3. `final_tools = scenario_tools ∩ phase_tools`

建议 `phase_tools`：
- planning / plan_ready / awaiting_exec：`{read_file, list_dir, search_content, ask_clarification}`
- executing：`ALL`（不额外限制）

## 1. phase 注入（软约束）

### 1.1 CollabPhaseMiddleware（planning 分支需要强化）

- 文件：`backend/packages/harness/evoflow/agents/middlewares/collab_phase_middleware.py`
- planning 必须注入：
  - 只读（可允许 read_file/list_dir/search_content）
  - 强制输出 `create-plan` 模板
  - 禁止副作用工具、禁止派发子任务
- plan_ready/awaiting_exec 注入：
  - 明确“等待确认/授权”，禁止执行
- executing 注入：
  - 允许执行，但要求里程碑验收 + 失败回退

## 2. PlanGuardMiddleware（硬门禁，保证 0 副作用）

### 2.1 目标

当 `collab_phase in {"planning","plan_ready","awaiting_exec"}` 时：
- 即使模型输出 `tool_calls`，也不会触发写/执行/委派等副作用
- 仅允许（可配置）少数只读工具

### 2.2 规则（建议）

- allowlist（planning 允许只读工具时）：
  - `read_file`
  - `list_dir`
  - `search_content`
  - `ask_clarification`（仅阻塞问题）
- denylist（必须拦截）：
  - 写入类：`write_to_file`, `replace_in_file`, `delete_file`
  - 执行类：`execute_command`
  - 委派类：`task`
  - supervisor 的执行类 action（若存在）：
    - `start_execution` / `create_subtask(s)` / `update_progress`（按你最终 action 语义再细分）

> 备注：工具名以本仓库实际暴露为准（`get_available_tools()`）。

### 2.4 与场景限制的组合方式（实现要点）

PlanGuard 不负责“替代场景选工具”，只做 phase 过滤：

- 输入：`tool_calls`（已在当前场景边界内生成）
- 行为：若 phase 为 planning 类阶段，过滤为 allowlist 交集
- 输出：过滤后的 `tool_calls`

这样可保证：
- 不破坏你现有场景切换逻辑
- 单场景时仍只会用该场景工具
- planning 时即使场景允许执行工具，也会被 phase 拦截

### 2.3 放置位置

- `backend/packages/harness/evoflow/agents/lead_agent/agent.py`
- 建议：`CollabPhaseMiddleware()` 之后，`ClarificationMiddleware()` 之前

## 3. 工具契约（摘要）

### 3.1 planning / plan_ready / awaiting_exec

- 允许：`read_file` / `list_dir` / `search_content` / `ask_clarification`
- 禁止：任何写/执行/委派/外部副作用工具
- 输出：必须是计划模板 Markdown

### 3.2 executing

- 允许：执行/写入/委派（仍受 guardrails）
- 输出：进度、证据、验收结论、交付物位置、失败回退

## 4. 主智能体 ↔ 子任务通信协议（让执行丝滑）

### 4.1 通信载体（建议组合）

1) 编排通道：`supervisor` / `task`  
2) 持久通道：任务存储、thread collab state（避免跨回合丢状态）  
3) 证据通道：tool results + artifacts/outputs（让主智能体可验收）  

### 4.2 子任务输入（主智能体派发 prompt 模板）

每个子任务的 prompt 建议强制包含：

- Goal：一句话目标
- Scope：In/Out
- Context：关键文件/约束/已有结论
- Acceptance：验收标准（如何判断完成）
- Constraints：权限/破坏性操作/时间预算
- Fallback：失败时如何处理（换路线/降级/返回证据）

### 4.3 子任务输出（回传结构）

子任务返回必须包含：

- 摘要（2-4 句）
- 证据（日志/测试输出/文件路径/变更点）
- Acceptance 是否满足（Yes/No + 缺口）
- 风险与边界（至少 1 条）
- 建议下一步（供主智能体继续编排）

### 4.4 “更理解意图”的关键：意图结构化复用

把用户意图写进三个地方，降低遗忘与偏航：

- `<mission_state>`：主智能体每轮可见（目标/约束/成功标准）
- 子任务 prompt：每个执行者对齐同一 Acceptance/Constraints
- 任务存储字段：跨回合保持（尤其是 streaming 时 context 固定）

