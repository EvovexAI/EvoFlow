# EvoFlow App 模板设计方案

> 设计日期：2026-07-10
> 状态：设计稿（待评审）
> 作者：Evo Assistant
> 关联文档：`docs/user/guides/chat/plan-mode.md`、`outputs/plan-system-research-report.md`、`TASK_CENTER_RESEARCH.md`

---

## 0. 一句话定义

**App 模板 = 参数化的 Plan + 元数据**。模型生成的一次性 plan，抽掉具体值、留下参数槽，存成可复用模板；每次运行只填参数，自动实例化成任务中心的任务树。

---

## 1. 背景与动机

### 1.1 现状

EvoFlow 已有完整的 plan → task → subtask 链路：

```
用户提需求 → Agent 调 plan(goal, steps[]) → 写入 evoflow_collab_tasks 的 plan_* 列
  → sync_subtasks_from_plan_steps() 1:1 创建子任务 → supervisor start_execution 按 DAG 调度
```

但 plan 是**一次性的**：
- 同会话再调 `plan()` 是修订（`bound_task_id` 不变），不是从模板创建新实例
- 新 cycle 是空白重新规划，不携带任何历史结构
- 没有模板表、没有参数化、没有复用入口

### 1.2 目标

| 目标 | 说明 |
|------|------|
| **沉淀** | 一次好的 plan 执行完后，可"存为模板" |
| **复用** | 换个需求填参数，直接从模板实例化出新的任务树 |
| **渐进演化** | 模型生成 → 表单微调 → 拖拉拽，三个阶段共用同一数据模型 |

### 1.3 类比 FastGPT

| 维度 | FastGPT 工作流 | EvoFlow App 模板 |
|------|---------------|-----------------|
| 节点来源 | 人工拖拽 | 模型生成 |
| 节点类型 | LLM/HTTP/条件/代码 | PlanStep（含 assigned_agent/tools/skills） |
| 参数化 | 变量引用 `{{var}}` | 参数槽 `{{topic}}` |
| 执行 | 工作流引擎逐节点 dispatch | Supervisor DAG 调度（已有） |
| 复用 | 导出/导入 JSON | 模板表 + 实例化 API |
| 编辑门槛 | 高（需理解节点类型） | 低（模型生成，人只填参数） |

**核心差异**：FastGPT 让人拖节点，EvoFlow 让模型生成节点、人只管提需求。门槛降低一个数量级。

---

## 2. 核心数据模型

### 2.1 设计原则

1. **复用现有 plan 结构**：App 模板的"节点图"直接复用 `PlanStepInput` 的字段集，不发明新结构
2. **参数槽是唯一新增**：在 plan 的 goal/steps 中引入 `{{param_name}}` 占位符，实例化时替换
3. **模板与运行分离**：模板是静态定义，运行时实例化为 task（复用现有 `evoflow_collab_tasks` 体系）
4. **向前兼容拖拽**：数据模型从第一天就按 DAG（节点+边）设计，后期拖拽只是加可视化编辑器

### 2.2 App 模板结构

```python
class AppTemplate(BaseModel):
    """App 模板 - 参数化的可复用 Plan"""
    
    # ── 标识 ──
    id: str                              # 模板 ID (AppTpl_YYYYMMDDHHMMSS_xxxxxx)
    name: str                            # 模板名称（如"竞品分析报告"）
    description: str                     # 一句话描述
    icon: str = ""                       # 图标标识（前端用）
    category: str = "general"            # 分类标签
    
    # ── 参数定义 ──
    parameters: list[TemplateParameter]  # 参数槽定义
    
    # ── Plan 结构（参数化的 PlanInput）──
    plan_template: PlanTemplateBody      # 含 {{param}} 占位符的 plan 结构
    
    # ── 元数据 ──
    source_task_id: str | None = None    # 来源任务 ID（从哪个执行好的 task 沉淀而来）
    source_thread_id: str | None = None  # 来源会话
    version: int = 1                     # 模板版本号
    tags: list[str] = []                 # 用户标签
    
    # ── 生命周期 ──
    status: str = "draft"                # draft | published | archived
    created_at: str = ""
    updated_at: str = ""
    usage_count: int = 0                 # 被使用次数
    last_used_at: str | None = None


class TemplateParameter(BaseModel):
    """参数槽定义"""
    name: str                            # 参数名（对应 {{name}} 占位符）
    label: str                           # 显示标签（如"分析主题"）
    type: str = "text"                   # text | textarea | select | number
    required: bool = True
    default: str = ""                    # 默认值
    description: str = ""                # 帮助文本
    options: list[str] | None = None     # type=select 时的选项


class PlanTemplateBody(BaseModel):
    """参数化的 Plan 主体（字段与 PlanInput 对齐）"""
    goal_template: str                   # 含 {{param}} 的目标模板
    steps: list[PlanStepTemplate]        # 步骤模板列表
    flowchart_mermaid: str = ""          # 分析图（可含参数）
    validation_template: list[str] = []  # 验收标准模板
    open_questions: str = "无"


class PlanStepTemplate(BaseModel):
    """参数化的步骤模板（字段与 PlanStepInput 对齐）"""
    ref: int | str | None
    name: str                            # 含 {{param}} 的步骤名
    goal: str                            # 含 {{param}} 的步骤目标
    inputs: str = ""
    outputs: str = ""
    acceptance: str = ""
    failure: str = ""
    assigned_agent: str                  # 固定值（不从参数来）
    depends_on: list[str] = []
    instruction: str = ""
    tools: list[str] | None = None
    skills: list[str] | None = None
    work_checklist: list[dict] | None = None
    project_path: str = ""
```

### 2.3 参数槽设计

参数槽是 App 模板与普通 plan 的**唯一本质差异**。设计要点：

```python
# 模板中的 goal_template:
"针对 {{topic}} 进行竞品分析，输出 {{format}} 格式的分析报告"

# 步骤中的 goal:
"调研 {{topic}} 领域的主要竞品，整理出 {{top_n}} 个核心竞品的基础信息"

# 实例化时，用户提供参数:
parameters = {
    "topic": "AI 编程助手",
    "format": "Markdown",
    "top_n": "5"
}

# 渲染后的 PlanInput:
goal = "针对 AI 编程助手 进行竞品分析，输出 Markdown 格式的分析报告"
steps[0].goal = "调研 AI 编程助手 领域的主要竞品，整理出 5 个核心竞品的基础信息"
```

**参数提取策略**（详见 §4.2）：
- `assigned_agent`、`tools`、`skills`、`depends_on` → **不参数化**（结构性字段，模板固化）
- `goal`、`name`、`inputs`、`outputs`、`acceptance`、`instruction` → **可参数化**（内容性字段，含 `{{param}}`）

### 2.4 与现有数据模型的关系

```
AppTemplate（新增）
  │
  │ instantiate(parameters) → 渲染参数槽
  ▼
PlanInput（现有，完全复用）
  │
  │ bind_plan_to_thread_task()（现有，完全复用）
  ▼
evoflow_collab_tasks.plan_* 列（现有，完全复用）
  │
  │ sync_subtasks_from_plan_steps()（现有，完全复用）
  ▼
evoflow_collab_subtasks（现有，完全复用）
  │
  │ supervisor start_execution（现有，完全复用）
  ▼
DAG 调度执行（现有，完全复用）
```

**关键洞察**：App 模板只是 plan 的"上游"——它在 plan 之前加了一层"模板 → 参数渲染 → PlanInput"。plan 以下的所有机制（存储、同步、调度、状态机）**零改动复用**。

---

## 3. 持久化设计

### 3.1 新增表

#### `evoflow_app_templates`（模板主表）

```sql
CREATE TABLE evoflow_app_templates (
    id TEXT PRIMARY KEY,                         -- AppTpl_YYYYMMDDHHMMSS_xxxxxx
    name TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    icon TEXT NOT NULL DEFAULT '',
    category TEXT NOT NULL DEFAULT 'general',
    parameters_json TEXT NOT NULL DEFAULT '[]',  -- TemplateParameter[] 的 JSON
    plan_template_json TEXT NOT NULL DEFAULT '{}', -- PlanTemplateBody 的 JSON
    source_task_id TEXT,
    source_thread_id TEXT,
    version INTEGER NOT NULL DEFAULT 1,
    tags_json TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL DEFAULT 'draft',         -- draft | published | archived
    created_at TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL DEFAULT '',
    usage_count INTEGER NOT NULL DEFAULT 0,
    last_used_at TEXT
);
```

#### `evoflow_app_template_runs`（运行记录表）

```sql
CREATE TABLE evoflow_app_template_runs (
    id TEXT PRIMARY KEY,                         -- Run_YYYYMMDDHHMMSS_xxxxxx
    template_id TEXT NOT NULL,                   -- 关联模板
    template_version INTEGER NOT NULL,           -- 运行时的模板版本快照
    task_id TEXT NOT NULL,                       -- 实例化出的主任务 ID
    thread_id TEXT,                              -- 运行会话
    parameters_json TEXT NOT NULL DEFAULT '{}',  -- 本次运行填入的参数
    status TEXT NOT NULL DEFAULT 'running',      -- running | completed | failed | cancelled
    created_at TEXT NOT NULL DEFAULT '',
    completed_at TEXT,
    FOREIGN KEY (template_id) REFERENCES evoflow_app_templates(id)
);
```

#### `evoflow_app_template_versions`（版本历史表 - Phase 2）

```sql
CREATE TABLE evoflow_app_template_versions (
    id TEXT PRIMARY KEY,
    template_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    snapshot_json TEXT NOT NULL,                 -- 完整模板快照
    change_note TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT '',
    UNIQUE(template_id, version)
);
```

### 3.2 迁移脚本

新增 `schema_migration_v80.py`（当前版本 v79）：

```python
def migrate_v80(conn: sqlite3.Connection) -> None:
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS evoflow_app_templates (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL DEFAULT '',
            description TEXT NOT NULL DEFAULT '',
            icon TEXT NOT NULL DEFAULT '',
            category TEXT NOT NULL DEFAULT 'general',
            parameters_json TEXT NOT NULL DEFAULT '[]',
            plan_template_json TEXT NOT NULL DEFAULT '{}',
            source_task_id TEXT,
            source_thread_id TEXT,
            version INTEGER NOT NULL DEFAULT 1,
            tags_json TEXT NOT NULL DEFAULT '[]',
            status TEXT NOT NULL DEFAULT 'draft',
            created_at TEXT NOT NULL DEFAULT '',
            updated_at TEXT NOT NULL DEFAULT '',
            usage_count INTEGER NOT NULL DEFAULT 0,
            last_used_at TEXT
        );
        CREATE TABLE IF NOT EXISTS evoflow_app_template_runs (
            id TEXT PRIMARY KEY,
            template_id TEXT NOT NULL,
            template_version INTEGER NOT NULL,
            task_id TEXT NOT NULL,
            thread_id TEXT,
            parameters_json TEXT NOT NULL DEFAULT '{}',
            status TEXT NOT NULL DEFAULT 'running',
            created_at TEXT NOT NULL DEFAULT '',
            completed_at TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_app_tpl_runs_task ON evoflow_app_template_runs(task_id);
        CREATE INDEX IF NOT EXISTS idx_app_tpl_runs_template ON evoflow_app_template_runs(template_id);
    """)
```

### 3.3 存储层

新增 `persistence/app_template_repositories.py`：

```python
class AppTemplateRepository:
    """App 模板 CRUD"""
    
    def save_template(self, template: dict) -> None: ...
    def load_template(self, template_id: str) -> dict | None: ...
    def list_templates(self, status: str | None = None, category: str | None = None) -> list[dict]: ...
    def delete_template(self, template_id: str) -> bool: ...
    def increment_usage(self, template_id: str) -> None: ...
    
    def save_run(self, run: dict) -> None: ...
    def load_run(self, run_id: str) -> dict | None: ...
    def load_run_by_task_id(self, task_id: str) -> dict | None: ...
    def update_run_status(self, run_id: str, status: str, completed_at: str | None = None) -> None: ...
    def list_runs(self, template_id: str, limit: int = 20) -> list[dict]: ...
```

---

## 4. 核心流程设计

### 4.1 模板创建：从执行好的 Task 沉淀

```
用户: "这个任务跑得不错，存成模板吧"
  │
  ▼
Step 1: 读取主任务的 plan 字段
  - load_task_bundle(main_task_id)
  - 提取 plan_goal, plan_steps, plan_validation, plan_flowchart_mermaid
  
Step 2: 参数提取（关键步骤）
  - 扫描 goal/steps 中的内容性字段
  - 识别可参数化的值（由模型辅助或人工标注）
  - 将具体值替换为 {{param_name}} 占位符
  - 生成 TemplateParameter[] 定义
  
Step 3: 组装 AppTemplate
  - plan_template = PlanTemplateBody(goal_template, steps[], ...)
  - parameters = 提取出的参数槽列表
  - source_task_id / source_thread_id 记录来源
  
Step 4: 持久化
  - save_template() → evoflow_app_templates
```

### 4.2 参数提取策略

参数提取是整个方案最关键的智能环节。两种路径：

#### 路径 A：模型辅助提取（推荐）

在"存为模板"时，调用一次模型，输入原始 plan，输出参数化后的模板：

```python
EXTRACTION_PROMPT = """
你是 App 模板参数提取器。给定一个已执行的 plan，请：
1. 识别其中的"可变内容"（主题、数量、格式、目标对象等）
2. 将它们替换为 {{param_name}} 占位符
3. 输出参数定义列表

规则：
- assigned_agent / tools / skills / depends_on 等结构性字段 → 不参数化
- goal / name / inputs / outputs / acceptance 中的业务内容 → 可参数化
- 参数名用英文 snake_case，label 用中文
- 如果某个值在整个 plan 中只出现一次且明显是结构性的，不要参数化

输入 plan:
{plan_json}

输出格式:
{{
  "parameters": [...],
  "plan_template": {{...}}
}}
"""
```

#### 路径 B：人工标注

前端提供编辑界面，用户手动选中 goal/steps 中的文本，标记为参数。适用于路径 A 提取不准时的微调。

### 4.3 模板实例化：从模板创建新任务

```
用户: 选择模板 → 填参数 → 点"运行"
  │
  ▼
Step 1: 加载模板
  - load_template(template_id)
  - 得到 PlanTemplateBody + TemplateParameter[]
  
Step 2: 参数渲染
  - 用户提供的 parameters dict
  - 遍历 plan_template 中所有字符串字段
  - 替换 {{param}} → 实际值
  - 生成 PlanInput（标准 plan 结构）
  
Step 3: 创建任务（复用现有链路）
  - new_project_bundle_root_task() 创建主任务
  - write_plan_fields() 写入 plan_* 列
  - sync_subtasks_from_plan_steps() 创建子任务
  - advance_collab_phase_to_plan_ready()
  
Step 4: 记录运行
  - save_run() → evoflow_app_template_runs
  - increment_usage() → 更新模板使用次数
  
Step 5: 等待用户确认执行（复用现有 plan_ready → awaiting_exec 流程）
  - 或 run_mode=unattended 时自动授权执行
```

**核心代码骨架**：

```python
def instantiate_template(
    template_id: str,
    parameters: dict[str, str],
    thread_id: str,
    run_mode: str = "manual",
) -> dict:
    """从模板实例化一个新任务"""
    
    # 1. 加载模板
    template = repo.load_template(template_id)
    plan_template = PlanTemplateBody(**template["plan_template_json"])
    
    # 2. 渲染参数
    plan_input = render_template(plan_template, parameters)
    # → 产出标准 PlanInput dict
    
    # 3. 创建任务（复用 plan_session_task 的逻辑）
    task = ensure_plan_session_task(thread_id, plan_input["goal"])
    bind_plan_to_thread_task(thread_id, plan_input)
    # → 内部调用 write_plan_fields + sync_subtasks_from_plan_steps
    
    # 4. 记录运行
    run = {
        "id": make_run_id(),
        "template_id": template_id,
        "template_version": template["version"],
        "task_id": task["task_id"],
        "thread_id": thread_id,
        "parameters_json": json.dumps(parameters),
        "status": "running",
        "created_at": now_iso(),
    }
    repo.save_run(run)
    repo.increment_usage(template_id)
    
    return {
        "task_id": task["task_id"],
        "run_id": run["id"],
        "plan": plan_input,
    }


def render_template(
    plan_template: PlanTemplateBody,
    parameters: dict[str, str],
) -> dict:
    """渲染参数槽，产出标准 PlanInput dict"""
    
    def render(text: str) -> str:
        for key, value in parameters.items():
            text = text.replace(f"{{{{{key}}}}}", str(value))
        return text
    
    return {
        "goal": render(plan_template.goal_template),
        "steps": [
            {
                **step.dict(),
                "name": render(step.name),
                "goal": render(step.goal),
                "inputs": render(step.inputs),
                "outputs": render(step.outputs),
                "acceptance": render(step.acceptance),
                "instruction": render(step.instruction),
            }
            for step in plan_template.steps
        ],
        "flowchart_mermaid": render(plan_template.flowchart_mermaid),
        "validation": [render(v) for v in plan_template.validation_template],
        "open_questions": plan_template.open_questions,
    }
```

### 4.4 完整生命周期

```
                    ┌─────────────────────────────────────────────────┐
                    │              App 模板生命周期                     │
                    └─────────────────────────────────────────────────┘

  ┌──────────┐     ┌──────────┐     ┌──────────┐     ┌──────────┐
  │ 模型生成  │────▶│ 执行验证  │────▶│ 沉淀模板  │────▶│ 发布模板  │
  │ Plan     │     │ Task 跑通 │     │ 抽参数槽  │     │ published│
  └──────────┘     └──────────┘     └──────────┘     └────┬─────┘
                                                          │
                    ┌─────────────────────────────────────┘
                    ▼
  ┌──────────┐     ┌──────────┐     ┌──────────┐     ┌──────────┐
  │ 选择模板  │────▶│ 填参数    │────▶│ 实例化    │────▶│ 执行     │
  │ 浏览列表  │     │ 表单填写  │     │ → Plan   │     │ DAG调度  │
  └──────────┘     └──────────┘     │ → Task   │     │ → SubTask│
                                     │ → SubTask│     └────┬─────┘
                                     └──────────┘          │
                                                           ▼
                                                    ┌──────────────┐
                                                    │ 运行完成      │
                                                    │ 更新 run 状态 │
                                                    │ → 可再复用    │
                                                    └──────────────┘
```

---

## 5. API 设计

### 5.1 模板管理 API

路由前缀：`/api/app-templates`

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/api/app-templates` | 列出模板（支持 status/category/search 过滤） |
| `POST` | `/api/app-templates` | 创建模板（手动或从 task 沉淀） |
| `GET` | `/api/app-templates/{id}` | 获取模板详情 |
| `PUT` | `/api/app-templates/{id}` | 更新模板 |
| `DELETE` | `/api/app-templates/{id}` | 删除模板 |
| `POST` | `/api/app-templates/{id}/publish` | 发布模板（draft → published） |
| `POST` | `/api/app-templates/{id}/archive` | 归档模板 |

### 5.2 模板实例化 API

| 方法 | 路径 | 说明 |
|------|------|------|
| `POST` | `/api/app-templates/{id}/instantiate` | 从模板实例化新任务（填参数 → 创建 task） |
| `GET` | `/api/app-templates/{id}/runs` | 列出该模板的运行历史 |
| `GET` | `/api/app-templates/runs/{run_id}` | 获取某次运行详情 |

### 5.3 从 Task 沉淀 API

| 方法 | 路径 | 说明 |
|------|------|------|
| `POST` | `/api/tasks/{task_id}/save-as-template` | 将已执行的任务沉淀为模板（触发参数提取） |

### 5.4 请求/响应结构

```typescript
// POST /api/app-templates/{id}/instantiate
// Request:
{
  "parameters": {
    "topic": "AI 编程助手",
    "format": "Markdown",
    "top_n": "5"
  },
  "thread_id": "thread_xxx",       // 可选，不传则创建新会话
  "run_mode": "manual"              // manual | unattended
}

// Response:
{
  "task_id": "Task_20260710...",
  "run_id": "Run_20260710...",
  "plan": {
    "goal": "针对 AI 编程助手 进行竞品分析...",
    "steps": [...],
    "step_count": 4
  },
  "subtasks": [
    {"id": "Subtask_...", "ref": "1", "name": "Step 1: ...", "status": "planned"}
  ],
  "status": "plan_ready"            // 等待用户确认执行
}
```

```typescript
// POST /api/tasks/{task_id}/save-as-template
// Request:
{
  "name": "竞品分析报告",
  "description": "对指定领域进行竞品调研并输出分析报告",
  "icon": "📋",
  "category": "research",
  "tags": ["调研", "报告"],
  "auto_extract": true              // true=模型辅助提取参数, false=手动标注
}

// Response:
{
  "template_id": "AppTpl_20260710...",
  "parameters": [
    {"name": "topic", "label": "分析主题", "type": "text", "required": true},
    {"name": "format", "label": "输出格式", "type": "select", "options": ["Markdown", "PDF"]},
    {"name": "top_n", "label": "核心竞品数量", "type": "number", "default": "5"}
  ],
  "status": "draft"                 // 默认 draft，用户确认后 publish
}
```

---

## 6. 前端设计（EvoPanel）

### 6.1 Phase 1：模板列表 + 参数表单

```
┌─────────────────────────────────────────────┐
│  📋 App 模板                          [+ 新建] │
├─────────────────────────────────────────────┤
│  ┌─────────┐ ┌─────────┐ ┌─────────┐       │
│  │ 📋      │ │ 🔍      │ │ 📝      │       │
│  │竞品分析  │ │代码审查  │ │周报生成  │       │
│  │调研→报告 │ │扫描→建议 │ │收集→汇总 │       │
│  │用了 12 次│ │用了 5 次 │ │新建      │       │
│  └─────────┘ └─────────┘ └─────────┘       │
└─────────────────────────────────────────────┘

点击模板卡片 → 参数表单：

┌─────────────────────────────────────────────┐
│  📋 竞品分析报告                       [运行] │
├─────────────────────────────────────────────┤
│  分析主题 *: [AI 编程助手          ]          │
│  输出格式:   [Markdown      ▼]               │
│  核心竞品数量: [5            ]                │
│                                             │
│  ── 预览执行计划 ──                           │
│  Goal: 针对 AI 编程助手 进行竞品分析...       │
│  Step 1: 调研 AI 编程助手 领域的主要竞品...    │
│  Step 2: 整理 5 个核心竞品的基础信息...       │
│  Step 3: 对比分析并输出 Markdown 报告...      │
└─────────────────────────────────────────────┘
```

### 6.2 Phase 2：模板编辑器

在 Phase 1 基础上增加：
- 模板编辑页面：可修改 goal_template、steps、parameters
- 参数管理：增删参数槽、修改类型
- 步骤管理：增删步骤、修改依赖关系
- 实时预览：填入默认参数预览渲染效果

### 6.3 Phase 3：可视化拖拽编辑器

```
┌─────────────────────────────────────────────────────┐
│ 🔧 模板编辑器 - 竞品分析报告          [保存] [预览]    │
├──────────┬──────────────────────────────────────────┤
│ 节点库    │  ┌──────┐     ┌──────┐     ┌──────┐    │
│          │  │ 调研  │────▶│ 整理  │────▶│ 输出  │    │
│ 📊 调研   │  │Step 1│     │Step 2│     │Step 3│    │
│ 📝 整理   │  └──────┘     └──────┘     └──────┘    │
│ 📤 输出   │       └─────────┘                      │
│ 🔗 条件   │                                         │
│          │  右侧: 选中节点的属性面板                  │
│ 参数槽    │  ┌─────────────────────────────────┐   │
│ {{topic}} │  │ Step 1: 调研                    │   │
│ {{format}}│  │ Agent: general-purpose          │   │
│ {{top_n}} │  │ Goal: 调研 {{topic}} 领域的...   │   │
│          │  │ Tools: web_search, read_file     │   │
│ [+ 添加]  │  └─────────────────────────────────┘   │
└──────────┴──────────────────────────────────────────┘
```

**拖拽编辑器技术选型建议**：React Flow（轻量、DAG 友好、已有大量节点编辑器案例）

---

## 7. 三阶段演进路线

### Phase 1：模板沉淀 + 参数复用（MVP）

**目标**：跑通"存模板 → 填参数 → 生成任务"闭环

| 工作项 | 说明 |
|--------|------|
| 后端：数据模型 + 迁移 | `evoflow_app_templates` + `evoflow_app_template_runs` 表 |
| 后端：Repository 层 | `app_template_repositories.py` CRUD |
| 后端：参数渲染引擎 | `render_template()` 函数 |
| 后端：实例化 API | `POST /api/app-templates/{id}/instantiate` |
| 后端：沉淀 API | `POST /api/tasks/{task_id}/save-as-template` + 模型辅助参数提取 |
| 前端：模板列表页 | 卡片式浏览，按分类/标签过滤 |
| 前端：参数表单 | 根据参数定义动态生成表单 |
| 前端：计划预览 | 渲染参数后的 plan 预览 |

**交付标准**：用户能从执行好的任务存模板，能从模板填参数创建新任务并执行

### Phase 2：模板编辑 + 版本管理

| 工作项 | 说明 |
|--------|------|
| 后端：版本管理 | `evoflow_app_template_versions` 表 + 版本快照 |
| 后端：模板编辑 API | 更新 goal_template / steps / parameters |
| 前端：模板编辑器 | 表单式编辑 goal/steps/params |
| 前端：参数管理 | 增删参数槽、修改类型/选项 |
| 前端：步骤管理 | 增删步骤、拖拽排序、修改依赖 |
| 前端：实时预览 | 填默认参数预览渲染效果 |

**交付标准**：用户能可视化编辑模板结构和参数定义，支持版本回溯

### Phase 3：可视化拖拽编辑器

| 工作项 | 说明 |
|--------|------|
| 前端：React Flow 画布 | 节点拖拽、连线、DAG 验证 |
| 前端：节点属性面板 | 选中节点编辑属性 |
| 前端：节点库 | 可复用节点/子流程组件 |
| 前端：DAG 验证 | 环检测、必填字段校验 |
| 后端：节点/边 JSON 格式 | 与 PlanStepTemplate 双向转换 |

**交付标准**：用户能像 FastGPT 一样拖拽编排，但节点是模型预生成的

---

## 8. 关键设计决策与权衡

### 8.1 为什么不复用 evoflow_collab_tasks 存模板？

| 方案 | 优点 | 缺点 |
|------|------|------|
| **新增 app_templates 表**（选定） | 模板与运行实例分离，互不干扰；模板可跨任务/会话复用 | 多一张表 |
| 复用 tasks 表加 type=template | 少一张表 | 模板和实例混在一起，查询/状态管理复杂；plan_* 列要兼容模板和实例两种语义 |

**决策**：新增表。模板是"类"，任务是"实例"，类和实例不应该混存。

### 8.2 为什么参数槽用 `{{param}}` 而非 JSON Path？

| 方案 | 优点 | 缺点 |
|------|------|------|
| **`{{param}}` 字符串替换**（选定） | 简单直观，模型易生成，前端易渲染 | 不支持嵌套/条件逻辑 |
| JSON Path / JSONata | 强大的表达式能力 | 过度复杂，模型生成不一致，前端难编辑 |

**决策**：`{{param}}`。App 模板的核心价值是"简单复用"，不是"复杂逻辑编排"。条件/循环等高级需求留给 Phase 3 的节点类型扩展。

### 8.3 参数提取：模型辅助 vs 人工标注

**决策**：Phase 1 以**模型辅助为主、人工微调为辅**。理由：
- 模型已经能生成 plan，参数提取是更简单的任务（识别可变内容 → 替换为占位符）
- 人工标注全部参数太繁琐，降低"存模板"的意愿
- 模型提取不准时，Phase 2 的编辑器可修正

### 8.4 模板实例化后是否自动执行？

**决策**：默认 `plan_ready`（等待用户确认），支持 `run_mode=unattended` 自动执行。理由：
- 与现有 plan 模式的行为一致（plan 落库后需用户点"开始执行"）
- unattended 模式已有完整支持，App 模板天然兼容

---

## 9. 与现有系统的集成点

| 集成点 | 现有模块 | App 模板如何接入 |
|--------|---------|-----------------|
| Plan 提交 | `plan_tool.py` → `bind_plan_to_thread_task()` | 实例化时直接调用 `bind_plan_to_thread_task()`，传入渲染后的 PlanInput |
| 子任务同步 | `plan_subtasks_sync.py` → `sync_subtasks_from_plan_steps()` | 完全复用，无需改动 |
| 任务调度 | `supervisor_tool.py` → `start_execution` | 完全复用，DAG 调度逻辑不变 |
| 状态机 | `state_transitions.py` + `CollabPhase` | 完全复用，模板实例化后任务状态走标准流程 |
| 任务中心 UI | `evopanel` 任务列表 | 新任务自然出现在任务中心，无需特殊处理 |
| REST API | `routers/tasks.py` | 新增 `/api/app-templates` 路由组，与现有 `/api/tasks` 并行 |
| SQLite 迁移 | `schema_migration_v{N}.py` | 新增 v80 迁移脚本 |

**改动面总结**：
- **新增**：2 张表 + 1 个迁移脚本 + 1 个 Repository + 1 组 API 路由 + 1 个渲染引擎 + 前端模板页
- **改动**：0 行现有代码（纯增量，不修改任何现有逻辑）
- **复用**：plan 提交、子任务同步、DAG 调度、状态机、任务中心 UI——全部零改动复用

---

## 10. 风险与对策

| 风险 | 影响 | 对策 |
|------|------|------|
| 模型参数提取不一致 | 同一 plan 存两次模板，参数槽不同 | Phase 2 提供编辑器修正；缓存提取结果避免重复提取 |
| 模板参数与实际需求不匹配 | 渲染后的 plan 语义偏移 | 实例化时提供"计划预览"，用户确认后再创建任务 |
| 拖拽编辑器开发成本高 | Phase 3 周期长 | Phase 1/2 先用表单，拖拽用 React Flow 渐进实现 |
| 模板数量膨胀后难管理 | 用户找不到需要的模板 | 分类 + 标签 + 搜索 + 使用次数排序 + 收藏 |
| 参数化过度/不足 | 要么参数太多填表累，要么参数太少不够灵活 | 模型提取时限制参数数量（建议 ≤5 个），不足的通过 instruction 自由文本补充 |

---

## 附录 A：关键文件索引（新增文件）

| 文件 | 职责 |
|------|------|
| `persistence/schema_migration_v80.py` | 新增 app_templates + app_template_runs 表 |
| `persistence/app_template_repositories.py` | 模板 CRUD + 运行记录管理 |
| `collab/app_template_engine.py` | 参数渲染引擎 `render_template()` |
| `collab/app_template_instantiate.py` | 模板实例化流程 `instantiate_template()` |
| `collab/parameter_extractor.py` | 模型辅助参数提取 |
| `app/gateway/routers/app_templates.py` | REST API 路由 |
| `evopanel/src/pages/AppTemplates.tsx` | 前端模板列表页 |
| `evopanel/src/pages/AppTemplateRun.tsx` | 前端参数表单 + 计划预览 |

## 附录 B：关键文件索引（复用文件，零改动）

| 文件 | 复用内容 |
|------|---------|
| `tools/builtins/plan_tool.py` | PlanInput / PlanStepInput schema |
| `collab/plan_session_task.py` | `bind_plan_to_thread_task()` |
| `collab/plan_task_storage.py` | `write_plan_fields()` |
| `collab/plan_subtasks_sync.py` | `sync_subtasks_from_plan_steps()` |
| `tools/builtins/supervisor_tool.py` | `start_execution` DAG 调度 |
| `persistence/task_repositories.py` | `save_task_bundle()` / `load_task_bundle()` |
| `app/gateway/routers/tasks.py` | 任务中心 REST API（模板实例化出的任务自然可用） |
