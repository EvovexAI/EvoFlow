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
| **智能体** | 「会什么」：人设、模型、工具、技能、连接器（MCP）、知识库能力。侧栏 `#/expert`。见 [智能体管理](../guides/configuration/agent-management.md)。 |
| **员工 / 智能体员工** | 「何时主动干」：岗位名、职责、部门与上级、绑定知识库、工作空间、转交审批、上班时间表、预算。侧栏 `#/proactive`，按钮是 **加人**。见 [智能体员工](../guides/configuration/smart-employees.md)。 |
| **连接器** | 智能体页里的 MCP 插件。先在 `#/tools` 添加并启用，再在某个智能体上勾选。员工不单独装连接器。 |
| **知识库** | 自有文档库：上传、检索、问 AI、Wiki、图谱。`#/knowledge`。绑到员工后上班可引用。见 [知识库](../guides/configuration/knowledge-base.md)。 |
| **自动上班（总开关）** | 页头开关：开启后，在岗员工按上班频率自动干活。 |
| **上班频率** | 多久自动来一轮（如每 30 分钟、每小时）。 |
| **交接审批策略** | 岗位档位：全自动 / 平衡型 / 谨慎型；主要决定正式转交同事前要不要你点「同意派发」。 |
| **同意派发** | 审批按钮：同意后叫醒下级继续干（不是普通「同意」）。 |
| **待闭环** | 本岗已交活，整单还等下游或收束。 |
| **工作项** | 员工岗位上的任务（待开始→执行中→待闭环/已完成/失败）。 |
| **待审批** | 待你处理的审批；常见是转交前的同意派发，少数是事项同意。 |
| **交工待验收** | 干完后等人确认结果（确认完成 / 打回）；与「同意派发」不同。 |
| **任务总结** | 交活时的交付说明（做了什么、交付了什么、如何验收）。 |
| **同事跨岗派发** | 派活/叫醒：任意在岗同事（含同级）都可。 |
| **本轮工作汇报** | 一轮下班小结；失败时可见「本轮汇报未写完」。 |
| **工作过程** | 某轮里具体怎么干的（工具调用与对话）；需要细节时再打开。 |
| **近期没干活** | 连续多轮无明显产出或空转偏高。 |
| **卡住执行** | 执行超过约 45 分钟仍未结束（健康页）。 |
| **系统前台** | 安装自带岗，偏催办全局待办。 |
| **小V** | 全局 AI 小秘书：待办管理、任务派发、进度查询、结果反馈与跨员工协调；一员工一会话委派、飞书绑定。**不是**某个 AI 员工。见 [任务中心概念](../explanation/task-center.md)。 |
| **任务中心** | 用户待办 + AI 员工任务协作 + 执行追踪 + 结果交付的协同中心（对话 / 员工 / 工作流 / 自动化等）。侧栏 `#/tasks`。见 [概念](../explanation/task-center.md) · [操作](../guides/tasks/task-center.md)。 |
| **我的事项（用户待办）** | 用户需要完成或关注的事；可自办或经小V / 派发转为协作任务。任务中心 `#/tasks?tab=items`。**不是**执行任务本身。 |
| **协作任务（执行任务）** | 交给 AI 员工或流程处理的正式账：含用户派发、小V 分配、员工间 / 上下级派发与汇报。 |
| **工作流（旧名：应用中心）** | 已跑通的可填参再跑工作流产品，侧栏现名「工作流」。侧栏 `#/apps`。见 [工作流](../guides/configuration/app-center.md) [[guides/configuration/app-center|工作流]]。注意与任务详情里的执行流程图 `#/workflow/:id` 区分。与任务中心联动含启动与进度 / 结果查询，**不含**业务参数传递能力位。 |
| **Agent 应用 / Agent 应用中心** | 业务应用承载 + AI 底座连接：统一列表挂载静态页 / 服务器 Web / 本地服务 / 第三方嵌入，点击在面板内打开；可进一步集成工作流、AI 员工、知识库。侧栏 `#/extensions`。见 [概念](../explanation/agent-applications.md) · [操作](../guides/configuration/settings-capabilities.md)。**不是**工作流（旧名「应用中心」）。 |
| **资产中心** | 统一管理记忆、画像、思考、反思与经验。用户记忆 ∥ 各 AI 员工独立记忆；**用户画像**可授权给员工复用；员工记忆互不共享。主 Agent 沉淀归用户侧。侧栏 `#/assets`。见 [概念](../explanation/asset-center.md)。 |
| **用户画像** | 用户资产中的可共享认识（偏好、工作要求等）；AI 员工在授权范围内可读，用于统一服务风格。与员工各自的工作记忆不是一回事。 |
| **chip（小条）** | 界面上显示当前值、可点击切换的小控件。如左下角「当前工作目录」小条，点它弹出文件夹选择器来绑定工作目录。见 [工作空间](../guides/chat/workspace.md)。 |
| **自动化 / 自动化中心** | 到点执行的两种模式：**自动化任务**（提示词 + 可选在编员工/智能体）与 **定时自动化**（已发布工作流）。侧栏 `#/cron`。**不是**员工主动值班。见 [概念](../explanation/automation-center.md) · [操作](../guides/tasks/scheduled-tasks.md)。 |
| **自动化任务** | 提示词驱动：编写 Prompt、选择执行 Agent/员工、按计划执行。 |
| **定时自动化** | 工作流驱动：选择已发布工作流、配置定时规则、到点触发预设流程（无「业务参数传递」能力位）。 |

## 技术与运行时

| 术语 | 含义 |
|------|------|
| **Gateway** | FastAPI 服务，提供模型、MCP、技能、记忆、上传、任务、渠道等 HTTP API（`backend/app/gateway/`）。 |
| **LangGraph Server** | Agent 运行时与线程状态服务（默认端口 `2024`，由 `langgraph dev` 等启动）。 |
| **Harness** | 可发布的 `evoflow` Python 包，含 Agent、工具、沙箱、MCP、技能等（`backend/packages/harness/evoflow/`）。 |
| **App** | 应用层代码，含 Gateway 与 IM 渠道（`backend/app/`）；**禁止**被 harness 反向依赖。与面板「工作流（旧名：应用中心）」的「应用」不是同一概念。 |
| **Thread** | LangGraph 会话线程标识；本地文件与上传目录常按 `thread_id` 隔离。 |
| **Sandbox** | Agent 命令与文件操作的执行环境（本地 / Docker / K8s 等），见 [沙箱模式配置](../guides/configuration/sandbox-config.md) [[guides/configuration/sandbox-config|沙箱模式配置]]。 |
| **Skill** | `SKILL.md`（含 YAML 头信息）描述的可选能力包，见 [skill-system.md](../explanation/skill-system.md) [[explanation/skill-system|skill-system.md]]。 |
| **MCP** | Model Context Protocol，通过 Gateway 配置并供 Agent 侧加载的外部工具协议。 |
| **ACP** | Agent Communication Protocol；通过配置的外部 ACP 适配进程与主 Agent 协作。 |
| **EvoFlow（桌面/Web）** | 面向用户的桌面与 Web 界面；仓库源码目录为 `evopanel/`。 |
---

## 相关阅读

- [[getting-started/product-overview|产品总览]] — 功能地图与典型路径
- [[explanation/agent-system|Agent 系统架构]] — 核心执行单元
- [[explanation/agent-applications|Agent 应用中心]] — 业务承载与 AI 集成
- [[explanation/task-center|任务中心]] — 待办、小V、员工协作派发
- [[explanation/automation-center|自动化中心]] — 提示词 Agent / 定时工作流
- [[explanation/smart-employees|智能体员工概念]] — 岗位协作
- [[guides/configuration/agent-management|智能体管理指南]] — 配置与操作
- [[tutorials/configure-models|配置模型教程]] — 模型配置
