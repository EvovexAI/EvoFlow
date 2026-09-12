---
name: evoflow-admin-external
description: "供 外部 Agent / CLI 宿主 等外部 Agent 管理 EvoFlow 平台。先按 references/00a-desktop-setup.md 下载桌面端、配模型、检测 evoflow CLI；再读 00-concept-routing 与 03 全量 CLI、examples/。覆盖模型、技能、Agent、岗位员工、事项、任务、审批、工作流、自动化、组织包、资产、MCP、记忆、知识、经验、评测、日志与 platform HTTP。"
license: Apache-2.0
version: 1.0.3
author: EvovexAI
homepage: https://github.com/EvovexAI/EvoFlow/tree/main/skills/public/evoflow-admin-external
repository: https://github.com/EvovexAI/EvoFlow
category: evoflow-system
compatibility: "Requires EvoFlow CLI (evoflow) on PATH; Gateway recommended for dispatch/approvals. Works with runtime, 常见 Agent 宿主, Work Body."
metadata:
  slug: evoflow-admin-external
  distribution: standalone-zip
  install_name: evoflow-admin-external
  min_evoflow: "0.5.9"
  package_formats:
    - zip
    - skill
tags:
  - evoflow
  - admin
  - cli
  - platform
  - external-agent
  - work-body
---

# EvoFlow Admin（外部 Agent 发行包）

独立可分发（文件夹 + `SKILL.md` → `.zip`）。**无软链接。**

## 必读顺序

| 顺序 | 文档 | 内容 |
|------|------|------|
| 0 | [`references/00a-desktop-setup.md`](references/00a-desktop-setup.md) | **下载桌面端、配模型、检测 CLI**（先做） |
| 1 | [`references/00-concept-routing.md`](references/00-concept-routing.md) | 待办 / 任务 / Agent / 岗位员工 / 工作流 怎么选 |
| 2 | [`references/03-cli-cheatsheet.md`](references/03-cli-cheatsheet.md) | 20 组命令全量 |
| 3 | [`examples/README.md`](examples/README.md) | JSON/MD 样例索引 |
| 4 | [`references/05-playbooks.md`](references/05-playbooks.md) | 照抄剧本 |
| 5 | [`references/04-http-platform.md`](references/04-http-platform.md) | platform 全量 action + REST |
| — | [`references/employees-observe.md`](references/employees-observe.md) | 员工观察字段 |
| — | [`references/01-install.md`](references/01-install.md) / [`02-version-check.md`](references/02-version-check.md) | 技能包安装验版 |
| — | [`references/06-publish-and-website.md`](references/06-publish-and-website.md) | 官网发布 |


## 概念速查

| 说法 | 组 |
|------|-----|
| 个人待办 / 备忘 | `items` |
| 任务中心 / 结案 | `tasks` |
| 角色配置 | `agents` |
| 值班岗 / 雇员工 / 派活 | `employees` |
| 审批 | `approvals` |
| 跑 App | `workflow` |
| 定时 | `automation` |
| 团队包 | `org` |

`items ≠ tasks ≠ employees ≠ workflow` · `agents` → `employees hire` → `dispatch`/`wake`

## 环境

先完成 [`00a-desktop-setup.md`](references/00a-desktop-setup.md)（桌面端 + 模型 + CLI 冒烟），再：

```bash
evoflow models list ; evoflow agents list ; evoflow employees list
```

`--file` 必须是路径。禁止 `agents seed`。Windows 用 `;`。

```text
1. evoflow CLI   2. POST /api/platform   3. 专用 REST
```
