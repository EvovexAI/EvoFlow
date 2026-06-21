# 运维与操作手册

面向**自托管部署**与日常运维，内容与仓库脚本、Docker 配置一致。

## 进程与端口

| 组件 | 典型端口 | 说明 |
|------|-----------|------|
| LangGraph Server | `2024` | `langgraph dev` / 容器内等价进程 |
| Gateway（`make dev`） | **`8012`** | 见 `scripts/serve.sh` 中 `GATEWAY_PORT` |
| Gateway（Docker Compose） | **`8001`**（容器内） | 见 `docker/docker-compose*.yaml` |
| Nginx 统一入口 | **`2026`** | `docker/nginx/nginx.local.conf` 将 Gateway 指到 `127.0.0.1:8012` |

客户端（EvoPanel 等）请按你的启动方式指向正确 Base URL。

## 日志

| 日志 | 位置 |
|------|------|
| Gateway 文件日志 | 仓库根 `logs/gateway.log`（可由 `EVOFLOW_LOGS_DIR` 等覆盖，见 `backend/CLAUDE.md`） |
| LangGraph（本地脚本） | `logs/langgraph.log` |
| Nginx | `logs/nginx-access.log`、`logs/nginx-error.log`（使用自带 nginx 配置时） |

## 配置升级

1. 仓库更新后执行 **`make config-upgrade`**（或 `scripts/config-upgrade.sh`），将 `config.example.yaml` 中新增字段合并进本地 `config.yaml`。
2. `config_version` 不匹配时，启动日志会提示；以 `config.example.yaml` 为 schema 真相来源。

## 备份与恢复

建议至少备份：

- **`config.yaml`**、**`.env`**（或等价密钥注入方式）
- **`extensions_config.json`**（MCP 与技能启用状态）
- **`backend/.evo-flow/`**（线程工作区、记忆文件等运行时数据，路径以 `evoflow.config.paths` 为准）
- **LangGraph 检查点/存储**（若使用 SQLite 或外部 DB，备份对应文件或做数据库快照）

恢复时先停服，还原上述目录与配置，再按安装文档启动。

## 自动化调度（Gateway）

默认 Gateway 进程内会运行自动化调度循环（读取 `~/.evoflow/tasks/automations/*.toml`，目录可由环境变量覆盖）。禁用方式见环境变量说明：

- **`EVOFLOW_AUTOMATION_SCHEDULER=0`**（或 `false` / `off` / `disabled`）

详见 [automation-scheduler.md](../tasks/automation-scheduler.md) 与 `backend/app/gateway/automation_runner.py`。

## 安全建议

- EvoFlow 具备命令执行与文件系统访问能力，**默认面向可信网络**；若暴露公网，须前置**认证、TLS、IP 限制**与审计。
- 勿将 `.env`、密钥文件提交到版本库。

## EvoPanel

- 源码位于仓库 [`evopanel/`](https://github.com/EvovexAI/EvoFlow/tree/main/evopanel)。
- 开发与打包流程见 [evopanel-guide.md](../configuration/evopanel-guide.md) 及 `evopanel/README.md`。
- 面板需能访问上述 Gateway / LangGraph 地址（按你的部署填写）。

## 文档与 API 契约

- HTTP 路由以 **`docs/reference/generated/openapi-gateway.json`** 为准；更新路由后运行  
  `cd backend && PYTHONPATH=. uv run python ../scripts/docs/export_gateway_openapi.py`  
  并提交 JSON。
