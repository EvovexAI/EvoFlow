# 创建自定义 Agent

## 你将学到什么

- 理解 Agent 的配置结构
- 创建一个自定义 Agent
- 为 Agent 配置独立的 SOUL 和模型

## 前置条件

- 已完成 [安装](../getting-started/installation.md)
- 已配置至少一个模型

## 预计用时

10 分钟

## 步骤

### 1. 什么是 Agent

Agent 是 EvoFlow 中具有特定角色和能力的智能体。每个 Agent 可以拥有：
- **SOUL**：定义 Agent 的角色、性格和行为准则
- **IDENTITY**：Agent 的自我认知
- **独立模型配置**：可以覆盖全局默认模型
- **工具集**：可用工具的组合

### 2. 在 EvoPanel 中创建 Agent

1. 打开 EvoPanel，进入 **Agent 管理** 页面
2. 点击 **新建 Agent**
3. 填写 Agent 名称，例如 `research-assistant`
4. 编辑 SOUL 内容，定义 Agent 的角色：

```
你是一个专业的研究助手，擅长信息搜集、分析和报告撰写。
你的回答应该结构清晰、引用准确、逻辑严密。
```

### 3. 配置独立模型（可选）

在 Agent 配置中指定使用的模型，覆盖全局默认值。

### 4. 在聊天中使用 Agent

在 EvoPanel 聊天界面选择对应的 Agent，或通过 IM 渠道发送消息时指定 `agent_name`。

## 验证是否生效

在 Agent 列表中能看到新建的 Agent，发送消息后其 SOUL 会体现在回复风格中。

## 下一步

- [添加自定义技能](add-skill.md) — 扩展 Agent 的能力
- [多智能体协作](multi-agent-collab.md) — 让多个 Agent 协同工作
