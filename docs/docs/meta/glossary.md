# 术语表

| 术语 | 含义 |
|------|------|
| **Gateway** | FastAPI 服务，提供模型、MCP、技能、记忆、上传、任务、渠道等 HTTP API（`backend/app/gateway/`）。 |
| **LangGraph Server** | Agent 运行时与线程状态服务（默认端口 `2024`，由 `langgraph dev` 等启动）。 |
| **Harness** | 可发布的 `evoflow` Python 包，含 Agent、工具、沙箱、MCP、技能等（`backend/packages/harness/evoflow/`）。 |
| **App** | 应用层代码，含 Gateway 与 IM 渠道（`backend/app/`）；**禁止**被 harness 反向依赖。 |
| **Thread** | LangGraph 会话线程标识；本地文件与上传目录常按 `thread_id` 隔离。 |
| **Sandbox** | Agent 命令与文件操作的执行环境（本地 / Docker / K8s 等），见 [sandbox-design.md](../explanation/sandbox-design.md)。 |
| **Skill** | `SKILL.md`（含 YAML 头信息）描述的可选能力包，见 [skill-system.md](../explanation/skill-system.md)。 |
| **MCP** | Model Context Protocol，通过 Gateway 配置并供 Agent 侧加载的外部工具协议。 |
| **ACP** | Agent Communication Protocol；通过配置的外部 ACP 适配进程与主 Agent 协作。 |
| **EvoPanel** | 本仓库中的 Tauri 桌面管理端（`evopanel/`），用于聊天、模型、任务等 UI。 |
