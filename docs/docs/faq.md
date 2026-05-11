# 常见问题

## 安装与启动

### 运行 `make dev` 前需要什么？

确保已安装以下依赖：
- Python 3.12+（后端）
- Node.js 18+（EvoPanel 前端）
- uv（Python 包管理器）

首次运行建议先执行 `make install` 安装所有依赖。

### `make dev` 和 `make start` 有什么区别？

| 命令 | 模式 | 热重载 | 适用场景 |
|------|------|--------|----------|
| `make dev` | 开发模式 | 是 | 日常开发 |
| `make start` | 生产模式 | 否 | 部署测试 |

### 启动后端口被占用怎么办？

EvoFlow 使用以下端口：

| 端口 | 服务 |
|------|------|
| 2024 | LangGraph Server |
| 8001 | Gateway API |
| 1420 | EvoPanel 开发 |
| 8002 | Provisioner（可选） |

运行 `make stop` 停止所有服务后重试。如果端口仍被占用，检查是否有其他进程占用这些端口。

### 如何在后台运行？

使用 `make dev-daemon` 在后台启动所有服务。使用 `make stop` 停止。

## 模型配置

### 支持哪些模型？

EvoFlow 支持 OpenAI、Anthropic Claude、Google Gemini、DeepSeek、阿里 DashScope、Moonshot (Kimi)、MiniMax、火山引擎等主流模型。在 `config.yaml` 的 `models` 列表中配置。

### 如何切换模型？

在 EvoPanel 界面中选择模型，或通过运行时参数 `model_name` 指定。

### thinking 模式是什么？

某些模型（如 Claude）支持扩展思考模式（`thinking_enabled: true`），让模型在回答前进行深度推理。这会增加响应时间但提高质量。

### vision 模式是什么？

当模型支持视觉（`supports_vision: true`）时，Agent 可以使用 `view_image` 工具查看图片。这需要在 `config.yaml` 中正确标记模型能力。

## Docker 与沙箱

### 本地沙箱和 Docker 沙箱有什么区别？

| 模式 | 隔离级别 | 适用场景 |
|------|----------|----------|
| 本地 | 仅路径隔离 | 单用户、可信环境 |
| Docker | 容器隔离 | 开发、测试、多用户 |
| Kubernetes | Pod 隔离 | 生产环境 |

### 沙箱容器镜像下载很慢怎么办？

运行 `make setup-sandbox` 预拉取沙箱容器镜像。这会在启动前提前下载镜像，避免首次使用时的等待时间。

### 容器沙箱最大并发数是多少？

默认 3。达到上限时，最久未使用的容器会被 LRU 淘汰。

## IM 消息渠道

### 对接飞书需要什么？

在 `config.yaml` 中配置飞书渠道，设置以下环境变量：
- `FEISHU_APP_ID`：飞书应用 ID
- `FEISHU_APP_SECRET`：飞书应用密钥

飞书渠道通过 outbound 连接（WebSocket），无需公网 IP。

### 支持哪些 IM 平台？

飞书、钉钉、Telegram、Slack、Discord、QQ。

### 如何同时支持多个渠道？

在 `config.yaml` 的 `channels` 中配置多个渠道，每个渠道独立配置 App ID 和密钥。

## 记忆系统

### 记忆存储在哪里？

全局记忆存储在 `backend/.evo-flow/memory.json`，按线程隔离的记忆存储在各 `threads/{thread_id}/` 目录下。

### 如何清除记忆？

直接删除或编辑 `backend/.evo-flow/memory.json` 文件，重启服务后生效。

### Agent 能记住上一次对话吗？

可以。记忆系统会自动从对话中提取关键事实并持久化。下次对话时，相关记忆会注入系统提示中。

## 技能与 Agent

### 如何添加自定义技能？

1. 在 `skills/custom/` 下创建目录
2. 在目录中创建 `SKILL.md` 文件
3. 在 `extensions_config.json` 中启用

或通过 API 安装 `.skill` 压缩包。

### 如何创建自定义 Agent？

通过 API 创建：
```bash
curl -X POST http://localhost:8001/api/agents \
  -H "Content-Type: application/json" \
  -d '{"agent_code": "my-agent", "agent_name": "我的Agent", "description": "..."}'
```

创建后在 `agents/my-agent/` 目录下配置 `config.yaml` 和 `SOUL.md`。

### 子 Agent 是什么？

子 Agent 是主 Agent 委派任务的机制。主 Agent 可以将任务拆分，委派给多个子 Agent 并行执行，最后综合结果。

## 自动化调度

### 如何创建定时任务？

在自动化调度器中配置 cron 或 rrule 表达式，指定触发时间和任务内容。支持飞书推送通知。

### 调度器默认启用吗？

默认启用。设置 `EVOFLOW_AUTOMATION_SCHEDULER=0` 可禁用。

## 其他

### `config.yaml` 和 `extensions_config.json` 有什么区别？

- `config.yaml`：主配置文件，定义模型、沙箱、工具、渠道等
- `extensions_config.json`：扩展配置文件，控制 MCP 服务器和技能的启用/禁用状态

### 如何查看 API 文档？

启动服务后访问 `http://localhost:8001/docs` 查看 FastAPI 自动生成的 Swagger UI。

### 如何贡献代码？

参见项目 `CONTRIBUTING.md` 文件。

### 许可证是什么？

MIT 许可证。版权由 ByteDance 和 EvoFlow Authors 共同持有。
