# 设计哲学：从 DeerFlow 到 EvoFlow

## 背景

EvoFlow 脱胎于 DeerFlow 项目。DeerFlow 是一个基于 LangGraph 的研究导向 Agent 系统，具备基础的 Agent 编排能力。然而在实际使用中，DeerFlow 暴露出若干架构局限，促使我们进行了系统性重构，诞生了 EvoFlow。

## 核心设计问题

### 问题一：缺少生产级 API 网关

DeerFlow 的 Agent 能力直接通过 LangGraph Server 暴露，缺少业务逻辑层。这导致：
- 无法进行统一的模型管理、MCP 配置
- 记忆系统、技能管理没有独立的 API
- 文件上传、制品服务等基础设施缺失

**EvoFlow 方案**：引入 FastAPI Gateway 作为业务层，LangGraph Server 专注 Agent 运行时。Gateway 承载所有 REST API（模型、MCP、记忆、技能、文件上传等），LangGraph 通过独立的进程运行 Agent。

### 问题二：缺少企业级消息渠道集成

DeerFlow 仅支持 Web 界面交互。企业场景中需要对接飞书、Slack、Telegram 等 IM 平台。

**EvoFlow 方案**：在 App 层引入 Channels 模块，实现消息总线、线程映射、多平台适配器架构。所有渠道通过 outbound 连接（WebSocket 或轮询），无需公网 IP。

### 问题三：沙箱隔离不足

DeerFlow 的沙箱机制简单，缺乏虚拟路径系统和容器化支持。

**EvoFlow 方案**：
- 虚拟路径系统：Agent 看到统一的 `/mnt/user-data/`、`/mnt/skills/` 路径
- 本地沙箱：`LocalSandboxProvider` 直接执行
- 容器沙箱：`AioSandboxProvider` 基于 Docker/Apple Container 隔离
- Provisioner 模式：生产环境通过 k3s 管理沙箱 Pod

### 问题四：缺少可组合的 Agent 系统

DeerFlow 只有一个固定的 Agent。无法创建自定义 Agent、无法配置不同 Agent 的工具和模型。

**EvoFlow 方案**：
- 自定义 Agent CRUD：通过 `agents/{code}/` 目录管理
- SOUL.md 机制：每个 Agent 有独立的人格文件
- 子 Agent 委派：主 Agent 可将任务委派给 specialized subagents
- ACP 集成：支持外部 Agent（Claude Code、Codex）通过 ACP 协议调用

## 架构演进

```
DeerFlow                    EvoFlow
┌──────────────┐            ┌────────────────────────────────┐
│ LangGraph    │            │ Nginx (2026)                    │
│   Agent      │     →      │   ├──→ LangGraph (2024)         │
│              │            │   ├──→ Gateway (8001)           │
└──────────────┘            │   └──→ EvoPanel (1420)          │
                            └────────────────────────────────┘
                            Harness (evoflow.*) ── 可发布框架
                            App (app.*)         ── 业务逻辑
```

## 设计原则

1. **Harness/App 分离**：框架与应用解耦，依赖方向严格单向
2. **线程隔离**：每个会话拥有独立的数据目录和环境
3. **懒初始化**：MCP、沙箱等资源按需创建，减少启动时间
4. **原子操作**：记忆写入、配置更新使用临时文件 + rename 保证一致性
5. **配置热更新**：通过 mtime 检测文件变更，无需重启进程

## 与其他方案的比较

| 特性 | DeerFlow | EvoFlow |
|------|----------|---------|
| API 网关 | 无 | FastAPI Gateway |
| 消息渠道 | 无 | 飞书/Slack/Telegram |
| 沙箱 | 简单 | 本地+容器+Provisioner |
| 自定义 Agent | 不支持 | 完整 CRUD |
| 子 Agent | 不支持 | 双线程池委派 |
| 记忆系统 | 基础 | 防抖队列 + 事实提取 |
| 技能系统 | 基础 | SKILL.md + 启用状态管理 |
| 嵌入式客户端 | 无 | EvoFlowClient |

## 延伸阅读

- [architecture.md](../reference/architecture.md) - 技术架构参考
- [agent-system.md](./agent-system.md) - Agent 系统架构

---

**最后验证**：2026-05-10；适用范围：默认分支。
