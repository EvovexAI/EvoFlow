# 参与贡献

本文档是仓库根目录 [CONTRIBUTING.md](https://github.com/EvovexAI/EvoFlow/blob/main/CONTRIBUTING.md) 的站内入口与摘要。完整的开发环境搭建、Docker 工作流、测试要求等内容请参阅原文（英文）。

## 快速导航

| 主题 | 说明 |
|------|------|
| **开发环境** | 推荐 Docker 开发环境（`make docker-init` → `make docker-start`），也支持本地开发（`make install` → `make dev`） |
| **项目结构** | `backend/` 后端、`evopanel/` 桌面端、`skills/` 技能、`scripts/` 脚本、`docker/` 容器配置 |
| **开发流程** | 创建 feature 分支 → 修改 → `make format`（后端）/ `pnpm typecheck`（前端）→ 提交 → PR |
| **代码风格** | 后端使用 ruff，前端使用 TypeScript 类型检查；CI 强制校验格式 |
| **测试** | 后端 `uv run pytest`，前端 `pnpm test` |

## 端口与架构

```
Browser
  ↓
Nginx (port 2026) ← 统一入口
  ├→ Gateway API (port 8001/8012) ← /api/*
  ├→ LangGraph Server (port 2024) ← /api/langgraph/*
  └→ EvoPanel / Web UI ← /（非 API 请求）
```

## 文档贡献

文档贡献者请参考术语表，并参考仓库内 `docs/internal/` 下的 SSOT 索引与写作规范。

- [术语表](../meta/glossary.md) — 统一术语
- SSOT 索引：`docs/internal/meta-ssot.md`
- 写作规范：`docs/internal/meta-writing-style.md`
