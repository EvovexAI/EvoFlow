# 案例七：Claude Code 持续对话

> **比如你要重构一个大型代码模块，Chat 模式太慢，想用 Claude Code 模式**：
>
> 在聊天里输入 `/claude`，切换到 Claude Code 模式。你可以：
> - 让 Claude 直接读写项目文件、全局搜索、跑命令
> - 开多个会话并行处理不同任务
> - 编码完成后再切回主智能体，让它做总结、推送到飞书
>
> Claude Code 可以作为子智能体被 Supervisor 模式（案例八）调用，专注于编码任务。

## 场景说明

EvoFlow 可以调用 Claude Code 实现 AI 辅助编码。你可以在对话中通过 `/claude` 指令唤起 Claude Code，让它在隔离环境中执行编码任务。

参考文档：[集成 Claude Code](../guides/chat/claude-code.md)

## 前置准备

- 已完成[安装](../getting-started/installation.md)
- 已配置至少一个 AI 模型
- 已配置 Claude Code CLI 或 ACP 连接（参考 `config.example.yaml` 中的 `acp_agents` 配置）

## 操作步骤

1. **配置 Claude Code 连接**：通过 CLI 或 ACP 协议完成配置
2. **在对话中唤起 Claude Code**：在 EvoFlow 对话中输入 `/claude` 指令
3. **描述编码任务**：用自然语言描述你要实现的代码功能
4. **查看 Claude Code 执行过程**：观察 Claude Code 在隔离环境中编写代码
5. **获取执行结果**：查看 Claude Code 生成的代码和输出
6. **多轮迭代**：继续对话要求修改或优化代码
7. **将结果整合到项目**：将 Claude Code 的产出合并到主项目
8. **关闭 Claude Code 会话**：完成编码后退出 Claude Code 模式

## 小结

通过 Claude Code 集成，EvoFlow 将 AI 编码助手无缝融入工作流。你可以在对话中随时唤起 Claude Code 完成编码任务，再回到主智能体继续其他工作。

## 相关文档

- [Claude Code 集成](../guides/chat/claude-code.md)
- [Plan 模式](../guides/chat/plan-mode.md)
- [产品总览](../getting-started/product-overview.md)
