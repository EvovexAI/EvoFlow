# EvoFlow 模块地图

> 用于产品讨论和任务拆分；代码定位仍应遵循根目录 `AGENTS.md` 的知识库检索约定。

| 模块 | 责任 | 主要协作者 | 典型改动归属 |
| --- | --- | --- | --- |
| EvoPanel | 桌面端界面、React/Tauri 交互与状态 | Cursor | UI、组件、页面、前端 API 接入 |
| Gateway | FastAPI 服务、路由、认证、事件和服务编排 | Codex | API、数据访问、中间件、集成 |
| Agent Runtime | 智能体执行、LangGraph、Supervisor 与团队协作 | Codex | 工作流、调度、运行时能力 |
| Memory | 上下文、记忆与知识能力 | Codex | 存储、检索、策略与权限 |
| Skills / MCP | 技能、工具和外部协议扩展 | Codex | 工具注册、协议与安全边界 |
| Sandbox | 隔离执行和资源边界 | Codex | 执行安全、生命周期与可观测性 |
| Product Governance | 需求、任务、架构决策与发布 | ChatGPT | 规划、验收、优先级与文档 |

## 拆分原则

- 单一 UI 页面或交互优化：优先 Cursor。
- 涉及 API 契约、数据模型或多个模块：优先 Codex，必要时拆出 Cursor 子任务。
- 涉及产品范围、优先级或架构取舍：先由 ChatGPT 形成需求或 ADR，再开始编码。
