# EvoFlow

## Git 协作（默认）
- 推送目标：`origin` → `EvovexAI/EvoFlow`（HTTPS + `gh auth git-credential`）
- **默认直推 / 合进 `main`，不要主动开 PR**；只有用户明确说「开 PR / 提 PR」时才 `gh pr create`
- 已有 PR 且用户要合：`gh pr merge --admin`（分支保护时）

## 桌面发版
升版本 / 打安装包前必读仓库根 [RELEASE.md](./RELEASE.md)（唯一版本源 `evopanel/VERSION`；三份说明；勿只改 package.json）。

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

## Agent 提示词工程
- 规范：[`.codebasewiki/meta/agent-prompt-architecture.md`](./.codebasewiki/meta/agent-prompt-architecture.md)
- 审计：`.claude/skills/prompt-audit/SKILL.md`(或 `python .claude/skills/prompt-audit/scripts/prompt_audit.py`)
- 适用：任何 Agent 提示词栈(system_prompt + AGENTS.md + .mdc rules)的结构化诊断

## Gateway 三车道（可用性）
桌面单进程 Gateway：**Control / Data / Best-effort**（见 `backend/app/gateway/traffic_lanes.py`）。
- **未知 `/api/*` 默认 DATA**，禁止默认进 Control——新慢接口也要被隔离，不能等 hang 再打补丁。
- Best-effort（catalog、serve-file、git、browser/log…）过载时由 `TrafficLaneMiddleware` **503 shed**。
- 本机媒体优先 Tauri `convertFileSrc`，勿默认经 Gateway 拉大 mp4。
