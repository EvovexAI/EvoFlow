# 配置你的第一个模型

> **没有模型，EvoFlow 什么都干不了。你得先接一个 AI 模型。**
>
> 比如你用 DeepSeek：
> 1. 去 DeepSeek 官网申请一个 API Key
> 2. 打开 **设置 → 模型 → 对话模型**，**+ 添加服务商**，选 DeepSeek，填上 Key
> 3. **+ 添加模型**，再把要用的设为 **主模型**
>
> 之后聊天、任务、自动化全用这个模型。你也可以加多个模型，比如让「写代码」用 Claude、「聊天」用 DeepSeek，不同角色用不同模型。

## 你将学到什么

- 在 EvoFlow 中添加对话模型（API Key 或 ChatGPT / Codex 账号登录）
- 配置 OpenAI 兼容服务商
- 设置主模型；知道同页还有生图生视频 / 向量 / 语音 / 套餐

## 前置条件

- 已完成 [安装](../getting-started/installation.md) [[getting-started/installation|安装]]
- Gateway 已启动（模型写入 SQLite `evoflow.db`）

## 预计用时

10 分钟

## 说明

**对话模型不再写在 `config.yaml`。** 运行时只从 SQLite（`evoflow_models` 表）读取；`config.yaml` 里的 `models:` 会被忽略。

模型页共五个 Tab：**对话模型 · 生图生视频 · 向量模型 · 语音 · 套餐**。第一次只要先把 **对话模型** 跑通。

## 步骤

### 1. 打开模型设置

左下角齿轮 → **模型**（`#/settings?tab=models`），确认在 **对话模型** Tab。

### 2. 添加服务商与模型（API Key）

1. **+ 添加服务商**，选预设或填自定义接口地址与 API Key（本机服务可留空密钥）。
2. **+ 添加模型**，勾选模型 ID。
3. 设为 **主模型**。顶栏应显示该名称，而不是「未配置」。

### 3. 可选：ChatGPT / Codex 账号登录

若服务商是 **OpenAI**，卡片上有 **ChatGPT / Codex 账号登录**：

1. 点 **授权登录**（浏览器验证），或 **使用本机 Codex CLI**（导入 `~/.codex/auth.json`）。
2. 登录成功后点 **添加 Codex 模型并可用**。
3. 调用走 Codex **订阅额度**，与上方 API Key（按量走 api.openai.com / 兼容网关）互不替代。

没有 ChatGPT / Codex 订阅时，用任意兼容端点 + API Key 即可（DeepSeek、Kimi、本机 Ollama 等）。

### 4. 验证

新开对话发一句。失败时先看该服务商密钥是否「已配置」、Codex 是否「已连接」，以及主模型是否指到刚添加的那条。

### 5. 其他 Tab（按需）

| Tab | 用途 |
|-----|------|
| **生图生视频** | 文生图 / 视频等渠道 Key |
| **向量模型** | 知识库嵌入；可到「套餐」补齐或手动添加 |
| **语音** | 语音相关渠道 |
| **套餐** | Agent Plan 绑定与目录补齐 |

完整对照见 [模型、联网搜索、插件与 Agent 应用](../guides/configuration/settings-capabilities.md)。

## 多模型切换

在聊天会话侧栏或会话设置中选择模型；底层通过模型 `name` 解析到 SQLite 中的配置行。员工 / 工作流节点也可覆盖本步模型。

## 常见问题

**回复写到一半停了、`output_tokens` 正好 8192？**  
把该模型的 **`max_tokens` 调大**（思考模式会占用输出预算）。

**旧版 `config.yaml` 里还有 models 块？**  
可删除；保留也会被启动逻辑忽略。一次性迁移可用 `sync_models_from_yaml_to_db`（见 `evoflow.persistence.bootstrap`）。

**ChatGPT Plus 能不能当 API Key 用？**  
网页 Plus ≠ API。要用订阅额度走 **ChatGPT / Codex 账号登录**；要用按量 API 仍需 OpenAI API Key 或兼容网关。

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
