# 生产环境部署

## 适用场景
将 EvoFlow 部署到生产环境，使用优化后的 Docker 镜像和多 worker 配置。

## 前置条件
- Docker 及 Docker Compose 已安装
- 已配置 `config.yaml`（包含有效的模型 API Key）
- Linux 服务器推荐；macOS 可用但需注意 Docker Socket 路径
- 如需 AIO 沙箱模式，确保 Docker Socket 路径正确

## 步骤

### 1. 准备环境

确保以下文件存在：
- `config.yaml` — 主配置（模型、沙箱、记忆等）
- `extensions_config.json` — MCP 服务器和技能配置
- `.env` — 环境变量（API Key、LangSmith 等，**不要提交到版本库**）

如果缺少配置文件：
```bash
make config          # 从交互向导生成 config.yaml
```

### 2. 启动生产环境

```bash
make up
```

`make up` 调用 `scripts/deploy.sh`，执行以下流程：
1. 设置 `EVOFLOW_HOME`（默认 `$REPO_ROOT/backend/.evoflow`）
2. 生成 `BETTER_AUTH_SECRET`（用于 Next.js 生产认证，持久化到 `$EVOFLOW_HOME/.better-auth-secret`）
3. 从 `config.yaml` 检测沙箱模式
4. 使用 `docker/docker-compose.yaml` 构建并启动容器

### 3. 访问服务

| 服务 | 地址 |
|------|------|
| Gateway API | `http://localhost:8001` |
| LangGraph Server | `http://localhost:2024` |

注意：生产 compose 不包含前端和 Nginx，需要通过外部反向代理（如 Nginx/Traefik）路由流量到后端服务。

### 4. 停止生产环境

```bash
make down
```

停止并移除所有生产容器。

### 5. 查看日志

```bash
docker compose -p evo-flow -f docker/docker-compose.yaml logs -f
```

## 验证是否生效

```bash
# 检查容器运行状态
docker ps | grep evo-flow

# 检查 Gateway 健康
curl http://localhost:8001/health

# 检查 LangGraph 健康
curl http://localhost:2024/health
```

## 与开发环境的区别

| 特性 | 开发 (`docker-compose-dev.yaml`) | 生产 (`docker-compose.yaml`) |
|------|----------------------------------|------------------------------|
| Gateway 命令 | `uvicorn --reload` | `uvicorn --workers 2` |
| LangGraph 命令 | `langgraph dev --reload` | `langgraph dev --no-reload` |
| 代码挂载 | 完整 `backend/` 目录挂载（热重载） | 仅挂载配置文件和数据目录 |
| `.venv` | 宿主缓存挂载 | 保留镜像内构建的 `.venv` |
| 前端/Nginx | 无（开发时单独启动） | 无（需外部反向代理） |

## 本地构建镜像

生产 compose 使用 `docker-compose.yaml` 中的 `build` 指令，基于 `backend/Dockerfile` 构建镜像。如需自定义构建参数：

```bash
# 通过环境变量传递构建参数
export APT_MIRROR=https://mirrors.aliyun.com
export UV_IMAGE=ghcr.io/astral-sh/uv:0.7.20

# 重新构建并启动
make up
```

## 挂载运行时配置

生产环境的配置文件通过卷挂载注入容器：

```yaml
# docker-compose.yaml 中的挂载
volumes:
  - ${EVOFLOW_CONFIG_PATH}:/app/backend/config.yaml:ro
  - ${EVOFLOW_EXTENSIONS_CONFIG_PATH}:/app/backend/extensions_config.json:ro
  - ${EVOFLOW_HOME}:/app/backend/.evoflow
```

可以通过环境变量覆盖默认路径：
```bash
export EVOFLOW_CONFIG_PATH=/etc/evoflow/config.yaml
export EVOFLOW_EXTENSIONS_CONFIG_PATH=/etc/evoflow/extensions_config.json
export EVOFLOW_HOME=/var/lib/evoflow
```

## 安全考虑

1. **BETTER_AUTH_SECRET**：自动生成并持久化，确保容器重启后认证会话不丢失
2. **API Key**：通过 `.env` 文件或宿主环境变量注入，不要硬编码到 `config.yaml`
3. **Docker Socket**：仅 AIO 沙箱模式需要挂载 `/var/run/docker.sock`，Local 模式不需要
4. **配置文件权限**：确保 `config.yaml` 和 `.env` 文件仅对运行用户可读（`chmod 600`）
5. **LangSmith 追踪**：默认禁用（`LANGSMITH_TRACING=false`），启用时需要设置 `LANGSMITH_API_KEY`
6. **网络隔离**：使用独立的 `evo-flow` Docker 网络，外部只能通过映射端口访问

## 常见问题

**Q: `make up` 构建失败？**
检查 Docker 版本（建议 24+）和磁盘空间。清理缓存后重试：`docker system prune -a`。

**Q: 容器启动后无法访问？**
确认防火墙未阻止 8001/2024 端口。检查容器日志：`docker logs evo-flow-gateway`。

**Q: 如何更新到最新版本？**
拉取最新代码后重新构建：`git pull && make down && make up`。

**Q: 生产环境能否使用 Provisioner（Kubernetes 模式）？**
可以。在 `config.yaml` 中配置 `provisioner_url` 后执行 `make up`，会自动启动 provisioner 容器（通过 `--profile provisioner`）。

## 相关文档
- [Docker 开发部署](./docker-deployment.md)
- [沙箱模式配置](./sandbox-config.md)

---

**最后验证**：2026-05-10；适用范围：默认分支。
