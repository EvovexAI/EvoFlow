# EvoFlow

## Git 协作（默认）

- 推送目标：`origin` **双公仓**（两条 push URL，一次 push 两边都更新）
  - GitHub：`https://github.com/EvovexAI/EvoFlow.git`（HTTPS + `gh auth git-credential`）
  - Gitee：`https://gitee.com/evovexai/EvoFlow.git`（HTTPS；私人令牌作密码，用户名可用 `oauth2`）
- fetch 默认仍走 GitHub；**remote URL 必须是 HTTPS**，不要切 SSH（否则落到本机其他账号 key）
- **默认直推 / 合进 `main`，不要主动开 PR**；只有用户明确说「开 PR / 提 PR / create PR」时才 `gh pr create`
- 已有 PR 且用户要合：`gh pr merge --admin`（分支保护时）
- Gitee 免费仓无 LFS；推 tags 若报 LFS 错用 `GIT_LFS_SKIP_PUSH=1`
- 安装包 **各自构建**：GitHub Actions ↔ GitHub Releases；Gitee Go（自建 Windows 机）↔ CDN + Gitee `update/latest.json`（见 `scripts/maintainer/gitee/README.md`）

## 桌面发版

升版本 / 打安装包前必读仓库根 [RELEASE.md](./RELEASE.md)（唯一版本源 `evopanel/VERSION`；三份说明；勿只改 package.json）。

## 检索约定

回答「代码在哪 / 某模块怎么工作」前：

1. 先读 [docs/contribute/repo-map.md](./docs/contribute/repo-map.md) 定位子系统与测试位置
2. 已知确切路径 → 直接 Read/Grep；未知路径 → `grep` / `search_code_index` 定位
3. 全项目 Grep 是最后手段，不是默认

## Agent 提示词工程

- 审计器：`python scripts/prompt-audit/prompt_audit.py <file>`（stdlib-only；`--layer L1|L2|L3`、`--json`）
- 漂移守卫：`python backend/scripts/prompt_drift_guard.py`（检出退役工具名 / 指向不存在路径的承诺）
- 适用：任何 Agent 提示词栈（system_prompt + AGENTS.md + 本地 `.mdc` rules）的结构化诊断
- HIGH 级问题 → 退出码 1；两者均在 `.github/workflows/lint-check.yml` 的 cheap lane 跑

## Gateway 三车道（可用性）

桌面单进程 Gateway：**Control / Data / Best-effort**（见 `backend/app/gateway/traffic_lanes.py`）。

- **未知 `/api/*` 默认 DATA**，禁止默认进 Control——新慢接口也要被隔离，不能等 hang 再打补丁
- Best-effort（catalog、serve-file、git、browser/log…）过载时由 `TrafficLaneMiddleware` **503 shed**
- 本机媒体优先 Tauri `convertFileSrc`，勿默认经 Gateway 拉大 mp4
