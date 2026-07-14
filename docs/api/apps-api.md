# EvoFlow App v2 API 文档

> 路由前缀：`/api/apps`
> 版本：v2（应用即运行实体）

## 概述

EvoFlow App v2 实现「应用即运行实体」架构。应用定义包含参数槽 + DAG 节点图，填入参数即可直接运行。支持两种执行模式：

| 模式 | 说明 | 适用场景 |
|------|------|---------|
| `workflow` | 纯工作流，无 lead agent，DAG 自动执行 | 标准化流程、批量重复 |
| `lead_supervised` | Lead agent 监督，可中途干预 | 复杂任务、需人工确认 |

---

## 应用管理

### `GET /api/apps`

列出应用，支持过滤。

**Query 参数：**

| 参数 | 类型 | 默认 | 说明 |
|------|------|------|------|
| `status` | string | - | 按状态过滤：`draft` / `published` / `archived` |
| `category` | string | - | 按分类过滤 |
| `search` | string | - | 搜索 name 和 description |
| `limit` | int | 100 | 返回上限（1-500） |

**响应：** `list[App]`

### `POST /api/apps`

创建应用定义。

**请求体：**

```json
{
  "name": "竞品分析报告",
  "description": "分析指定产品的竞争格局",
  "icon": "📋",
  "category": "research",
  "parameters": [
    {"name": "topic", "label": "分析主题", "type": "text", "required": true, "default": ""},
    {"name": "format", "label": "输出格式", "type": "select", "required": false, "options": ["Markdown", "PDF"]}
  ],
  "steps": [
    {
      "ref": "1", "name": "调研 {{topic}}", "goal": "收集 {{topic}} 相关数据",
      "assigned_agent": "researcher", "depends_on": [],
      "tools": ["web_search"], "skills": []
    },
    {
      "ref": "2", "name": "输出报告", "goal": "整理 {{topic}} 分析结果为 {{format}}",
      "assigned_agent": "writer", "depends_on": ["1"]
    }
  ],
  "goal_template": "针对 {{topic}} 进行竞品分析，输出 {{format}} 格式报告",
  "execution_mode": "workflow",
  "auto_run": false,
  "tags": ["调研", "竞品"]
}
```

> 也支持 `plan` 字段统一传参：`{"plan": {"goal": "...", "steps": [...], "canvas": {"nodes":[], "edges":[]}}}`，后端自动拆分为 `goal_template` + `steps` + `canvas_json`。

**响应：** `App`（含 `id`）

### `GET /api/apps/{app_id}`

获取应用详情。

**响应：** `App`（含 `plan: {goal, steps, canvas}` 和 `total_runs`）

### `PUT /api/apps/{app_id}`

更新应用定义（version 自增）。

**请求体：** 同 `POST`，所有字段可选。

**响应：** 更新后的 `App`

### `DELETE /api/apps/{app_id}`

删除应用（同时删除关联运行记录）。

**响应：** `{"success": true}`

### `POST /api/apps/{app_id}/publish`

发布应用（`draft` → `published`，version 自增）。

**响应：** 发布后的 `App`

---

## 应用生成（模型生成路径）

### `POST /api/apps/generate`

从模型生成的 plan（goal + steps）创建应用定义，自动提取参数占位符。

**请求体：**

```json
{
  "name": "竞品分析报告",
  "description": "可选描述",
  "goal": "针对 ChatGPT 进行竞品分析，输出 Markdown 格式报告",
  "steps": [
    {"name": "调研 ChatGPT", "goal": "收集 ChatGPT 相关数据", "assigned_agent": "researcher", "depends_on": []},
    {"name": "输出报告", "goal": "整理为 Markdown 报告", "assigned_agent": "writer", "depends_on": ["1"]}
  ],
  "icon": "📋",
  "category": "research",
  "execution_mode": "workflow",
  "auto_run": false,
  "auto_extract": true,
  "max_params": 5,
  "tags": ["调研"]
}
```

**处理流程：**
1. 参数提取引擎扫描 goal + steps，识别可变内容（产品名、数字、域名等）
2. 替换为 `{{param}}` 占位符
3. 生成 AppParameter 定义
4. 组装 App 文档（`source="generated"`）

**响应：** `App`（含提取的 `parameters` 和参数化的 `steps`）

---

## 应用运行

### `POST /api/apps/{app_id}/run`

运行应用（创建运行实例 + 任务中心任务）。

**请求体：**

```json
{
  "parameters": {
    "topic": "AI 编程助手",
    "format": "Markdown"
  },
  "execution_mode": "workflow",
  "thread_id": "thread_xxx"
}
```

| 参数 | 类型 | 说明 |
|------|------|------|
| `parameters` | `dict[str,str]` | 填入的参数值 |
| `execution_mode` | string? | 覆盖应用默认模式 |
| `thread_id` | string? | `lead_supervised` 模式必填 |

**响应（workflow 模式）：**

```json
{
  "run_id": "Run_20260710...",
  "task_id": "Task_20260710...",
  "execution_mode": "workflow",
  "status": "executing",
  "plan": {"goal": "...", "steps": [...]},
  "subtasks_sync": {...},
  "auto_authorized": true,
  "dispatch": {...}
}
```

**响应（lead_supervised 模式）：**

```json
{
  "run_id": "Run_20260710...",
  "task_id": "Task_20260710...",
  "execution_mode": "lead_supervised",
  "status": "plan_ready",
  "plan": {"goal": "...", "steps": [...]},
  "subtasks_sync": {...},
  "step_ref_to_subtask_id": {...}
}
```

---

## 运行管理

### `GET /api/apps/{app_id}/runs`

列出应用的运行历史。

**Query：** `limit` (int, 默认 20, 1-100)

**响应：** `list[AppRun]`

### `GET /api/apps/runs/{run_id}`

获取运行详情（聚合任务中心状态）。

**响应：**

```json
{
  "run_id": "Run_...",
  "app_id": "App_...",
  "task_id": "Task_...",
  "execution_mode": "workflow",
  "status": "executing",
  "task_status": "executing",
  "progress": 50,
  "subtask_status": {"1": "completed", "2": "executing"},
  "step_ref_to_subtask_id": {"1": "Sub_...", "2": "Sub_..."},
  "steps": [
    {
      "ref": "1",
      "subtask_id": "Sub_...",
      "status": "completed",
      "name": "",
      "assigned_agent": "coder",
      "progress": 100,
      "result_summary": "…",
      "error_text": ""
    }
  ],
  "result_summary": "",
  "error": null,
  "created_at": "...",
  "started_at": "...",
  "completed_at": null
}
```

### `POST /api/apps/runs/{run_id}/pause`

暂停运行。

**Query：** `reason` (string, 默认 "User paused")

**响应：** `{"success": true}`

### `POST /api/apps/runs/{run_id}/resume`

恢复已暂停的运行。

**响应：** `{"success": true}`

### `POST /api/apps/runs/{run_id}/cancel`

取消运行（同时取消关联的任务中心任务）。

**Query：** `reason` (string, 默认 "User cancelled")

**响应：** `{"success": true}`

---

## 数据模型

### App

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | string | `App_YYYYMMDDHHMMSS_xxxxxx` |
| `name` | string | 应用名称 |
| `description` | string | 描述 |
| `icon` | string | 图标 |
| `category` | string | 分类 |
| `parameters` | `AppParameter[]` | 参数槽定义 |
| `steps` | `AppStep[]` | DAG 节点图（可含 `{{param}}`） |
| `goal_template` | string | 目标模板（可含 `{{param}}`） |
| `validation_template` | `string[]` | 验收标准模板 |
| `flowchart_mermaid` | string | 流程图 |
| `execution_mode` | string | `workflow` / `lead_supervised` |
| `auto_run` | bool | 填完参数是否自动执行 |
| `source` | string | `generated` / `from_task` / `manual` |
| `source_task_id` | string? | 从哪个 task 沉淀 |
| `version` | int | 版本号 |
| `status` | string | `draft` / `published` / `archived` |
| `tags` | `string[]` | 标签 |
| `created_at` | string | 创建时间 |
| `updated_at` | string | 更新时间 |
| `usage_count` | int | 运行次数 |
| `last_used_at` | string? | 最近运行时间 |

### AppParameter

| 字段 | 类型 | 说明 |
|------|------|------|
| `name` | string | 参数名（对应 `{{name}}`） |
| `label` | string | 显示标签 |
| `type` | string | `text` / `textarea` / `select` / `number` |
| `required` | bool | 是否必填 |
| `default` | string | 默认值 |
| `description` | string | 描述 |
| `options` | `string[]?` | select 类型的选项 |

### AppRun

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | string | `Run_YYYYMMDDHHMMSS_xxxxxx` |
| `app_id` | string | 关联应用 ID |
| `app_version` | int | 运行时的应用版本 |
| `parameters` | `dict[str,str]` | 本次运行的参数值 |
| `execution_mode` | string | 执行模式 |
| `task_id` | string | 任务中心主任务 ID |
| `thread_id` | string? | 会话 ID（lead 模式） |
| `status` | string | `running` / `executing` / `completed` / `failed` / `cancelled` / `paused` / `plan_ready` |
| `progress` | int | 0-100 |
| `result_summary` | string | 结果摘要 |
| `created_at` | string | 创建时间 |
| `started_at` | string? | 开始时间 |
| `completed_at` | string? | 完成时间 |
| `error` | string? | 错误信息 |

---

## 从 Task 沉淀

### `POST /api/tasks/{task_id}/save-as-app`

将已执行的任务沉淀为可复用应用。

**请求体：**

```json
{
  "name": "竞品分析报告",
  "description": "可选描述",
  "execution_mode": "workflow",
  "auto_extract": true
}
```

**处理流程：**
1. 读取 task 的 `plan_goal` / `plan_steps`
2. 参数提取（模型辅助，识别可变内容）
3. 替换为 `{{param}}` 占位符
4. 组装 App 文档（`source="from_task"`）

**响应：** `App`

---

## 参数提取引擎

自动识别以下类型的可变内容：

| 检测器 | 示例 | 参数名 |
|--------|------|--------|
| 产品名称 | `"ChatGPT"` | `product_name` |
| 域名/URL | `openai.com` | `domain` / `base_url` |
| 技术术语 | `Python`, `React` | `framework` |
| 数字范围 | `1-50`, `top 10` | `range` / `top_n` |
| 日期 | `2024`, `Q1 2024` | `target_year` / `quarter` |
| 文件格式 | `.md`, `format: pdf` | `output_format` / `output_path` |
| 版本号 | `v2.1`, `version 3` | `version` |

提取策略：
- 按类型权重 + 出现频率排序
- 最多提取 5 个参数（可配置）
- 过滤过短或过于通用的值
- 大小写不敏感替换
