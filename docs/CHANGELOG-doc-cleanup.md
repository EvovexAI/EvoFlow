# 文档整理变更日志（2026-06-21）

> 本次整理目标：把 EvoFlow 文档体系（`docs/`、`backend/docs/`、`skills/`）按"准确、整洁、英文化"三个标准做一次彻底梳理；删过时、合重复、拆目录、改回链，最终通过 `mkdocs build` 干净构建。
>
> Git 由用户自行管理，本日志只列变更内容。

---

## 1. P0 · 删除冗余与修错

### 1.1 删除文件（共 16 个）

| 类型 | 文件 |
|------|------|
| PDF（与 md 不同步） | `docs/产品说明书.pdf`、`docs/使用说明.pdf`、`docs/assets/媒体agent团队协作 plan模式完成视频创作.pdf` |
| 重复截图（与 `screenshots/` 重复） | `assets/agents.png`、`assets/browser.png`、`assets/hosted-1.png`、`assets/hosted-2.png`、`assets/main-chat.png`、`assets/main-cha1t.png`、`assets/scheduled-tasks-1.png`、`assets/scheduled-tasks-2.png` |
| 配对 PDF 已删的孤儿 md | `docs/assets/媒体agent团队协作 plan模式完成视频创作.md` |
| 内容已并入主文档的旧 md | `docs/产品说明书.md`、`docs/使用说明.md`、`docs/faq.md`、`docs/guides/mcp-server.md`、`docs/guides/chat-mode.md` |

### 1.2 合并文档（3 对）

| 合并前 | 合并后 |
|--------|--------|
| `guides/chat-mode.md` + `guides/basic-functions.md` | `guides/chat/basic-functions.md`（保留后者） |
| `guides/mcp-server.md` + `guides/tools-mcp.md` | `guides/configuration/tools-mcp.md`（GUI 视角 + JSON 配置 + OAuth + 热重载 + FAQ 二合一） |
| `docs/faq.md` + `docs/guides/faq.md` | `docs/guides/faq.md`（用户排查 + 部署开发 二合一） |

### 1.3 修错

- `getting-started/installation.md`：`cd deerflow-agent` → `cd EvoFlow`（旧仓库名修正）

---

## 2. P1 · 重写与拆分

### 2.1 重写 `getting-started/introduction.md`

- 容量从 70 行扩到 230 行；融合原 `产品说明书.md` 的"目标人群、八大支柱、核心概念、架构图、安全隔离、系统要求"等核心内容
- 与 `产品说明书.md`（已删）形成 1:1 替代

### 2.2 物理拆分 `guides/`（27 md → 6 子目录）

```text
guides/
├── README.md            # 重写为新结构总目录
├── faq.md               # 用户排查 + 部署开发二合一
├── chat/                # 8 个文件：basic-functions, plan-mode, project-team-plan-workflow,
│                        #   hosted-agent, workspace, claude-code, shortcut-commands, file-upload
├── tasks/               # 3 个文件：task-center, scheduled-tasks, automation-scheduler
├── configuration/       # 7 个文件：settings, evopanel-guide, agent-management, skill-management,
│                        #   tools-mcp, memory-management, sandbox-config
├── integration/         # 2 个文件：feishu-integration, im-channels
├── deployment/          # 3 个文件：docker-deployment, production-deploy, operations-handbook
└── security/            # 1 个文件：guardrails
```

`guides/git-commit-steps.md` → `developer/git-commit-steps.md`（开发者视角，与产品功能无关）。

### 2.3 重写 `mkdocs.yml` nav

- 操作指南分组按新子目录全量重写（含部署与运维、安全两个新分组）
- 增补 nav 漏收的：`file-upload`、`project-team-plan-workflow`、`automation-scheduler`、`evopanel-guide`、`sandbox-config`、`im-channels`、`docker-deployment`、`production-deploy`、`operations-handbook`、`guardrails`、`public-repo-github-setup`、`git-commit-steps`
- `exclude_docs` 增补：`assets/plan-supervisor/README.md`、`assets/screenshots/README.md`、`presentations/**`

---

## 3. P2 · 目录归位与英文化

### 3.1 目录归位

| 原路径 | 新路径 |
|--------|--------|
| `docs/bug/` 全部 3 个文件 | `docs/internal/bug/` |
| `docs/reference/stream-resume-design.md` | `docs/internal/technical/stream-resume-design.md` |
| `docs/调研报告-EvoFlow文档体系摸底.md` | `docs/internal/doc-system-audit-report.md` |

### 3.2 中文文件名英文化

- `docs/internal/technical/`：20 个中文 md → 英文（`00-写作规范` → `00-writing-style`、`01-DeerFlow技术总览` → `01-tech-overview` 等）
- `docs/internal/requirements/`：12 个中文 md + 3 个中文目录 → 英文
  - 目录：`2026-04-27-Cursor风格Plan模式` → `2026-04-27-cursor-plan-mode`、`ACP任务模式集成` → `acp-task-mode-integration`、`任务管理` → `task-management`
  - `2026-04-27-cursor-plan-mode/` 下 7 个中文子文件英文化
  - `task-management/` 下 14 个中文子文件英文化
  - `acp-task-mode-integration/开发清单.md` → `development-checklist.md`
- `docs/assets/微信图片_20260520142957_115_302.png` → `wechat-image-20260520-302.png`

### 3.3 全局回链修正（共 30+ 处）

| 范围 | 修复内容 |
|------|----------|
| `docs/index.md` | 操作指南、运维手册、FAQ 入口指向新路径 |
| `docs/getting-started/downloads.md` | EvoPanel 指南指向 `configuration/` |
| `docs/getting-started/introduction.md` | guides 目录链接补全到 README.md |
| `docs/explanation/memory-system.md`、`sandbox-design.md` | 指向 `configuration/` 子目录 |
| `docs/tutorials/automation-task.md`、`setup-im-channel.md`、`multi-agent-collab.md` | 指向新子目录 |
| `docs/presentations/README.md` | plan-mode 指向 `chat/` |
| `docs/internal/README.md`、`meta-ssot.md`、`meta-writing-style.md` | guides/technical 路径与英文文件名修正 |
| `docs/internal/requirements/memory-retrieval-*.md` | technical/06-记忆系统 → 06-memory-system |
| `docs/reference/config-reference.md`、`env-reference.md`、`api-reference.md`、`architecture.md` | guides/im-channels、guardrails、stream-resume-design、AGENT_TRACE_DEBUG_PLAYBOOK、17-Cursor 等 |
| `docs/guides/chat/file-upload.md`、`plan-mode.md`、`project-team-plan-workflow.md` | 跨子目录与跨目录回链修正 |
| `docs/guides/configuration/sandbox-config.md`、`evopanel-guide.md`、`memory-management.md`、`tools-mcp.md` | 跨子目录回链修正 |
| `docs/guides/deployment/docker-deployment.md`、`production-deploy.md`、`operations-handbook.md` | 跨子目录回链修正 |
| `docs/guides/security/guardrails.md` | 跨子目录回链修正 |
| `docs/guides/integration/im-channels.md`、`tasks/automation-scheduler.md` | 跨子目录回链修正 |
| `docs/guides/faq.md` | NOTICE 改 GitHub 外链 |
| `docs/assets/plan-supervisor/README.md`、`screenshots/README.md` | 仓库根 README 改 GitHub 外链 |
| `backend/docs/README.md`、`MCP_SERVER.md`、`GUARDRAILS.md`、`FILE_UPLOAD.md`、`plan_mode_usage.md` | 5 处指向 guides 旧路径修正到新子目录 |
| `skills/public/evoflow-intro/SKILL.md` | 2 处 docs/guides 路径修正 |

---

## 4. 验证结果

```bash
$ cd D:\github\haze-ctrl
$ mkdocs build
INFO -  Cleaning site directory
INFO -  Building documentation to directory: D:\github\haze-ctrl\site
INFO -  Documentation built in 3.89 seconds
```

- **0 个 WARNING**
- **0 个 nav 外页面**（已 exclude 或入 nav）
- **0 个死链**

仅剩 mkdocs-material 主题官方 banner 输出（与本仓库无关）。

---

## 5. 数据对比

| 维度 | 整理前 | 整理后 |
|------|--------|--------|
| `docs/` 根目录中文 md | 3 个 | 0 个（迁入 internal） |
| `docs/guides/` 平铺 md | 27 个 | 2 个（`README.md`、`faq.md`）+ 6 子目录 |
| `docs/internal/technical/` 中文文件名 | 20 个 | 0 个 |
| `docs/internal/requirements/` 中文文件名（含子目录） | 12 + 3 目录 + 22 子文件 | 0 个 |
| `docs/assets/` 重复截图 | 8 张 | 0 张 |
| `docs/` PDF | 3 份 | 0 份 |
| `mkdocs build` warning | 10 | 0 |

---

*本次整理由 EvoFlow 工作区代理执行；如需回滚，参考你本地 git 历史。*
