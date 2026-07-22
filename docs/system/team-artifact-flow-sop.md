# 技术团队产物流转规范（SOP）

> 本文档是技术团队所有 AI 员工的产出契约。每个人写东西前先读这份，写完的东西必须符合这里的命名和格式要求，下游才知道去哪读、读什么、读到的能不能用。

---

## 一、产物放哪：目录结构

所有团队产物统一放在 `outputs/team/` 下，**按角色分目录**，不再堆在根目录：

```
outputs/team/
├── pm/                    # 产品经理产出
│   ├── prd/               # 需求文档
│   └── roadmap/           # 路线图、排期
├── cto/                   # 技术总监产出
│   ├── dispatch/          # 派发单（派给谁的任务）
│   ├── dashboard/         # 质量看板、周报
│   └── review/            # 方案评审、门禁结论
├── frontend/              # 前端工程师产出
│   └── worklog/           # 工作日志、变更说明
├── backend/               # 后端工程师产出
│   └── worklog/
├── qa/                    # Bug 分析师产出
│   ├── bug/               # bug 单（待定位）
│   └── analysis/          # 根因分析报告
└── _archive/              # 已完结归档（按月）
```

**规则：**
- 每个人只能往自己角色的目录写，不越界
- 临时文件、实验脚本不进 `team/`，放 `outputs/tmp/`
- 归档用 `_archive/YYYY-MM/`，完结的需求整体搬过去

---

## 二、命名规范

所有文件名统一格式：`{类型}-{主题}-{日期}.{ext}`

| 角色 | 类型前缀 | 示例 |
|------|---------|------|
| 产品经理 | `prd`、`roadmap` | `prd-登录优化-20260719.md` |
| 技术总监 | `dispatch`、`dashboard`、`review` | `dispatch-登录优化-20260719.md` |
| 前端 | `worklog-fe` | `worklog-fe-登录优化-20260719.md` |
| 后端 | `worklog-be` | `worklog-be-登录优化-20260719.md` |
| Bug 分析师 | `bug`、`analysis` | `bug-登录页闪烁-20260719.md` |

**规则：**
- 主题用中文短词，不超过 10 字，跨文件保持一致（同一个需求的 prd 和 dispatch 主题词必须一样）
- 日期是产出日期，不是需求日期
- 扩展名只允许 `.md`（文档）或 `.json`（结构化数据）

---

## 三、通用要求：每个产物必须有 Metadata 头部

**所有 Markdown 产物**，文件开头必须是这段 metadata（用 YAML front matter）：

```yaml
---
author: product-manager        # 产出者 agent_code
role: 产品经理                  # 产出者岗位名
date: 2026-07-19               # 产出日期
topic: 登录优化                 # 主题（与文件名一致）
status: draft                  # draft | in_review | approved | done | blocked
downstream:                    # 下游是谁（agent_code 列表）
  - quality-inspector
upstream:                      # 上游依赖（本产物读了谁的产出）
  - prd-登录优化-20260719.md
related:                       # 关联的其他产物
  - dispatch-登录优化-20260719.md
---
```

**字段说明：**

| 字段 | 必填 | 说明 |
|------|------|------|
| `author` | ✅ | 产出者的 agent_code |
| `role` | ✅ | 产出者的岗位名 |
| `date` | ✅ | 产出日期 |
| `topic` | ✅ | 主题词，与文件名一致 |
| `status` | ✅ | 状态流转：`draft`→`in_review`→`approved`→`done`；卡住用 `blocked` |
| `downstream` | ✅ | 这个产物该给谁看/谁消费（agent_code 列表） |
| `upstream` | ❌ | 写这个产物时读了哪些上游产物（文件名列表） |
| `related` | ❌ | 关联但非直接依赖的产物 |

**为什么要这个头部：**
- 下游员工读文件时，先看 `downstream` 里有没有自己，确认"这是给我的"
- 看 `status` 确认"这个产物能不能用"（`draft` 不能直接用，`approved` 才能用）
- 看 `upstream` 知道这个产物基于什么写的，方便追溯

---

## 四、流转链路：谁产出 → 谁读

### 标准需求流转

```
1. 产品经理
   产出: prd-{主题}-{日期}.md        → outputs/team/pm/prd/
   下游: quality-inspector

2. 技术总监（读 PRD）
   读:  prd-{主题}-{日期}.md
   产出: dispatch-{主题}-{日期}.md    → outputs/team/cto/dispatch/
   下游: code-agent, project-implementer, project-debugger

3. 前端工程师（读 dispatch）
   读:  dispatch-{主题}-{日期}.md（其中指派前端的部分）
   产出: worklog-fe-{主题}-{日期}.md  → outputs/team/frontend/worklog/
   下游: quality-inspector

4. 后端工程师（读 dispatch）
   读:  dispatch-{主题}-{日期}.md（其中指派后端的部分）
   产出: worklog-be-{主题}-{日期}.md  → outputs/team/backend/worklog/
   下游: quality-inspector

5. 技术总监（汇总）
   读:  worklog-fe-* + worklog-be-* + analysis-*
   产出: dashboard-{日期}.md          → outputs/team/cto/dashboard/
   下游: product-manager（反馈进度）
```

### Bug 处理流转

```
1. 任何人发现 bug
   产出: bug-{现象}-{日期}.md          → outputs/team/qa/bug/
   下游: project-debugger

2. Bug 分析师（读 bug 单）
   读:  bug-{现象}-{日期}.md
   产出: analysis-{现象}-{日期}.md     → outputs/team/qa/analysis/
   下游: quality-inspector（定优先级 + 派回修复）

3. 技术总监（读 analysis）
   读:  analysis-{现象}-{日期}.md
   动作: 更新 dispatch-{现象}-{日期}.md，指派前端/后端修复
   下游: code-agent 或 project-implementer
```

---

## 五、产物的状态流转

每个产物的 `status` 字段按这个顺序流转，不允许跳级：

```
draft → in_review → approved → done
                 ↘ blocked
```

| 状态 | 含义 | 谁能动 |
|------|------|--------|
| `draft` | 写了一半，还没定稿 | 只有作者自己能改 |
| `in_review` | 提交评审，等上级看 | 上级评审中 |
| `approved` | 评审通过，下游可用 | 下游可以消费 |
| `done` | 已经被下游消费完，需求闭环 | 归档候选 |
| `blocked` | 卡住了（缺信息/有依赖/有冲突） | 需要上级介入 |

**关键规则：**
- 下游只能消费 `approved` 或 `done` 状态的产物，**不能读 `draft`**
- `blocked` 必须在文档正文写明卡在哪、需要谁解锁

---

## 六、下游怎么读：检索约定

下游员工不需要记住文件全名，按这个规则找：

1. **按目录找**：知道自己要读谁的东西，去对应角色目录
   - 要读 PRD → `outputs/team/pm/prd/`
   - 要读派发单 → `outputs/team/cto/dispatch/`
   - 要读 bug 分析 → `outputs/team/qa/analysis/`

2. **按主题筛**：同一需求的所有产物主题词一致，用 `rg` 搜主题词
   ```bash
   rg "topic: 登录优化" outputs/team/ --files-with-matches
   ```

3. **按状态筛**：只读 `approved` 以上的
   ```bash
   rg "status: (approved|done)" outputs/team/ -l
   ```

4. **看 metadata 头部**：打开文件先看 front matter，确认 `downstream` 里有自己、`status` 是 `approved`

---

## 七、迁移说明（现有产物）

现有 `outputs/` 根目录的产物暂不强制迁移，**从本规范生效后的新产物**必须遵守。旧产物按需归档到 `outputs/team/_archive/`。

社媒运营相关产物（`evoflow_douyin_topic_*.md` 等）不属于技术团队流转范围，保持在 `outputs/` 根目录或另建 `outputs/marketing/`。
