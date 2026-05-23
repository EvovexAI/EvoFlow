# EvoFlow 项目介绍

> EvoFlow 是 **Evovex AI** 旗下的**超级 Agent 驾驭框架**——通过编排子 Agent、记忆系统和沙箱执行来完成几乎所有任务，由可扩展技能驱动。当前以**发行版与文档**便于体验为主；完整源码开放节奏见 GitHub 仓库说明。
>
> **Evovex** 迭代进化 重塑 AI 新范式。英文：*EvoVex, AI Evolve Beyond Complexity*。

## 一句话了解 EvoFlow

EvoFlow 是一个基于 LangGraph 构建的 AI Agent 运行时。你给它一个目标，它会自主规划、调用工具、委派子 Agent、读写文件、执行命令——直到任务完成。

## 核心概念

### Agent

Agent 是 EvoFlow 的核心。每个 Agent 拥有：
- **SOUL**（灵魂）：决定它的性格、角色和行为方式
- **模型**：驱动它思考的 LLM
- **工具**：它能执行的操作（搜索、编码、文件读写等）
- **记忆**：跨会话积累的知识和偏好

### 技能（Skills）

技能是结构化的能力模块（`SKILL.md` 格式），让 Agent 能做特定类型的工作。EvoFlow 内置 100+ 公开技能，覆盖内容创作、媒体处理、开发工具等领域。另有一组 **`superpowers-*` 开发流程技能**（源自 Superpowers，MIT），与长任务规格/计划/子代理执行纪律配套；结构化产出路径约定见 `docs/evoflow/artifacts/README.md`。

### 沙箱（Sandbox）

每个任务在隔离的执行环境中运行，拥有独立的文件系统视图。支持本地、Docker、Kubernetes 三种模式。

### 子 Agent（Subagents）

复杂任务会被拆解，主 Agent 委派多个子 Agent 并行执行，最后综合结果。

### 记忆系统（Memory）

Agent 会记住你的偏好、工作风格和积累的知识，跨会话持续学习。

## 架构一览

```
┌─────────────────┐     ┌──────────────────┐
│   EvoPanel      │     │   IM Channels    │
│   (Tauri v2)    │     │ (飞书/Slack/等)  │
└────────┬────────┘     └────────┬─────────┘
         └───────────┬───────────┘
                     ▼
         ┌───────────────────────┐
         │   LangGraph Server    │
         │   Agent 运行时        │
         └───────────┬───────────┘
                     ▼
         ┌───────────────────────┐
         │   Gateway API         │
         │   (REST API)          │
         └───────────┬───────────┘
                     ▼
         ┌───────────────────────┐
         │   Sandbox             │
         │   Local/Docker/K8s    │
         └───────────────────────┘
```

## 下一步

- [安装指南](installation.md) — 在本地部署 EvoFlow
- [5 分钟快速上手](quick-start.md) — 完成第一个对话
