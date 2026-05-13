# ⚡ EvoFlow

> EvoFlow 是 **Evovex AI** 旗下的**超级 Agent 驾驭框架**：通过编排**子 Agent**、**记忆系统**与**沙箱执行**完成任务，由**可扩展技能**驱动。当前提供**安装包与文档**供下载体验；欢迎在 GitHub **Star** 关注进展，**完整源码开放**将在社区成熟后另行公布。

[![官网](https://img.shields.io/badge/官网-evovexai.com-6366f1?style=flat-square)](https://www.evovexai.com)
[![联系](https://img.shields.io/badge/联系-cloud%40evovexai.com-64748b?style=flat-square&logo=gmail&logoColor=white)](mailto:cloud@evovexai.com)
[![主体](https://img.shields.io/badge/主体-Evovex%20AI-0f172a?style=flat-square)](https://www.evovexai.com)
[![仓库](https://img.shields.io/badge/仓库-EvovexAI%2FEvoFlow-181717?style=flat-square&logo=github)](https://github.com/EvovexAI/EvoFlow)


> [!NOTE]
> **EvoFlow** 定位为**超级智能体编排框架**（产品口径见官网与下文「功能说明」）。公开仓库当前以**发行版与文档**为主，便于体验与反馈；工程理念与能力继承自 [DeerFlow](https://github.com/bytedance/deerflow) **2.0** 技术路线之上的**深度改造与持续演进**，并非换名发行版。上游原始深度研究框架（v1）在 [`1.x` 分支](https://github.com/bytedance/deerflow/tree/main-1.x) 维护。

**构建与发行**

[![EvoFlow Releases](https://img.shields.io/github/v/release/EvovexAI/EvoFlow?label=EvoFlow%20Releases&logo=github)](https://github.com/EvovexAI/EvoFlow/releases)

**合规与文档**

[![许可证](https://img.shields.io/badge/许可证-AGPL--v3-blue?style=flat-square)](LICENSE)
[![文档站](https://img.shields.io/badge/文档-MkDocs-009485?style=flat-square&logo=readthedocs&logoColor=white)](docs/index.md)
[![贡献指南](https://img.shields.io/badge/贡献-CONTRIBUTING-2ea043?style=flat-square&logo=github)](CONTRIBUTING.md)

---

## 📑 目录

**产品与体验**

- [📦 获取产品与桌面端](#获取产品与桌面端)
- [✨ 功能总览](#功能总览)
- [📖 功能说明](#功能说明)
- [🏗️ 架构概览](#架构概览)

**仓库与文档**

- [📂 仓库目录说明](#仓库目录说明)
- [📚 文档与开发者索引](#文档与开发者索引)

**其他**

- [🔒 安全提示](#安全提示)
- [🤝 贡献](#贡献)
- [⚖️ 许可证](#许可证)
- [🙏 致谢](#致谢)

---

## 📦 获取产品与桌面端

| 你需要 | 入口 |
|--------|------|
| 发行版与桌面安装包 | [EvovexAI/EvoFlow Releases](https://github.com/EvovexAI/EvoFlow/releases) |
| 下载说明 | [downloads.md](docs/getting-started/downloads.md) |

**EvoPanel** 是面向使用者的桌面客户端（基于 Tauri v2），连接 Gateway 完成对话、任务与编排操作。源码见 [`evopanel/`](evopanel/)，维护说明见 [evopanel/README.md](evopanel/README.md)。

自托管、从源码运行与部署细节见 [文档与开发者索引](#文档与开发者索引) 及 [CONTRIBUTING.md](CONTRIBUTING.md)。

---

## ✨ 功能总览

下列三表分别对应：**产品差异化（与官网支柱一致）**、**桌面端能力**、**服务端 / 扩展能力**。操作细节以 [EvoPanel 使用指南](docs/guides/evopanel-guide.md) 为准；具体范围以当前发行说明与文档为准。

### 🎯 1. 核心特色（八大支柱 + 编排主轴）

| 特色 | 要解决什么 | 产品抓手 |
|------|------------|----------|
| **长任务与可恢复编排** | 多步任务易中断、难闭环 | 跨会话监督、排队与重试，必要时局部重编排，尽量闭环到验收 |
| **超级总控智能体（Supervisor）** | 缺乏全局调度、任务-能力匹配低效、并行度不足、执行过程黑盒 | 澄清意图→方案规划→拆解为有向无环子任务依赖图；支持基于子智能体能力画像的任务精准分发，能力与任务最优匹配；子任务间结构化上下文自动传递；总控全链路感知子智能体运行状态，支持全局进度调控、异常纠错与局部重编排 |
| **Claude Code 多会话协同** | 编码类任务效率低、多编码任务并行难 | 直连Claude Code交互，也可作为子代理承接编码/调试专项任务，支持多Claude Code会话并行分工与结果汇总 |
| **托管智能体与长期任务托管** | 后台长期运行任务需要人工值守，运行状态难观测 | 独立沙箱隔离，支持7×24小时后台托管运行，实时查看状态与日志，支持暂停/恢复/终止，结果可追溯 |
| **场景与工作阶段** | 误触与上下文失控 | 按任务切换形态；先规划、再确认、后执行 |
| **工具渐进暴露 · 技能 / MCP** | 首轮工具过大、浪费 Token | 核心能力先行，扩展按需挂载；与市场 / 治理白名单联动 |
| **记忆 · 任务状态 · 主线快照与编排闭环** | 长对话漂移、规划与落地脱节 | 会话 / 任务状态与主线快照；子问题进度回注；Plan 闸口与 DAG、护栏收口、观测与交付一体化表述 |
| **智能体进化** | 专员化与技能迭代难统一治理 | 智能体管理（模型、工具白名单、扩展与技能注入）与技能生命周期协同；配置优化后运行侧可重载，与治理白名单及工具渐进暴露配套 |

### 🖥️ 2. EvoPanel（界面能力一览）

完整说明见 [EvoPanel 使用指南](docs/guides/evopanel-guide.md)；与网关的连接方式随部署而定。

| 功能域 | 要点 |
|--------|------|
| **对话模式** | Chat · Plan · Execute · Infinite；与 thinking / 规划 / 子代理等开关组合（见指南） |
| **实时聊天** | 流式输出、Markdown、多模态、工具调用过程可视化 |
| **模型配置** | 模型切换、thinking / vision、多提供商与网关地址 |
| **任务中心** | 创建与监控任务、批量操作、历史记录 |
| **多代理与项目** | 项目维度、Supervisor 协调、上下文隔离 |
| **Agent 管理** | 人设与身份、按 Agent 的模型与工具、记忆隔离 |
| **工具与技能** | 技能浏览与启停、归档安装、MCP 状态 |
| **IM 渠道** | 桌面侧配置连接器与会话映射（飞书、Slack、Telegram 等以版本为准） |
| **定时任务** | Cron、可选编排运行时与飞书推送；线程策略 |
| **记忆管理** | 全局与按 Agent 记忆、导入导出、外部记忆插件 |
| **主题与本地化** | 明暗主题、多语言（以客户端为准） |

### ⚙️ 3. 运行时 / Gateway / 扩展

| 类别 | 功能 | 文档 |
|------|------|------|
| **编排运行时** | LangGraph、子 Agent、中间件 | [运维手册](docs/guides/operations-handbook.md) |
| **Gateway API** | REST、模型 / 技能 / 任务 / 自动化 | [API 参考](docs/reference/api-reference.md) |
| **多模型** | 兼容 OpenAI 的服务商与网关 | [配置参考](docs/reference/config-reference.md) |
| **沙箱** | 本地 / 容器 / K8s | [沙箱配置](docs/guides/sandbox-config.md) |
| **护栏** | 工具调用前策略 | [护栏](docs/guides/guardrails.md) |
| **文件上传** | 多文件与文档解析 | [文件上传](docs/guides/file-upload.md) |
| **视觉** | 多模态与模型能力 | [配置参考](docs/reference/config-reference.md) |
| **MCP** | 扩展传输与接入 | [MCP](docs/guides/mcp-server.md) |
| **ACP** | 外部 ACP 兼容 Agent | [后端文档索引](backend/docs/README.md) |
| **自动化调度** | 周期任务与推送 | [自动化调度](docs/guides/automation-scheduler.md) |
| **记忆（数据面）** | 持久化与注入策略 | [记忆管理](docs/guides/memory-management.md) |
| **Plan 模式（护栏）** | 规划期拦截等 | [Plan 模式](docs/guides/plan-mode.md) |

---

## 📖 功能说明

本节与 **[官网 · 能力矩阵](https://www.evovexai.com/#capabilities)** 对齐；线上正文为准。中文同源文案：[website/packages/content/src/home.ts](website/packages/content/src/home.ts)（`homeContentByLocale.zh`）。

**阅读顺序：** 定位 → Supervisor / Plan → 八条支柱 → 编排与执行 → 四层架构 → 五步闭环 → 运行能力说明 → 典型场景。

### 🧭 定位

面向「多步、跨日、跨系统」的长任务：普通闲聊界面往往缺少**可恢复的总控状态**，又把工具和长提示堆进上下文，推高 **Token 与费用**。EvoFlow 用 **Supervisor** 作单一控制面——在多轮澄清中对齐意图与边界，形成可执行的 **Plan**，再展开为带依赖的子任务直至交付；并用**分阶段协作**与**工具渐进暴露**（冷启动不摊全量工具、按需挂载）控制上下文规模。

### 🎛️ 控制面：Supervisor 与 Plan 模式

- **Supervisor**：**澄清**（Plan 前明确范围、非目标与验收）→ **分解**（Plan → 子任务 DAG，管理分支与汇合）→ **监督**（全局与子任务状态，纠错、重试、局部重编排）。
- **Plan 模式**：在大量工具调用前固化目标与验收条件，降低返工；目标变化时由 Supervisor **再对齐**并更新后续结构。官网「五步闭环」的第一步即规划对齐。

### 🏛️ 核心差异化 · 八大支柱

| 支柱 | 说明 |
|------|------|
| **长任务与可恢复编排** | 跨会话仍可监督与重试，必要时局部重编排，尽量闭环到验收。 |
| **超级总控智能体（Supervisor）多智能体协作** | 全局总控统一调度，基于子智能体能力画像做任务精准分发，实现能力与任务最优匹配；子智能体支持并行执行，子任务间结构化上下文自动传递；总控全链路感知子智能体运行状态，支持全局进度调控、异常纠错与局部重编排；全流程可解释、可追溯。 |
| **Claude Code 多会话协同** | 支持与 Claude Code 实时对话交互，也可在超级总控模式下作为子代理承接编码、调试等专项任务；支持多 Claude Code 会话并行分工与结果汇总，兼顾自主交互与编排管控能力。 |
| **托管智能体与长期任务托管** | 针对持续运行的后台任务：独立沙箱隔离执行，支持7×24小时后台托管运行，实时监控运行状态与输出日志，支持暂停、恢复与终止操作，运行结果与日志持久化可追溯，适合巡检、监控、自动化运维等需要长期驻留的任务场景。 |
| **场景与工作阶段** | 不同任务形态配合「先规划、再确认、后执行」，降低误触。 |
| **工具渐进暴露与技能 / MCP** | 核心能力先行，扩展按需挂载；市场安装与治理白名单配合。 |
| **核心问题与子问题状态** | 紧扣主线与验收；多线时用子问题快照回注，减少跑偏。 |
| **智能体进化** | 将智能体配置治理与技能包生命周期放在同一能力面：维护模型、工具分组与白名单、外部扩展与技能说明注入；技能的启用、说明与资源更新与智能体定义协同迭代，变更可被运行侧重新读取，总控对话中出现的技能名与当前启用及允许范围一致。 |

### 🔀 编排与执行（两大主轴）

**编排** — Plan 审定后展开为显式依赖的子任务；步骤间传递结构化上下文与工件；异步分支在闸口汇合。适用于工单、运维、研发流水线与跨日项目。要点：Plan 固化验收口径；DAG 驱动下游；并行与汇合可控；监督侧可视与局部重编排；主线快照在方向变化时再对齐。

**执行** — 子任务在目标环境调用工具与外部 API，受策略约束；结果回写上下文并进入观测。高风险动作可按部署启用**沙箱**隔离影响；是否启用取决于环境与策略。

### 🏢 产品架构 · 四层

| 层次 | 模块 | 要点 |
|------|------|------|
| **编排与执行** | 编排运行时 | 超级总控（Supervisor）/ 子智能体、中间件与工具装配；支持基于子智能体能力画像的任务精准分发，任务与能力最优匹配；子智能体支持并行执行，子任务间结构化上下文自动传递；长任务执行中仍可在对话侧实时干预编排，并同步查看子任务进度与产出。 |
| | 沙箱 | 隔离环境承载命令、文件与解析等高风险动作。 |
| **状态与工具** | 记忆与任务状态 | 长期记忆、会话与任务状态、主线快照；注入可按策略开关。 |
| | 技能与 MCP | 技能包与 MCP 扩展；与市场及治理策略配合。 |
| **渠道与终端** | IM | 飞书、Slack、Telegram 等与同一运行时对接 → [IM 渠道指南](docs/guides/im-channels.md)。支持 `/claude`（直连 Claude Code，可选会话ID续接）、`/new`（新建会话线程）、`/lead`（切回主智能体）、`/status`（查看会话状态）等命令。 |
| | EvoPanel | 主操作面：对话、线程与任务、场景、自动化与观测。 |
| | 研发协同 | 可与 Claude Code 等外部助手协同（以版本与配置为准），IM 侧支持直接唤起 Claude Code 会话并续接历史。 |
| **治理与运维** | 护栏与自动化 | 工具策略、轨迹与观测；定时任务与渠道投递。 |
| | 任务与观测 | 重跑、进度与结果查询，便于验收与排障。 |
| | 治理与工作空间 | 按任务 / 线程隔离；管控提示词、工具、技能与自动化策略。 |

### 🔁 从编排到交付 · 五步闭环

1. **规划对齐** — 谁规划、目标、边界与验收标准。  
2. **分解执行** — 子任务分工、依赖、异步与汇合。  
3. **受控落地** — 工具与外部调用；护栏收敛权限；轨迹可解释。  
4. **状态与集成** — 记忆与任务沉淀；技能与渠道接入外部系统。  
5. **观测与交付** — 进度可视、人工纠错；定时与推送收口。

### 🧩 运行能力说明

与官网首页「运行能力说明」一致，便于仓库内对照口径。

| 能力 | 摘要 |
|------|------|
| **EvoPanel** | 与网关直连的桌面主界面：对话、线程与任务、场景与自动化入口；服务端承载编排语义，桌面侧重呈现与控制台（含外部编码助手输出流）。 |
| **Claude Code 编排** | 总控将编码、改库、排错等委派给本机或既有 Claude Code；同会话多轮往返；产出回流桌面对照验收。 |
| **场景切换** | 默认对话、规划与执行、文件与命令、联网检索、治理与自动化等；多场景并存时工具取并集，避免无关工具长期占用上下文。 |
| **工具渐进暴露与技能 / MCP** | 首轮精简工具说明，扩展按需挂载；市场统一管理安装项并与治理配置衔接。 |
| **长期记忆** | 要点写入本机知识库文件，按会话与全局组织；关键词检索（与站内向量检索等不同通路）。 |
| **工作空间** | 单次运行可指定工作目录；绑定根路径后文件与命令能力在约定范围内；是否允许写盘与执行命令由策略决定。 |
| **定时任务** | 按周期扫描自动化描述并触发；可配置周期、提示词、是否走编排运行时、是否推送飞书等；与聊天窗内人工任务相互独立。 |
| **智能体进化** | 与上文「八大支柱」之智能体进化一致；运行能力矩阵中侧重 EvoPanel / 网关侧的启停、热更新与总控可见性等入口级提示。 |

### 典型场景（示意）

官网「典型场景」列举多种搭法（长任务与多代理编码、定时汇报、专员智能体、记忆助手、跨系统办事、运维并行等）。均需自行对接系统与配置，**不是开箱行业方案**。详见线上正文或 [`home.ts`](website/packages/content/src/home.ts) 中 `scenariosSection`。

---

## 🏗️ 架构概览

```
┌────────────────────┐     ┌─────────────────────────────┐
│  EvoPanel          │     │  IM 渠道                     │
│  （桌面客户端）     │     │  飞书 · Slack · Telegram 等   │
└─────────┬──────────┘     └──────────────┬──────────────┘
          │                               │
          └───────────────┬───────────────┘
                          ▼
          ┌───────────────────────────────┐
          │  LangGraph 编排运行时           │
          └───────────────┬───────────────┘
                          ▼
          ┌───────────────────────────────┐
          │  Gateway（FastAPI）           │
          └───────────────┬───────────────┘
                          ▼
          ┌───────────────────────────────┐
          │  沙箱（可选）                   │
          └───────────────────────────────┘
```

**LangGraph** 承载编排语义；**Gateway** 提供对外 API 与控制面；**EvoPanel** 为主界面；**沙箱**隔离高风险执行。端口与部署拓扑见 [运维手册](docs/guides/operations-handbook.md)。

---

## 📂 仓库目录说明

| 路径 | 标签 | 说明 |
|------|------|------|
| [backend/](backend/) | `FastAPI` · `LangGraph` | Gateway、编排运行时、渠道与工具 |
| [evopanel/](evopanel/) | `Tauri` · `桌面` | EvoPanel 客户端 |
| [website/](website/) | `Next.js` · `营销` | 官网与展示站点 |
| [skills/](skills/) | `Skills` | 技能包（公开示例见 [skills/public/](skills/public/)） |

---

## 📚 文档与开发者索引

**MkDocs 文档站**源码在 [docs/](docs/)；本地构建说明见 [CONTRIBUTING.md](CONTRIBUTING.md)。

面向集成、运维与代码贡献时，除 [功能总览](#功能总览) 与 [功能说明](#功能说明) 外，可按下表跳转（字段与 API 以当前分支为准）。

| 主题 | 文档 |
|------|------|
| 文档总目录 | [docs/index.md](docs/index.md) |
| 下载与版本 | [docs/getting-started/downloads.md](docs/getting-started/downloads.md) |
| EvoPanel 版本变更记录 | [evopanel/CHANGELOG.md](evopanel/CHANGELOG.md)
| 配置与模型 | [docs/reference/config-reference.md](docs/reference/config-reference.md) |
| Gateway API | [docs/reference/api-reference.md](docs/reference/api-reference.md) |
| 运维与拓扑 | [docs/guides/operations-handbook.md](docs/guides/operations-handbook.md) |
| 沙箱 | [docs/guides/sandbox-config.md](docs/guides/sandbox-config.md) |
| 记忆 | [docs/guides/memory-management.md](docs/guides/memory-management.md) |
| 自动化调度 | [docs/guides/automation-scheduler.md](docs/guides/automation-scheduler.md) |
| Plan 模式 | [docs/guides/plan-mode.md](docs/guides/plan-mode.md) |
| 护栏 | [docs/guides/guardrails.md](docs/guides/guardrails.md) |
| 文件上传 | [docs/guides/file-upload.md](docs/guides/file-upload.md) |
| IM 渠道 | [docs/guides/im-channels.md](docs/guides/im-channels.md) |
| MCP | [docs/guides/mcp-server.md](docs/guides/mcp-server.md) |
| 后端索引 | [backend/docs/README.md](backend/docs/README.md)、[backend/CLAUDE.md](backend/CLAUDE.md) |

---

## 🔒 安全提示

> [!WARNING]
> EvoFlow 具备命令执行、文件与网络访问等高权限能力，默认适合**本地可信环境**（例如仅监听 `127.0.0.1`）。

若需跨网络访问，请自行配置防火墙、反向代理认证与最小暴露面；勿将未加固实例直接暴露到公网。

---

## 🤝 贡献

欢迎贡献。环境与流程见 [CONTRIBUTING.md](CONTRIBUTING.md)；新特性与修复请尽量附带可维护的自动化测试。

---

## ⚖️ 许可证

本项目基于 [GNU AGPLv3](LICENSE) 发布。

---

## 🙏 致谢

| 项目 | 说明 |
|------|------|
| [LangChain](https://github.com/langchain-ai/langchain) | LLM 抽象与工具生态 |
| [LangGraph](https://github.com/langchain-ai/langgraph) | 图式 Agent 编排 |
| [DeerFlow](https://github.com/bytedance/deerflow) | 2.0 基线来源 · 感谢 ByteDance 团队上游开源贡献 |
