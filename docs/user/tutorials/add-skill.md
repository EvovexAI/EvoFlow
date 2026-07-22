# 添加自定义技能

> **比如你想让 AI 能做这么一件事**：
>
> "帮我写一份周报，从飞书群里抓本周消息，按项目归类，生成 Markdown 格式"
>
> 系统内置的 50+ 技能里没有专门做这个的。你可以自己写一个周报技能——创建一个文件夹，里面放一个 `SKILL.md` 描述技能怎么用，配几个脚本。AI 在对话中自动识别并调用这个技能。
>
> 技能 vs 工具 vs MCP 的区别：技能是"领域知识包"（告诉 AI 怎么做），工具是"内置能力"（read/write/terminal），MCP 是"外部服务"（GitHub API、Notion 等）。三者互补。

## 你将学到什么

- 理解 SKILL.md 格式
- 创建并安装一个自定义技能

## 前置条件

- EvoFlow 正在运行

## 预计用时

10 分钟

## 步骤

### 1. 什么是技能

技能是一个包含 `SKILL.md` 文件的目录。`SKILL.md` 使用 YAML frontmatter + Markdown 正文的格式：

```markdown
---
name: my-skill
description: 我的自定义技能
allowed-tools: bash, read_file, write_file

## 工作流程

1. 第一步...
2. 第二步...

## 最佳实践

- ...
```

### 2. 创建技能目录

```bash
mkdir -p skills/custom/my-skill
```

### 3. 编写 SKILL.md

在 `skills/custom/my-skill/` 下创建 `SKILL.md`，写入你的技能定义。

### 4. 安装 .skill 归档文件（可选）

通过 Gateway API 安装远程技能包：

```bash
curl -X POST http://localhost:8001/api/skills/install \
  -F "file=@/path/to/skill.skill"
```

### 5. 启用技能

技能默认启用。你可以在 EvoFlow 的**工具与技能**页面管理启用/禁用状态。

## 验证是否生效

Agent 在执行相关任务时会自动加载和使用该技能。

## 下一步

- [配置你的第一个模型](configure-models.md)
- [创建自定义 Agent](create-agent.md)
