# ⚡ EvoFlow

> EvoFlow 是一个开源的**超级 Agent 驾驭框架**——通过编排**子 Agent**、**记忆系统**和**沙箱执行**完成任务，由**可扩展技能**驱动。

**对外官网**：[www.evovexai.com](https://www.evovexai.com) · **联系**：cloud@evovexai.com · **主体**：Evovex AI · **仓库**：[EvovexAI/EvoFlow](https://github.com/EvovexAI/EvoFlow)


> [!NOTE]
> **EvoFlow** 是开源的**超级智能体编排框架**（产品定位见官网与本文「功能说明」）；工程在 [DeerFlow](https://github.com/bytedance/deerflow) **2.0 代码基线之上深度改造与持续演进**，并非「换名发行版」。上游原始深度研究框架（v1）在 [`1.x` 分支](https://github.com/bytedance/deerflow/tree/main-1.x) 维护。

[![EvoFlow Releases](https://img.shields.io/github/v/release/EvovexAI/EvoFlow?label=EvoFlow%20Releases&logo=github)](https://github.com/EvovexAI/EvoFlow/releases)
[![Windows desktop CI](https://img.shields.io/github/actions/workflow/status/EvovexAI/EvoFlow/evopanel-windows-package.yml?label=Windows%20desktop%20CI&logo=github)](https://github.com/EvovexAI/EvoFlow/actions/workflows/evopanel-windows-package.yml)
[![EvoPanel Releases](https://img.shields.io/github/v/release/YT/evopanel?label=EvoPanel&logo=github)](https://github.com/YT/evopanel/releases/latest)

---

## 仓库组成

| 路径 | 说明 |
|------|------|
| [`backend/`](backend/) | Gateway（FastAPI）、LangGraph 运行时、渠道与工具 |
| [`evopanel/`](evopanel/) | EvoPanel 桌面客户端（Tauri） |
| [`website/`](website/) | 营销站（Next.js，可选） |
| [`skills/`](skills/) | 技能包（公开示例主要在 [`skills/public/`](skills/public/)） |
| [`docs/`](docs/) | MkDocs 文档源 |

---

## 目录

- [获取产品](#获取产品)
- [EvoPanel 桌面端](#evopanel-桌面端)
- [功能总览](#功能总览)
- [功能说明](#功能说明)
- [开发者文档索引](#开发者文档索引)（配置、API、运维等 — 面向集成与贡献者）
- [架构概览](#架构概览)
- [文档与支持](#文档与支持)
- [⚠️ 安全提示](#️-安全提示)
- [贡献](#贡献)
- [许可证](#许可证)
- [致谢](#致谢)

## 获取产品

| 你需要 | 说明 |
|--------|------|
| **本仓库发行版** | [EvovexAI/EvoFlow Releases](https://github.com/EvovexAI/EvoFlow/releases)（附件以页面为准） |
| **Windows 安装包（CI 产物）** | 在 [EvoPanel Windows Package](https://github.com/EvovexAI/EvoFlow/actions/workflows/evopanel-windows-package.yml) 中打开最近一次成功运行，于 **Artifacts** 下载 `evopanel-windows-nsis` |
| **EvoPanel 官方安装包** | [EvoPanel Releases](https://github.com/YT/evopanel/releases/latest) |
| **下载说明与版本差异** | [docs/getting-started/downloads.md](docs/getting-started/downloads.md) |

自托管网关、从源码运行、端口与 Docker 等**开发与部署**步骤不在此罗列；请参阅 [文档与支持](#文档与支持) 中的入门与运维文档，或仓库内 [CONTRIBUTING.md](CONTRIBUTING.md)。

## EvoPanel 桌面端

[EvoPanel](https://github.com/YT/evopanel) 基于 **Tauri v2**，作为面向用户的桌面壳层，连接本仓库 **Gateway** 使用。

- 对话、任务与编排相关 UI；技能 / MCP 与后端配置联动（细节以当前版本为准）。
- 与 IM 渠道、定时任务等能力配合时，以后端实现与文档为准。

桌面端能力细节与维护者说明见 **[evopanel/README.md](evopanel/README.md)**；终端用户安装包见 [EvoPanel Releases](https://github.com/YT/evopanel/releases/latest)。

## 功能总览

下表汇总 **官网产品定位**、**EvoPanel 桌面端**（操作细节以 [docs/guides/evopanel-guide.md](docs/guides/evopanel-guide.md) 为准）与 **运行时 / Gateway**。具体范围以当前发行说明与文档为准。

### 表 1 — 核心特色（与官网「五条支柱 + 编排主轴」对应）

| 特色 | 要解决什么 | 产品上有哪些抓手 |
|------|------------|------------------|
| **长任务与可恢复编排** | 多步任务易中断、难闭环 | 跨会话监督、排队与重试，必要时局部重编排，对齐验收而非停在半截对话 |
| **Supervisor 多智能体** | 缺少总控与分工边界 | 单一总控路径：澄清意图 → Plan → 子任务 DAG → 监督与纠错；子智能体分工，「谁规划、谁执行、何时汇合」可复述 |
| **场景与工作阶段** | 误触与上下文失控 | 按任务类型切换工作形态；「先规划、再确认、后执行」，规划阶段对齐目标与约束 |
| **工具渐进暴露 · 技能 / MCP 市场** | 首轮工具清单过大、Token 浪费 | 冷启动挂核心与检索类能力，扩展按需挂载；技能市场 / MCP 市场安装与治理面白名单联动 |
| **记忆 · 任务状态 · 主线快照** | 长对话漂移、验收口径丢失 | 会话/任务状态与主线意图快照；核心问题与子问题进度回注（详见下文功能说明） |
| **编排 ↔ 执行闭环** | 规划与落地脱节 | Plan 闸口与 DAG 依赖；子任务受策略与护栏约束执行；观测、定时与飞书等交付收口 |

### 表 2 — EvoPanel 桌面端（GUI 能力一览）

桌面端完整说明见 **[EvoPanel 使用指南](docs/guides/evopanel-guide.md)**；与网关的默认连接地址随你的部署环境而定，详见该指南。

| 功能域 | 能力要点 |
|--------|----------|
| **对话模式** | **Chat**（快问快答）· **Plan**（规划分析）· **Execute**（执行任务）· **Infinite**（复杂多步）；通过 `thinking_enabled` / `is_plan_mode` / `subagent_enabled` 等开关组合（见指南表格） |
| **实时聊天** | 流式输出、Markdown（代码块/表格等）、多模态（图片等）、工具调用过程可视化 |
| **模型配置** | 选择当前模型；thinking / vision；新增提供商（OpenAI、Anthropic、Google、DeepSeek 等）；Base URL 与 API Key |
| **任务中心** | 从模板或自定义创建任务；监控执行与输出；批量启停删；执行历史 |
| **多代理协作 · 项目** | 项目维度组织多 Agent；配置 **Supervisor** 协调分配；项目级会话与上下文隔离 |
| **Agent 管理** | 编辑 SOUL / IDENTITY；按 Agent 指定模型与工具集；**记忆按 Agent 隔离** |
| **工具与技能** | 浏览 `skills/public/`、`skills/custom/`；启停技能；`.skill` 归档安装；**MCP** 启用状态 |
| **IM 渠道** | 在桌面侧配置各渠道与连接状态、会话/线程映射；Gateway 已落地的连接器（常见：飞书、Slack、Telegram）以当前版本与文档为准 |
| **定时任务** | Cron 调度；可选走 LangGraph、飞书推送；线程模式 **fresh / sticky** |
| **记忆管理** | 查看/编辑全局与按 Agent 记忆；导入导出 `memory.json`；外部记忆插件配置 |
| **主题与本地化** | 亮/暗主题；多语言界面（具体语言列表以客户端版本为准） |

### 表 3 — 运行时 / Gateway / 扩展（非桌面独占）

| 类别 | 功能 | 说明或入口 |
|------|------|------------|
| **编排运行时** | LangGraph、子 Agent、中间件链 | 与 Gateway 协同；拓扑见 [运维手册](docs/guides/operations-handbook.md) |
| **Gateway API** | REST、模型/技能/任务/自动化等 | [docs/reference/api-reference.md](docs/reference/api-reference.md) |
| **多模型** | OpenAI 兼容、网关 URL、可选 CLI 后端 | [docs/reference/config-reference.md](docs/reference/config-reference.md) |
| **沙箱** | 本地 / Docker / K8s provisioner | [docs/guides/sandbox-config.md](docs/guides/sandbox-config.md) |
| **护栏** | 工具调用前策略审核 | [docs/guides/guardrails.md](docs/guides/guardrails.md) |
| **文件上传与解析** | 多文件、文档转可读文本等 | [docs/guides/file-upload.md](docs/guides/file-upload.md) |
| **视觉** | 模型视觉能力与多模态输入 | [docs/reference/config-reference.md](docs/reference/config-reference.md) |
| **MCP** | 多种传输方式的扩展接入 | [docs/guides/mcp-server.md](docs/guides/mcp-server.md) |
| **ACP** | 调用外部 ACP 兼容 Agent | [后端文档索引](backend/docs/README.md) |
| **自动化调度** | 周期任务、飞书推送等 | [docs/guides/automation-scheduler.md](docs/guides/automation-scheduler.md) |
| **记忆（数据面）** | 会话与全局记忆的持久化与注入策略 | [docs/guides/memory-management.md](docs/guides/memory-management.md) |
| **Plan 模式（护栏）** | 规划期写操作拦截等 | [docs/guides/plan-mode.md](docs/guides/plan-mode.md) |

---

## 功能说明

本节写出 EvoFlow **对外承诺的核心能力**，叙述与 **[官网首页 · 能力矩阵](https://www.evovexai.com/#capabilities)** 一致；完整措辞与后续改版以线上为准。中文文案同源维护于 [`website/packages/content/src/home.ts`](website/packages/content/src/home.ts)（`homeContentByLocale.zh`）。

### 定位

面向「多步、跨日、跨系统」的智能体长任务：闲聊式界面往往缺少**总控与可恢复状态**，工具与长提示一把塞进上下文又会推高 **Token 与费用**。EvoFlow 以 **Supervisor（超级总控智能体）** 为单一控制面：在多轮澄清里对齐意图与边界，形成可执行的 **Plan**，再展开为带依赖关系的子任务直至闭环交付；同时用 **分阶段协作** 与 **工具渐进暴露**（冷启动不摊开大清单、扩展按需挂载）把上下文压在必要范围内。

### 控制面：Supervisor 与 Plan 模式

- **Supervisor**：面向长周期任务的总控路径——**澄清**（订立 Plan 前明确目标范围、非目标与验收口径）→ **分解**（将 Plan 落实为有向子任务图/DAG，管理先后、分支、汇合与上下文传递）→ **监督**（掌握全局与子任务状态，支持纠错、重试与局部重编排）。
- **Plan 模式**：在工具调用与执行细化之前，把目标与验收条件固化在 Plan 里，降低返工成本；当目标或边界变更时，由 Supervisor **再对齐**并同步更新后续子任务结构。上述机制驱动首页所示的「五步闭环」，第一步即规划对齐（Plan 入口）。

### 核心差异化 · 五条支柱

| 支柱 | 说明 |
|------|------|
| **长任务与可恢复编排** | 跨系统与跨会话仍可监督、排队与重试，必要时局部重编排，尽量跑到验收而非停在半截对话。 |
| **多智能体与 Supervisor** | 总控统筹目标与节奏，子智能体分工执行；「谁规划、谁执行、何时汇合」在编排层可复述、可对外讲解。 |
| **场景与工作阶段** | 按任务类型进入不同工作形态，并与「先规划、再确认、后执行」等阶段配合，降低误触风险。 |
| **工具渐进暴露与技能 / MCP 市场** | 冷启动只挂核心与检索类能力，扩展按需挂载；技能市场、MCP 市场用于安装与统一管理，并与治理面启用范围配合。 |
| **核心问题与子问题状态** | 抓住主线目标与验收边界；多线事项时维护带子问题的进度快照并回注后续回合，减少跑偏。 |

### 编排与执行（能力矩阵 · 两大主轴）

**编排（Plan、依赖与观测）** — 与「澄清—分解—监督」一致：Plan 审定后展开为显式依赖的子任务；步骤间用结构化上下文与工件传递；异步分支在同步闸口汇合。适用于工单链路、运维处置、研发流水线及跨日项目。要点包括：Plan 闸口固化验收口径；DAG 解锁下游与共享上下文；并行与同步闸口可控汇合；监督侧全局/子任务可视与局部重编排；主线快照（含按需子问题）回注，方向变更时再对齐。

**执行（子任务与策略约束）** — 子任务在目标环境中调用工具、脚本与外部 API，须符合策略边界；结果回写共享上下文并进入遥测；鉴权决策可追溯、可审计。高风险操作可按部署启用**隔离执行（沙箱）**以收敛影响半径；沙箱为可选加固能力，是否开启取决于你的环境与配置。

### 产品架构 · 四层

| 层次 | 模块 | 要点 |
|------|------|------|
| **编排与执行** | 编排运行时 | Supervisor / 子智能体、中间件与工具装配；长任务执行中仍可在对话里继续编排，并流式查看子任务产出。 |
| | 沙箱执行 | 隔离执行环境，承载命令、文件与解析等高风险动作。 |
| **状态与工具** | 记忆与任务状态 | 长期记忆、会话与任务状态、主线意图快照；记忆注入可按策略开关，并与线程工作空间数据面配套。 |
| | 技能与 MCP | 技能包与 MCP 扩展业务工具；技能市场、MCP 市场浏览安装与治理面启用范围、工具组合策略相配合。 |
| **渠道与终端** | IM 渠道 | 飞书、Slack、Telegram 等与同一运行时对接；详见 [IM 渠道指南](docs/guides/im-channels.md)。 |
| | EvoPanel 桌面端 | 与网关直连的主操作面：对话、线程与任务、场景切换、自动化与观测入口。 |
| | 研发协同 | 与 Claude Code 等外部编码助手协同；子任务可委派至部署侧配置的外部助手（以当前版本与配置为准）。 |
| **治理与运维** | 护栏与自动化 | 工具调用策略、执行轨迹与观测；定时/持续类任务可托管，并可向飞书等渠道投递结果。 |
| | 任务中心与观测 | 任务可重跑；查询进度、状态与结果，便于排障与验收对齐。 |
| | 治理与工作空间 | 按任务/线程隔离工作空间；管控智能体提示词、工具与技能，及关联的定时与自动化策略。 |

### 从编排到交付 · 五步闭环

1. **规划对齐（Plan 入口）** — 明确谁规划、核心目标、边界与验收标准。  
2. **分解执行** — 谁执行子任务、依赖先后、异步与汇合。  
3. **受控落地** — 子任务实际调用工具与外部接口；护栏与策略收敛权限，轨迹可解释。  
4. **状态与集成** — 记忆与任务状态沉淀；技能与渠道把外部系统接进编排。  
5. **观测与交付** — 进度可视、人工纠错与收口；定时与推送汇总结果。

### 运行能力说明（官网「运行能力说明」分条）

下列条目与官网首页能力矩阵下方「运行能力说明」一致，便于在仓库内对照产品口径。

#### EvoPanel

核心桌面客户端：与网关直连，承载实时对话、线程与任务、协作阶段与场景切换，以及自动化、观测等高频入口；服务端负责策略与编排语义，桌面端负责呈现与控制台视图（含委派外部编码助手时的输出流）。主工作台适合值班与业务侧日常编排；总控在服务端推进子任务时，桌面侧可并行查看进度、切换场景、对照轨迹；任务中心、定时规则、联调排障等入口集中，减少在多工具间跳转。

#### Claude Code 编排

以外部子代理接入：总控可将编码、改库、排错等委派给本机或既有 Claude Code 环境，编排侧下达与收口；同一会话内可多轮往返，不必每句追问都建新会话。产出流式回传到桌面控制台，便于与主线编排对照验收。

#### 场景切换

提供多种工作场景（如默认对话、规划与执行、文件与命令、联网检索、治理与自动化等）。可按需启用或退出；多场景并存时，可调用的工具为合并结果，避免无关工具长期占上下文。规划侧重先做方案与子任务编排；文件侧重在明确需要读写或命令时再启用；联网侧重外部检索；治理侧重智能体/技能管理与定时自动化（改定时规则应走自动化能力，勿与纯规划对话混淆）。

#### 工具渐进暴露与技能 / MCP 市场

首轮不挂全量可选工具说明，核心与检索类先行，扩展在确认需要时再挂载，缩短提示与首响；可与场景合并后的工具白名单一起裁剪误触。技能市场、MCP 市场支持安装、启用、卸载与统一管理已接入项，并与智能体治理配置衔接。技能执行仍遵循先读说明、再按步骤调用。

#### 长期记忆与上下文治理

提供写入记忆与回忆：把多轮间需保留的要点写入本机知识库文件，按会话隔离并支持全局条目，检索为关键词匹配（与「站内在线助手资料检索 / 向量索引」属不同通路，请勿混用）。便于备份迁移与排障；可与任务协作、线程状态等机制搭配。

#### 工作空间

定时自动化与本地执行可为单次运行指定工作目录；桌面或网关侧可绑定本机根路径，使文件类与命令类能力在约定范围内操作。是否允许写盘与执行系统命令由部署与安全策略决定。

#### 定时任务

网关按周期扫描自动化任务目录中的描述文件，到期触发；可配置周期、提示词、是否在触发时走编排运行时、是否向飞书推送摘要等。每次触发为独立自动化运行，与当前聊天窗内的人工编排任务不同。

#### 智能体进化

在同一能力面维护「智能体配置」与「技能包生命周期」：智能体侧可配置模型、工具分组与白名单、外部扩展与可选技能说明注入；技能侧可启停、修订说明与资源，变更可被运行侧重新读取，总控对话中出现的技能名与启用范围一致。

### 典型场景（示意）

官网「典型场景」给出六种搭法（长任务与多子代理编码、定时与飞书汇报、专员智能体与技能进化、记忆与内部助手、跨系统办事、运维并行处置等）：均需自行对接系统与配置，**不是开箱即用的行业方案**。详见线上正文或 [`home.ts`](website/packages/content/src/home.ts) 中 `scenariosSection`。

---

## 开发者文档索引

面向**自托管、集成与贡献**：产品能力与界面操作仍以 [功能总览](#功能总览)、[功能说明](#功能说明) 与 [EvoPanel 使用指南](docs/guides/evopanel-guide.md) 为准；下表指向常见技术主题（具体字段与 API 以当前分支文档为准）。

| 主题 | 文档 |
|------|------|
| 文档总目录 | [docs/index.md](docs/index.md) |
| 下载与版本 | [docs/getting-started/downloads.md](docs/getting-started/downloads.md) |
| `config.yaml` / 模型 | [docs/reference/config-reference.md](docs/reference/config-reference.md) |
| Gateway API | [docs/reference/api-reference.md](docs/reference/api-reference.md) |
| 运维、端口与拓扑 | [docs/guides/operations-handbook.md](docs/guides/operations-handbook.md) |
| 沙箱 | [docs/guides/sandbox-config.md](docs/guides/sandbox-config.md) |
| 记忆 | [docs/guides/memory-management.md](docs/guides/memory-management.md) |
| 自动化调度 | [docs/guides/automation-scheduler.md](docs/guides/automation-scheduler.md) |
| Plan 模式 | [docs/guides/plan-mode.md](docs/guides/plan-mode.md) |
| 护栏 | [docs/guides/guardrails.md](docs/guides/guardrails.md) |
| 文件上传 | [docs/guides/file-upload.md](docs/guides/file-upload.md) |
| IM 渠道 | [docs/guides/im-channels.md](docs/guides/im-channels.md) |
| MCP | [docs/guides/mcp-server.md](docs/guides/mcp-server.md) |
| 后端实现索引 | [backend/docs/README.md](backend/docs/README.md)、[backend/CLAUDE.md](backend/CLAUDE.md) |

从源码安装、本地启动与文档站预览等步骤见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 架构概览

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
          │  · Agent · 中间件 · 工具装配    │
          └───────────────┬───────────────┘
                          │
          ┌───────────────▼───────────────┐
          │  Gateway（FastAPI）           │
          │  · REST · 模型 / 技能 / 任务等 │
          └───────────────┬───────────────┘
                          │
          ┌───────────────▼───────────────┐
          │  沙箱                          │
          │  本地 · 容器 · 编排环境（可选）  │
          └───────────────────────────────┘
```

**组件说明**：**LangGraph** 承载编排语义；**Gateway** 对外提供 API 与控制面；**EvoPanel** 为主操作界面；**沙箱**用于隔离高风险执行。端口、反向代理与部署拓扑见 [运维手册](docs/guides/operations-handbook.md)。

## 文档与支持

**MkDocs 文档站**的源文件位于 [`docs/`](docs/)。本地构建与预览依赖说明见 [CONTRIBUTING.md](CONTRIBUTING.md) 或文档仓库内 `requirements-docs.txt` 说明。

| 入口 | 说明 |
|------|------|
| [docs/getting-started/downloads.md](docs/getting-started/downloads.md) | 下载、Release、CI 产物导航 |
| [docs/index.md](docs/index.md) | 文档中心导航 |
| [docs/reference/api-reference.md](docs/reference/api-reference.md) | Gateway API |
| [docs/reference/config-reference.md](docs/reference/config-reference.md) | 配置参考 |
| [docs/guides/operations-handbook.md](docs/guides/operations-handbook.md) | 运维与端口说明 |

历史文档 stub 仍可能指向根目录 `docs/` 下的旧路径（如 `backend/docs/API.md`）。

## ⚠️ 安全提示

### 不当部署可能带来安全风险

EvoFlow 具备系统命令执行、文件与网络访问等高权限能力，默认适合**本地可信环境**（例如仅监听 `127.0.0.1`）使用。

### 安全建议

如需跨网络访问，请自行配置防火墙、反向代理认证与最小权限暴露；不要将未加固实例直接暴露到公网。

## 贡献

欢迎贡献！请查看 [CONTRIBUTING.md](CONTRIBUTING.md) 了解开发环境搭建、工作流和指南。

新特性与修复请尽量附带**可维护的自动化测试**（具体约定见 `CONTRIBUTING.md`）。

## 许可证

本项目基于 [GNU AGPLv3 许可证](./LICENSE) 发布。

## 致谢

EvoFlow 基于开源社区的杰出工作构建。特别感谢：

- **[LangChain](https://github.com/langchain-ai/langchain)** — LLM 抽象与工具生态
- **[LangGraph](https://github.com/langchain-ai/langgraph)** — 图式 Agent 编排

EvoFlow 受益于开源生态；工程在早期承接 [DeerFlow](https://github.com/bytedance/deerflow) 2.0 基线并持续深度演进，感谢 ByteDance 团队的上游开源贡献。
