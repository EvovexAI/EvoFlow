# config.yaml 完整配置参考

## 概述

`config.yaml` 是 EvoFlow 的主要配置文件，位于项目根目录。所有配置项均可通过环境变量覆盖（以 `$` 开头）。

## 配置加载优先级

1. `config_path` 参数（代码级）
2. `DEER_FLOW_CONFIG_PATH` 环境变量
3. `config.yaml` 在当前目录（backend/）
4. `config.yaml` 在父目录（项目根目录 — **推荐位置**）

## 顶级配置项

| 配置项 | 类型 | 必填 | 默认值 | 说明 |
|--------|------|------|--------|------|
| `config_version` | int | 否 | 0 | 配置 schema 版本号 |
| `log_level` | string | 否 | `info` | 日志级别（debug/info/warning/error） |
| `token_usage` | object | 否 | `{enabled: true}` | Token 用量追踪配置 |
| `tools` | list | 否 | — | 自定义工具配置（运行时以 SQLite 为准） |
| `tool_groups` | list | 否 | — | 工具逻辑分组 |
| `sandbox` | object | 否 | — | 沙箱执行配置 |
| `skills` | object | 否 | — | 技能路径配置 |
| `title` | object | 否 | — | 自动标题生成 |
| `summarization` | object | 否 | — | 上下文摘要压缩 |
| `subagents` | object | 否 | — | 子 Agent 配置 |
| `memory` | object | 否 | — | 记忆系统配置 |
| `channels` | object | 否 | — | IM 消息渠道 |
| `guardrails` | object | 否 | — | 安全护栏配置 |
| `acp_agents` | object | 否 | — | ACP 外部 Agent |

## models（SQLite，不在 config.yaml）

对话模型与 `primary_model` **不再写入** `config.yaml`。运行时从 SQLite 加载：

- 表：`evoflow_models`（模型行）、`evoflow_app_settings`（`primary_model` 等）
- 管理：EvoPanel → **设置 → 模型**，或 Gateway **`/api/models`**
- 若 `config.yaml` 仍含 `models:` / `primary_model:`，启动时会 **忽略并打 warning**

字段参考（与 API / 数据库行一致）：

| 字段 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| `name` | string | 是 | — | 内部标识符 |
| `display_name` | string | 否 | name | UI 显示名称 |
| `use` | string | 是 | — | LangChain 类路径（如 `langchain_openai:ChatOpenAI`） |
| `model` | string | 是 | — | API 模型标识符 |
| `api_key` | string | 否 | — | API 密钥（支持 `$ENV_VAR`） |
| `base_url` | string | 否 | — | 自定义 API 端点 |
| `max_tokens` | int | 否 | **65536** | 最大**输出** token（固定默认，无需在 UI 单独设置） |
| `context_length` | int | 否 | — | 输入上下文窗口（用于压缩阈值） |
| `temperature` | float | 否 | — | 采样温度（0-1） |
| `supports_thinking` | bool | 否 | `false` | 是否支持思考模式 |
| `supports_vision` | bool | 否 | `false` | 是否支持视觉理解 |
| `supports_reasoning_effort` | bool | 否 | `false` | 是否支持推理强度调节 |
| `use_responses_api` | bool | 否 | `false` | 是否使用 OpenAI Responses API |
| `output_version` | string | 否 | — | Responses API 版本 |
| `timeout` / `request_timeout` | float | 否 | — | 请求超时（秒） |
| `max_retries` | int | 否 | — | 最大重试次数 |
| `when_thinking_enabled` | object | 否 | — | 思考模式开启时的额外参数 |

## sandbox

```yaml
sandbox:
  use: evoflow.sandbox.local:LocalSandboxProvider  # 或 AioSandboxProvider
  image: enterprise-public-cn-beijing.cr.volces.com/vefaas-public/all-in-one-sandbox:latest
  provisioner_url: http://localhost:8002  # 仅 provisioner 模式需要
```

## memory

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `enabled` | bool | `true` | 总开关 |
| `injection_enabled` | bool | `true` | 是否注入到系统提示 |
| `storage_path` | string | `backend/.evo-flow/memory.json` | 存储路径 |
| `debounce_seconds` | float | `30` | 更新防抖等待 |
| `model_name` | string | `null` | 用于更新的模型（null = 默认） |
| `max_facts` | int | `100` | 最大事实条目数 |
| `fact_confidence_threshold` | float | `0.7` | 事实置信度阈值 |
| `max_injection_tokens` | int | `2000` | 注入 token 上限 |

## subagents

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `enabled` | bool | `true` | 总开关 |
| `max_concurrent` | int | `3` | 最大并发子 Agent 数 |
| `timeout_minutes` | int | `15` | 超时上限 |

## title

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `enabled` | bool | `true` | 总开关 |
| `max_words` | int | `10` | 最大词数 |
| `max_chars` | int | `50` | 最大字符数 |

## summarization

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `enabled` | bool | — | 总开关 |
| `trigger` | object | — | 触发条件（tokens/messages/fraction） |
| `keep_policy` | string | — | 保留策略 |

## agent_orchestration

Lead Agent 编排模式（`config_version` ≥ 11）。默认 **hybrid**：绑定本地工作区时在首轮 `before_model` 并行预取索引命中文件；写/终端仍走模型 `tool_calls`。

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `default` | string | `hybrid` | `react` \| `hybrid` \| `local_scheduler` |
| `hybrid.prefetch_enabled` | bool | `true` | 是否注入 `<prefetch_context>` |
| `hybrid.prefetch_max_files` | int | `8` | 预取最多文件数 |
| `hybrid.read_search_via_scheduler` | bool | `true` | 读/搜经调度器批处理（预留） |
| `local_scheduler.max_io_concurrency` | int | `8` | 并行 IO 上限 |
| `local_scheduler.tier0_paths` | list | 见 example | Tier0 串行配置文件名 |
| `file_read_cache.enabled` | bool | `true` | `read_file` LRU 缓存 |
| `file_read_cache.ttl_seconds` | int | `90` | 缓存 TTL |
| `file_read_cache.max_entries` | int | `256` | LRU 上限 |

## channels

详见 [IM 消息渠道配置指南](../guides/integration/im-channels.md)。

## guardrails

详见 [安全护栏配置](../guides/security/guardrails.md)。

## 完整示例

```yaml
config_version: 5
log_level: info

token_usage:
  enabled: true

models:
  - name: gpt-4
    display_name: GPT-4
    use: langchain_openai:ChatOpenAI
    model: gpt-4
    api_key: $OPENAI_API_KEY
    max_tokens: 4096
    temperature: 0.7
    supports_vision: true

sandbox:
  use: evoflow.sandbox.local:LocalSandboxProvider

skills:
  path: ./skills
  container_path: /mnt/skills

title:
  enabled: true
  max_words: 10

summarization:
  enabled: false

subagents:
  enabled: true

memory:
  enabled: true
  storage_path: backend/.evo-flow/memory.json
  debounce_seconds: 30
  max_facts: 100
  fact_confidence_threshold: 0.7
  max_injection_tokens: 2000

channels:
  langgraph_url: http://localhost:2024
  gateway_url: http://localhost:8001
  feishu:
    enabled: false
    app_id: $FEISHU_APP_ID
    app_secret: $FEISHU_APP_SECRET
```

## 相关参考

- [.env 环境变量参考](env-reference.md)
- [Makefile 命令参考](makefile-reference.md)
)
