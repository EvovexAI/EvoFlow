# 配置你的第一个模型

> **没有模型，EvoFlow 什么都干不了。你得先接一个 AI 模型。**
>
> 比如你用 DeepSeek：
> 1. 去 DeepSeek 官网申请一个 API Key
> 2. 打开 **设置 → 模型 → 对话模型**，**+ 添加服务商**，选 DeepSeek，填上 Key
> 3. **+ 添加模型**，再把要用的设为 **主模型**
>
> 之后聊天、任务、自动化全用这个模型。你也可以加多个模型，比如让"写代码"用 Claude、"聊天"用 DeepSeek，不同角色用不同模型。

## 你将学到什么

- 在 EvoFlow 中添加对话模型
- 配置 OpenAI 兼容服务商
- 设置主模型与 `max_tokens`

## 前置条件

- 已完成 [安装](../getting-started/installation.md) [[getting-started/installation|安装]]
- Gateway 已启动（模型写入 SQLite `evoflow.db`）

## 预计用时

10 分钟

## 说明

**对话模型不再写在 `config.yaml`。** 运行时只从 SQLite（`evoflow_models` 表）读取；`config.yaml` 里的 `models:` 会被忽略。

## 步骤

### 1. 打开模型设置

左下角齿轮 → **模型**（`#/settings?tab=models`），确认在 **对话模型** Tab。

### 2. 添加服务商与模型

1. **+ 添加服务商**，选预设或填自定义接口地址与 API Key（本机服务可留空密钥）。
2. **+ 添加模型**，勾选模型 ID。
3. 设为 **主模型**。顶栏应显示该名称，而不是「未配置」。

向量模型、语音、套餐是同页另外三个 Tab。知识库要用的嵌入在 **向量模型**。完整对照见 [模型、联网搜索、插件与 Agent 应用](../guides/configuration/settings-capabilities.md)。

### 3. 验证

新开对话发一句。失败时先看该服务商密钥是否「已配置」，以及主模型是否指到刚添加的那条。

## 多模型切换

在聊天会话侧栏或会话设置中选择模型；底层通过模型 `name` 解析到 SQLite 中的配置行。

## 常见问题

**回复写到一半停了、`output_tokens` 正好 8192？**  
把该模型的 **`max_tokens` 调大**（思考模式会占用输出预算）。

**旧版 `config.yaml` 里还有 models 块？**  
可删除；保留也会被启动逻辑忽略。一次性迁移可用 `sync_models_from_yaml_to_db`（见 `evoflow.persistence.bootstrap`）。

## 下一步

- [工具与 MCP](../guides/configuration/tools-mcp.md) [[guides/configuration/tools-mcp|工具与 MCP]]
- [完成第一个任务](../getting-started/first-task.md) [[getting-started/first-task|完成第一个任务]]


---

## 相关阅读

- [[getting-started/product-overview|产品总览]] — 功能地图与典型路径
- [[getting-started/installation|安装指南]] — 环境准备
- [[explanation/agent-system|Agent 系统架构]] — 核心执行单元
- [[tutorials/add-skill|添加自定义技能教程]] — 扩展能力
- [[tutorials/create-agent|创建自定义 Agent 教程]] — 角色配置
