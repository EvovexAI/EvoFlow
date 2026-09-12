# 仓库地图

大仓库里多数 PR 只碰一个子系统。改之前先对上目录与测试位置。

| 子系统 | 主要路径 | 先读 | 测试 / 检查 |
|--------|----------|------|-------------|
| Gateway / 渠道 | `backend/app/` | [CONTRIBUTING](../../CONTRIBUTING.md) | `cd backend && uv run pytest`（相关用例） |
| Agent Runtime / Harness | `backend/packages/harness/evoflow/` | [backend/AGENTS.md](../../backend/AGENTS.md) | 同上；改工具/记忆/沙箱必跑相关测试 |
| 持久化 / 迁移 | `backend/packages/harness/evoflow/persistence/` | 同左 | 迁移与 schema 相关测试 |
| EvoPanel 桌面端 | `evopanel/` | `evopanel/CONTRIBUTING.md` | `pnpm typecheck`；UI 逻辑加 `pnpm test` |
| 公开 Skills | `skills/public/` | [添加 Skill](add-skill.md) | 人工：面板加载技能；无密钥进仓 |
| 用户文档 | `docs/user/`、`docs/index.md` | [文档首页](../index.md) | `make docs-build` |
| 代码知识库 Wiki | `.codebasewiki/` | [代码知识库 Wiki](codebase-wiki.md) | `python .claude/skills/codebase-wiki/scripts/wiki_audit.py --config ./wiki-config.yaml`（本地有技能时） |
| 贡献者脚本 | `scripts/`（不含 `maintainer/`） | [scripts/README.md](../../scripts/README.md) | 按脚本说明试跑 |
| 上游发版 / 公仓同步 | `scripts/maintainer/` | 维护者专用 | 勿在社区 PR 中改，除非维护者指定 |
| CI | `.github/workflows/` | [分支与检查](branching-and-checks.md) | PR 上 Actions 必须绿 |

## 边界（必守）

- **`evoflow.*` 不得 import `app.*`**；`app` 可以依赖 `evoflow`。  
- 不要把运行时数据提交进库：`.evoflow/`、`backend/outputs/`、密钥、`local-publish.env`。  
- 桌面安装包与公仓 `update/latest.json` 由维护者发版流程写入（草稿在 `scripts/maintainer/update/`），普通 PR 不要手改版本假数据。

## 建议改动落点

| 你想做的事 | 优先改 |
|------------|--------|
| 修 Gateway API / 飞书微信 | `backend/app/channels/` 或对应 router |
| 改规划 / 子 Agent / 工具行为 | `backend/packages/harness/evoflow/` |
| 改面板交互 | `evopanel/src/` |
| 教 Agent 做一件新业务事 | **先写 Skill**，不要先加核心 tool |
| 澄清产品用法 | `docs/user/` |
