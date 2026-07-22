# 沙箱模式配置

> **沙箱决定了 AI 的代码和命令在什么环境里跑**：
>
> - **本地沙箱**：直接在你自己电脑上执行，零依赖，适合个人开发
> - **Docker 沙箱**：在容器里隔离执行，不会影响宿主机，适合团队协作
> - **Kubernetes 沙箱**：生产级隔离，适合大规模部署
>
> 比如你让 AI"跑个 Python 脚本处理数据"——本地沙箱就在你电脑上直接跑，Docker 沙箱先起个容器再跑。切换沙箱模式后需重启服务。

## 适用场景
配置 Agent 的代码执行环境。EvoFlow 提供三种沙箱模式，从最简单的本地执行到完全隔离的 Kubernetes Pod。

## 前置条件
- 已创建 `config.yaml`
- 了解各模式的安全边界和资源需求

## 步骤

### 模式一：本地沙箱（默认）

命令直接在宿主机上执行，无容器隔离。

```yaml
sandbox:
  use: evoflow.sandbox.local:LocalSandboxProvider
  allow_host_bash: false
```

**特点：**
- 零依赖，无需 Docker
- 适合个人开发、快速验证
- **安全性最低**：Agent 可访问宿主机文件系统
- `allow_host_bash` 默认为 `false`，仅用于受信任的单人工作流

### 模式二：容器化 AIO 沙箱

命令在隔离容器中执行。macOS 优先使用 Apple Container，回退到 Docker；其他平台使用 Docker。

```yaml
sandbox:
  use: evoflow.community.aio_sandbox:AioSandboxProvider
  # image: enterprise-public-cn-beijing.cr.volces.com/vefaas-public/all-in-one-sandbox:latest
  # port: 8080
  # replicas: 3
  # container_prefix: evo-flow-sandbox
```

**可选配置：**

| 字段 | 默认值 | 说明 |
|------|--------|------|
| `image` | `all-in-one-sandbox:latest` | 容器镜像 |
| `port` | `8080` | 沙箱基础端口 |
| `replicas` | `3` | 最大并发容器数，超出时淘汰最久未使用的 |
| `container_prefix` | `evo-flow-sandbox` | 容器名称前缀 |
| `environment` | `{}` | 注入容器的环境变量 |
| `mounts` | `[]` | 额外挂载目录 |

**自定义挂载示例：**
```yaml
sandbox:
  use: evoflow.community.aio_sandbox:AioSandboxProvider
  mounts:
    - host_path: /path/on/host
      container_path: /home/user/shared
      read_only: false
```

**环境变量注入示例：**
```yaml
sandbox:
  use: evoflow.community.aio_sandbox:AioSandboxProvider
  environment:
    NODE_ENV: production
    API_KEY: $MY_API_KEY    # 从宿主机环境变量解析
```

### 模式三：Provisioner 管理的 Kubernetes 沙箱

每个 `sandbox_id` 对应一个独立的 Kubernetes Pod，由 provisioner 服务管理生命周期。

```yaml
sandbox:
  use: evoflow.community.aio_sandbox:AioSandboxProvider
  provisioner_url: http://provisioner:8002
```

**特点：**
- 最佳隔离性：每个会话一个 Pod
- 需要 Kubernetes 集群（如 k3s）
- 适合生产环境或多用户场景
- Docker Compose 启动时需启用 provisioner profile

## 虚拟路径系统

Agent 在沙箱内使用统一的虚拟路径，与实际物理路径自动映射：

| 虚拟路径 | 物理路径 | 说明 |
|----------|----------|------|
| `/mnt/user-data/workspace/` | `backend/.evo-flow/threads/{thread_id}/user-data/workspace/` | 工作目录 |
| `/mnt/user-data/uploads/` | `backend/.evo-flow/threads/{thread_id}/user-data/uploads/` | 上传文件 |
| `/mnt/user-data/outputs/` | `backend/.evo-flow/threads/{thread_id}/user-data/outputs/` | 输出文件 |
| `/mnt/skills/` | `skills/`（项目根目录） | 技能目录 |

**路径翻译**：`bash` 工具执行命令时，自动将虚拟路径替换为沙箱内的实际路径。

## 何时使用各模式

| 场景 | 推荐模式 |
|------|----------|
| 个人开发、快速原型 | 本地沙箱 |
| 需要文件隔离、团队协作 | AIO 容器沙箱 |
| 生产部署、多租户 | Kubernetes Provisioner |
| macOS 上不想装 Docker | AIO 容器沙箱（Apple Container） |

## 验证是否生效

```bash
# 检查当前沙箱模式
grep -A 2 "^sandbox:" config.yaml

# AIO 模式下，查看运行的沙箱容器
docker ps | grep evo-flow-sandbox

# Kubernetes 模式下，查看 Pod
kubectl get pods -n evo-flow
```

## 常见问题

**Q: 切换沙箱模式后需要重启吗？**
是的。沙箱提供者在 Agent 创建时初始化，修改 `config.yaml` 后需重启 Gateway 和 LangGraph 服务。

**Q: AIO 模式下容器无法启动？**
检查 Docker 是否运行，以及镜像是否已拉取（`make docker-init`）。

**Q: 本地沙箱的 `allow_host_bash` 能打开吗？**
仅在全受信任的单人环境中打开。打开后 Agent 可以直接执行宿主机的 bash 命令。

**Q: Docker-in-Docker (DooD) 是什么？**
生产/开发 compose 中将宿主 Docker Socket 挂载到容器内，使 AioSandboxProvider 能通过宿主 Docker 创建沙箱容器。这不是真正的 Docker-in-Docker，而是 "Docker-outside-of-Docker"。

## 相关文档
- [沙箱配置（本文）](sandbox-config.md)
- [工具与 MCP](tools-mcp.md)
