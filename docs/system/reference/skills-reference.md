# 技能列表与说明

## 概述

EvoFlow 技能位于 `skills/` 目录，分为 `public/`（公开技能，提交到版本库）和 `custom/`（自定义技能，被 gitignore）。此外还有 `development/`、`devops/`、`interview/` 三个分类目录。

每个技能是一个包含 `SKILL.md` 的目录，`SKILL.md` 使用 YAML frontmatter 声明元数据（name, description, license, allowed-tools）。

技能的启用/禁用状态由 `extensions_config.json` 中的 `skills` 字段控制。

## 公开技能列表

### EvoFlow 系统

| 技能名 | 说明 |
|--------|------|
| `evoflow-intro` | EvoFlow 产品与能力自介绍：技能、MCP、角色、记忆、目标、模型、渠道等 |
| `evoflow-admin` | EvoFlow 系统治理 CLI，管理模型、技能、Agent、MCP、长期记忆、知识库、经验库等 |
| `evoflow-debugging` | EvoFlow 项目内 Bug / 行为不符 / 数据展示错误排查 |
| `evoflow-plan-workflow` | Plan 场景协作流程：需求澄清、写 plan 落库、supervisor 派发与验收 |
| `evoflow-subagent-delegation` | subagent 与 supervisor 选型、委派边界、并行上限与媒体工种流水线 |
| `bootstrap` | 对话式生成个性化 SOUL.md |
| `preset-role-assistant` | 快速创建预设 Agent 角色、系统提示词、SOUL |
| `find-skills` | 发现与安装技能 |
| `skill-creator` | 创建与迭代改进技能、测量技能性能 |
| `skill-lint` | Skill 格式审查工具，基于规范对技能进行合规性审计 |
| `self-evolution` | 执行任务时持续改进技能、经验库与智能体配置 |

### 数据与分析

| 技能名 | 说明 |
|--------|------|
| `data-analysis` | 数据分析与可视化，支持 Excel/CSV 上传分析 |
| `chart-visualization` | 图表可视化生成，智能选择最合适的图表类型 |
| `deep-research` | 多领域联网深入研究 + 展示页生成（HTML） |
| `github-deep-research` | 对任意 GitHub 仓库进行多轮深度研究 |
| `repo-research` | GitHub 仓库深度研究与整合分析，支持多仓库对比 |
| `summarize` | 快速 CLI 总结 URL、本地文件和 YouTube 链接 |
| `technology-search` | 搜索科技博客、开发者论坛和 IT 媒体获取行业动态 |
| `aihot` | AI HOT 中文 AI 资讯查询 |

### 文档处理

| 技能名 | 说明 |
|--------|------|
| `pdf` | PDF 文件处理：读取、提取文本/表格、表单填写等 |
| `pdfkit-py` | 纯 Python PDF 工具包，50 个命令覆盖读取、编辑、转换、表单、加密、OCR |
| `docx` | Word 文档（.docx）创建、读取、编辑、修改 |
| `pptx` | PowerPoint 演示文稿（.pptx）创建/读取/编辑/修改 |
| `xlsx` | Excel 电子表格（.xlsx/.xls）处理 |
| `md2word` | Markdown 转 Word 文档，支持多种预设格式 |

### 内容创作

| 技能名 | 说明 |
|--------|------|
| `article-writer` | 多风格文章创作（深度分析、实用指南、故事驱动、观点评论、新闻简报） |
| `content-planner` | 微信公众号选题规划和内容日历管理 |
| `de-ai-polish` | 检测并去除文章中的 AI 化表述模式，用于写作润色 |
| `podcast-generation` | 从文本内容生成播客音频 |

### 开发与编码

| 技能名 | 说明 |
|--------|------|
| `coding-agent` | 通过后台进程将编码任务委托给 Codex、Claude Code 或 Pi 代理 |
| `code-reviewer` | 代码审查专家，专注于代码质量、性能优化和最佳实践 |
| `frontend-design` | 创建独特的、生产级前端界面（Web 组件、页面、海报等） |
| `web-design-guidelines` | 审查 UI 代码是否符合 Web 界面规范 |
| `workspace-code-workflow` | 工作区代码任务路由与 worker 检索/改写规范 |

### DevOps 与版本控制

| 技能名 | 说明 |
|--------|------|
| `commit-push-release` | 一键提交代码、推送到远程、并触发 GitHub Actions 正式包构建 |
| `git-batch-commit` | Git 批量提交工具，支持按变更分类生成交互式提交 |
| `api-tester` | API 接口自动化测试，支持 RESTful API 测试用例生成、执行和报告 |
| `gh-issues` | 获取 GitHub issues，启动子代理实现修复并创建 PR |
| `github` | GitHub 操作（通过 gh CLI）：issues、PRs、CI 运行、代码审查 |
| `vercel-deploy` | 部署应用到 Vercel |

### 媒体生成

| 技能名 | 说明 |
|--------|------|
| `byted-ark-seedream-skill` | 火山方舟 Agent Plan 专属 Seedream 生图，支持连贯组图、流式输出 |
| `agnes-media-generation` | Agnes AI（agnes-ai.com）生图/生视频 |
| `wan-media-generation` | 通义万相 / DashScope 生图/生视频 |
| `kling-media-generation` | 可灵（Kling）生图/生视频 |
| `media-production` | 多 Agent 短片制片流水线（火山 Seedance 生视频） |
| `plan-video-production` | Plan 模式视频步骤规划，串行执行编剧/视觉/美术/导演/后期 |
| `media-use` | Agent Media OS，解析任意媒体需求（BGM/SFX/图片/图标）为本地文件 |
| `sherpa-onnx-tts` | 本地文字转语音（离线，无需云端） |
| `canvas` | 在连接的 OpenClaw 节点上显示 HTML 内容 |
| `canvas-design` | 创建精美的视觉艺术作品（海报、艺术作品、设计等） |

### HyperFrames 与视频

| 技能名 | 说明 |
|--------|------|
| `hyperframes` | 从 HTML 渲染视频的框架，DOM 通过 data-* 属性声明时序 |
| `hyperframes-core` | HyperFrames 组合契约，构建可渲染项目 |
| `hyperframes-animation` | HyperFrames 动画知识库：原子动效规则、场景蓝图、转场 |
| `hyperframes-creative` | HyperFrames 创意方向：设计规范、调色板、字体 |
| `hyperframes-media` | HyperFrames 音频与媒体资源 |
| `hyperframes-cli` | HyperFrames CLI 开发循环（init/add/catalog/lint/validate） |
| `hyperframes-registry` | 安装和接线 HyperFrames 注册表组件 |
| `motion-graphics` | 短片动态图形制作入口，设计主导的无旁白动态图形 |
| `music-to-video` | 音乐节拍同步的 HyperFrames 视频 |
| `slideshow` | HyperFrames 幻灯片制作契约 |
| `general-video` | 通用视频制作，集成 media-use 资源解析 |
| `faceless-explainer` | 将文本转为无脸解说视频（最长约 3 分钟） |
| `product-launch-video` | 产品发布视频（SaaS 宣传、功能演示等） |
| `pr-to-video` | 将 GitHub PR 转为视频 |
| `website-to-video` | 将网站/URL 转为 HyperFrames 视频 |
| `talking-head-recut` | 为说话头/采访/播客视频添加图形叠加层 |
| `embedded-captions` | 为说话头视频添加字幕，32 种视觉风格 |

### 自动化与浏览器

| 技能名 | 说明 |
|--------|------|
| `agent-browser` | 浏览器自动化：导航页面、快照、点击/填写、截图 |
| `desktop-control` | 通过 clawdevoflow 引擎提供安全的桌面控制：读屏、点击、输入、开应用 |
| `wechat-chat` | 微信聊天自动化 |
| `web-scraping` | 智能网页爬虫，使用 Scrapling 框架，支持反爬虫绕过 |

### 效率与集成

| 技能名 | 说明 |
|--------|------|
| `notion` | Notion API，创建和管理页面、数据库和块 |
| `obsidian` | 操作 Obsidian 仓库（纯 Markdown 笔记）并通过 obsidian-cli 自动化 |
| `trello` | 通过 Trello REST API 管理看板、列表和卡片 |
| `mcporter` | 使用 mcporter CLI 列出、配置、认证和调用 MCP 服务器/工具 |
| `mcp-terminal` | 通过终端（npx stdio）调用 MCP 服务器，支持 tools/list 和 tools/call |

### Superpowers 系列

| 技能名 | 说明 |
|--------|------|
| `superpowers-brainstorming` | 创意工作前的头脑风暴 |
| `superpowers-dispatching-parallel-agents` | 面临 2+ 独立任务时分发并行代理 |
| `superpowers-executing-plans` | 在独立会话中执行实现计划 |
| `superpowers-finishing-a-development-branch` | 实现完成后决定如何集成工作 |
| `superpowers-receiving-code-review` | 接收代码审查反馈后的处理流程 |
| `superpowers-requesting-code-review` | 完成任务后请求代码审查 |
| `superpowers-subagent-driven-development` | 子代理驱动开发，在当前会话执行计划 |
| `superpowers-systematic-debugging` | 遇到 Bug/测试失败/异常行为时的系统化调试 |
| `superpowers-test-driven-development` | 测试驱动开发，实现前先写测试 |
| `superpowers-using-git-worktrees` | 使用 Git Worktrees 隔离功能开发 |
| `superpowers-using-superpowers` | 会话开始时建立技能发现与使用机制 |
| `superpowers-verification-before-completion` | 声称工作完成前的验证流程 |
| `superpowers-writing-plans` | 有规格/需求时编写多步骤任务计划 |
| `superpowers-writing-skills` | 创建、编辑、验证技能 |

### 其他分类

| 技能名 | 说明 |
|--------|------|
| `pua-interviewer` | 以专业、高压的面试官身份进行技术面试，评估候选人深度 |

## 自定义技能

自定义技能位于 `skills/custom/` 目录（被 gitignore），可通过 API 安装 `.skill` 压缩包后自动解压到此目录。

## 技能格式

每个技能的 `SKILL.md` 格式：

```markdown
---
name: skill-name
description: 技能描述
license: MIT
---

# Skill Name

技能指令内容...
```

### frontmatter 字段

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `name` | string | 是 | 技能标识符（hyphen-case） |
| `description` | string | 是 | 技能描述，用于 UI 展示和触发匹配 |
| `license` | string | 否 | 许可证类型 |
| `allowed-tools` | list | 否 | 技能允许使用的工具白名单 |

## 技能发现与加载

技能发现流程：

1. 扫描 `skills/public/` 目录 → 所有公开技能
2. 扫描 `skills/custom/` 目录 → 所有自定义技能
3. 扫描 `skills/development/`、`skills/devops/`、`skills/interview/` 等分类目录
4. 加载已启用技能的 `SKILL.md` 内容

技能列表通过 mtime 检测配置文件变更，无需重启进程即可启用/禁用技能。

## 技能安装

通过 API 安装 `.skill` 压缩包：

```bash
curl -X POST http://localhost:8001/api/skills/install \
  -F "file=@my-skill.skill"
```

安装后技能会解压到 `skills/custom/` 目录。

## 启用/禁用技能

技能的启用状态由 `extensions_config.json` 中的 `skills` 字段控制：

```json
{
  "skills": {
    "byted-ark-seedream-skill": { "enabled": true },
    "deep-research": { "enabled": true }
  }
}
```

也可通过 API 启用/禁用：

```bash
curl -X PUT http://localhost:8001/api/skills/{name} \
  -H "Content-Type: application/json" \
  -d '{"enabled": true}'
```

## 技能工具路径约定

技能文件安装在 EvoFlow 程序目录，与用户工作区不是同一棵树。读写技能文件时使用 `skill:<name>` 路径前缀，详见 `skills/EVOFLOW_TOOLS.md`。

## 相关参考

- [skill-system.md](../../user/explanation/skill-system.md) - 技能系统设计原理
- [api-reference.md](api-reference.md) - Skills API 端点
- [skill-management.md](../../user/guides/configuration/skill-management.md) - 技能管理指南
