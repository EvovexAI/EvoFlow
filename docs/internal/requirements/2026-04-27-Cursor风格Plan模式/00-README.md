# 2026-04-27 - Cursor 风格 Plan 模式

## 结论摘要

本需求目标是在 EvoFlow 中实现“与 Cursor Plan 模式一致”的协作体验：

- Plan 阶段：**只读 + 输出计划模板 + 0 副作用（硬门禁）**
- Confirm 阶段：用户确认/授权后才进入执行
- Execute 阶段：主智能体作为“监工”编排子任务，支持自适应监工强度（快/稳可切换）
- 与现有场景模式对齐：**不拆 `scenario` 体系，Plan 作为 `phase` 横切叠加**
- 工具选择原则：**最终可用工具 = 场景工具集合 ∩ phase 允许集合**

## 文档导航

- `01-需求分析.md`：目标/非目标/成功标准/约束
- `02-方案调研.md`：Cursor 行为抽象、与 EvoFlow 差异、取舍
- `03-总体方案与架构设计.md`：全周期流程、状态机、时序图（中文）
- `04-详细设计.md`：phase 注入、PlanGuard、工具契约、主↔子通信协议
- `05-开发拆解与改造清单.md`：MUST/SHOULD/NICE 清单（含文件路径/验收点）
- `06-测试方案.md`：单测/回归建议
- `07-验收标准与回滚.md`：验收步骤、灰度/回滚

## 相关参考

- 原始综合文档（已拆分来源）：`backend/docs/cursor_plan_mode.md`
- Plan 模板契约：`skills/public/create-plan/SKILL.md`

