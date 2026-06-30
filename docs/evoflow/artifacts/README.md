# EvoFlow 任务产出目录约定（结构化真源）

本约定与 `skills/public/superpowers-*` 技能族对齐：把「需求 → 澄清 → 规格 → 计划 → 执行 → 验收」各阶段产物落在**固定相对路径**下，便于：

- **下游自动化**（CI、评审机器人、发布流水线）按路径读取；
- **多轮对话 / 新会话**再注入上下文时，只引用 `README.yaml` 与阶段文件，而不必复述整段历史；
- **未来产品化**：任务中心、飞书回传、主线快照可将 `<run-id>` 与线程 `thread_id`、目标任务 id 对齐后落库或索引。

`<run-id>` 建议取值（择一即可，全仓统一口径）：

| 来源 | 示例 | 说明 |
|------|------|------|
| 任务中心 / 目标任务 id | `task_7f3a9c` | 与产品侧任务记录主键一致时最优 |
| LangGraph 线程 | `thread_uuid…` | 与运行时线程一一对应 |
| 日期 + 主题 slug | `2026-05-15-auth-jwt` | 人工可读、适合无任务 id 的本地迭代 |

## 目录布局

在仓库根下（或当前工作区根下）使用：

```text
docs/evoflow/runs/<run-id>/
  README.yaml          # 机器可读索引（强烈建议）
  01-brief.md          # 原始需求 / 用户原话摘要
  02-intent.md         # 澄清后的目标与非目标
  03-spec/             # 已确认规格（可拆分多文件）
    overview.md
    decisions.md
  04-plan/             # 实现计划（可对应 superpowers-writing-plans 产出）
    YYYY-MM-DD-feature.md
  05-execution/        # 执行过程记录（子任务小结、SHA、测试结果）
    task-01.md
  06-review.md         # 代码评审 / 规格复核结论
  99-summary.md        # 交付小结：做了什么、未做什么、后续建议
```

技能中的占位写法 `docs/evoflow/runs/<run-id>/...` 表示将上述片段拼成实际路径时替换 `<run-id>`。

### README.yaml 建议字段

以下为**建议** schema，便于后续接入 DB 或 API；YAML 内容应保持稳定、可解析。

```yaml
run_id: "<run-id>"
created_at: "2026-05-15T12:00:00Z"
updated_at: "2026-05-15T14:30:00Z"
title: "短标题"
stages:
  brief: { path: "01-brief.md", status: done }
  intent: { path: "02-intent.md", status: done }
  spec: { path: "03-spec/overview.md", status: done }
  plan: { path: "04-plan/2026-05-15-feature.md", status: in_progress }
  execution: { path: "05-execution/", status: pending }
  review: { path: "06-review.md", status: pending }
  summary: { path: "99-summary.md", status: pending }
links:
  thread_id: null
  task_id: null
  pr_url: null
```

`status` 可取 `pending` | `in_progress` | `done` | `blocked`。

## 与 Superpowers 衍生技能的关系

`skills/public/superpowers-*` 中的路径示例已统一为 `docs/evoflow/runs/<run-id>/` 下的 `plans/`、`specs/` 等子目录；与上游 [Superpowers](https://github.com/obra/superpowers)（MIT）行为一致的部分是**流程与纪律**，路径则以 EvoFlow 本约定为准。

## 许可说明

Superpowers 原始技能文本版权归属上游作者；本目录文档与路径约定由 EvoFlow 项目维护，与上游独立演进。
