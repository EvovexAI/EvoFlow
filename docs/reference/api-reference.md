# Gateway API 参考

## 概述

EvoFlow **Gateway** 基于 FastAPI，与 **LangGraph Server**（默认 `2024` 端口）并列运行；Nginx（常见于 Docker/本地统一入口 **`2026`**）将 `/api/langgraph/*` 代理到 LangGraph，其余 `/api/*` 代理到 Gateway。

**监听端口（以实际进程为准）**

| 场景 | Gateway 直连端口 | 说明 |
|------|------------------|------|
| `make dev`（`scripts/serve.sh`） | **8012** | 脚本内 `GATEWAY_PORT=8012`，不经 Nginx |
| Docker Compose（`docker/docker-compose*.yaml`） | 容器内 **8001** | 与 `uvicorn ... --port 8001` 一致 |
| 本地 Nginx 统一入口 | **2026** | `docker/nginx/nginx.local.conf` 将 Gateway upstream 指向 `127.0.0.1:8012` |

**交互式文档**：Gateway 进程启动后可访问其自带的 Swagger / ReDoc（路径见 FastAPI 应用上的 `docs_url` / `redoc_url`，默认 **`/docs`**、**`/redoc`**），例如 `http://localhost:8012/docs`（本地 dev 脚本端口）。

## 机器可读规范（SSOT）

与当前代码一致的路由、方法、参数模型见：

- **[openapi-gateway.json](generated/openapi-gateway.json)** — 由 [`scripts/docs/export_gateway_openapi.py`](https://github.com/EvovexAI/EvoFlow/blob/main/scripts/docs/export_gateway_openapi.py) 从 `app.gateway.app:create_app()` 导出；须与仓库中已提交文件一致。

若你修改了 `backend/app/gateway/routers/` 下的路由，请在 `backend` 目录执行：

```bash
PYTHONPATH=. uv run python ../scripts/docs/export_gateway_openapi.py
```

并提交更新后的 `docs/reference/generated/openapi-gateway.json`。

## 路由前缀速览

下列为常用能力分组，**具体子路径与动词以 OpenAPI 为准**（上节 JSON）。

| 前缀 | 能力 |
|------|------|
| `/health` | 健康检查 |
| `/api/models` | 模型列表、详情、主模型、调用、探测等 |
| `/api/mcp` | MCP 服务器配置读写 |
| `/api/memory` | 全局记忆数据与配置 |
| `/api/skills` | 技能列表、启用状态、安装 |
| `/api/agents` | 自定义 Agent 与 `USER.md` 配置等 |
| `/api/user-profile`、`/api/tools/metadata` | 用户配置与工具元数据 |
| `/api/threads/{thread_id}/uploads` | 线程上传 |
| `/api/threads/{thread_id}/artifacts` | 线程制品 |
| `/api/threads/{thread_id}` | 本地线程数据清理 |
| `/api/threads/{thread_id}/suggestions` | 后续问题建议 |
| `/api/workspaces` | 工作空间解析 |
| `/api/channels` | IM 渠道状态与配置（飞书 / Slack / Telegram） |
| `/api/automation` | 自动化调度与任务定义 |
| `/api/tasks` | 任务与批量操作 |
| `/api/task-detail` | 任务执行期记忆、事实与进度 |
| `/api/events` | SSE 事件 |
| `/api/collab` | 协作阶段与任务流 |
| `/api/langgraph` | LangGraph 代理与部分封装端点 |
| `/api/sessions` | 会话搜索与索引维护 |
| `/api/runtime/paths` | 运行时路径诊断与配置升级辅助 |

### 调试追踪（未纳入 OpenAPI）

以下端点默认 **`include_in_schema=False`**，故不会出现在 `openapi-gateway.json` 中：

- 前缀 **`/api/debug/agent-trace`**（如 `/data`、`/export`、`/analysis`、`/recent-threads`）
- 需设置环境变量 **`EVOFLOW_DEBUG_TRACE_UI=1`** 才可用，仅建议本地排障
- 前缀 **`/api/observability`**（如 `/report`、`/overview`、`/insights`、`/errors/summary`、`/trends`、`/tools`、`/models`）；SQLite 观测默认开启
- AI 巡检技能：`skills/custom/evoflow-observability-analysis/SKILL.md`

排查手册（工具报错、慢调用、Token/耗时 Top N、AI 定期分析）：[backend/docs/AGENT_TRACE_DEBUG_PLAYBOOK.md](https://github.com/EvovexAI/EvoFlow/blob/main/backend/docs/AGENT_TRACE_DEBUG_PLAYBOOK.md)

详见 `backend/app/gateway/routers/debug_agent_trace.py`、`backend/app/gateway/routers/observability.py`。

## 示例

健康检查（按你的 Gateway 端口替换 `8012`）：

```bash
curl -s http://localhost:8012/health
```

上传文件：

```bash
curl -X POST "http://localhost:8012/api/threads/{thread_id}/uploads" \
  -F "files=@document.pdf"
```

## 相关参考

- [config-reference.md](config-reference.md) — `config.yaml` 配置项
- [env-reference.md](env-reference.md) — 环境变量
- [术语表](../meta/glossary.md) — 统一术语
