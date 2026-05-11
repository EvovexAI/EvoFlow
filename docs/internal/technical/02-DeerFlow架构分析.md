# 02-EvoFlow 架构分析

---

## 目录

- [一、系统概述](#一系统概述)
- [二、分层架构](#二分层架构)
- [三、核心组件](#三核心组件)
- [四、数据流转](#四数据流转)
- [五、扩展机制](#五扩展机制)
- [六、安全设计](#六安全设计)

---

## 一、系统概述

EvoFlow 采用**分层架构设计**，将系统划分为清晰的层次，每层负责特定的职责，层与层之间通过明确的接口进行通信。

### 1.1 设计原则

| 原则 | 说明 |
|------|------|
| **关注点分离** | 不同功能模块独立演进，降低耦合 |
| **可扩展性** | 通过配置和插件机制支持功能扩展 |
| **安全性** | 工具执行隔离，敏感操作受控 |
| **可观测性** | 全流程追踪，状态可查询 |

### 1.2 架构全景

```mermaid
flowchart TB
    subgraph "用户层"
        UI[Web UI]
        API[API 客户端]
    end
    
    subgraph "接入层"
        GW[Gateway 网关]
    end
    
    subgraph "编排层"
        AG[Agent 运行时]
    end
    
    subgraph "能力层"
        TOOLS[工具系统]
        MEM[记忆系统]
        GD[安全护栏]
    end
    
    subgraph "执行层"
        SB[Sandbox 沙箱]
        SUB[子代理]
    end
    
    UI --> GW
    API --> GW
    GW --> AG
    AG --> TOOLS
    AG --> MEM
    AG --> GD
    TOOLS --> SB
    TOOLS --> SUB
```

---

## 二、分层架构

### 2.1 五层架构模型

EvoFlow 采用经典的五层架构：

```
┌─────────────────────────────────────────┐
│           用户层 (Presentation)          │  ← Web UI、API
├─────────────────────────────────────────┤
│           接入层 (Gateway)               │  ← 路由、认证、限流
├─────────────────────────────────────────┤
│           编排层 (Orchestration)         │  ← Agent 运行时
├─────────────────────────────────────────┤
│           能力层 (Capabilities)          │  ← 工具、记忆、护栏
├─────────────────────────────────────────┤
│           执行层 (Execution)             │  ← 沙箱、子代理
└─────────────────────────────────────────┘
```

### 2.2 各层职责

| 层级 | 核心职责 | 关键组件 |
|------|----------|----------|
| **用户层** | 提供交互界面 | Web UI、API 端点 |
| **接入层** | 请求路由与治理 | Gateway、认证中间件 |
| **编排层** | Agent 生命周期管理 | Lead Agent、状态机 |
| **能力层** | 提供可复用能力 | 工具集、记忆存储、安全策略 |
| **执行层** | 隔离执行环境 | Sandbox、子代理进程 |

---

## 三、核心组件

### 3.1 Agent 运行时

Agent 运行时是系统的核心编排引擎，负责协调 LLM、工具和上下文。

**核心概念**：

- **Lead Agent**：主代理，负责接收用户输入并协调工具调用
- **Thread**：对话线程，维护一次完整对话的上下文状态
- **Turn**：单轮交互，包含用户输入和模型响应

**运行时流程**：

```mermaid
sequenceDiagram
    participant U as 用户
    participant A as Lead Agent
    participant M as 大模型
    participant T as 工具系统
    
    U->>A: 发送消息
    A->>A: 加载上下文
    A->>M: 发送提示词
    M-->>A: 返回响应
    
    alt 需要工具调用
        A->>T: 调用工具
        T-->>A: 返回结果
        A->>M: 发送工具结果
        M-->>A: 最终响应
    end
    
    A->>A: 更新状态
    A-->>U: 返回结果
```

### 3.2 中间件链

中间件链是 Agent 运行时的**拦截器机制**，在请求处理的不同阶段插入逻辑。

**处理阶段**：

```mermaid
flowchart LR
    A[请求进入] --> B[前置处理]
    B --> C[模型调用]
    C --> D[后置处理]
    D --> E[响应输出]
    
    subgraph "前置处理"
        B1[加载线程数据]
        B2[注入上传文件]
        B3[初始化沙箱]
        B4[安全护栏检查]
    end
    
    subgraph "后置处理"
        D1[上下文压缩]
        D2[生成标题]
        D3[更新记忆]
        D4[澄清拦截]
    end
    
    B --> B1 --> B2 --> B3 --> B4 --> C
    C --> D1 --> D2 --> D3 --> D4 --> E
```

**典型中间件**：

| 中间件 | 阶段 | 作用 |
|--------|------|------|
| 线程数据加载 | 前置 | 恢复对话上下文 |
| 上传文件注入 | 前置 | 将用户上传文件加入提示词 |
| 沙箱初始化 | 前置 | 准备代码执行环境 |
| 安全护栏 | 前置 | 检查输入合规性 |
| 上下文压缩 | 后置 | 长对话时压缩历史 |
| 记忆更新 | 后置 | 提取并存储关键信息 |

### 3.3 工具系统

工具系统为 Agent 提供**可调用能力**，将外部功能封装为 LLM 可调用的接口。

**工具来源**：

```mermaid
flowchart TB
    subgraph "工具注册中心"
        REG[工具注册表]
    end
    
    subgraph "工具来源"
        B1[内置工具]
        B2[配置文件]
        B3[MCP 服务]
        B4[子代理]
    end
    
    B1 --> REG
    B2 --> REG
    B3 --> REG
    B4 --> REG
    
    REG --> AG[Agent 工具集]
```

**工具类型**：

| 类型 | 说明 | 示例 |
|------|------|------|
| **内置工具** | 系统预置的基础工具 | 文件读写、网络请求 |
| **配置工具** | 通过配置文件定义的命令行工具 | Python 脚本、Shell 命令 |
| **MCP 工具** | 通过 MCP 协议接入的外部服务 | 数据库查询、API 调用 |
| **子代理** | 将复杂任务委托给专门的子 Agent | 代码审查、文档生成 |

### 3.4 记忆系统

记忆系统负责**持久化对话中的关键信息**，支持跨会话的上下文延续。

**记忆类型**：

```mermaid
flowchart LR
    subgraph "记忆层级"
        STM[短期记忆<br/>Session 级]
        MTM[中期记忆<br/>Thread 级]
        LTM[长期记忆<br/>User 级]
    end
    
    subgraph "存储介质"
        MEM_DB[(记忆数据库)]
        VEC_DB[(向量数据库)]
    end
    
    STM --> MEM_DB
    MTM --> MEM_DB
    LTM --> VEC_DB
```

| 记忆层级 | 生命周期 | 存储内容 |
|----------|----------|----------|
| **短期记忆** | 单次会话 | 当前对话的完整历史 |
| **中期记忆** | 对话线程 | 线程级别的关键信息 |
| **长期记忆** | 用户级别 | 跨对话的用户偏好和知识 |

### 3.5 安全护栏

安全护栏是系统的**安全闸门**，在关键操作前进行合规性检查。

**检查点分布**：

```mermaid
flowchart TB
    subgraph "输入检查"
        I1[Prompt 注入检测]
        I2[敏感信息过滤]
    end
    
    subgraph "工具调用检查"
        T1[命令白名单]
        T2[路径遍历防护]
        T3[资源限制]
    end
    
    subgraph "输出检查"
        O1[内容安全]
        O2[信息脱敏]
    end
    
    IN[用户输入] --> I1 --> I2 --> AGENT[Agent 处理]
    AGENT --> T1 --> T2 --> T3 --> EXEC[工具执行]
    EXEC --> O1 --> O2 --> OUT[输出响应]
```

---

## 四、数据流转

### 4.1 单次请求生命周期

```mermaid
sequenceDiagram
    participant U as 用户
    participant GW as Gateway
    participant AG as Lead Agent
    participant MW as 中间件链
    participant LLM as 大模型
    participant TS as 工具系统
    participant SB as Sandbox
    
    U->>GW: HTTP 请求
    GW->>AG: 转发请求
    
    AG->>MW: 执行前置中间件
    MW-->>AG: 上下文准备完成
    
    AG->>LLM: 发送提示词
    LLM-->>AG: 返回响应
    
    alt 需要工具调用
        AG->>TS: 调用工具
        TS->>SB: 在沙箱中执行
        SB-->>TS: 返回结果
        TS-->>AG: 工具结果
        AG->>LLM: 发送工具结果
        LLM-->>AG: 最终响应
    end
    
    AG->>MW: 执行后置中间件
    MW-->>AG: 状态更新完成
    
    AG-->>GW: 返回结果
    GW-->>U: HTTP 响应
```

### 4.2 状态管理

系统通过**状态机**管理对话的生命周期：

```mermaid
stateDiagram-v2
    [*] --> 初始化: 创建线程
    初始化 --> 运行中: 接收消息
    
    运行中 --> 等待工具: 模型请求工具
    等待工具 --> 运行中: 工具执行完成
    
    运行中 --> 完成: 模型返回结果
    等待工具 --> 错误: 工具执行失败
    运行中 --> 错误: 发生异常
    
    错误 --> 运行中: 错误恢复
    完成 --> [*]: 关闭线程
    错误 --> [*]: 终止线程
```

---

## 五、扩展机制

### 5.1 技能扩展

技能（Skill）是 EvoFlow 的**模块化扩展单元**，将相关工具和配置打包为可复用单元。

**技能结构**：

```
skill/
├── skill.yaml          # 技能元信息
├── tools.yaml          # 工具定义
├── prompts/            # 提示词模板
└── scripts/            # 辅助脚本
```

**加载机制**：

```mermaid
flowchart LR
    A[技能目录] --> B[扫描技能]
    B --> C[解析配置]
    C --> D[注册工具]
    D --> E[加入 Agent]
```

### 5.2 MCP 集成

MCP（Model Context Protocol）是**标准化的外部服务接入协议**。

**集成架构**：

```mermaid
flowchart TB
    subgraph "EvoFlow"
        AG[Agent]
        MCP[MCP 客户端]
    end
    
    subgraph "外部服务"
        S1[文件系统服务]
        S2[数据库服务]
        S3[API 服务]
    end
    
    AG --> MCP
    MCP <-->|MCP 协议| S1
    MCP <-->|MCP 协议| S2
    MCP <-->|MCP 协议| S3
```

### 5.3 子代理机制

子代理（Subagent）用于**将复杂任务分解**给专门的 Agent 处理。

**调用模式**：

```mermaid
sequenceDiagram
    participant Main as 主代理
    participant Sub as 子代理
    participant Tools as 工具集
    
    Main->>Sub: 委派任务
    
    loop 子代理执行
        Sub->>Tools: 调用工具
        Tools-->>Sub: 返回结果
    end
    
    Sub-->>Main: 返回最终结果
```

---

## 六、安全设计

### 6.1 多层防护

```mermaid
flowchart TB
    subgraph "边界防护"
        B1[API 认证]
        B2[请求限流]
    end
    
    subgraph "内容防护"
        C1[输入过滤]
        C2[输出审查]
    end
    
    subgraph "执行防护"
        E1[沙箱隔离]
        E2[权限控制]
        E3[资源限制]
    end
    
    B1 --> B2 --> C1 --> C2 --> E1 --> E2 --> E3
```

### 6.2 沙箱隔离

Sandbox 提供**代码执行的隔离环境**：

| 隔离维度 | 措施 |
|----------|------|
| **文件系统** | 虚拟路径映射，限制访问范围 |
| **网络** | 可选的网络访问控制 |
| **资源** | CPU、内存、执行时间限制 |
| **权限** | 最小权限原则 |

---

## 导航

**上一篇**：[01-项目总览](01-项目总览.md)  
**下一篇**：[03-技能系统技术文档](03-技能系统技术文档.md)

> **文档版本**：v1.0  
> **最后更新**：2026-03-30  
> **作者**：银泰

📚 返回总览：[EvoFlow技术总览](01-EvoFlow技术总览.md)
