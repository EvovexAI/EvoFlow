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

## 产品能力（面板侧栏）

| 术语 | 含义 |
|------|------|
| **智能体** | 「会什么」：人设、工具、技能、MCP。侧栏 `#/expert`。见 [智能体管理](../guides/configuration/agent-management.md)。 |
| **智能体员工** | 「何时主动干」：把智能体雇成岗位（职责、工作区、心跳、审批、交班）。侧栏 `#/proactive`。见 [智能体员工](../guides/configuration/smart-employees.md)。 |
| **值班 / 值班台** | 全局开关：开启后在岗员工按上岗节奏自动心跳巡检。 |
| **交接审批策略** | 岗位上的人闸档位：全自动 / 平衡型 / 谨慎型（口语有时称「自主权」）。 |
| **工作项** | 员工岗位上的一件事（看板：待办→执行中→已完成/失败）。 |
| **待审批** | **开工前**或**交接派发前**须你同意的事项（可「同意」或「同意派发」）。 |
| **交工待验收** | 员工交工后等你确认；在工作项详情处理，任务中心也有「待确认」。 |
| **任务总结** | 交工时的交付说明（做了什么、交付了什么、如何验收）。 |
| **本轮小结** | 值班一轮结束时的 wrap_up 小结；失败时可见「自动交班·未完成」。 |
| **工作轨迹** | 某轮值班/委派的工具调用与对话过程；需要细节时再打开。 |
| **摸鱼中** | 连续多轮无明显产出或空转偏高的状态提示；先看健康与工作轨迹。 |
| **系统前台** | 安装自带岗，偏催办全局待办。 |
| **小V** | 全局助手：一员工一会话委派、工作台、会议、飞书绑定。 |
| **任务中心** | 跨来源任务驾驶舱（对话 / 智能体员工 / 工作流）。侧栏 `#/tasks`。 |
| **应用 / 应用中心** | 已跑通的可填参再跑工作流产品。侧栏 `#/apps`。见 [应用中心](../guides/configuration/app-center.md)。 |
| **自动化** | 到点跑固定 Prompt（Cron），不是岗位合同。侧栏 `#/cron`。 |

## 技术与运行时

| 术语 | 含义 |
|------|------|
| **Gateway** | FastAPI 服务，提供模型、MCP、技能、记忆、上传、任务、渠道等 HTTP API（`backend/app/gateway/`）。 |
| **LangGraph Server** | Agent 运行时与线程状态服务（默认端口 `2024`，由 `langgraph dev` 等启动）。 |
| **Harness** | 可发布的 `evoflow` Python 包，含 Agent、工具、沙箱、MCP、技能等（`backend/packages/harness/evoflow/`）。 |
| **App** | 应用层代码，含 Gateway 与 IM 渠道（`backend/app/`）；**禁止**被 harness 反向依赖。与面板「应用中心」的「应用」不是同一概念。 |
| **Thread** | LangGraph 会话线程标识；本地文件与上传目录常按 `thread_id` 隔离。 |
| **Sandbox** | Agent 命令与文件操作的执行环境（本地 / Docker / K8s 等），见 [沙箱模式配置](../guides/configuration/sandbox-config.md)。 |
| **Skill** | `SKILL.md`（含 YAML 头信息）描述的可选能力包，见 [skill-system.md](../explanation/skill-system.md)。 |
| **MCP** | Model Context Protocol，通过 Gateway 配置并供 Agent 侧加载的外部工具协议。 |
| **ACP** | Agent Communication Protocol；通过配置的外部 ACP 适配进程与主 Agent 协作。 |
| **EvoFlow（桌面/Web）** | 面向用户的桌面与 Web 界面；仓库源码目录为 `evopanel/`。 |
