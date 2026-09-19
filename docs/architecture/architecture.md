# EvoFlow 架构基线

> 状态：初始化基线。详细代码级架构以 `.codebasewiki/index/architecture.md` 为准；本文件记录协作时的稳定边界与变更决策入口。

## 系统边界

```text
EvoPanel (Tauri + React)
          │ API / events
          ▼
Gateway (FastAPI)
          │ orchestration
          ▼
Agent Runtime (LangGraph, Supervisor, Agent Teams)
    ┌─────┼─────┐
    ▼     ▼     ▼
 Memory Skills/MCP Sandbox
```

## 关键原则

1. **契约先行**：改变前后端交互时，先明确 Gateway API、事件或数据模型的兼容性与迁移方案。
2. **运行时隔离**：Runtime、Memory、Skills/MCP 与 Sandbox 的职责边界应清晰；不得通过 UI 直接绕过 Gateway 或安全控制。
3. **可观测性**：新增异步执行、工具调用或任务调度时，必须定义日志、状态、失败路径与取消行为。
4. **安全默认**：权限、密钥、外部工具和 Sandbox 变更必须在任务中说明最小权限、审计和回滚方案。
5. **可演进性**：跨模块或破坏性变更先新增 ADR，并提供兼容、迁移或回退策略。

## 变更入口

- 产品范围与验收：`../product/requirements.md`
- 技术取舍：`../decisions/ADR-<编号>-<名称>.md`
- 可执行工作：`../tasks/backlog.md`
