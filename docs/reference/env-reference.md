# .env 环境变量参考

## 概述

`.env` 文件位于项目根目录，用于存储敏感信息（API 密钥等）。以 `$ENV_VAR` 形式在 `config.yaml` 中引用。

## 模型 API 密钥

| 变量 | 说明 | 示例 |
|------|------|------|
| `OPENAI_API_KEY` | OpenAI API 密钥 | `sk-...` |
| `ANTHROPIC_API_KEY` | Anthropic API 密钥 | `sk-ant-...` |
| `GEMINI_API_KEY` | Google Gemini API 密钥 | `AIza...` |
| `DEEPSEEK_API_KEY` | DeepSeek API 密钥 | `sk-...` |
| `DASHSCOPE_API_KEY` | 阿里 DashScope API 密钥 | `sk-...` |
| `MOONSHOT_API_KEY` | Moonshot (Kimi) API 密钥 | `sk-...` |
| `NOVITA_API_KEY` | Novita AI API 密钥 | `nv-...` |
| `MINIMAX_API_KEY` | MiniMax API 密钥 | `eyJ...` |
| `VOLCENGINE_API_KEY` | 火山引擎 / 既梦 生图生视频 | — |
| `ARK_API_KEY` | 火山方舟（与 VOLCENGINE 二选一） | — |
| `AGNES_API_KEY` | Agnes AI 生图/生视频（或 `AGNES_API_TOKEN` / `APIHUB_AGNES_API_KEY`） | — |
| `GITHUB_TOKEN` | GitHub API Token | `ghp_...` |

## 搜索与工具

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `TAVILY_API_KEY` | Tavily 搜索 API 密钥 | — |
| `JINA_API_KEY` | Jina Web Fetch API 密钥 | — |
| `FIRECRAWL_API_KEY` | Firecrawl 爬取 API 密钥 | — |
| `INFOQUEST_API_KEY` | InfoQuest 搜索 API 密钥 | — |

## IM 渠道

| 变量 | 说明 |
|------|------|
| `FEISHU_APP_ID` | 飞书应用 ID |
| `FEISHU_APP_SECRET` | 飞书应用密钥 |
| `EVOFLOW_FEISHU_PUSH_SECRET` | 飞书主动推送密钥 |
| `SLACK_BOT_TOKEN` | Slack Bot Token（xoxb-） |
| `SLACK_APP_TOKEN` | Slack App Token（xapp-） |
| `TELEGRAM_BOT_TOKEN` | Telegram Bot Token |

## 自动化调度

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `EVOFLOW_AUTOMATION_SCHEDULER` | `1` | `0` 禁用调度器 |
| `EVOFLOW_AUTOMATIONS_DIR` | `~/.evoflow/tasks/automations` | 任务目录 |
| `EVOFLOW_AUTOMATION_TICK_SECONDS` | `30` | 扫描间隔 |
| `EVOFLOW_AUTOMATION_LANGGRAPH_TIMEOUT` | `600` | LangGraph 超时 |
| `EVOFLOW_AUTOMATION_LANGGRAPH_MAX_CONCURRENT` | `2` | 最大并发数 |
| `EVOFLOW_AUTOMATION_LANGGRAPH_RECURSION_LIMIT` | `800` | 递归限制 |
| `EVOFLOW_AUTOMATION_PLAN_MODE` | `0` | 是否启用 plan 模式 |
| `EVOFLOW_AUTOMATION_CHAT_LINK_TEMPLATE` | — | 飞书链接模板 |

## LangGraph 运行时

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `EVOFLOW_LONG_RUN_WALL_SECONDS` | `14400` | Plan/主会话/子智能体长跑墙钟（4h） |
| `EVOFLOW_LONG_RUN_STREAM_READ_SECONDS` | 同墙钟 | Gateway→LangGraph `runs/stream` HTTP 读超时 |
| `EVOFLOW_LONG_RUN_RECURSION_LIMIT` | `2500` | 主图 `recursion_limit` 上限 |
| `EVOFLOW_SUBAGENT_RECURSION_LIMIT_MAX` | `3000` | 子智能体 `recursion_limit` 推导封顶 |
| `BG_JOB_ISOLATED_LOOPS` | — | 设为 `true` 启用事件循环隔离 |
| `N_JOBS_PER_WORKER` | `10` | 每个 worker 的并发 job 数 |
| `DEER_FLOW_CONFIG_PATH` | — | 自定义 config.yaml 路径 |
| `DEER_FLOW_EXTENSIONS_CONFIG_PATH` | — | 自定义 extensions_config.json 路径 |
| `DEER_FLOW_CHANNELS_LANGGRAPH_URL` | `http://localhost:2024` | IM 渠道 LangGraph URL |
| `DEER_FLOW_CHANNELS_GATEWAY_URL` | `http://localhost:8001` | IM 渠道 Gateway URL |

## 日志

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `LOG_LEVEL` | `info` | 全局日志级别 |
| `EVOFLOW_LOGS_DIR` | 项目根目录 `logs/` | Gateway 日志目录 |
| `EVOFLOW_GATEWAY_LOG_LEVEL` | 同 `LOG_LEVEL` | Gateway 日志级别 |

## LangSmith 追踪

| 变量 | 说明 |
|------|------|
| `LANGSMITH_TRACING` | 设为 `true` 启用 |
| `LANGSMITH_ENDPOINT` | `https://api.smith.langchain.com` |
| `LANGSMITH_API_KEY` | LangSmith API 密钥 |
| `LANGSMITH_PROJECT` | 项目名称 |

## 安全护栏

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `EVOFLOW_GUARDRAILS_DENY_EXECUTE_COMMAND` | `0` | 设为 `1` 保留 execute_command 在 denied_tools |

## 其他

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `EVOFLOW_MISSION_STATE_ENABLED` | `0` | 设为 `1` 启用后台 Mission State 分析器 |
| `CORS_ORIGINS` | — | 允许的 CORS 源（逗号分隔） |

## 相关参考

- [config.yaml 配置参考](config-reference.md)
