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

## 验证命令（后端 / 前端 / shell）

**本仓 `.venv` 已用 editable 方式装好 harness，不需要 `PYTHONPATH`。** 加 `PYTHONPATH=packages/harness:.`
是纯冗余——它曾被当成「门禁模板」照抄 3105 次（近 7 天 bash 调用 17%），每条多 175 字节。

```bash
# 后端（在 backend/ 下；python 已指向 .venv，不用写 .venv/Scripts/python.exe）
cd backend
python -m py_compile <改动文件>        # 语法
python -m ruff check <改动文件>        # 静态检查
python -m pytest tests/<相关测试>.py -q
python packages/harness/scripts/obs_query.py --list-tables   # 观测库即席查询

# 前端（在仓库根；不要用 npx，本机易假阴性）
node evopanel/node_modules/typescript/bin/tsc --noEmit

# shell
bash -n <脚本>
```

要点：

- **不需要 `PYTHONPATH`**。`backend/.venv/Lib/site-packages/_editable_impl_evoflow_harness.pth`
  已把 `packages/harness` 写进搜索路径；实测裸 `python -m pytest` 直接通过。
- **不需要绝对 `cd`**。终端工作目录在调用间持久，`cd` 一次后续沿用；只有跨目录时才再 `cd`。
- 命令前的 `VAR=value` 前缀不会持久（每次调用是新 shell），别靠它传状态。
- 观测/度量类查询**优先用现成脚本**，不要在命令里现写 `python - <<EOF` 长探针。
  在 `backend/` 下按下面的**完整相对路径**调用（`scripts/` 前面必须带 `packages/harness/`，
  少写这一段会 `No such file or directory`）：
  - `python packages/harness/scripts/agent_self_metrics.py --days 7` —— 错误率 / 慢调用 / 重复踩坑 / 已消失
  - `python packages/harness/scripts/tool_latency_report.py --days 1` —— 工具耗时归因（含 bash 拆分）
  - `python packages/harness/scripts/context_cost_report.py --days 7` —— **工具返回值体积 → 上下文 → TTFT 分桶**（谁在灌字节、缓存命中率、按岗位耗时）
  - `python packages/harness/scripts/obs_query.py --list-tables / --schema / --sql` —— 任意即席只读查询
  【self-evolution-bot · 2026-11-19 · 第67轮 · 模型:deepseek-v4.1-flash-1017】此处先前写成
  `scripts/…` 少了 `packages/harness/` 前缀，实测直接 `No such file or directory`；
  已按真跑通过的完整路径更正。
- 不为验收起 dev server / 点页面 / 截图；类型检查通过 ≠ 效果达成——
  性能类改动必须报数字（ms / 条数 / 占比）。

- 审计器：`python scripts/prompt-audit/prompt_audit.py <file>`（stdlib-only；`--layer L1|L2|L3`、`--json`）
- 漂移守卫：`python backend/scripts/prompt_drift_guard.py`（检出退役工具名 / 指向不存在路径的承诺）
- 适用：任何 Agent 提示词栈（system_prompt + AGENTS.md + 本地 `.mdc` rules）的结构化诊断
- HIGH 级问题 → 退出码 1；两者均在 `.github/workflows/lint-check.yml` 的 cheap lane 跑

## Gateway 三车道（可用性）

桌面单进程 Gateway：**Control / Data / Best-effort**（见 `backend/app/gateway/traffic_lanes.py`）。

- **未知 `/api/*` 默认 DATA**，禁止默认进 Control——新慢接口也要被隔离，不能等 hang 再打补丁
- Best-effort（catalog、serve-file、git、browser/log…）过载时由 `TrafficLaneMiddleware` **503 shed**
- 本机媒体优先 Tauri `convertFileSrc`，勿默认经 Gateway 拉大 mp4

## Agent 终端长任务（防对话假死）

`ffmpeg` / `render*.py` / 整片编码 / 大批量生图生视频：**禁止前台干等 + `| tail`**（会卡在「正在获取任务输出」，对话像死机；中断后进程常变僵尸）。

权威规则：`.cursor/rules/long-running-shell.mdc`（先探活 → 后台 + 日志 → 轮询产物；只杀确认过的 PID）。
