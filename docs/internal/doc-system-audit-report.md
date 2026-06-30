# EvoFlow 文档体系摸底调研报告

> **调研日期**：2026-06-16  
> **项目根目录**：`D:\github\haze-ctrl`  
> **文档源目录**：`docs/`  
> **构建系统**：MkDocs（Material 主题）

---

## 目录

1. [文件清单与结构](#1-文件清单与结构)
2. [导航结构分析](#2-导航结构分析)
3. [内容质量评估](#3-内容质量评估)
4. [命名与路径问题](#4-命名与路径问题)
5. [重复与冗余](#5-重复与冗余)
6. [企业级文档体系建议](#6-企业级文档体系建议)

---

## 1. 文件清单与结构

### 1.1 目录树

```
docs/
├── index.md                                    # 首页
├── faq.md                                      # 常见问题（开发者/自托管视角）
├── 产品说明书.md                                # 产品定位与架构
├── 产品说明书.pdf                               # PDF 副本
├── 使用说明.md                                  # 操作手册
├── 使用说明.pdf                                 # PDF 副本
│
├── getting-started/                            # 快速开始（5 文件）
│   ├── introduction.md                         # 项目介绍
│   ├── downloads.md                            # 下载
│   ├── installation.md                         # 安装指南
│   ├── quick-start.md                          # 5 分钟快速上手
│   └── first-task.md                           # 完成第一个任务
│
├── tutorials/                                  # 教程（6 文件）
│   ├── configure-models.md                     # 配置模型
│   ├── create-agent.md                         # 创建 Agent
│   ├── add-skill.md                            # 添加技能
│   ├── multi-agent-collab.md                   # 多 Agent 协作
│   ├── automation-task.md                      # 定时自动化任务
│   └── setup-im-channel.md                     # 接入 IM 渠道
│
├── guides/                                     # 操作指南（27 文件）
│   ├── README.md                               # 指南总目录
│   ├── faq.md                                  # 常见问题排查（用户视角）
│   ├── evopanel-guide.md                       # EvoPanel 桌面端指南
│   ├── basic-functions.md                      # 基础功能
│   ├── chat-mode.md                            # 会话模式
│   ├── plan-mode.md                            # Plan 模式
│   ├── memory-management.md                    # 记忆管理
│   ├── hosted-agent.md                         # 目标智能体
│   ├── workspace.md                            # 工作空间
│   ├── task-center.md                          # 任务中心
│   ├── scheduled-tasks.md                      # 自动化
│   ├── settings.md                             # 面板设置
│   ├── agent-management.md                     # Agent 管理
│   ├── feishu-integration.md                   # 飞书集成
│   ├── skill-management.md                     # 技能管理
│   ├── claude-code.md                          # Claude Code
│   ├── tools-mcp.md                            # 工具与 MCP
│   ├── shortcut-commands.md                    # 快捷指令
│   ├── im-channels.md                          # IM 渠道配置
│   ├── operations-handbook.md                  # 运维手册
│   ├── docker-deployment.md                    # Docker 部署
│   ├── sandbox-config.md                       # 沙箱配置
│   ├── guardrails.md                           # 安全护栏
│   ├── production-deploy.md                    # 生产部署
│   ├── automation-scheduler.md                 # 自动化调度
│   ├── file-upload.md                          # 文件上传
│   ├── git-commit-steps.md                     # Git 提交步骤
│   ├── mcp-server.md                           # MCP 服务器配置
│   └── project-team-plan-workflow.md           # 项目团队与 Plan 协作
│
├── cases/                                      # 最佳实践案例（11 文件 + 1 模板）
│   ├── index.md
│   ├── use-main-agent.md
│   ├── create-agent.md
│   ├── create-skill.md
│   ├── install-skill.md
│   ├── scheduled-tasks.md
│   ├── search-html-report.md
│   ├── claude-code-continuous.md
│   ├── supervisor-mode.md
│   ├── e2e-stream-run-registry.md
│   ├── stream-acceptance-catalog.md
│   ├── manual-acceptance-test-playbook.md
│   └── templates/
│       └── scenario-acceptance-report.template.md
│
├── explanation/                                # 核心概念（9 文件）
│   ├── why-evoflow.md                          # 设计哲学
│   ├── agent-system.md                         # Agent 系统
│   ├── subagent-system.md                      # 子 Agent 系统
│   ├── skill-system.md                         # 技能系统
│   ├── memory-system.md                        # 记忆系统
│   ├── middleware-chain.md                     # 中间件链
│   ├── context-engineering.md                  # 上下文工程
│   ├── sandbox-design.md                       # 沙箱设计
│   └── public-repo-github-setup.md             # 公开仓库设置
│
├── reference/                                  # 参考文档（9 文件 + 1 生成文件）
│   ├── api-reference.md                        # API 参考
│   ├── config-reference.md                     # 配置参考
│   ├── env-reference.md                        # 环境变量参考
│   ├── architecture.md                         # 技术架构
│   ├── agent-reference.md                      # Agent 参考
│   ├── skills-reference.md                     # 技能参考
│   ├── tool-reference.md                       # 工具参考
│   ├── makefile-reference.md                   # Makefile 参考
│   ├── stream-resume-design.md                 # 流式恢复设计
│   └── generated/
│       └── openapi-gateway.json                # OpenAPI 规范（自动生成）
│
├── developer/                                  # 贡献（1 文件）
│   └── contributing.md                         # 参与贡献
│
├── meta/                                       # 元信息（1 文件）
│   └── glossary.md                             # 术语表
│
├── evoflow/                                    # EvoFlow 约定（1 文件）
│   └── artifacts/
│       └── README.md                           # 任务产出目录约定
│
├── bug/                                        # Bug 分析（3 文件）
│   ├── evoflow-long-run-fix-design.md
│   ├── evoflow-long-run-session-ui-analysis.md
│   └── evoflow-session-history-analysis.md
│
├── internal/                                   # 内部文档（MkDocs exclude）
│   ├── README.md
│   ├── meta-ssot.md
│   ├── meta-writing-style.md
│   ├── public-private-push-guide.md
│   ├── tauri-windows-updater.md
│   ├── requirements/                           # 需求文档（18 文件）
│   │   ├── 00-需求文档规范.md
│   │   ├── GATEWAY_API_接口总览.md
│   │   ├── WorkerProfile 优化待办事项.md
│   │   ├── 主智能体工具调用与阶段说明.md
│   │   ├── 任务跳转实时对话数据链路分析.md
│   │   ├── 前端布局线框-聊天与任务监控.html
│   │   ├── 前端风格UI约束.md
│   │   ├── 动态提示词与意图驱动设计方案.md
│   │   ├── 后台任务持续执行与断线续跑实施方案.md
│   │   ├── 记忆子系统说明.md
│   │   ├── 记忆检索-SQLite索引与混合召回-需求与设计.md
│   │   ├── 记忆检索索引-混合召回-需求与详细设计.md
│   │   ├── 2026-04-27-Cursor风格Plan模式/ (7 文件)
│   │   └── ACP任务模式集成/ (1 文件)
│   │   └── 任务管理/ (12 文件)
│   ├── technical/                              # 技术文档（19 文件）
│   │   ├── 00-写作规范.md
│   │   ├── 01-DeerFlow技术总览.md
│   │   ├── 02-DeerFlow架构分析.md
│   │   ├── 03-技能系统技术文档.md
│   │   ├── 04-Agent 核心机制.md
│   │   ├── 05-工具系统与 Sandbox 执行安全技术文档.md
│   │   ├── 06-记忆系统技术文档.md
│   │   ├── 07-上下文工程技术文档.md
│   │   ├── 08-安全护栏 Guardrails 技术文档.md
│   │   ├── 09-MCP 系统技术文档.md
│   │   ├── 10-文件上传与制品体系技术文档.md
│   │   ├── 11-子代理与任务执行技术文档.md
│   │   ├── 12-Gateway API 端点体系技术文档.md
│   │   ├── 13-IM 渠道集成技术文档.md
│   │   ├── 14-前端交互与流式渲染技术文档.md
│   │   ├── 15-Supervisor统一外部执行器架构设计.md
│   │   ├── 16-ACP同会话流式与状态查询设计.md
│   │   ├── 17-Cursor本地调度引擎对标差距与路线图.md
│   │   ├── 17-任务子任务数据关系与存储梳理.md
│   │   └── 18-Agent模块解耦演进方案.md
│   │   └── collab-peer-messaging-design.md
│   └── third-party-references/                 # 第三方参考（3 文件）
│       ├── CodeBuddy AI 助手 - 完整工具API参考文档.md
│       ├── CodeBuddy 系统提示词.md
│       └── TRAE系统提示词.md
│
├── presentations/                              # 演示文稿
│   ├── README.md
│   ├── evoflow-plan-workflow.marp.md
│   ├── evoflow-plan-workflow.pptx
│   └── plan-workflow/
│       ├── index.html
│       ├── main.js
│       └── styles.css
│
├── assets/                                     # 静态资源
│   ├── EvoFlow-LOGO.png
│   ├── agents.png
│   ├── browser.png
│   ├── hosted-1.png
│   ├── hosted-2.png
│   ├── main-cha1t.png                          # 疑似 typo（多了一个 a）
│   ├── main-chat.png
│   ├── scheduled-tasks-1.png
│   ├── scheduled-tasks-2.png
│   ├── wechat-group-qr.png
│   ├── 微信图片_20260520142957_115_302.png
│   ├── 媒体agent团队协作 plan模式完成视频创作.md
│   ├── 媒体agent团队协作 plan模式完成视频创作.pdf
│   ├── plan-supervisor/                        # Plan 模式演示素材
│   │   ├── README.md
│   │   ├── plan-02-structured-plan-modal.png
│   │   ├── plan-02-structured-plan-modal-2.png
│   │   ├── plan-04-exec-confirm-dock.png
│   │   ├── plan-05-supervisor-workflow-panel.png
│   │   ├── video-01-plan-clarify-to-ready.mp4
│   │   ├── video-01-plan-clarify-to-ready-poster.png
│   │   ├── video-02-plan-project-running-result.mp4
│   │   └── video-02-plan-project-running-result-poster.png
│   └── screenshots/                            # GUI 截图
│       ├── README.md
│       ├── .gitkeep
│       ├── agents.png
│       ├── agents-preset-roles.png
│       ├── agents-preset-teams.png
│       ├── browser.png
│       ├── hosted-1.png
│       ├── hosted-2.png
│       ├── main-chat.png
│       ├── scheduled-tasks-1.png
│       ├── scheduled-tasks-2.png
│       ├── wechat-group-qr.png
│       └── 微信图片_20260607215240_23_495.png
```

### 1.2 统计总览

| 目录 | Markdown 文件 | 其他文件 | 合计 |
|------|:---:|:---:|:---:|
| `docs/` 根目录 | 4 | 2 (PDF) | 6 |
| `getting-started/` | 5 | 0 | 5 |
| `tutorials/` | 6 | 0 | 6 |
| `guides/` | 27 | 0 | 27 |
| `cases/` | 12 | 0 | 12 |
| `cases/templates/` | 1 | 0 | 1 |
| `explanation/` | 9 | 0 | 9 |
| `reference/` | 9 | 1 (JSON) | 10 |
| `reference/generated/` | 0 | 1 (JSON) | 1 |
| `developer/` | 1 | 0 | 1 |
| `meta/` | 1 | 0 | 1 |
| `evoflow/artifacts/` | 1 | 0 | 1 |
| `bug/` | 3 | 0 | 3 |
| `internal/` | 5 | 0 | 5 |
| `internal/requirements/` | 15 | 1 (HTML) | 16 |
| `internal/requirements/2026-04-27-Cursor风格Plan模式/` | 7 | 0 | 7 |
| `internal/requirements/ACP任务模式集成/` | 1 | 0 | 1 |
| `internal/requirements/任务管理/` | 12 | 0 | 12 |
| `internal/technical/` | 20 | 0 | 20 |
| `internal/third-party-references/` | 3 | 0 | 3 |
| `presentations/` | 2 | 4 | 6 |
| `assets/` | 2 | 11 (图片) | 13 |
| `assets/plan-supervisor/` | 1 | 8 (图片+视频) | 9 |
| `assets/screenshots/` | 1 | 11 (图片) | 12 |
| **总计** | **~148** | **~39** | **~187** |

> **文件类型分布**：Markdown ~148 个，图片 ~30 个，PDF 3 个，视频 2 个，PPTX 1 个，HTML 2 个，JSON 1 个，JS/CSS 各 1 个。

---

## 2. 导航结构分析

### 2.1 mkdocs.yml nav 配置摘要

```
- 首页: index.md
- 快速开始: getting-started/introduction.md → downloads → installation → quick-start → first-task
- 教程: tutorials/configure-models → create-agent → add-skill → multi-agent-collab → automation-task → setup-im-channel
- 最佳实践案例: cases/index.md + 12 个子条目
- 操作指南:
  - 实时对话: basic-functions, chat-mode, plan-mode, memory-management, hosted-agent, workspace
  - 任务与调度: task-center, scheduled-tasks
  - 配置与面板: settings, agent-management, feishu-integration, memory-management(重复), skill-management,
    evoflow/artifacts/README, claude-code, tools-mcp, settings(重复), feishu-integration(重复), memory-management(重复)
- 快捷指令: guides/shortcut-commands.md
- 常见问题: guides/faq.md
- 核心概念: explanation/ 下 8 个文件
- 参考: reference/ 下 8 个文件
- 贡献: developer/contributing.md, meta/glossary.md
```

### 2.2 断链分析（导航引用了但文件不存在）

| 导航路径 | 问题 | 严重程度 |
|----------|------|:--------:|
| `guides/evopanel-guide.md` — index.md 中「操作指南」链接指向此文件 | ✅ 文件存在 | — |
| `guides/operations-handbook.md` — index.md 中「运维手册」链接 | ✅ 文件存在 | — |
| 无 | 所有 nav 条目均指向存在的文件 | ✅ 无断链 |

**结论：导航中无断链。** 所有 nav 中引用的文件路径均存在。

### 2.3 孤儿文件分析（文件存在但导航未收录）

以下文件存在于 `docs/` 下但未被 mkdocs.yml nav 收录：

| 文件 | 说明 | 建议 |
|------|------|:----:|
| `faq.md`（根目录） | 开发者/自托管 FAQ | ⚠️ 与 `guides/faq.md` 内容不同，但导航只收录了后者 |
| `产品说明书.md` | 产品定位与架构 | ⚠️ 被 `使用说明.md` 和 `guides/README.md` 引用，但 nav 未收录 |
| `使用说明.md` | 操作手册 | ⚠️ 同上 |
| `reference/stream-resume-design.md` | 流式恢复设计 | ⚠️ 技术设计文档，未纳入 nav |
| `bug/` 下 3 个文件 | Bug 分析 | ✅ 内部文档，可不收录 |
| `internal/` 全部 | 内部文档 | ✅ 被 `exclude_docs` 排除 |
| `presentations/` 全部 | 演示文稿 | ✅ 非文档内容 |
| `assets/` 下 .md 文件 | 素材说明 | ✅ 非导航内容 |

**关键孤儿**：`产品说明书.md`、`使用说明.md`、`faq.md`（根目录）这三个顶层文件未被 nav 收录，但它们是用户文档体系的重要组成部分。

### 2.4 导航路径不一致

| 导航条目 | 问题 |
|----------|------|
| `guides/evopanel-guide.md` — 导航中未直接引用，但 index.md 中「操作指南」链接指向它 | 不一致：nav 中无此条目，但首页有链接 |
| `guides/operations-handbook.md` — 同上 | 同上 |
| `guides/faq.md` — 导航中「常见问题」指向此文件 | ✅ 正确 |
| `faq.md`（根目录）— 首页「常见问题」链接指向此文件 | ⚠️ 首页 FAQ 链接指向根目录 `faq.md`，但导航 FAQ 指向 `guides/faq.md`，两个 FAQ 内容不同 |

### 2.5 导航结构问题

1. **「配置与面板」分组混乱**：`settings.md`、`feishu-integration.md`、`memory-management.md` 各出现了 2-3 次，且子条目顺序无逻辑
2. **`memory-management.md` 在 nav 中出现 3 次**（实时对话、配置与面板下各一次）
3. **`settings.md` 在 nav 中出现 2 次**（配置与面板下）
4. **`feishu-integration.md` 在 nav 中出现 2 次**（配置与面板下）
5. **缺少「产品说明书」和「使用说明」的导航入口**——这两个是核心文档

---

## 3. 内容质量评估

### 3.1 逐文件评估

#### 根目录文件

| 文件 | 评估 | 问题 |
|------|------|------|
| `index.md` | ✅ 保留 | 内容合理，但「操作指南」链接指向 `guides/evopanel-guide.md`，而 nav 中该文件不在「操作指南」分组下 |
| `产品说明书.md` | ⚠️ 需重写 | 版本标注为「EvoPanel v0.2.3」，已过时；多处提到「EvoPanel」作为产品名，与当前品牌「EvoFlow」不一致；「八大支柱」描述与当前产品功能有差异 |
| `使用说明.md` | ⚠️ 需重写 | 同样标注 v0.2.3；内容与 `guides/` 下多个文件大量重复；「四种模式对照」表与 `guides/plan-mode.md` 重复 |
| `faq.md`（根目录） | ⚠️ 需合并 | 开发者/自托管视角的 FAQ，与 `guides/faq.md`（用户视角）内容互补但分散；应合并或明确分工 |

#### getting-started/

| 文件 | 评估 | 问题 |
|------|------|------|
| `introduction.md` | ✅ 保留 | 内容准确，但「100+ 公开技能」与 `产品说明书.md` 的「55 个」不一致 |
| `downloads.md` | ✅ 保留 | 内容简洁，但指向 GitHub Releases 链接 |
| `installation.md` | ⚠️ 需更新 | `git clone` 后 `cd deerflow-agent` 是旧仓库名（应为 `EvoFlow`）；`make config` 流程与当前代码可能不一致 |
| `quick-start.md` | ✅ 保留 | 内容合理，但「聊天输入栏目标药丸」与当前 UI 需保持同步 |
| `first-task.md` | ✅ 保留 | 内容合理，但 `/config set is_plan_mode true` 指令可能已过时 |

#### tutorials/

| 文件 | 评估 | 问题 |
|------|------|------|
| `configure-models.md` | ⚠️ 需更新 | 配置格式为旧版扁平列表，未反映新版嵌套格式；CLI 后端示例（Codex/Claude Code）可能已过时 |
| `create-agent.md` | ✅ 保留 | 内容合理，但偏简略 |
| `add-skill.md` | ✅ 保留 | 内容合理 |
| `multi-agent-collab.md` | ⚠️ 需重写 | 描述的「项目管理」页面流程与当前任务中心 UI 差异较大；Supervisor 描述偏旧 |
| `automation-task.md` | ⚠️ 需更新 | TOML 格式任务文件路径 `~/.evoflow/tasks/automations/` 与当前代码可能不一致 |
| `setup-im-channel.md` | ✅ 保留 | 内容合理 |

#### guides/

| 文件 | 评估 | 问题 |
|------|------|------|
| `README.md` | ✅ 保留 | 指南总目录，内容合理 |
| `faq.md` | ✅ 保留 | 用户视角 FAQ，内容详实 |
| `evopanel-guide.md` | ⚠️ 需重写 | 文件名含旧名「EvoPanel」；内容与 `使用说明.md` 大量重复；「四种对话模式」表与 `plan-mode.md` 重复 |
| `basic-functions.md` | ✅ 保留 | 内容合理 |
| `chat-mode.md` | ⚠️ 需合并 | 内容与 `basic-functions.md` 几乎完全重复（对话功能、文件上传等） |
| `plan-mode.md` | ✅ 保留 | 内容详实准确，但偏技术细节 |
| `memory-management.md` | ✅ 保留 | 内容详实准确 |
| `hosted-agent.md` | ✅ 保留 | 内容合理 |
| `workspace.md` | ✅ 保留 | 内容简洁 |
| `task-center.md` | ✅ 保留 | 内容详实准确 |
| `scheduled-tasks.md` | ✅ 保留 | 内容合理 |
| `settings.md` | ⚠️ 需扩充 | 仅 735 字节，内容过于简略 |
| `agent-management.md` | ✅ 保留 | 内容合理 |
| `feishu-integration.md` | ✅ 保留 | 内容合理 |
| `skill-management.md` | ✅ 保留 | 内容合理 |
| `claude-code.md` | ✅ 保留 | 内容合理 |
| `tools-mcp.md` | ✅ 保留 | 内容合理 |
| `shortcut-commands.md` | ✅ 保留 | 内容详实 |
| `im-channels.md` | ✅ 保留 | 内容详实 |
| `operations-handbook.md` | ✅ 保留 | 内容合理 |
| `docker-deployment.md` | ✅ 保留 | 内容合理 |
| `sandbox-config.md` | ✅ 保留 | 内容详实 |
| `guardrails.md` | ✅ 保留 | 内容详实 |
| `production-deploy.md` | ✅ 保留 | 内容合理 |
| `automation-scheduler.md` | ✅ 保留 | 内容详实 |
| `file-upload.md` | ✅ 保留 | 内容详实 |
| `git-commit-steps.md` | ⚠️ 定位不明 | 通用 Git 教程，与 EvoFlow 产品无关，建议移至 developer/ 或删除 |
| `mcp-server.md` | ⚠️ 需合并 | 内容与 `tools-mcp.md` 大量重复 |
| `project-team-plan-workflow.md` | ✅ 保留 | 内容详实，但文件过长（24KB），建议拆分 |

#### cases/

| 文件 | 评估 | 问题 |
|------|------|------|
| `index.md` | ✅ 保留 | 内容合理 |
| 其余 11 个案例文件 | ✅ 保留 | 内容合理，但部分案例的 UI 截图占位未填充 |

#### explanation/

| 文件 | 评估 | 问题 |
|------|------|------|
| 全部 9 个文件 | ✅ 保留 | 内容合理，架构解释准确 |

#### reference/

| 文件 | 评估 | 问题 |
|------|------|------|
| `api-reference.md` | ✅ 保留 | 内容合理 |
| `config-reference.md` | ⚠️ 需更新 | `config_version: 5` 示例过旧；嵌套格式示例需补充 |
| `env-reference.md` | ✅ 保留 | 内容合理 |
| `architecture.md` | ✅ 保留 | 内容合理 |
| `agent-reference.md` | ✅ 保留 | 内容合理 |
| `skills-reference.md` | ✅ 保留 | 内容合理 |
| `tool-reference.md` | ✅ 保留 | 内容合理 |
| `makefile-reference.md` | ✅ 保留 | 内容合理 |
| `stream-resume-design.md` | ⚠️ 定位不明 | 技术设计文档，放在 reference/ 下不合适，应移至 internal/technical/ |

#### 其他

| 文件 | 评估 | 问题 |
|------|------|------|
| `developer/contributing.md` | ✅ 保留 | 内容合理 |
| `meta/glossary.md` | ✅ 保留 | 内容合理 |
| `evoflow/artifacts/README.md` | ✅ 保留 | 内容合理 |
| `bug/` 下 3 个文件 | ⚠️ 移至 internal/ | Bug 分析应放在 internal/ 下 |
| `assets/媒体agent团队协作 plan模式完成视频创作.md` | ⚠️ 需清理 | 含本地绝对路径（`C:\Users\...`），图片无法在站内渲染；有 PDF 副本 |

### 3.2 过时内容汇总

| 问题 | 涉及文件 |
|------|----------|
| 版本号标注为 v0.2.3 | `产品说明书.md`、`使用说明.md` |
| 旧仓库名 `deerflow-agent` | `installation.md` |
| 旧配置格式（扁平列表） | `configure-models.md`、`config-reference.md` |
| 「55 个技能」vs「100+ 技能」不一致 | `产品说明书.md` vs `introduction.md` |
| 旧 UI 描述（右上角 + 等） | `quick-start.md` |
| 旧指令 `/config set` | `first-task.md` |
| 旧项目管理 UI 描述 | `multi-agent-collab.md` |

### 3.3 重复内容汇总

| 重复对 | 说明 |
|--------|------|
| `使用说明.md` ↔ `guides/evopanel-guide.md` | 大量重复（安装、界面、模式等） |
| `使用说明.md` ↔ `guides/basic-functions.md` | 对话功能部分重复 |
| `basic-functions.md` ↔ `chat-mode.md` | 几乎完全重复 |
| `guides/faq.md` ↔ `faq.md`（根目录） | 内容互补但部分重叠 |
| `tools-mcp.md` ↔ `mcp-server.md` | MCP 配置内容大量重复 |
| `产品说明书.md` ↔ `使用说明.md` | 部分功能描述重复 |
| `settings.md` 内容散落在多个文件 | 设置说明在 `basic-functions.md`、`使用说明.md` 中都有 |

---

## 4. 命名与路径问题

### 4.1 旧名残留

| 文件名/路径 | 旧名 | 建议 |
|------------|------|------|
| `guides/evopanel-guide.md` | **EvoPanel**（应为 EvoFlow 桌面端指南） | 重命名为 `guides/desktop-guide.md` |
| `installation.md` 中 `cd deerflow-agent` | **DeerFlow**（旧项目名） | 改为 `cd EvoFlow` |
| `reference/config-reference.md` 中 `DEER_FLOW_CONFIG_PATH` | **DEER_FLOW** 前缀 | 确认当前是否已改为 `EVOFLOW_` |
| `reference/why-evoflow.md` 中大量对比 DeerFlow | **DeerFlow** | 作为设计哲学文档可保留，但需确认准确性 |
| `internal/technical/01-DeerFlow技术总览.md` | **DeerFlow** | 内部文档可保留，但需标注历史 |

### 4.2 中英文混用

| 文件 | 问题 |
|------|------|
| `assets/媒体agent团队协作 plan模式完成视频创作.md` | 文件名中英文混用 |
| `assets/微信图片_20260520142957_115_302.png` | 中文文件名，含时间戳 |
| `assets/screenshots/微信图片_20260607215240_23_495.png` | 同上 |
| `internal/requirements/` 下多个文件 | 文件名中英文混用（如 `GATEWAY_API_接口总览.md`） |
| `internal/technical/collab-peer-messaging-design.md` | 英文文件名在中文目录中 |

### 4.3 路径层级问题

| 问题 | 说明 |
|------|------|
| `guides/` 下 27 个文件过于扁平 | 建议按子主题分组（如 `guides/chat/`、`guides/tasks/`、`guides/deployment/`） |
| `reference/stream-resume-design.md` 放在 reference/ 下不合适 | 这是技术设计文档，应移至 `internal/technical/` |
| `bug/` 作为顶层目录不合适 | 应移至 `internal/bug/` |
| `assets/` 下混合了截图、logo、案例文档 | 建议拆分：`assets/images/`、`assets/case-studies/` |

---

## 5. 重复与冗余

### 5.1 PDF 副本

| PDF 文件 | 对应 Markdown | 大小 | 建议 |
|----------|---------------|:----:|:----:|
| `产品说明书.pdf` | `产品说明书.md` | 662KB | ⚠️ 删除或移出 docs/（PDF 与 MD 不同步风险高） |
| `使用说明.pdf` | `使用说明.md` | 527KB | ⚠️ 同上 |
| `assets/媒体agent团队协作 plan模式完成视频创作.pdf` | 对应 .md 文件 | 6.8MB | ⚠️ 删除（MD 已含所有内容） |

### 5.2 截图重复

| 文件 | 重复位置 | 大小 | 建议 |
|------|----------|:----:|:----:|
| `assets/agents.png` | `assets/screenshots/agents.png` | 226KB | ⚠️ 完全重复，保留 screenshots/ 下即可 |
| `assets/browser.png` | `assets/screenshots/browser.png` | 260KB | ⚠️ 完全重复 |
| `assets/hosted-1.png` | `assets/screenshots/hosted-1.png` | 299KB | ⚠️ 完全重复 |
| `assets/hosted-2.png` | `assets/screenshots/hosted-2.png` | 356KB | ⚠️ 完全重复 |
| `assets/main-chat.png` | `assets/screenshots/main-chat.png` | 162KB | ⚠️ 完全重复 |
| `assets/scheduled-tasks-1.png` | `assets/screenshots/scheduled-tasks-1.png` | 195KB | ⚠️ 完全重复 |
| `assets/scheduled-tasks-2.png` | `assets/screenshots/scheduled-tasks-2.png` | 132KB | ⚠️ 完全重复 |
| `assets/wechat-group-qr.png` | `assets/screenshots/wechat-group-qr.png` | 291KB | ⚠️ 内容不同（二维码可能不同） |

> **结论**：`assets/` 下的 7 张截图与 `assets/screenshots/` 下的文件完全重复，应删除 `assets/` 下的副本，统一使用 `assets/screenshots/`。

### 5.3 内容重复文档对

| 文档对 | 重复程度 | 建议 |
|--------|:--------:|------|
| `使用说明.md` ↔ `guides/evopanel-guide.md` | 高 | 合并或明确分工 |
| `basic-functions.md` ↔ `chat-mode.md` | 极高（几乎相同） | 合并 |
| `tools-mcp.md` ↔ `mcp-server.md` | 高 | 合并 |
| `faq.md`（根目录） ↔ `guides/faq.md` | 中 | 合并或明确分工 |
| `产品说明书.md` ↔ `使用说明.md` | 中 | 明确分工 |

---

## 6. 企业级文档体系建议

### 6.1 建议的目录结构

```
docs/
├── index.md                              # 首页（保留）
├── getting-started/                      # 快速开始（保留）
│   ├── introduction.md
│   ├── downloads.md
│   ├── installation.md
│   ├── quick-start.md
│   └── first-task.md
│
├── tutorials/                            # 教程（保留）
│   ├── configure-models.md
│   ├── create-agent.md
│   ├── add-skill.md
│   ├── multi-agent-collab.md
│   ├── automation-task.md
│   └── setup-im-channel.md
│
├── guides/                               # 操作指南（重组）
│   ├── index.md                          # 指南总目录（原 README.md）
│   ├── chat/                             # 对话相关
│   │   ├── basic-functions.md            # 合并 chat-mode.md
│   │   ├── plan-mode.md
│   │   ├── memory-management.md
│   │   ├── hosted-agent.md
│   │   └── workspace.md
│   ├── tasks/                            # 任务与调度
│   │   ├── task-center.md
│   │   ├── scheduled-tasks.md
│   │   └── automation-scheduler.md
│   ├── configuration/                    # 配置与面板
│   │   ├── settings.md                   # 扩充
│   │   ├── agent-management.md
│   │   ├── skill-management.md
│   │   ├── tools-mcp.md                  # 合并 mcp-server.md
│   │   ├── claude-code.md
│   │   └── shortcut-commands.md
│   ├── integration/                      # 集成
│   │   ├── im-channels.md
│   │   ├── feishu-integration.md
│   │   └── file-upload.md
│   ├── deployment/                       # 部署
│   │   ├── docker-deployment.md
│   │   ├── production-deploy.md
│   │   ├── sandbox-config.md
│   │   └── operations-handbook.md
│   ├── security/                         # 安全
│   │   └── guardrails.md
│   ├── faq.md                            # 常见问题（合并根目录 faq.md）
│   └── reference/                        # 开发参考
│       ├── git-commit-steps.md           # 移至此处
│       └── project-team-plan-workflow.md # 拆分后放入
│
├── cases/                                # 最佳实践（保留）
│   ├── index.md
│   └── ...
│
├── explanation/                          # 核心概念（保留）
│   └── ...
│
├── reference/                            # 参考（精简）
│   ├── api-reference.md
│   ├── config-reference.md
│   ├── env-reference.md
│   ├── architecture.md
│   ├── agent-reference.md
│   ├── skills-reference.md
│   ├── tool-reference.md
│   ├── makefile-reference.md
│   └── generated/
│       └── openapi-gateway.json
│
├── developer/                            # 贡献（保留）
│   └── contributing.md
│
├── meta/                                 # 元信息（保留）
│   └── glossary.md
│
├── evoflow/                              # EvoFlow 约定（保留）
│   └── artifacts/
│       └── README.md
│
├── internal/                             # 内部文档（MkDocs exclude）
│   ├── bug/                              # 原 bug/ 目录移入
│   ├── technical/                        # 保留
│   ├── requirements/                     # 保留
│   └── third-party-references/           # 保留
│
└── assets/                               # 静态资源（清理）
    ├── images/                           # 通用图片
    │   ├── EvoFlow-LOGO.png
    │   └── wechat-group-qr.png
    ├── screenshots/                      # GUI 截图（唯一副本）
    │   └── ...
    └── plan-supervisor/                  # Plan 演示素材（保留）
        └── ...
```

### 6.2 建议的文件命名规范

| 规则 | 说明 |
|------|------|
| **全小写 + 连字符** | 如 `desktop-guide.md`，不用 `evopanel-guide.md` |
| **英文命名** | 避免中文文件名（如 `产品说明书.md` → `product-overview.md`） |
| **目录分组** | guides/ 下按子主题建子目录，避免 27 个文件平铺 |
| **无空格** | 文件名中不要有空格（如 `媒体agent团队协作 plan模式完成视频创作.md`） |

### 6.3 建议的导航结构

```yaml
nav:
  - 首页: index.md
  - 快速开始:
      - getting-started/introduction.md
      - getting-started/downloads.md
      - getting-started/installation.md
      - getting-started/quick-start.md
      - getting-started/first-task.md
  - 教程:
      - tutorials/configure-models.md
      - tutorials/create-agent.md
      - tutorials/add-skill.md
      - tutorials/multi-agent-collab.md
      - tutorials/automation-task.md
      - tutorials/setup-im-channel.md
  - 最佳实践案例:
      - cases/index.md
      - ...
  - 操作指南:
      - 对话与协作:
          - guides/chat/basic-functions.md
          - guides/chat/plan-mode.md
          - guides/chat/memory-management.md
          - guides/chat/hosted-agent.md
          - guides/chat/workspace.md
      - 任务与调度:
          - guides/tasks/task-center.md
          - guides/tasks/scheduled-tasks.md
          - guides/tasks/automation-scheduler.md
      - 配置与管理:
          - guides/configuration/settings.md
          - guides/configuration/agent-management.md
          - guides/configuration/skill-management.md
          - guides/configuration/tools-mcp.md
          - guides/configuration/claude-code.md
      - 集成:
          - guides/integration/im-channels.md
          - guides/integration/feishu-integration.md
          - guides/integration/file-upload.md
      - 部署与运维:
          - guides/deployment/docker-deployment.md
          - guides/deployment/production-deploy.md
          - guides/deployment/sandbox-config.md
          - guides/deployment/operations-handbook.md
      - 安全:
          - guides/security/guardrails.md
      - 快捷指令: guides/configuration/shortcut-commands.md
      - 常见问题: guides/faq.md
  - 核心概念:
      - explanation/why-evoflow.md
      - explanation/agent-system.md
      - explanation/subagent-system.md
      - explanation/skill-system.md
      - explanation/memory-system.md
      - explanation/middleware-chain.md
      - explanation/context-engineering.md
      - explanation/sandbox-design.md
  - 参考:
      - reference/api-reference.md
      - reference/config-reference.md
      - reference/env-reference.md
      - reference/architecture.md
      - reference/agent-reference.md
      - reference/skills-reference.md
      - reference/tool-reference.md
      - reference/makefile-reference.md
  - 贡献:
      - developer/contributing.md
      - meta/glossary.md
```

### 6.4 文件操作清单

#### 🔴 建议删除

| 文件 | 原因 |
|------|------|
| `产品说明书.pdf` | PDF 副本，与 MD 不同步 |
| `使用说明.pdf` | 同上 |
| `assets/媒体agent团队协作 plan模式完成视频创作.pdf` | PDF 副本 |
| `assets/agents.png` | 与 `assets/screenshots/agents.png` 重复 |
| `assets/browser.png` | 与 `assets/screenshots/browser.png` 重复 |
| `assets/hosted-1.png` | 与 `assets/screenshots/hosted-1.png` 重复 |
| `assets/hosted-2.png` | 与 `assets/screenshots/hosted-2.png` 重复 |
| `assets/main-chat.png` | 与 `assets/screenshots/main-chat.png` 重复 |
| `assets/scheduled-tasks-1.png` | 与 `assets/screenshots/scheduled-tasks-1.png` 重复 |
| `assets/scheduled-tasks-2.png` | 与 `assets/screenshots/scheduled-tasks-2.png` 重复 |
| `assets/main-cha1t.png` | 疑似 typo 文件（多了一个 a） |

#### 🟡 建议合并

| 合并目标 | 源文件 |
|----------|--------|
| `guides/chat/basic-functions.md` | `guides/chat-mode.md`（内容几乎相同） |
| `guides/configuration/tools-mcp.md` | `guides/mcp-server.md`（内容重复） |
| `guides/faq.md` | `faq.md`（根目录，合并 FAQ） |
| `guides/chat/basic-functions.md` | `guides/evopanel-guide.md`（部分内容合并） |

#### 🟠 建议重写/重命名

| 文件 | 新名称 | 原因 |
|------|--------|------|
| `guides/evopanel-guide.md` | `guides/chat/desktop-guide.md` | 旧名「EvoPanel」 |
| `产品说明书.md` | `product-overview.md` | 中文文件名，内容需更新 |
| `使用说明.md` | `user-manual.md` | 中文文件名，内容需精简（与 guides/ 去重） |
| `guides/settings.md` | 保留但扩充 | 内容过于简略（735 字节） |
| `guides/git-commit-steps.md` | 移至 `developer/git-workflow.md` | 通用 Git 教程，与产品无关 |

#### 🔵 建议移动

| 文件 | 目标位置 |
|------|----------|
| `reference/stream-resume-design.md` | `internal/technical/` |
| `bug/` 下 3 个文件 | `internal/bug/` |
| `assets/媒体agent团队协作 plan模式完成视频创作.md` | `cases/media-agent-collab-case.md` 或删除（含本地路径） |

#### ✅ 建议保留

- `getting-started/` 全部（需小更新）
- `tutorials/` 全部（需小更新）
- `cases/` 全部
- `explanation/` 全部
- `reference/` 大部分（`config-reference.md` 需更新）
- `developer/contributing.md`
- `meta/glossary.md`
- `evoflow/artifacts/README.md`
- `guides/` 大部分（按上述建议重组）

---

## 总结

### 核心发现

1. **文档体量庞大**：~148 个 Markdown 文件，~187 个总文件，是成熟的产品文档体系
2. **导航基本完整**：无断链，但存在重复条目和分组混乱
3. **内容质量参差**：部分文件标注 v0.2.3 已过时，部分文件间存在大量重复
4. **命名需统一**：仍有「EvoPanel」「DeerFlow」等旧名残留
5. **截图重复严重**：`assets/` 和 `assets/screenshots/` 下 7 张截图完全重复
6. **PDF 副本需清理**：3 个 PDF 文件与 MD 不同步风险高

### 优先级建议

| 优先级 | 任务 | 工作量 |
|:------:|------|:------:|
| P0 | 删除重复截图和 PDF 副本 | 低 |
| P0 | 合并 `basic-functions.md` 和 `chat-mode.md` | 低 |
| P0 | 更新 `installation.md` 中的旧仓库名 | 低 |
| P1 | 重组 `guides/` 目录结构（建子目录） | 中 |
| P1 | 重写 `产品说明书.md` 和 `使用说明.md` | 高 |
| P1 | 更新 nav 配置（去重、分组） | 中 |
| P2 | 统一文件名规范（英文+小写+连字符） | 高 |
| P2 | 合并 `tools-mcp.md` 和 `mcp-server.md` | 低 |
| P2 | 合并根目录 `faq.md` 和 `guides/faq.md` | 低 |
| P3 | 更新所有过时版本号和 UI 描述 | 中 |
| P3 | 拆分 `project-team-plan-workflow.md` | 中 |
| P3 | 清理 `assets/` 下的中文文件名图片 | 低 |

---

*报告完毕。*
