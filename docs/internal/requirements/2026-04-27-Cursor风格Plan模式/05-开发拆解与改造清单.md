# 开发拆解与改造清单（MUST/SHOULD/NICE）

> 说明：这是评审与排期用的拆解清单。每项包含文件位置与验收点。

## 表格版总览（含进度与状态）

| 编号 | 阶段 | 模块 | 具体任务 | 关键文件/位置 | 完成标准 | 处理进度 | 状态 |
|---|---|---|---|---|---|---|---|
| A1 | 前端 | 运行上下文 | 在发起 run 时透传 `collab_phase`（planning/plan_ready/awaiting_exec/executing） | `evopanel/src/react/ChatApp.tsx`（及 run 请求组装处） | 不同 phase 可被后端识别并驱动行为差异 | 0% | 未开始 |
| A2 | 前端 | 交互流程 | 新增 `Plan` / `Authorize execution` / `Revise plan` 按钮与状态联动 | `evopanel/src/react/ChatApp.tsx`、相关组件 | 用户可完成 Plan->确认->执行完整流程 | 0% | 未开始 |
| A3 | 前端 | 结构化澄清 | 渲染单选/多选/Other补充/多问题表单 | 前端消息渲染组件、交互表单组件 | 可在聊天中渲染并提交结构化问题答案 | 0% | 未开始 |
| A4 | 前端 | 协议回传 | 实现 `answers[]` 回传协议（question_id/selected_option_ids/free_text） | run 输入组装、消息提交逻辑 | 后端可稳定解析结构化答案 | 0% | 未开始 |
| A5 | 前端 | 执行策略 | （可选）增加 `supervision_intensity` 开关并透传 | 会话设置/请求 context | 后端可收到并据此调整监工强度 | 0% | 未开始 |
| B1 | 后端 | 中间件 | 新增 `PlanGuardMiddleware` | `backend/packages/harness/evoflow/agents/middlewares/plan_guard_middleware.py` | planning类阶段能硬拦截副作用 tool_calls | 0% | 未开始 |
| B2 | 后端 | 中间件链 | 将 PlanGuard 挂入 lead agent middleware 链 | `backend/packages/harness/evoflow/agents/lead_agent/agent.py` | 顺序正确：phase注入后、澄清前执行门禁 | 0% | 未开始 |
| B3 | 后端 | phase规则 | 强化 `CollabPhaseMiddleware` 的 planning/plan_ready/awaiting_exec/executing 提示注入 | `backend/packages/harness/evoflow/agents/middlewares/collab_phase_middleware.py` | 不同阶段提示行为明确且无冲突 | 0% | 未开始 |
| B4 | 后端 | 提示词分层 | 新增 phase 提示词块并接入 prompt 组装 | `backend/packages/harness/evoflow/agents/lead_agent/prompt.py`、`prompt_blocks.py` | prompt 体现 phase 规则，planning 不诱导执行 | 0% | 未开始 |
| B5 | 后端 | 提示词兼容 | 给执行场景提示词加“phase 优先”补丁 | 同上（执行策略相关 block） | planning 阶段不再出现“立即执行”指令 | 0% | 未开始 |
| B6 | 后端 | 工具决策 | 落地 `final_tools = scenario_tools ∩ phase_tools` 规则（不拆 scenario） | tool 过滤/中间件处理链 | 单场景工具限制保留，phase 仅二次收紧 | 0% | 未开始 |
| B7 | 后端 | 澄清协议 | 解析结构化澄清问题与答案（多题） | 问题工具/消息处理层 | 能处理多问题结构化输入并继续规划 | 0% | 未开始 |
| C1 | 编排 | 子任务输入 | 主智能体派发子任务时强制模板（Goal/Scope/Context/Acceptance/Constraints/Fallback） | supervisor/task 调用构造处 | 子任务输入信息完整且可验收 | 0% | 未开始 |
| C2 | 编排 | 子任务输出 | 统一子任务回传结构（摘要/证据/验收结果/风险/下一步） | supervisor/task 结果处理处 | 主智能体可据此自动验收与调度 | 0% | 未开始 |
| C3 | 编排 | 状态同步 | 将用户意图在 `mission_state` + 子任务prompt + 任务存储三处对齐 | mission/state、task storage 相关模块 | 跨回合不丢意图，不重复无效追问 | 0% | 未开始 |
| D1 | 测试 | 单元测试 | PlanGuard：planning 拦截执行类 tool_calls | `backend/tests/` 新增测试 | planning 阶段不产生副作用 | 0% | 未开始 |
| D2 | 测试 | 单元测试 | PlanGuard：planning 放行只读工具 | `backend/tests/` | allowlist 工具正常可用 | 0% | 未开始 |
| D3 | 测试 | 单元测试 | PlanGuard：executing 不拦截执行类工具 | `backend/tests/` | executing 阶段正常执行 | 0% | 未开始 |
| D4 | 测试 | 集成测试 | Plan->Authorize->Execute 全链路联调 | 前后端联调用例 | 端到端流程可走通 | 0% | 未开始 |
| E1 | 文档 | 规范沉淀 | 维护需求目录为 SSOT，更新索引链接 | `docs/需求文档/...`、`backend/docs/cursor_plan_mode.md` | 文档与实现一致，入口清晰 | 70% | 进行中 |
| E2 | 文档 | 拆分产物 | 需求分析/方案/设计/开发/测试/验收文档拆分完成 | `docs/需求文档/2026-04-27-Cursor风格Plan模式/` | 文档结构完整可评审 | 100% | 已完成 |

## A. 前端/调用侧（evopanel 或任意 LangGraph 调用方）

- **A1（MUST）**：新增 Plan/Execute 入口（run 时传 `context.collab_phase`）
  - planning / plan_ready / awaiting_exec / executing
  - **验收**：planning 无副作用；executing 可执行

- **A2（MUST）**：新增执行授权按钮
  - Authorize execution / Revise plan
  - **验收**：未授权不执行；授权后才执行

- **A3（SHOULD）**：新增 `supervision_intensity`（0/1/2）
  - 0 直跑收敛、1 里程碑监工、2 全程监工
  - **验收**：反馈密度与调度策略随强度变化

- **A4（SHOULD）**：新增“结构化澄清问题”渲染能力（ABCD/多选/补充）
  - **目标**：在 planning/plan_ready/awaiting_exec 阶段，用可交互表单替代纯文本追问
  - **UI 能力**：
    - 单选（A/B/C/D，radio）
    - 多选（checkbox）
    - 其他补充（Other + free text）
    - 多问题同屏（最多 1-2 个阻塞问题）
  - **验收**：用户可直接勾选并提交，无需手写长文本

- **A5（SHOULD）**：定义结构化问题与答案回传协议
  - **问题协议（示例）**：
    - `questions[]`：`id`、`prompt`、`options[]`、`allow_multiple`
    - `options[]`：`id`、`label`
  - **答案协议（示例）**：
    - `answers[]`：`question_id`、`selected_option_ids[]`、`free_text`
  - **验收**：后端能稳定解析结构化答案并继续生成计划

- **A6（NICE）**：澄清交互与 phase 联动显示
  - planning：显示“需要你确认的关键选项”
  - plan_ready/awaiting_exec：显示“确认执行”与“回到改计划”
  - **验收**：用户不需要理解内部状态名，也能完成下一步操作

## B. 后端：阶段注入（软约束）

- **B1（MUST）**：强化 `CollabPhaseMiddleware` planning/确认/执行阶段提示词
  - **文件**：`backend/packages/harness/evoflow/agents/middlewares/collab_phase_middleware.py`
  - **验收**：各 phase 行为可预期一致

- **B2（MUST）**：明确并实现“场景层 + phase 层”的工具决策顺序
  - **规则**：`final_tools = scenario_tools ∩ phase_tools`
  - **要求**：
    - 不改现有 scenario 选工具逻辑
    - phase 只做二次过滤
  - **验收**：
    - 单场景时仍仅可见该场景工具
    - planning 时执行类工具被 phase 拦截

## C. 后端：PlanGuard 硬门禁（保证 planning 0 副作用）

- **C1（MUST）**：新增 `PlanGuardMiddleware`
  - **新文件建议**：`backend/packages/harness/evoflow/agents/middlewares/plan_guard_middleware.py`
  - **验收**：planning 等阶段无法触发写/执行/委派类 tool_calls

- **C2（MUST）**：挂载 PlanGuard 到中间件链
  - **文件**：`backend/packages/harness/evoflow/agents/lead_agent/agent.py`
  - **验收**：顺序正确且不破坏澄清中断

- **C3（SHOULD）**：PlanGuard allowlist 包含 `ask_clarification`
  - **原因**：planning 阶段允许少量阻塞问题澄清
  - **验收**：planning 可提 1-2 个阻塞问题，但不会执行副作用工具

## D. 主智能体=监工：子任务通信协议

- **D1（SHOULD）**：子任务输入 prompt 模板强制化（Goal/Scope/Context/Acceptance/Constraints/Fallback）
  - **验收**：子任务偏航显著减少

- **D2（SHOULD）**：子任务输出结构化（摘要/证据/是否满足验收/风险/下一步）
  - **验收**：主智能体可验收可重排

- **D3（SHOULD）**：意图在 `<mission_state>` + prompt + 任务存储 三处复用
  - **验收**：执行过程不反复问同一意图，收敛更快

## E. 提示词分层改造（不推倒重写）

- **E1（MUST）**：保留现有 `scenario` 提示词体系，不新增 `plan` 业务场景
  - **原则**：`scenario` 负责业务语义；`phase` 负责阶段行为约束
  - **验收**：`execute/web/manage/...` 仍按原逻辑生效

- **E2（MUST）**：新增 phase 提示词块（planning/plan_ready/awaiting_exec/executing）
  - **建议位置**：`backend/packages/harness/evoflow/agents/lead_agent/prompt.py` 或 `prompt_blocks.py` 中的独立模块
  - **要求**：
    - planning：只读、计划模板、最多 1-2 个阻塞澄清
    - plan_ready/awaiting_exec：等待确认/授权，不执行
    - executing：允许执行，要求验收与回退
  - **验收**：不同 phase 下模型文案与行为指令明显区分

- **E3（MUST）**：对现有执行场景提示词打“phase 优先”补丁
  - **要求**：在执行策略段增加“当 phase=planning 类阶段时，执行策略失效，遵循 Plan 规则”
  - **验收**：planning 下不再出现“立即执行”倾向文案

- **E4（SHOULD）**：将“立即执行”措辞改为“在 executing 阶段执行”
  - **验收**：提示词内部无 phase 语义冲突

- **E5（SHOULD）**：提示词改造后配套回归测试
  - **覆盖**：
    - planning：输出计划模板意图明显，且不诱导执行
    - executing：正常执行导向
  - **验收**：关键 prompt 快照对比无冲突句式

## F. 测试与回归

- **F1（SHOULD）**：PlanGuard 单测
  - **目录**：`backend/tests/`
  - **验收**：CI 能捕获 planning 副作用回归

## G. 文档

- **G1（NICE）**：将 `backend/docs/cursor_plan_mode.md` 简化为索引，指向本需求目录
  - **验收**：入口更清晰，避免重复维护

