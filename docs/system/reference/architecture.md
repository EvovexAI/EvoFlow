# 技术架构参考

## 概述

EvoFlow 是基于 LangGraph 的 AI 超级 Agent 系统，采用全栈架构。后端提供"超级 Agent"能力，包含沙箱执行、持久记忆、子 Agent 委派和可扩展工具集成，所有操作在线程隔离环境中运行。

## 服务架构

```
                    ┌─────────────────┐
                    │   Nginx (2026)   │
                    │  统一反向代理     │
                    └────────┬─────────┘
                             │
              ┌──────────────┼──────────────┐
              │              │              │
     /api/langgraph    /api/*（其他）    /（非 API）
              │              │              │
    ┌─────────▼─────────┐ ┌─▼───────────┐ ┌─▼───────────┐
    │ LangGraph Server   │ │Gateway API  │ │ EvoPanel    │
    │ (port 2024)        │ │(port 8001)  │ │ (port 1420) │
    │ Agent 运行时       │ │ REST API    │ │ Next.js UI  │
    └────────────────────┘ └─────────────┘ └─────────────┘
```

| 服务 | 端口 | 技术 | 职责 |
|------|------|------|------|
| Nginx | 2026 | Nginx | 统一反向代理入口 |
| LangGraph Server | 2024 | LangGraph | Agent 运行时与工作流执行 |
| Gateway API | 8001 | FastAPI | REST API 管理接口 |
| EvoPanel | 1420 | Next.js | 前端用户界面 |
| Provisioner | 8002 | 可选 | Provisioner/Kubernetes 模式 |

## Cursor 本地调度对标（规划）

若目标为「大模型只出任务清单、本地引擎管串并行与工具速度」，请参阅内部设计文档：

- [17-cursor-local-scheduler-roadmap](../internal/technical/17-cursor-local-scheduler-roadmap.md)

当前实现仍以 LangGraph + 原生 `tool_calls` 为主链；上下文落盘、代码索引、Collab 阶段机等已部分对齐 Cursor 体验。

## 代码架构

```
backend/
├── packages/harness/evoflow/   # Harness 层（import: evoflow.*）
│   ├── agents/                 # LangGraph Agent 系统
│   │   ├── lead_agent/         # 主 Agent
│   │   ├── middlewares/        # 中间件组件
│   │   ├── memory/             # 记忆提取、队列、提示词
│   │   └── thread_state.py     # ThreadState 数据模型
│   ├── sandbox/                # 沙箱执行系统
│   ├── subagents/              # 子 Agent 委派系统
│   ├── tools/                  # 内置工具
│   ├── mcp/                    # MCP 集成
│   ├── models/                 # 模型工厂
│   ├── skills/                 # 技能发现与加载
│   ├── config/                 # 配置系统
│   ├── community/              # 社区工具
│   └── client.py               # 嵌入式 Python 客户端（EvoFlowClient）
├── app/                        # App 层（import: app.*）
│   ├── gateway/                # FastAPI Gateway API
│   └── channels/               # IM 平台集成（飞书、Slack、Telegram）
└── tests/                      # 测试套件
```

## Harness/App 分离

后端分为两层，依赖方向严格单向：

- **Harness**（`packages/harness/evoflow/`）：可发布的 Agent 框架包，导入前缀 `evoflow.*`
- **App**（`app/`）：未发布的应用代码，导入前缀 `app.*`

**依赖规则**：App 导入 evoflow，但 evoflow 永不导入 app。由 `tests/test_harness_boundary.py` 在 CI 中强制执行。

## 数据流

```
用户请求 → Nginx → Gateway API
                    ↓
              config.yaml / extensions_config.json
                    ↓
              加载模型/MCP/技能/记忆
                    ↓
              LangGraph Server → Lead Agent
                    ↓
              中间件链执行（13 个中间件）
                    ↓
              工具调用 → 沙箱/MCP/子Agent
                    ↓
              结果 → SSE 流式返回 → 前端
```

## 关键路径

### 线程隔离

每个会话（thread）拥有独立的数据目录：

```
backend/.evo-flow/threads/{thread_id}/
├── user-data/
│   ├── workspace/    # 工作区文件
│   ├── uploads/      # 上传文件
│   └── outputs/      # 输出文件
```

### 虚拟路径

Agent 看到的是统一的虚拟路径：

| 虚拟路径 | 物理路径 |
|----------|----------|
| `/mnt/user-data/workspace/` | `backend/.evo-flow/threads/{thread_id}/user-data/workspace/` |
| `/mnt/user-data/uploads/` | `backend/.evo-flow/threads/{thread_id}/user-data/uploads/` |
| `/mnt/user-data/outputs/` | `backend/.evo-flow/threads/{thread_id}/user-data/outputs/` |
| `/mnt/skills/` | `evo-flow/skills/` |
| `/mnt/acp-workspace/` | `backend/.evo-flow/threads/{thread_id}/acp-workspace/` |

### 记忆存储

```
backend/.evo-flow/memory.json
├── workContext      # 工作上下文
├── personalContext  # 个人上下文
├── topOfMind        # 最近关注点（1-3 句）
├── facts[]          # 离散事实（id, content, category, confidence, source）
└── history          # 历史上下文（recentMonths, earlierContext, longTermBackground）
```

### MCP 系统

- 懒初始化：首次使用时加载
- 缓存失效：通过 mtime 检测配置文件变更
- 传输协议：stdio、SSE、HTTP
- OAuth 支持：HTTP/SSE 传输的 token 刷新

## 相关参考

- [api-reference.md](api-reference.md) - Gateway API 参考
- [config-reference.md](config-reference.md) - 配置参考
