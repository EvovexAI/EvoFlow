# 沙箱与虚拟路径设计

## 背景

Agent 在执行任务时需要读写文件、运行命令。如果直接操作主机文件系统，会带来安全风险和线程间数据污染问题。沙箱系统提供了隔离的执行环境，而虚拟路径系统让 Agent 以统一的方式访问资源。

## 设计理念

沙箱设计的核心原则是**路径透明、执行隔离、资源可控**：

1. **路径透明**：Agent 看到的是统一的虚拟路径，不关心物理存储位置
2. **执行隔离**：命令在沙箱环境中执行，与主机隔离
3. **资源可控**：每个线程有独立的数据目录，互不干扰

## 沙箱提供者

### LocalSandboxProvider（本地沙箱）

- 直接在主机执行命令
- 通过路径映射实现虚拟路径翻译
- 适用于可信的单用户环境
- 不支持安全隔离（`allow_host_bash` 默认 false）

### AioSandboxProvider（容器沙箱）

- 基于 Docker 或 Apple Container 的容器隔离
- macOS 上优先使用 Apple Container，降级到 Docker
- 支持容器镜像配置、端口映射、环境变量注入
- 最大并发数限制（默认 3），达到上限时 LRU 淘汰

```yaml
sandbox:
  use: evoflow.community.aio_sandbox:AioSandboxProvider
  image: enterprise-public-cn-beijing.cr.volces.com/vefaas-public/all-in-one-sandbox:latest
  replicas: 3
```

### Provisioner 模式

- 通过 provisioner（端口 8002）管理 k3s Pod
- 每个 sandbox_id 对应一个独立 Pod
- 适用于生产环境，提供更强隔离和可扩展性

## 虚拟路径系统

### 虚拟路径映射

Agent 看到的虚拟路径：

| 虚拟路径 | 说明 |
|----------|------|
| `/mnt/user-data/workspace/` | 工作区文件 |
| `/mnt/user-data/uploads/` | 用户上传文件 |
| `/mnt/user-data/outputs/` | Agent 输出文件（可展示给用户） |
| `/mnt/skills/` | 技能目录 |
| `/mnt/acp-workspace/` | ACP 工作空间（只读） |

### 路径翻译

`replace_virtual_path()` 和 `replace_virtual_paths_in_command()` 负责虚拟路径到物理路径的转换：

```
# Agent 执行：
bash("ls /mnt/user-data/workspace/")

# 翻译后（本地沙箱）：
ls backend/.evo-flow/threads/{thread_id}/user-data/workspace/

# 翻译后（容器沙箱）：
ls /home/user/workspace/  # 容器内的挂载点
```

### 线程隔离目录结构

```
backend/.evo-flow/threads/{thread_id}/
├── user-data/
│   ├── workspace/    # 工作区
│   ├── uploads/      # 上传文件
│   └── outputs/      # 输出文件
├── acp-workspace/    # ACP 工作空间
└── memory.json       # 线程记忆
```

## 沙箱工具

沙箱提供 5 个核心工具：

| 工具 | 功能 |
|------|------|
| `bash` | 执行 shell 命令，自动翻译路径 |
| `ls` | 目录列表（树形） |
| `read_file` | 读取文件（支持行范围） |
| `write_file` | 写入文件，自动创建目录 |
| `str_replace` | 字符串替换 |

## 生命周期管理

沙箱通过 `SandboxProvider` 的生命周期接口管理：

```
acquire(thread_id) → 创建或获取沙箱
  ↓
执行工具调用
  ↓
release(sandbox_id) → 释放沙箱资源
```

本地模式下，acquire 和 release 是幂等的（同一个线程始终使用同一个 LocalSandboxProvider 实例）。容器模式下，acquire 会启动新容器，release 会停止容器。

## 安全考量

- 本地沙箱不提供真正的安全隔离，`allow_host_bash` 默认关闭
- 容器沙箱提供进程级隔离，但仍共享主机内核
- ACP 工作空间挂载为只读
- `present_files` 工具仅允许展示 `/mnt/user-data/outputs/` 下的文件

## 与其他方案的比较

| 方案 | 隔离级别 | 适用场景 |
|------|----------|----------|
| LocalSandboxProvider | 无隔离（仅路径隔离） | 单用户、可信环境 |
| AioSandboxProvider | 容器隔离 | 开发、测试、多用户 |
| Provisioner | Pod 隔离（k3s） | 生产环境 |

## 延伸阅读

- [sandbox-config.md](../guides/sandbox-config.md) - 沙箱配置指南
- [tool-reference.md](../reference/tool-reference.md) - 内置工具参考
