# 技能列表与说明

## 概述

EvoFlow 技能位于 `skills/` 目录，分为 `public/`（公开技能，提交到版本库）和 `custom/`（自定义技能，被 gitignore）。

每个技能是一个包含 `SKILL.md` 的目录，`SKILL.md` 使用 YAML frontmatter 声明元数据（name, description, license, allowed-tools）。

技能的启用/禁用状态由 `extensions_config.json` 中的 `skills` 字段控制。

## 公开技能列表

### 数据与分析

| 技能名 | 说明 |
|--------|------|
| `data-analysis` | 数据分析与可视化 |
| `chart-visualization` | 图表可视化生成 |
| `deep-research` | 深度研究报告生成 |
| `consulting-analysis` | 咨询分析报告 |
| `github-deep-research` | GitHub 仓库深度分析 |

### 文档处理

| 技能名 | 说明 |
|--------|------|
| `pdf` | PDF 文件处理 |
| `docx` | Word 文档处理 |
| `pptx` | PowerPoint 演示文稿处理 |
| `xlsx` | Excel 电子表格处理 |

### 开发与编码

| 技能名 | 说明 |
|--------|------|
| `coding-agent` | 编码代理，代码生成与修改 |
| `frontend-design` | 前端设计与开发 |
| `browser` | 浏览器自动化 |
| `playwright` | Playwright 浏览器控制 |

### 媒体生成

| 技能名 | 说明 |
|--------|------|
| `media-generation` | **总览**：生图/生视频能力类型、支持厂商、路由到子技能 |
| `media-generation-volcengine` | 火山方舟 Seedream / Seedance 脚本与参数 |
| `media-generation-agnes` | Agnes AI 生图/生视频（[官方文档](https://agnes-ai.com/doc/overview)） |
| `media-production` | 多 Agent 短片制片流水线（默认 volcengine 脚本） |
| `plan-video-production` | Plan 模式视频步骤规划 |
| `video-generation` | 视频生成（占位；推荐 `media-generation`） |
| `image-generation` | 图片生成（占位；推荐 `media-generation`） |
| `ppt-generation` | PPT 演示文稿生成 |

### 产品与入门

| 技能名 | 说明 |
|--------|------|
| `evoflow-intro` | EvoFlow 能力自介绍：技能、MCP、角色、记忆、托管、模型、渠道等 |
| `preset-role-assistant` | 快速创建预设 Agent 角色 |
| `bootstrap` | 对话式生成个性化 SOUL.md |
| `find-skills` | 发现与安装技能 |
| `skill-creator` | 创建与迭代改进技能 |

### 自定义技能

| 技能名 | 说明 |
|--------|------|
| `jira_logger` | Jira 日志记录工具 |

## 技能格式

每个技能的 `SKILL.md` 格式：

```markdown
---
name: skill-name
description: 技能描述
license: MIT

# Skill Name

技能指令内容...
```

## 技能安装

通过 API 安装 `.skill` 压缩包：

```bash
curl -X POST http://localhost:8001/api/skills/install \
  -F "file=@my-skill.skill"
```

安装后技能会解压到 `skills/custom/` 目录。

## 启用/禁用技能

```bash
curl -X PUT http://localhost:8001/api/skills/{name} \
  -H "Content-Type: application/json" \
  -d '{"enabled": true}'
```

## 相关参考

- [skill-system.md](../explanation/skill-system.md) - 技能系统设计原理
- [api-reference.md](./api-reference.md) - Skills API 端点
