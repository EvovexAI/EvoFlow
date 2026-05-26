# 验收标准与回滚：可控上线

## 验收标准（DoD）

### 1) planning：Plan 输出正确且 0 副作用

- 输入：`collab_phase="planning"`（按钮或自然语言触发）
- 输出：严格为计划模板（# Plan / Scope / Action items / Open questions）
- 系统保证：
  - 不写文件
  - 不执行命令
  - 不派发子代理
  - 即使模型尝试产生副作用 tool_calls，也会被硬门禁拦截

### 2) plan_ready/awaiting_exec：确认门禁有效

- 未点击 Authorize execution 前：不发生任何执行动作
- 点击 Authorize execution 后：下一次 run 才进入 executing

### 3) executing：执行顺畅且可验收

- 能执行工具、生成交付物
- 输出包含：进度、证据、验收结论、失败回退方案
- 支持暂停/回退到 planning 并重新产出计划

## 灰度策略（建议）

- 先对内部用户/特定 thread 启用（例如仅对 UI 的 Plan 按钮路径启用 PlanGuard）
- 观察 1-2 天：是否有误拦截（executing 被拦）或漏拦截（planning 有副作用）

## 回滚策略

- 快速开关：
  - 关闭 PlanGuardMiddleware（从中间件链移除或通过配置开关禁用）
- 行为回退：
  - 即使回滚 PlanGuard，也保留 CollabPhase 的提示词约束（软约束）

