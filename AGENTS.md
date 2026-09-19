# EvoFlow

本项目的 AI 可消费知识库位于 [`.codebasewiki/`](./.codebasewiki/)(多工具按 [AGENTS.md 标准](https://agents.md/) 自动发现本文件)。

## 检索约定(AI 默认先查知识库)
处理「代码在哪 / 某模块怎么工作 / 某概念涉及哪些文件」前:
1. 先读 `.codebasewiki/index/index.md`(模块地图)+ `index/architecture.md`(整体架构),再下钻;
2. 关键词 → 源文件用 `/codebase-navigator <关键词>`(四层索引,<10s 定位);
3. 全项目 Grep 是最后手段,不是默认。已知确切路径的简单查找仍可直接 Read/Grep。

## 五环闭环
- **建库**:`/codebase-bootstrap` 或 `python .claude/skills/codebase-bootstrap/scripts/bootstrap.py`
- **检索**:`/codebase-navigator <关键词>`
- **沉淀**:会话结束自动(Stop hook → codebase-compound)
- **编排验证**:`/codebase-loop verify`
- **质量审**:`/codebase-wiki`(审 .codebasewiki/ 断链/缺节/frontmatter)

详见 `.claude/skills/codebase-wiki/SKILL.md`。

## 多 AI 协同开发规则

### 固定职责

| 角色 | 定位 | 主要负责 | 不负责或需先协调 |
| --- | --- | --- | --- |
| ChatGPT | 产品、架构与项目总控 | 需求澄清、模块划分、方案与任务拆解、优先级、验收标准、发布规划 | 不作为常规业务代码的直接实现者 |
| Codex | 核心研发与架构工程师 | Gateway/FastAPI、Agent Runtime、LangGraph、Supervisor、Agent Teams、Memory、Skills、MCP、Sandbox、数据模型、权限、任务调度、跨模块重构、自动化测试与代码审查 | UI 的纯视觉微调应交给 Cursor |
| Cursor | EvoPanel UI 与本地开发工程师 | React/Tauri 页面、组件、交互、样式、前端状态、API 接入、页面级修复 | 不单独修改 Runtime、Memory、MCP、Sandbox 等底层架构；涉及这些边界时先建任务并交由 Codex 处理 |

### 协作流程

1. ChatGPT 将每项需求记录到 `docs/product/requirements.md`，并在 `docs/tasks/backlog.md` 建立带验收标准的任务。
2. 任务按改动边界分配：跨模块、后端或运行时任务给 Codex；EvoPanel 页面和局部交互任务给 Cursor。
3. 实施者只修改自己任务涉及的文件；发现跨边界影响时暂停扩大改动，在任务中记录并请求拆分或协调。
4. 合并前由 ChatGPT 按任务验收标准检查；Codex 对高风险、跨模块或运行时改动进行代码审查。
5. 完成的任务移至 `docs/tasks/completed.md`，版本与用户可见变更同步记录在 `docs/releases/`。

### Git 规则

- `main` 仅保存已验证、可发布的版本；不得直接开发或直接提交业务变更。
- `develop` 是日常集成分支。本仓库的协作规范、文档和初始化变更首先进入 `develop`。
- 功能从 `develop` 创建 `feature/EVO-<编号>-<简短名称>`；修复从 `develop` 创建 `fix/EVO-<编号>-<简短名称>`；紧急修复从 `main` 创建 `hotfix/EVO-<编号>-<简短名称>`。
- 一个任务对应一个分支和一个拉取请求。提交信息使用 Conventional Commits，例如 `feat(runtime): add team template` 或 `docs(process): add collaboration baseline`。
- 合并目标默认是 `develop`；仅已通过验收的发布候选可从 `develop` 合并到 `main`。禁止强推共享分支。
- 合并前必须同步分支、运行与改动相称的检查，并在拉取请求中关联 EVO 任务编号、验收结果和风险说明。
