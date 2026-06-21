# Docker 开发部署

## 适用场景
在 Docker 环境中运行 EvoFlow 开发环境，无需本地安装 Python/Node.js 依赖。

## 前置条件
- Docker 已安装且守护进程运行中
- 项目根目录下存在 `config.yaml`（可执行 `make config` 生成）
- macOS/Linux 环境（Windows 需通过 WSL 使用）

## 步骤

### 1. 初始化环境

```bash
make docker-init
```

此命令会：
- 从 `config.yaml` 检测沙箱模式（Local / AIO / Provisioner）
- Local 模式下无需拉取 Docker 镜像，直接提示就绪
- AIO/Provisioner 模式下预拉取沙箱镜像 `all-in-one-sandbox:latest`

### 2. 启动服务

```bash
make docker-start
```

脚本自动从 `config.yaml` 的 `sandbox.use` 字段检测沙箱模式，决定启动哪些容器：

| 沙箱模式 | 启动容器 |
|----------|----------|
| `LocalSandboxProvider` | gateway + langgraph |
| `AioSandboxProvider`（无 provisioner_url） | gateway + langgraph |
| `AioSandboxProvider`（有 provisioner_url） | gateway + langgraph + provisioner |

如果 `config.yaml` 不存在，脚本会从 `config.example.yaml` 复制一份并提示编辑配置。

### 3. 访问服务

| 服务 | 地址 |
|------|------|
| 统一入口（Nginx） | `http://localhost:2026` |
| Gateway API | `http://localhost:8001` |
| LangGraph Server | `http://localhost:2024` |

### 4. 查看日志

```bash
# 查看所有容器日志
make docker-logs

# 仅查看 Gateway 日志
make docker-logs-gateway

# 仅查看前端日志
make docker-logs-frontend
```

### 5. 停止服务

```bash
make docker-stop
```

此命令会停止 Docker 容器并清理残留的沙箱容器。

## 验证是否生效

```bash
# 检查容器运行状态
docker ps | grep evo-flow

# 检查 Gateway 健康
curl http://localhost:8001/health

# 检查 LangGraph 健康
curl http://localhost:2024/health
```

## 容器架构

开发环境使用 `docker/docker-compose-dev.yaml`，包含三个服务：

- **gateway**：FastAPI Gateway API（端口 8001），含热重载
- **langgraph**：LangGraph 开发服务器（端口 2024）
- **provisioner**（可选）：Kubernetes 沙箱供给器，仅当 `config.yaml` 配置了 `provisioner_url` 时启动

### 卷挂载

| 挂载路径 | 说明 |
|----------|------|
| `../backend/` → `/app/backend/` | 后端代码热重载 |
| `../config.yaml` → `/app/config.yaml` | 主配置文件 |
| `../extensions_config.json` → `/app/extensions_config.json` | 扩展配置 |
| `../skills` → `/app/skills` | 技能目录 |
| `/var/run/docker.sock` → `/var/run/docker.sock` | Docker-in-Docker（AioSandboxProvider 需要） |
| `~/.claude` / `~/.codex` | CLI 认证目录（只读） |

## 常见问题

**Q: `make docker-start` 提示 Docker 不可用？**
确认 Docker Desktop / OrbStack 已启动。执行 `docker info` 验证守护进程可达。

**Q: 容器启动后立即退出？**
检查 `config.yaml` 中模型配置是否正确（API Key 等）。使用 `make docker-logs` 查看具体错误。

**Q: 修改了 `config.yaml` 如何生效？**
配置通过 mtime 检测自动重载，无需重启容器。如需强制重载，执行 `make docker-stop && make docker-start`。

**Q: Windows 上如何使用？**
通过 WSL2 执行命令。确保 Docker Desktop 的 WSL2 后端已启用。

## 相关文档
- [生产环境部署](./production-deploy.md)
- [沙箱模式配置](../configuration/sandbox-config.md)
