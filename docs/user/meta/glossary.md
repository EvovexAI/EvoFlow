# 术语表

> **比如你看到"Agent 的 SOUL 是什么？"不用慌，看看这里**：
>
> - **Agent**：就是 AI 角色，有自己的性格、工具和技能。比如"Python 数据分析师"是一个 Agent
> - **SOUL**：角色的人设设定。比如"你是 Python 数据分析师，偏好 Pandas，讨厌冗余代码"
> - **Plan**：一种聊天模式，AI 先出方案，你确认后再执行
> - **Goal**：一种后台任务模式，设定目标后 AI 自己跑，不用你管
> - **MCP**：让 AI 能调用外部服务的接口（比如 GitHub API、Notion）
> - **Supervisor**：负责拆解任务、分配子 AI 的总控指挥官
>
> 阅读其他文档时遇到不熟悉的术语，随时回来查。

| 术语 | 含义 |
|------|------|
| **Gateway** | FastAPI 服务，提供模型、MCP、技能、记忆、上传、任务、渠道等 HTTP API（`backend/app/gateway/`）。 |
| **LangGraph Server** | Agent 运行时与线程状态服务（默认端口 `2024`，由 `langgraph dev` 等启动）。 |
| **Harness** | 可发布的 `evoflow` Python 包，含 Agent、工具、沙箱、MCP、技能等（`backend/packages/harness/evoflow/`）。 |
| **App** | 应用层代码，含 Gateway 与 IM 渠道（`backend/app/`）；**禁止**被 harness 反向依赖。 |
| **Thread** | LangGraph 会话线程标识；本地文件与上传目录常按 `thread_id` 隔离。 |
| **Sandbox** | Agent 命令与文件操作的执行环境（本地 / Docker / K8s 等），见 [沙箱模式配置](../guides/configuration/sandbox-config.md)。 |
| **Skill** | `SKILL.md`（含 YAML 头信息）描述的可选能力包，见 [skill-system.md](../explanation/skill-system.md)。 |
| **MCP** | Model Context Protocol，通过 Gateway 配置并供 Agent 侧加载的外部工具协议。 |
| **ACP** | Agent Communication Protocol；通过配置的外部 ACP 适配进程与主 Agent 协作。 |
| **EvoFlow（桌面/Web）** | 面向用户的桌面与 Web 界面；仓库源码目录为 `evopanel/`。 |
