# Claude Code 操作指南

> **比如你要重构一个大型代码模块，Chat 模式太慢，Plan 模式又太死板**：
>
> 在聊天里输入 `/claude`，一键切换到 Claude Code 直连模式。你可以：
> - 让 Claude 直接读写项目文件、全局搜索、跑命令
> - 开多个会话并行处理不同任务（比如一个会话重构 API，另一个改测试）
> - 编码完成后切回主智能体，让它做总结、推送到飞书
>
> 适合大段代码重构、多文件改造、依赖升级、调试 bug 等需要长时间交互的编码场景。
>
> **功能关系**：Claude Code 是 EvoFlow 主智能体的编码增强模式——它不加载 EvoFlow 的技能/MCP/记忆生态，专注于代码操作；可与[Plan 模式](plan-mode.md)组合使用（Plan 模式的子任务可调用 Claude Code）；与[工作空间场景](workspace.md)共享同一套工作目录沙箱机制。

EvoFlow 内置 **Claude Code 直连模式**：让 Anthropic Claude 的原生工具链直接接管当前会话，专门处理代码编辑、命令执行、多文件操作、架构设计等软件开发任务。与 EvoFlow 主智能体相比，Claude Code 模式更专注、更少中间层，适合**长时间、重交互的编码场景**。

---

## 何时启用 Claude Code

适合 Claude Code 模式的场景：

- 大段代码编辑、重构、多文件协同改造
- 仓库级问题排查（结合阅读源码、跑测试、看日志）
- 项目脚手架搭建、依赖升级、构建流水线调优
- 调试已知 bug：贴上日志或截图后让 Claude Code 直接动手

不建议使用 Claude Code 的场景：

- 纯聊天、知识问答 → 用主智能体的「日常对话」
- 需要多角色协作的项目交付 → 用 [Plan 模式](plan-mode.md) 调度项目团队
- 需要 EvoFlow 的技能/MCP/记忆生态 → 用主智能体，Claude Code **不会自动加载 EvoFlow 技能与 MCP**

---

## 启用与关闭

### 桌面端（EvoFlow）

在聊天窗口发送以下斜杠指令：

| 指令 | 行为 |
|------|------|
| `/claude` 或 `/claude-code` | 当前会话切到 Claude Code 直连模式 |
| `/lead` 或 `/main` | 关闭 Claude Code，切回 EvoFlow 主智能体 |

启用后会话顶部会出现「Claude Code」标签，所有后续消息都由 Claude Code 直接处理，无需在 Composer 中额外勾选模型或工具。

### 飞书 / IM 端

在已绑定 EvoFlow 的飞书会话中同样可用：

1. 发送 `/claude` 开启 Claude Code 直连
2. 直接描述需求或贴代码片段，Claude Code 在沙箱内编辑文件、跑命令并回复结果
3. 发送 `/lead` 切回主智能体

---

## 工具能力清单

Claude Code 模式下可用的工具集（与主智能体的「工作空间」场景重叠但更聚焦）：

| 类别 | 工具 |
|------|------|
| **文件操作** | `Read`、`Write`、`Edit`、`MultiEdit`、`NotebookEdit` |
| **检索** | `Grep`、`Glob` |
| **命令** | `Bash`（含后台任务） |
| **联网** | `WebFetch`、`WebSearch` |
| **任务管理** | `TodoWrite`（Claude Code 原生 Todo 面板） |
| **代理** | `Task`（派生子代理） |

文件读写默认限定在当前工作目录树内（与主智能体的沙箱机制一致）。

---

## 多会话并行

Claude Code 支持**同一 EvoFlow 内并行多个会话**：

- 每个会话拥有独立的 Claude Code session_id，上下文互不污染
- 适合把大型重构拆成多个子任务并行推进（如：A 会话改后端、B 会话改前端、C 会话写测试）
- 不同会话可绑定不同工作目录，避免相互覆盖

会话切换通过 EvoFlow 左侧会话列表即可，无需重新 `/claude`。

---

## 与主智能体协作

实际开发常见组合：

| 场景 | 推荐路径 |
|------|---------|
| 需求拆解 + 多角色协作 | **主智能体 Plan 模式** 派发，再由其中一个子任务调用 Claude Code |
| 单人长链编码 | 直接 `/claude` 全程 |
| 拿到 Claude Code 结果后做总结/通知 | `/lead` 切回主智能体，再用 IM 推送 |

> Claude Code 完成后**不会自动落记忆**——若需要把结论沉淀，需切回主智能体让 MemoryMiddleware 处理。

---

## 常见问题

**Q：发送 `/claude` 后没有反应？**
检查面板设置 → 模型 Tab，确认已配置 Anthropic 服务商（或 OpenRouter 等 Claude 兼容网关）且测试连接通过。

**Q：Claude Code 改的文件能不能撤销？**
推荐每次重大改动前先 `git stash` 或建分支；EvoFlow 不会自动拍快照。

**Q：Claude Code 会不会用我的记忆与项目配置？**
不会。Claude Code 是**独立 SDK 会话**，仅继承当前工作目录；EvoFlow 记忆、技能、MCP 仅供主智能体使用。

---

## 相关阅读

- [工作空间场景](workspace.md)
- [Plan 模式](plan-mode.md)
- [工具与 MCP](../configuration/tools-mcp.md)
- [Claude Code 持续协作（案例）](../../cases/claude-code-continuous.md)
