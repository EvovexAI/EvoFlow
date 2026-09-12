# 分支与检查

与根目录 [CONTRIBUTING.md](../../CONTRIBUTING.md) 一致；本页是中文速查。

## 拉最新并开分支

```bash
git fetch origin
git checkout main
git pull --ff-only origin main
git checkout -b feat/short-description   # 或 fix/… docs/…
```

| 分支 | 用途 |
|------|------|
| `main` | 受保护，只收 PR |
| `feat/*` | 功能 |
| `fix/*` | 缺陷 |
| `docs/*` | 仅文档 |

一个 PR 只做一件逻辑上完整的事。提交前变基（或合并）到最新 `main`：

```bash
git fetch origin
git rebase origin/main
git push -u origin HEAD
```

提交说明用 Conventional Commits：`feat:` / `fix:` / `docs:` / `chore:` / `refactor:` / `test:`。

## 本地检查（推送前）

尽量跑与 CI 对齐的入口：

```bash
make ci-local
# 或: bash scripts/ci-local.sh
```

按改动范围的最低要求：

| 改动 | 命令 |
|------|------|
| Backend Python | `cd backend && make format` 且 `uv run pytest` |
| EvoPanel | `cd evopanel && pnpm typecheck`（动 UI 逻辑再加 `pnpm test`） |
| 文档 / `mkdocs.yml` | `make docs-build` |

## CI（PR 必绿）

- [lint-check.yml](../../.github/workflows/lint-check.yml)
- [backend-unit-tests.yml](../../.github/workflows/backend-unit-tests.yml)
- [docs.yml](../../.github/workflows/docs.yml)（改了文档时）

发版打包、公仓同步工作流由维护者触发，不是普通贡献者检查项。

## 合并约定

- 至少一名维护者 Review  
- 推荐 squash merge  
- 禁止对 `main` force-push  
- 详见 [MAINTAINERS.md](../../MAINTAINERS.md)
