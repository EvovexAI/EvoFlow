# 员工 · 知识库 · 工作流 · 任务中心：接口与 CLI

> **给谁看**：要用脚本、curl、外部 Agent，或 `evoflow` CLI 操作这四块能力时读本文。  
> **面板怎么点**：员工 / 知识库 / 工作流 / 任务中心各自的操作指南见文末「相关阅读」。面板「使用指南」里 **概览 → 操作 → 接口 → FAQ → 更多文档**，「接口」Tab 摘录常用调用。  
> **权威目录**：运行中的 Gateway 可开 `http://127.0.0.1:<port>/docs`；平台 action 完整清单用 `GET /api/platform/catalog`。

关键词检索：`employees.list` `employees.dispatch` `knowledge.create` `knowledge.search` `workflow.run` `tasks.list` `items.create` `接口 CLI`。

本文梳理四块模块共用的调用方式，并按模块给出**接口示例**与**接口说明**（入参 / 出参要点，或等价 CLI）。

---

## 总览（加一列：接口示例与说明）

| 模块 | 面板入口 | 操作指南 | 接口示例与说明 |
|------|----------|----------|----------------|
| **智能体员工** | `#/proactive` | [员工](../configuration/smart-employees.md) | **示例**：`POST /api/platform` → `employees.list` / `employees.dispatch`；CLI `evoflow employees list`。**说明**：岗位名册、雇佣、派活、值班启停；写操作需 `confirm:true`。详见 [§员工](#employees) |
| **知识库** | `#/knowledge` | [知识库](../configuration/knowledge-base.md) | **示例**：`knowledge.create` / `knowledge.search`；REST 面板走 `/api/knowledge/owned`；CLI `evoflow knowledge …`。**说明**：自有库 CRUD、笔记写入与检索；勿用旧 `/api/knowledge` dataset。详见 [§知识库](#knowledge) |
| **工作流** | `#/apps` | [工作流](../configuration/app-center.md) | **示例**：`workflow.run`；CLI `evoflow workflow run <App_id>`；REST `POST /api/apps/{id}/run`。**说明**：运行路径 CLI/REST 齐全；创建/发布优先 platform 或 `/api/apps`。详见 [§工作流](#workflow) |
| **任务中心** | `#/tasks` | [任务中心](../tasks/task-center.md) | **示例**：协作任务 `tasks.*` / `evoflow tasks …`；我的事项 `items.*` / `evoflow items …`。**说明**：**tasks ≠ items**——台账结案用 tasks，随手备忘用 items。详见 [§任务中心](#tasks-items) |

---

## 怎么调（三种入口）

Gateway 默认本机地址以安装目录 / 开发配置为准，文档示例统一写 `http://127.0.0.1:8001`（端口以实际为准）。HTTP 管理接口需 **组织管理员** 身份（桌面端同源请求会带本地会话；脚本需 `Authorization: Bearer <token>`）。

### 1）Platform 总线（推荐脚本 / 外部 Agent）

与对话里助手的 `platform` 工具同一套注册表。

```http
GET  /api/platform/catalog?domain=employees&detailed=1
POST /api/platform
Content-Type: application/json

{"action":"<domain.op>","args":{…},"confirm":false}
```

| 字段 | 说明 |
|------|------|
| `action` | 动作名，如 `employees.list`、`workflow.run` |
| `args` | 入参对象（也可用字符串字段 `args_json`） |
| `confirm` | **读操作**可省略或 `false`；**写 / 破坏性**操作必须 `true`，否则被拒绝 |

**通用出参形状**（多数 action）：

```json
{
  "ok": true,
  "action": "employees.list",
  "result": { }
}
```

失败时 HTTP 4xx，`detail` 为错误信息；状态机类错误（如 `tasks.set_state`）可能附带合法 `next_states`。

### 2）`evoflow` CLI（本机终端）

与 platform 域一一对应（工作流的创建/发布除外，见下表）。默认 pretty JSON；脚本加 `--compact`。复杂 JSON 用 `--file path.json` 或 `--stdin`，不要把整段 JSON 塞进 `--file` 的「文件名位置」。

```bash
evoflow employees list
evoflow knowledge list
evoflow workflow list
evoflow tasks list
evoflow items list
```

### 3）专用 REST（面板同源细粒度）

| 前缀 | 对应模块 |
|------|----------|
| `/api/proactive` 等 | 员工仪表盘等（部分能力也经 platform `employees.*`） |
| `/api/knowledge/owned` | **当前**知识库面板与检索 |
| `/api/apps` | 工作流 CRUD / 发布 / 运行 / 版本 |
| `/api/tasks` | 任务中心细粒度（队列、子任务、验收等） |

日常自动化优先 **platform 或 CLI**；只有面板特有能力（上传大文件、调试坞、子任务 DAG）才直打专用 REST。

---

<a id="employees"></a>

## 一、员工（`employees.*`）

**用途**：岗位名册、一次创建 / 雇佣、改岗、派活、唤醒、值班启停、工作日志与轨迹。  
**易混**：智能体能力包 = `agents.*`；值班岗位 = `employees.*`。先有智能体再 `hire`，或用 `employees.create` 一次建岗。

### 接口示例

```bash
# CLI
evoflow employees list --status active
evoflow employees get code-reviewer
evoflow employees dispatch code-reviewer --goal "核对 ESLint 是否仍为 0 error"
evoflow employees wake code-reviewer --goal "协助验收"
```

```bash
# HTTP platform
curl -s http://127.0.0.1:8001/api/platform \
  -H "Content-Type: application/json" \
  -d "{\"action\":\"employees.list\",\"args\":{\"status\":\"active\"}}"

curl -s http://127.0.0.1:8001/api/platform \
  -H "Content-Type: application/json" \
  -d "{\"action\":\"employees.dispatch\",\"args\":{\"agent_code\":\"code-reviewer\",\"goal\":\"核对 lint\"},\"confirm\":true}"
```

雇佣 JSON 示例见仓库 `skills/public/evoflow-admin/examples/employees-hire.json`。

### 接口说明（常用 action）

| action / CLI | 风险 | 主要入参 | 出参要点 |
|--------------|------|----------|----------|
| `employees.list` · `evoflow employees list` | read | `status?`（active/paused/draft） | 岗位列表；有 Gateway 时含 `busy` |
| `employees.get` · `… get <code>` | read | `agent_code`，`recent_limit?` | 岗位详情与近期事项 |
| `employees.create` | write | `role_name` 必填；`reports_to?`，`workspace_path?`，`responsibilities?`，`capability_pack?`，`knowledge_vault_ids?`… | 新建岗 + 能力；下属务必带 `reports_to` |
| `employees.hire` · `… hire --file` | write | `agent_code` 必填（智能体须已存在）；`role_name?`，`reports_to?`，`heartbeat_schedule?`… | 把已有智能体雇成值班岗 |
| `employees.update` · `… update` | write | `agent_code` + 要改的字段 | 更新后的岗位配置。`responsibilities` 写入提示词的 `## 岗位职责` 段（可重复改，传 `[]` 表示不动段落）；`tools`/`mcp_servers` 会镜像到智能体，非法名如实报错 |
| `employees.dispatch` · `… dispatch` | write | `agent_code` 或 `role_name`，`goal`；`description?`，`priority?`，`source?` | 后台值班轮；返回任务 / round 信息（需 Gateway） |
| `employees.wake` · `… wake` | write | `target`/`agent_code`/`role_name`；`goal?`，`task_id?` | 叫醒在岗员工（需 Gateway） |
| `employees.pause` / `resume` / `stop` | write | `agent_code` | pause=停巡检；stop=停在途轮次并挂起；resume **同时解挂起并重排下次心跳**（返回 `patrol_rearmed`，为 false 说明未开排程） |
| `employees.delete` | destructive | `agent_code`，`delete_agent?` | 删岗位；可选一并删智能体 |
| `employees.worklog` / `trail` | read | `agent_code` 或 `role_name`；日志可加 `day`/`days`/`round_id`；轨迹可加 `round_id`/`max_steps` | `rounds`/`tasks`；轨迹含 `steps[]`、`tool_counts`。日志传 `round_id` 时只返回该轮（缺省回溯近 7 日，不必猜日期） |
| `employees.bind_channel_begin` | write | `agent_code`，`channel?=feishu\|wecom` | 返回扫码引导（`say_to_user`）；勿用 `ui.show` 交二维码 |

**CLI 独有**：`evoflow employees migrate`（旧 initiative → Task）。  
完整子命令以 `evoflow employees -h` 为准。

---

<a id="knowledge"></a>

## 二、知识库（`knowledge.*`）

**用途**：平台自有知识库（`kb_…`）的创建、笔记写入、检索、重索引。  
**易混**：面板与员工绑定走 **`/api/knowledge/owned`**；旧 dataset `/api/knowledge` 对不上现在的「问 AI」。

### 接口示例

```bash
# CLI
evoflow knowledge create --name "英语单词库"
evoflow knowledge list
evoflow knowledge remember --file note.json    # title + knowledge|content
evoflow knowledge recall "怎么配置 MCP" --mode hybrid
```

```bash
# HTTP platform
curl -s http://127.0.0.1:8001/api/platform \
  -H "Content-Type: application/json" \
  -d "{\"action\":\"knowledge.create\",\"args\":{\"name\":\"英语单词库\"},\"confirm\":true}"

curl -s http://127.0.0.1:8001/api/platform \
  -H "Content-Type: application/json" \
  -d "{\"action\":\"knowledge.search\",\"args\":{\"query\":\"怎么配置 MCP\",\"top_k\":5,\"mode\":\"hybrid\"}}"
```

```bash
# 面板同源 REST（列表 / 建库 / 检索）
curl -s http://127.0.0.1:8001/api/knowledge/owned/bases
curl -s -X POST http://127.0.0.1:8001/api/knowledge/owned/bases \
  -H "Content-Type: application/json" \
  -d "{\"name\":\"英语单词库\"}"
curl -s -X POST http://127.0.0.1:8001/api/knowledge/owned/bases/<kbId>/search \
  -H "Content-Type: application/json" \
  -d "{\"query\":\"怎么配置 MCP\",\"top_k\":5}"
```

`remember` 笔记 JSON 示例：`skills/public/evoflow-admin-external/examples/knowledge-remember.json`。

### 接口说明（常用 action）

| action / CLI | 风险 | 主要入参 | 出参要点 |
|--------------|------|----------|----------|
| `knowledge.list` · `evoflow knowledge list` | read | 无；CLI 可 `--vault` / `--prefix` | 自有库列表 |
| `knowledge.create` · `… create --name` | write | `name`；`description?`，`embeddingModelRef?` | 新建 `kb_…`；需已配置向量模型 |
| `knowledge.ingest` · CLI `remember` | write | `title`，`content`/`knowledge`；`vaultId?`/`kbId?`，`tags?` | 写入一篇笔记并进入索引队列 |
| `knowledge.search` · CLI `recall` | read | `query`；`vaultId?`/`kbId?`，`top_k?`，`mode?=hybrid\|semantic\|keyword` | 命中片段列表（默认多库 hybrid） |
| `knowledge.notes` / `note_get` / `note_delete` | read / destructive | `path`；`vaultId?`/`kbId?` | 笔记列表 / 正文 / 删除结果 |
| `knowledge.reindex` | write | `kbId`；`embeddingModelRef?`，`force?`（默认 false） | 整库重建向量；`force=true` 强制全量 |
| `knowledge.requeue` | write | `kbId?`，`limit?` | 重排队卡住的索引任务 |
| `knowledge.delete` | destructive | `kbId` | 软删；内置库不可删 |
| `knowledge.enable` | write | `vaultId`，`enabled` | 仅遗留 Obsidian Vault |

上传 PDF/Office、文件夹导入、问 AI：用 REST `/api/knowledge/owned/bases/{id}/documents`、`…/ask` 等（面板同款），platform 侧重笔记与检索行政操作。

---

<a id="workflow"></a>

## 三、工作流（`workflow.*`）

**用途**：可发布的多节点 App（侧栏「工作流」`#/apps`）。  
**易混**：`#/workflow/:id` 是某次协作任务的执行 DAG，不是画布；Agent 应用网页走 `extensions.*`，不是本域。

### 接口示例

```bash
# CLI（运行路径）
evoflow workflow list
evoflow workflow get App_xxx
evoflow workflow run App_xxx --file params.json
evoflow workflow status <runId>
evoflow workflow stop <runId> [--pause] [--reason "…"]
```

```bash
# HTTP platform
curl -s http://127.0.0.1:8001/api/platform \
  -H "Content-Type: application/json" \
  -d "{\"action\":\"workflow.create\",\"args\":{\"name\":\"日报\",\"goal\":\"汇总昨日进展\",\"steps\":[\"收集\",\"总结\"]},\"confirm\":true}"

curl -s http://127.0.0.1:8001/api/platform \
  -H "Content-Type: application/json" \
  -d "{\"action\":\"workflow.publish\",\"args\":{\"appId\":\"App_xxx\"},\"confirm\":true}"

curl -s http://127.0.0.1:8001/api/platform \
  -H "Content-Type: application/json" \
  -d "{\"action\":\"workflow.run\",\"args\":{\"appId\":\"App_xxx\",\"parameters\":{}},\"confirm\":true}"
```

```bash
# REST
curl -s http://127.0.0.1:8001/api/apps
curl -s -X POST http://127.0.0.1:8001/api/apps/App_xxx/run \
  -H "Content-Type: application/json" \
  -d "{\"parameters\":{}}"
curl -s http://127.0.0.1:8001/api/apps/runs/<runId>
```

运行参数示例：`skills/public/evoflow-admin-external/examples/workflow-run-params.json`。

### 接口说明（常用 action）

| action / CLI / REST | 风险 | 主要入参 | 出参要点 |
|---------------------|------|----------|----------|
| `workflow.list` · `evoflow workflow list` · `GET /api/apps` | read | `status?`，`search?`，`limit?` | 应用列表 |
| `workflow.get` · `… get` · `GET /api/apps/{id}` | read | `appId` | 目标、步骤、参数定义、发布状态 |
| `workflow.schema` | read | 无 | 创建时可用的步骤/参数模板 |
| `workflow.create` / `generate` · `POST /api/apps` | write | `name`；`goal?`，`steps?`，`parameters?`…；generate 需 `goal` | 草稿 `appId` |
| `workflow.update` · `PUT /api/apps/{id}` | write | `appId` + 要改字段 | 更新后的定义 |
| `workflow.publish` / `unpublish` · `POST …/publish` | write | `appId` | 已发布才能列表 ▶ 运行 / 对外 API Key |
| `workflow.run` · `… run` · `POST …/run` | write | `appId`，`parameters?` | `runId` / 关联协作任务 id；进度进任务中心 |
| `workflow.run_status` · `… status` · `GET /api/apps/runs/{runId}` | read | `runId` | 运行状态、进度 |
| `workflow.stop` · `… stop` · `…/cancel` 或 `…/pause` | write | `runId`；`pause?`，`reason?` | 取消或暂停 |
| `workflow.resume` / `recover` | write | `runId`（recover 亦可 `taskId`） | 续跑结果 |
| `workflow.list_runs` · `GET …/runs` | read | `appId`，`limit?`，`page?` | 历史跑次 |
| `workflow.revisions` / `restore_revision` | read/write | `appId`，`version`… | 版本列表 / 恢复 |
| `workflow.delete` · `DELETE /api/apps/{id}` | destructive | `appId` | 删除应用 |

**CLI 无**：create / publish / generate / revisions / resume / list_runs → 用 platform 或 `/api/apps`。

---

<a id="tasks-items"></a>

## 四、任务中心（`tasks.*` + `items.*`）

任务中心有两本账，接口也拆成两域：

| 账本 | 域 / CLI | 含义 |
|------|----------|------|
| **协作任务** | `tasks.*` · `evoflow tasks` | AI/员工正式台账：进度、结案、轨迹 |
| **我的事项** | `items.*` · `evoflow items` | 用户待办备忘；要员工干再 `items.dispatch` |

不要把随手备忘直接建成协作任务。

### 接口示例

```bash
# 协作任务 CLI
evoflow tasks list --status executing --limit 20
evoflow tasks get <task_id>
evoflow tasks create --name "核对发布清单" --assignee code-reviewer
evoflow tasks progress <task_id> --progress 60
evoflow tasks state <task_id> --status completed --summary "已核对无误"
```

```bash
# 我的事项 CLI
evoflow items create --file item.json          # title 必填
evoflow items list --status todo --exclude-done
evoflow items dispatch <item_id> --agent code-reviewer
```

```bash
# HTTP platform
curl -s http://127.0.0.1:8001/api/platform \
  -H "Content-Type: application/json" \
  -d "{\"action\":\"tasks.list\",\"args\":{\"status\":\"executing\",\"limit\":20}}"

curl -s http://127.0.0.1:8001/api/platform \
  -H "Content-Type: application/json" \
  -d "{\"action\":\"tasks.set_state\",\"args\":{\"task_id\":\"…\",\"state\":\"completed\",\"summary\":\"已完成\"},\"confirm\":true}"

curl -s http://127.0.0.1:8001/api/platform \
  -H "Content-Type: application/json" \
  -d "{\"action\":\"items.create\",\"args\":{\"title\":\"周五交报告\",\"priority\":\"medium\"},\"confirm\":true}"
```

```bash
# REST（任务中心细粒度）
curl -s "http://127.0.0.1:8001/api/tasks?page_size=50"
curl -s http://127.0.0.1:8001/api/tasks/<task_id>
```

事项 JSON 示例：`skills/public/evoflow-admin-external/examples/item-create.json`。

### 接口说明 — 协作任务 `tasks.*`

| action / CLI | 风险 | 主要入参 | 出参要点 |
|--------------|------|----------|----------|
| `tasks.list` · `evoflow tasks list` | read | `status?`，`assignee?`/`role?`，`source?=chat\|workflow\|role`，`limit?`（默认 50，上限 200），`include_subtasks?` | 主任务台账（默认不含子任务） |
| `tasks.get` · `… get` | read | `task_id`，`subtask_id?` | 详情、进度、总结、handlers |
| `tasks.create` · `… create` | write | `name`；`assignee?`，`role?`，`description?`，`source?`… | 新 `task_id` |
| `tasks.progress` · `… progress` | write | `task_id`，`progress`（0–100）；`status?` | 更新后进度 |
| `tasks.set_state` · `… state` | write | `task_id`，`state`（pending/planned/executing/waiting_user/awaiting_close/completed/failed/cancelled…）；结案常需 `summary` | 合法流转成功；非法时错误含 `next_states` |
| `tasks.execution_trail` | read | `task_id`，`subtask_id?`，`max_steps?` | 内部工具轨迹 `steps[]`（仅 platform） |
| `tasks.delete` · `… delete --yes` | destructive | `task_id` | 删除结果 |
| `tasks.cleanup_noise` / `reclaim_zombies` | write | 默认 dry-run；`apply=true` 才落地 | 预览或清理结果 |

### 接口说明 — 我的事项 `items.*`

| action / CLI | 风险 | 主要入参 | 出参要点 |
|--------------|------|----------|----------|
| `items.list` · `evoflow items list` | read | `status?`，`priority?`，`tag?`，`q?`，`include_done?`，分页 | 事项列表 |
| `items.get` · `… get` | read | `item_id` | 事项详情 |
| `items.create` · `… create --file` | write | `title` 必填；`notes?`，`priority?`，`due_at?`，`tags?`… | 新 `item_id`（不自动开跑） |
| `items.update` · `… update` | write | `item_id` + 字段 | 更新后事项 |
| `items.dispatch` · `… dispatch` | write | `item_id`，`agent_code`；`wake_now?`，`force?` | 派生可执行 Task 并可选叫醒员工 |
| `items.delete` · `… delete` | destructive | `item_id` | 删除结果 |

面板上的「确认完成 / 要求修改 / 同意派发」等验收动作，细粒度多在 `GET/POST /api/tasks/...` 与审批域 `approvals.*`；行政结案优先 `tasks.set_state` / CLI `tasks state`。

---

## 相关阅读

- [员工操作](../configuration/smart-employees.md) · [员工概念](../../explanation/smart-employees.md)
- [知识库](../configuration/knowledge-base.md)
- [工作流](../configuration/app-center.md)
- [任务中心操作](../tasks/task-center.md) · [任务中心概念](../../explanation/task-center.md)
- [自动化调度（运维 / API）](../tasks/automation-scheduler.md) — 定时任务另一条线
- [产品总览](../../getting-started/product-overview.md) — 能力地图中的「接口 / CLI」列
