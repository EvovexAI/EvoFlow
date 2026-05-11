# EvoPanel 桌面端使用指南

## 适用场景
通过 EvoPanel 桌面客户端与 EvoFlow 交互，提供完整的 GUI 界面来管理对话、Agent、任务和集成。

## 前置条件
- EvoFlow 后端已运行（localhost:2026）
- 已安装 EvoPanel（Tauri v2 桌面应用）

## 什么是 EvoPanel

EvoPanel 是基于 Tauri v2 构建的桌面客户端，为 EvoFlow 提供图形化交互界面。包含 AI 对话、Agent 管理、任务中心、多代理协作、技能与 IM 管理等完整功能。

## AI 助手

### 四种对话模式

| 模式 | thinking_enabled | is_plan_mode | subagent_enabled | 适用场景 |
|------|-------------------|--------------|-------------------|----------|
| Chat | false | false | false | 快速问答 |
| Plan | true | true | false | 规划分析 |
| Execute | true | false | true | 任务执行 |
| Infinite | true | true | true | 复杂多步骤任务 |

### 实时聊天

- 流式响应，逐字显示 AI 回复
- Markdown 渲染（代码高亮、表格、数学公式）
- 多模态支持（图片理解、文件上传）
- 工具调用过程可视化

## 模型配置

通过模型配置 UI 可：
- 选择当前使用的模型
- 配置模型的 thinking/vision 开关
- 添加新的模型提供商（OpenAI、Anthropic、Google、DeepSeek 等）
- 设置基础 URL 和 API Key

## 任务中心

- **创建任务**：从模板或自定义创建自动化任务
- **监控执行**：实时查看任务执行状态和输出
- **批量操作**：批量启动/暂停/删除任务
- **执行历史**：查看过往执行记录和结果

## 多代理协作

### 项目管理

- 创建项目，组织多个 Agent 协同工作
- 配置 Supervisor 主管 Agent，负责任务分配和协调
- 每个项目有独立的会话和上下文

### Agent 管理

- **SOUL/IDENTITY 编辑**：自定义 Agent 的人格和身份描述
- **模型配置**：为不同 Agent 分配不同的模型
- **工具集配置**：控制每个 Agent 可用的工具
- **记忆隔离**：每个 Agent 有独立的记忆文件

## 工具与技能管理

- 浏览已加载的技能（`skills/public/` 和 `skills/custom/`）
- 启用/禁用单个技能
- 从 `.skill` 归档安装新技能
- 管理 MCP 服务器的启用状态

## IM 渠道管理

- 配置飞书、钉钉、Telegram、Slack、Discord、QQ 等消息渠道
- 查看各渠道连接状态
- 管理渠道会话和线程映射

## 定时任务

- 创建 cron 调度的自动化任务
- 配置 LangGraph 执行和飞书推送
- 选择线程模式（fresh/sticky）

## 记忆管理

- 查看全局和按 Agent 分类的记忆数据
- 手动编辑或删除特定事实
- 导入/导出 `memory.json` 文件
- 配置外部记忆插件

## 主题与本地化

- 支持亮色/暗色主题切换
- 多语言界面（中文、英文、日语、韩语、法语、德语、西班牙语、葡萄牙语、俄语、越南语等）

## 验证是否生效

1. 启动 EvoPanel 应用
2. 确认连接状态指示器显示已连接到 EvoFlow（localhost:2026）
3. 发送一条测试消息，确认 AI 正常响应

## 常见问题

**Q: EvoPanel 无法连接到 EvoFlow？**
确认后端已运行（`make dev` 或 `make docker-start`）。检查连接设置中的 URL 是否正确。

**Q: 修改了 Agent 配置后不生效？**
部分配置修改后需要重置 Agent 或新建会话才能生效。

**Q: 定时任务不执行？**
确认定时任务引擎已启动。Gateway 默认运行调度循环，可通过 `EVOFLOW_AUTOMATION_SCHEDULER=0` 关闭。

**Q: 如何备份 EvoPanel 数据？**
EvoPanel 数据存储在 `~/.evoflow/` 目录下。备份该目录即可保留所有任务配置和本地设置。

## 相关文档
- [自动化任务调度](./automation-scheduler.md)
- [IM 消息渠道配置](./im-channels.md)
- [记忆管理](./memory-management.md)

---

**最后验证**：2026-05-10；适用范围：默认分支。
