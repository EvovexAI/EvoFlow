# 方案调研：Cursor Plan vs EvoFlow（取舍与融合）

## Cursor 更接近的模式（抽象）

- Plan 阶段：只读理解 + 输出计划（固定模板/清单思维）
- Act 阶段：直接执行（改代码/跑命令/生成产物），反馈密度通常偏“结果导向”
- 其核心不是“子任务通信体系”，更多是“同一 agent 在 IDE 内连续行动”

## EvoFlow 的现状与优势

- 具备编排与监控能力：`supervisor`、子任务/任务存储、执行态快照、流式回传
- 具备阶段注入能力：`CollabPhaseMiddleware` 能按 phase 注入行为约束
- 具备治理/门禁基础：已有 guardrails、中间件链路、工具系统可拦截

## 差距（为什么不能只用 `is_plan_mode`）

当前项目中的 `is_plan_mode` 更像“Todo 中间件开关”，并不等同 Cursor 的 Plan：

- Cursor Plan 的本质是“阶段/模式”：计划期只读 + 固定输出协议 + 执行前确认门禁
- 因此建议用 `collab_phase` 表达周期（planning/plan_ready/awaiting_exec/executing）

## 备选方案对比

### 方案 A：仅提示词约束（不做硬门禁）
- 优点：改动小
- 缺点：不可控；模型漂移会导致 Plan 阶段产生副作用
- 结论：不推荐

### 方案 B：提示词 + PlanGuard 硬门禁（推荐）
- 优点：Plan 阶段 0 副作用可验证；体验可控
- 缺点：需要新增中间件与测试
- 结论：推荐

### 方案 C：完全复刻 Cursor（执行阶段默认直跑收敛）
- 优点：最像 Cursor，最“爽”
- 缺点：复杂任务易失控；失败发现晚；并行任务验收弱
- 结论：可作为 `supervision_intensity=0` 的一种执行策略

## 最强融合结论

采用“两段式 + 自适应监工强度”：

- Plan：100% Cursor（只读、计划模板、确认门禁）
- Execute：同一机制下支持三种强度：
  - 0：直跑收敛（像 Cursor）
  - 1：里程碑监工（默认推荐：快且稳）
  - 2：全程监工（高风险：强治理）

