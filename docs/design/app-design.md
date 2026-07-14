# EvoFlow 应用（App）设计方案 v2

> 设计日期：2026-07-10
> 状态：设计稿（待评审）
> 关联文档：`outputs/plan-system-research-report.md`、`TASK_CENTER_RESEARCH.md`
> 取代：`docs/design/app-template-design.md`（v1 模板方案，已废弃）

---

## 0. 一句话定义

**应用 = 可直接运行的完整流程定义**。给参数就跑，不是"先存模板再实例化"。task 表演变成应用定义表，每次运行产生一组执行实例。

---

## 1. 为什么不是模板

v1 方案的核心是"模板 → 实例化 → 任务"三步走。用户反馈：

| v1 模板方案的问题 | v2 应用方案的修正 |
|---|---|
| 模板和运行是两个分离的实体，多一层间接 | 应用本身就是可运行实体，给参数直接跑 |
| 还依赖 task 表做运行实例 | task 表直接演变成应用表 |
| 只有一种执行模式（复用现有 supervisor 链路） | 两种模式：纯工作流（无 lead）+ lead 监督 |

**核心转变**：不是"模板"，是"应用"。应用就是 FastGPT 里的那个"应用"--一个定义好流程、填入参数就能跑的东西。

---

## 2. 核心概念

### 2.1 三层结构

```
App（应用定义）          ← 可复用的流程定义，含参数槽 + DAG 节点图
  │
  │  run(parameters)  →  渲染参数 + 创建执行实例
  ▼
AppRun（运行实例）        ← 一次具体执行，含实际参数值 + 状态
  │
  │  创建 subtask 实例（复用现有 evoflow_collab_subtasks）
  ▼
SubTask 执行             ← DAG 调度执行（复用现有 supervisor 链路 / 新增工作流引擎）
```

### 2.2 两种执行模式

| 模式 | 类比 | 机制 | 适用场景 |
|------|------|------|---------|
| **纯工作流模式** `workflow` | FastGPT 工作流 | 无 lead agent，DAG 自主执行，节点完成后自动推进下一波 | 标准化流程、批量重复、无人值守 |
| **Lead 监督模式** `lead_supervised` | 现有 plan + supervisor | Lead agent 规划/确认/派发/监控/干预，可中途调整 | 复杂任务、需要人工确认、探索性任务 |

**纯工作流模式的核心**：去掉 lead agent 的参与，让 DAG 引擎自己跑完。现有的 `_resolve_subtasks_for_start_execution` + `delegate_collab_subtasks_for_start_execution` + `auto_delegate_collab_followup_wave` 已经实现了 DAG 解析、并行委派、自动推进--唯一障碍是这些函数都依赖 `runtime`（lead agent 的 ToolRuntime）。解决方案见 §5。

### 2.3 与 FastGPT 的对比

| 维度 | FastGPT 应用 | EvoFlow 应用 |
|------|-------------|-------------|
| 流程来源 | 人工拖拽节点 | 模型生成 DAG |
| 节点类型 | LLM/HTTP/条件/代码 | AppStep（assigned_agent + tools + skills + instruction） |
| 参数 | 输入变量 `{{var}}` | 输入参数 `{{param}}` |
| 执行 | 工作流引擎逐节点 dispatch | DAG 引擎按依赖波次并行 dispatch |
| 存档 | nodes / edges / position 整图 JSON | **双轨**：`steps_json`（执行语义）+ `canvas_json`（nodes/edges/viewport 布局） |
| 监督模式 | 无 | Lead agent 可介入/干预/重规划 |
| 复用 | 导出/导入 JSON | 应用定义直接复用，换参数再跑 |

---

## 3. 数据模型

### 3.1 应用定义：App

```python
class App(BaseModel):
    """应用 = 可直接运行的完整流程定义"""
    
    # ── 标识 ──
    id: str                              # App_YYYYMMDDHHMMSS_xxxxxx
    name: str                            # 应用名称（如"竞品分析报告"）
    description: str                     # 一句话描述
    icon: str = ""                       # 图标
    category: str = "general"            # 分类
    
    # ── 输入参数 ──
    parameters: list[AppParameter]       # 参数槽定义（用户运行时填写）
    
    # ── 流程定义 ──
    steps: list[AppStep]                 # DAG 节点图（含 {{param}} 占位符）；执行真相
    canvas: dict | None = None           # 画布布局 JSON：nodes / edges / viewport（仅 UI；runner 忽略）
    goal_template: str                   # 应用目标模板
    validation_template: list[str] = []  # 验收标准模板
    flowchart_mermaid: str = ""          # 分析图
    
    # ── 执行配置 ──
    execution_mode: str = "workflow"     # workflow | lead_supervised
    auto_run: bool = False               # 填完参数后是否自动执行（不需手动确认）
    
    # ── 来源与版本 ──
    source: str = "generated"            # generated(模型生成) | manual(手动创建) | imported(导入)
    source_task_id: str | None = None    # 从哪个 task 沉淀而来
    version: int = 1
    
    # ── 生命周期 ──
    status: str = "draft"                # draft | published | archived
    tags: list[str] = []
    created_at: str = ""
    updated_at: str = ""
    usage_count: int = 0
    last_used_at: str | None = None


class AppParameter(BaseModel):
    """输入参数定义"""
    name: str                            # 参数名（对应 {{name}}）
    label: str                           # 显示标签
    type: str = "text"                   # text | textarea | select | number
    required: bool = True
    default: str = ""
    description: str = ""
    options: list[str] | None = None     # select 类型的选项


class AppStep(BaseModel):
    """DAG 节点定义（字段与现有 PlanStepInput 对齐）"""
    ref: int | str | None                # 节点序号
    name: str                            # 节点名（可含 {{param}}）
    goal: str                            # 节点目标（可含 {{param}}）
    inputs: str = ""                     # 输入描述
    outputs: str = ""                    # 输出描述
    acceptance: str = ""                 # 验收标准
    assigned_agent: str                  # 执行 agent
    depends_on: list[str] = []           # 上游节点 ref
    instruction: str = ""                # 补充指令
    tools: list[str] | None = None       # 可用工具
    skills: list[str] | None = None      # 可用技能
    work_checklist: list[dict] | None = None
    project_path: str = ""
```

**双轨落库**：`steps` 存 `assigned_agent` / `tools` / `skills` / `depends_on` 等执行字段；`canvas`（表字段 `canvas_json`）存 FastGPT 形状的 `nodes[{nodeId,type,position}]` + `edges[{source,target,sourceHandle,targetHandle}]` + 可选 `viewport`。保存时由画布边推导 `depends_on`；运行时只读 `steps`。

**JSON 契约与归一化**：所有读写经 `evoflow.collab.app_schema.normalize_app_document`：
- `tools` / `skills` 统一为 `string[]`（兼容历史 CSV）
- `steps[]` **禁止**嵌套 `canvas`（布局只在 `canvas_json`）
- `parameters[]` 规范化为 `name/label/type/required/default/description/options?`
- 保存时用 canvas 非 start 边覆盖 `depends_on`，保证执行轨与视觉轨一致

### 3.1.1 App / Plan / 任务表的关系（避免「存多套」）

```
evoflow_apps                 ← 唯一定义真相（SOP 模板）
        │ run(parameters) → render_plan()（内存）
        ├─► evoflow_app_runs              ← 运行索引（参数快照 + task_id）
        └─► evoflow_collab_tasks.plan_*   ← 当次物化 plan（执行需要）
                    └─► evoflow_collab_subtasks ← 步骤运行实例
```

| 存哪儿 | 是什么 | 是不是第二套 App 定义 |
|--------|--------|----------------------|
| `evoflow_apps` | 可复用模板（含 `{{param}}`） | **唯一定义真相** |
| `evoflow_app_runs` | 哪次跑、填了啥参、挂哪个 task | 否，是运行账本 |
| `collab_tasks.plan_steps_json` 等 | 渲染后的具体 plan | 否，是**执行物化**（和当次聊天 plan 同构） |
| `collab_subtasks` | 逐步调度状态 | 否，是运行态 |

**原则**：不要把运行结果写回 App 行；不要为「应用」再造第三套 plan 表。Task 上的 plan 字段与会话里 `bind_plan` 写入的是同一套执行面，App 只是其上游模板来源。

**版本快照**：`evoflow_app_revisions(app_id, version, snapshot_json)` — 每次 `save_app` 写入当前 version 的不可变定义切片。`app_runs.app_version` 可据此复现当时 steps/parameters/canvas。API：`GET /api/apps/{id}/revisions`、`GET /api/apps/{id}/revisions/{version}`、`POST /api/apps/{id}/revisions/{version}/restore`（把旧快照合并为当前定义并 **version+1**；旧切片永不改写）。

**任务溯源**：App 运行时在主任务 `extra_json` 写入 `source_app_id` / `source_run_id` / `source_app_version` / `source_app_name`（不另开列），便于任务中心跳回应用与「再跑一次」。

**运行主路径**：

- **编辑器调试（主路径）**：画布「运行」同页填参后 `runApp`，不跳转；轮询 AppRun 刷新画布节点执行态；悬浮条仅作总进度与暂停/取消。点节点打开与主对话协作工作流同款的子任务会话弹窗（`SubtaskExecutionDrawer`），不嵌任务中心整页。
- **填参页（外部入口）**：`#/apps/{id}/run` 留给列表「运行」、任务「再跑一次」等；进度也在本页轮询，无需先进任务中心。

纯工作流在显式 `run()` 时始终 `auto_authorize=True`。Lead 模式若未传 `thread_id`，后端自动创建 LangGraph 线程。终态 toast + 桌面通知（Tauri）。

### 3.2 运行实例：AppRun

```python
class AppRun(BaseModel):
    """应用的一次运行实例"""
    
    id: str                              # Run_YYYYMMDDHHMMSS_xxxxxx
    app_id: str                          # 关联的应用定义
    app_version: int                     # 运行时的应用版本快照
    
    # ── 运行参数 ──
    parameters: dict[str, str]           # 本次运行填入的实际参数值
    
    # ── 执行关联 ──
    execution_mode: str                  # workflow | lead_supervised
    task_id: str                         # 实例化出的主任务 ID（对接任务中心）
    thread_id: str | None = None         # 运行会话（lead 模式需要）
    
    # ── 状态 ──
    status: str = "running"              # running | completed | failed | cancelled | paused
    progress: int = 0                    # 0-100
    result_summary: str = ""             # 运行结果摘要
    
    # ── 时间 ──
    created_at: str = ""
    started_at: str | None = None
    completed_at: str | None = None
    error: str | None = None
```

### 3.3 AppStep 与现有 PlanStepInput 的关系

AppStep 的字段集**完全对齐** PlanStepInput，只是字符串字段中可能含 `{{param}}` 占位符。运行时渲染参数后，产出标准 PlanStepInput，直接喂给现有的 `sync_subtasks_from_plan_steps()`。

```
AppStep（含 {{param}}）
  │  render(parameters)
  ▼
PlanStepInput（标准 plan 步骤，现有结构）
  │  sync_subtasks_from_plan_steps()
  ▼
evoflow_collab_subtasks（现有表，零改动）
  │  start_execution / workflow engine
  ▼
DAG 调度执行
```

---

## 4. 持久化设计

### 4.1 task 表的演进策略

用户提出"task 表可以改掉，以后就是应用表"。有两种路径：

| 方案 | 做法 | 优点 | 缺点 |
|------|------|------|------|
| **A. 新增 app 表**（推荐 Phase 1） | 新建 `evoflow_apps` + `evoflow_app_runs`，task 表保持不变 | 零风险，不影响现有功能 | task 和 app 两套表并存 |
| **B. task 表演变成 app 表** | 重命名 `evoflow_collab_tasks` → `evoflow_apps`，加列 | 统一概念 | 迁移成本高，影响面大 |

**推荐**：Phase 1 用方案 A（新增表，不动 task），Phase 3 做方案 B（统一表，清理历史包袱）。这样前期不冒风险，后期再收敛。

### 4.2 新增表

#### `evoflow_apps`（应用定义表）

```sql
CREATE TABLE evoflow_apps (
    id TEXT PRIMARY KEY,                         -- App_YYYYMMDDHHMMSS_xxxxxx
    name TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    icon TEXT NOT NULL DEFAULT '',
    category TEXT NOT NULL DEFAULT 'general',
    parameters_json TEXT NOT NULL DEFAULT '[]',  -- AppParameter[] JSON
    steps_json TEXT NOT NULL DEFAULT '[]',       -- AppStep[] JSON
    goal_template TEXT NOT NULL DEFAULT '',
    validation_json TEXT NOT NULL DEFAULT '[]',
    flowchart_mermaid TEXT NOT NULL DEFAULT '',
    execution_mode TEXT NOT NULL DEFAULT 'workflow',
    auto_run INTEGER NOT NULL DEFAULT 0,
    source TEXT NOT NULL DEFAULT 'generated',
    source_task_id TEXT,
    version INTEGER NOT NULL DEFAULT 1,
    status TEXT NOT NULL DEFAULT 'draft',
    tags_json TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL DEFAULT '',
    usage_count INTEGER NOT NULL DEFAULT 0,
    last_used_at TEXT
);
```

#### `evoflow_app_runs`（运行实例表）

```sql
CREATE TABLE evoflow_app_runs (
    id TEXT PRIMARY KEY,                         -- Run_YYYYMMDDHHMMSS_xxxxxx
    app_id TEXT NOT NULL,
    app_version INTEGER NOT NULL,
    parameters_json TEXT NOT NULL DEFAULT '{}',
    execution_mode TEXT NOT NULL DEFAULT 'workflow',
    task_id TEXT NOT NULL,                       -- 对接任务中心的主任务 ID
    thread_id TEXT,
    status TEXT NOT NULL DEFAULT 'running',
    progress INTEGER NOT NULL DEFAULT 0,
    result_summary TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT '',
    started_at TEXT,
    completed_at TEXT,
    error TEXT,
    FOREIGN KEY (app_id) REFERENCES evoflow_apps(id)
);
CREATE INDEX idx_app_runs_app ON evoflow_app_runs(app_id);
CREATE INDEX idx_app_runs_task ON evoflow_app_runs(task_id);
CREATE INDEX idx_app_runs_status ON evoflow_app_runs(status);
```

### 4.3 迁移脚本

新增 `schema_migration_v80.py`（当前 v79）：

```python
def migrate_v80(conn: sqlite3.Connection) -> None:
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS evoflow_apps (...);
        CREATE TABLE IF NOT EXISTS evoflow_app_runs (...);
    """)
```

### 4.4 存储层

新增 `persistence/app_repositories.py`：

```python
class AppRepository:
    def save_app(self, app: dict) -> None: ...
    def load_app(self, app_id: str) -> dict | None: ...
    def list_apps(self, status: str | None = None, category: str | None = None) -> list[dict]: ...
    def delete_app(self, app_id: str) -> bool: ...
    def increment_usage(self, app_id: str) -> None: ...
    
    def save_run(self, run: dict) -> None: ...
    def load_run(self, run_id: str) -> dict | None: ...
    def load_run_by_task_id(self, task_id: str) -> dict | None: ...
    def update_run_status(self, run_id: str, status: str, **fields) -> None: ...
    def list_runs(self, app_id: str, limit: int = 20) -> list[dict]: ...
```

---

## 5. 两种执行模式

### 5.1 模式一：纯工作流模式（workflow）

#### 核心挑战

现有的 DAG 执行函数都依赖 `runtime`（lead agent 的 ToolRuntime）：

```
delegate_collab_subtasks_for_start_execution(runtime, storage, main_task_id, subtask_ids)
  └── if runtime is None: abort  ← 问题在这
auto_delegate_collab_followup_wave(runtime, main_task_id)
  └── runtime = _resolve_collab_followup_runtime(runtime, tid)
  └── if runtime is None: skip wave-2+  ← 问题在这
```

纯工作流模式没有 lead agent，所以需要解决"无 runtime 怎么执行"的问题。

#### 解决方案：WorkflowRuntime

现有系统已经有 `unattended_task_pipeline.py` 和 `task_queue_runner.py` 处理无人值守场景。纯工作流模式在此基础上进一步简化：

```python
class WorkflowRuntime:
    """纯工作流模式的运行时 - 替代 lead agent 的 ToolRuntime"""
    
    def __init__(self, app_run_id: str, main_task_id: str, config: dict):
        self.app_run_id = app_run_id
        self.main_task_id = main_task_id
        self.config = config  # local_workspace_root, model 等
        self._runtime = self._build_tool_runtime()
    
    def _build_tool_runtime(self) -> ToolRuntime:
        """构建一个不需要 lead agent 的 ToolRuntime"""
        # 复用 unattended_task_pipeline 的 runtime 构建逻辑
        # 或者创建一个轻量级 runtime，只包含 delegate 所需的最小上下文
        ...
    
    async def start(self, parameters: dict[str, str]) -> str:
        """启动工作流执行"""
        # 1. 渲染参数 → PlanInput
        # 2. 创建主任务 + 同步子任务（复用现有链路）
        # 3. 自动授权执行（auto_run=True 时）
        # 4. 调用 start_execution 派发第一波
        # 5. auto follow-up wave 自动推进后续波次
        ...
    
    async def on_subtask_completed(self, subtask_id: str):
        """子任务完成回调 - 触发下一波"""
        # 复用 auto_delegate_collab_followup_wave
        ...
```

#### 执行流程

```
用户填参数 → 点"运行"
  │
  ▼
1. 创建 AppRun 记录
2. 渲染参数 → PlanInput（goal + steps[]）
3. 创建主任务（new_project_bundle_root_task）
4. 写入 plan 字段（write_plan_fields）
5. 同步子任务（sync_subtasks_from_plan_steps）
6. 自动授权执行（execution_authorized = True）
7. WorkflowRuntime.start()
   └── _resolve_subtasks_for_start_execution() → 解析第一波
   └── delegate_collab_subtasks_for_start_execution() → 并行委派
8. 子任务完成 → on_subtask_completed()
   └── auto_delegate_collab_followup_wave() → 自动推进下一波
9. 全部完成 → 更新 AppRun.status = "completed"
```

#### 与 unattended 模式的关系

现有的 `unattended` 模式（`run_mode=unattended`）已经实现了"无人工确认自动执行"。纯工作流模式的区别：

| 维度 | unattended 模式 | 纯工作流模式 |
|------|----------------|-------------|
| 是否有 lead agent | 有（lead 规划后自动授权） | 无（应用定义已固化，不需要 lead） |
| plan 来源 | lead agent 现场规划 | 应用定义中预存 |
| 适合场景 | 单次自动化任务 | 可复用的标准化流程 |
| 参数 | 无（lead 根据需求生成） | 有（用户填参数渲染） |

**实现策略**：纯工作流模式可以复用 unattended 模式的 runtime 构建和自动授权逻辑，只是 plan 来源从"lead 现场生成"变成"应用定义渲染"。

### 5.2 模式二：Lead 监督模式（lead_supervised）

这个模式**完全复用现有 plan + supervisor 链路**，零改动：

```
用户填参数 → 点"运行"
  │
  ▼
1. 创建 AppRun 记录
2. 渲染参数 → PlanInput
3. 创建会话（thread_id）
4. 在会话中创建占位任务（ensure_plan_session_task）
5. 绑定 plan（bind_plan_to_thread_task）
6. 同步子任务（sync_subtasks_from_plan_steps）
7. 状态到 plan_ready → 等待用户确认
8. 用户点"开始执行" → supervisor start_execution
9. Lead agent 监控执行，可中途干预/重规划
10. 完成 → 更新 AppRun.status
```

**与纯工作流模式的区别**：
- 有会话（thread_id），lead agent 可介入
- 需要用户确认执行（plan_ready → awaiting_exec）
- Lead 可以中途调整 plan、重试子任务、引导子任务
- 适合复杂/探索性任务

### 5.3 两种模式的统一入口

```python
async def run_app(
    app_id: str,
    parameters: dict[str, str],
    thread_id: str | None = None,
) -> dict:
    """应用运行统一入口"""
    
    app = repo.load_app(app_id)
    mode = app["execution_mode"]
    
    # 1. 渲染参数
    plan_input = render_plan(app, parameters)
    
    # 2. 创建运行记录
    run = create_app_run(app, parameters, mode)
    
    # 3. 按模式分发
    if mode == "workflow":
        task_id = await run_workflow(app, plan_input, run)
    elif mode == "lead_supervised":
        task_id = await run_lead_supervised(app, plan_input, run, thread_id)
    
    # 4. 更新运行记录
    run["task_id"] = task_id
    repo.save_run(run)
    repo.increment_usage(app_id)
    
    return {"run_id": run["id"], "task_id": task_id, "mode": mode}


async def run_workflow(app, plan_input, run):
    """纯工作流模式"""
    # 创建主任务 + 同步子任务
    task_id = create_task_and_sync(plan_input)
    # 自动授权
    authorize_execution(task_id)
    # WorkflowRuntime 启动 DAG 执行
    runtime = WorkflowRuntime(run["id"], task_id, config)
    await runtime.start(parameters)
    return task_id


async def run_lead_supervised(app, plan_input, run, thread_id):
    """Lead 监督模式"""
    # 创建会话 + 占位任务
    thread_id = thread_id or create_thread()
    ensure_plan_session_task(thread_id, plan_input["goal"])
    # 绑定 plan + 同步子任务
    bind_plan_to_thread_task(thread_id, plan_input)
    # 状态到 plan_ready，等待用户确认
    advance_to_plan_ready(thread_id)
    return get_bound_task_id(thread_id)
```

---

## 6. 参数渲染引擎

```python
def render_plan(app: dict, parameters: dict[str, str]) -> dict:
    """渲染应用定义中的参数槽，产出标准 PlanInput"""
    
    def render(text: str) -> str:
        if not text:
            return text
        for key, value in parameters.items():
            text = text.replace(f"{{{{{key}}}}}", str(value))
        return text
    
    return {
        "goal": render(app["goal_template"]),
        "steps": [
            {
                **step,
                "name": render(step["name"]),
                "goal": render(step["goal"]),
                "inputs": render(step.get("inputs", "")),
                "outputs": render(step.get("outputs", "")),
                "acceptance": render(step.get("acceptance", "")),
                "instruction": render(step.get("instruction", "")),
            }
            for step in app["steps"]
        ],
        "flowchart_mermaid": render(app.get("flowchart_mermaid", "")),
        "validation": [render(v) for v in app.get("validation_template", [])],
        "open_questions": "无",
    }
```

---

## 7. 应用的创建方式

### 7.1 模型生成（主要方式）

用户描述需求 → 模型生成应用定义：

```
用户: "帮我做一个竞品分析的应用，以后换个领域也能用"
  │
  ▼
1. Lead agent 理解需求
2. 调用 plan 生成 PlanInput（goal + steps[]）
3. 参数提取：识别可变内容 → 替换为 {{param}}
4. 组装 App 对象（steps + parameters + execution_mode）
5. 保存到 evoflow_apps
6. 用户可在应用列表看到，下次直接填参数运行
```

**关键**：应用创建走的是现有的 plan 链路（lead 生成 plan），只是生成后不是直接执行，而是"参数化 + 存为应用定义"。

### 7.2 从已执行 Task 沉淀

```
用户: "这个任务跑得不错，存成应用吧"
  │
  ▼
1. 读取 task 的 plan_steps / plan_goal
2. 参数提取（模型辅助）
3. 组装 App 对象
4. 保存
```

### 7.3 手动创建 / 导入

前端编辑器手动创建步骤、定义参数；或导入 JSON。

---

## 8. API 设计

### 8.1 应用管理 API

路由前缀：`/api/apps`

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/api/apps` | 列出应用（支持 status/category/search 过滤） |
| `POST` | `/api/apps` | 创建应用（模型生成 / 手动 / 从 task 沉淀） |
| `GET` | `/api/apps/{id}` | 获取应用详情 |
| `PUT` | `/api/apps/{id}` | 更新应用定义 |
| `DELETE` | `/api/apps/{id}` | 删除应用 |
| `POST` | `/api/apps/{id}/publish` | 发布应用（draft → published） |

### 8.2 应用运行 API

| 方法 | 路径 | 说明 |
|------|------|------|
| `POST` | `/api/apps/{id}/run` | 运行应用（填参数 → 创建 run → 执行） |
| `GET` | `/api/apps/{id}/runs` | 列出该应用的运行历史 |
| `GET` | `/api/apps/runs/{run_id}` | 获取运行详情 |
| `POST` | `/api/apps/runs/{run_id}/pause` | 暂停运行 |
| `POST` | `/api/apps/runs/{run_id}/resume` | 恢复运行 |
| `POST` | `/api/apps/runs/{run_id}/cancel` | 取消运行 |

### 8.3 请求/响应

```typescript
// POST /api/apps/{id}/run
// Request:
{
  "parameters": {
    "topic": "AI 编程助手",
    "format": "Markdown",
    "top_n": "5"
  },
  "thread_id": "thread_xxx"    // 可选，lead_supervised 模式需要
}

// Response:
{
  "run_id": "Run_20260710...",
  "task_id": "Task_20260710...",
  "execution_mode": "workflow",
  "status": "running",         // workflow 模式直接 running
  // 或 "status": "plan_ready" // lead_supervised 模式等待确认
  "subtasks": [
    {"id": "Subtask_...", "ref": "1", "name": "Step 1: ...", "status": "executing"}
  ]
}
```

```typescript
// POST /api/apps  (从 task 沉淀)
{
  "source": "from_task",
  "source_task_id": "Task_xxx",
  "name": "竞品分析报告",
  "execution_mode": "workflow",
  "auto_extract": true         // 模型辅助参数提取
}
```

---

## 9. 前端设计（EvoPanel）

### 9.1 应用列表页

```
┌─────────────────────────────────────────────────┐
│  📱 应用                              [+ 新建应用] │
├─────────────────────────────────────────────────┤
│  全部 | 调研 | 开发 | 运营                        │
│                                                 │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐       │
│  │ 📋       │ │ 🔍       │ │ 📝       │       │
│  │竞品分析   │ │代码审查   │ │周报生成   │       │
│  │workflow  │ │lead监督   │ │workflow  │       │
│  │用了12次  │ │用了5次   │ │新建       │       │
│  │[运行]    │ │[运行]    │ │           │       │
│  └──────────┘ └──────────┘ └──────────┘       │
└─────────────────────────────────────────────────┘
```

### 9.2 运行界面

```
┌─────────────────────────────────────────────────┐
│  📋 竞品分析报告                        [运行]   │
│  模式: 纯工作流                    ⚡ 自动执行   │
├─────────────────────────────────────────────────┤
│  分析主题 *: [AI 编程助手          ]             │
│  输出格式:   [Markdown      ▼]                  │
│  核心竞品数量: [5            ]                   │
│                                                 │
│  ── 执行计划预览 ──                              │
│  Goal: 针对 AI 编程助手 进行竞品分析...          │
│                                                 │
│  ┌─────────┐    ┌─────────┐    ┌─────────┐    │
│  │ Step 1  │───▶│ Step 2  │───▶│ Step 3  │    │
│  │ 调研    │    │ 整理    │    │ 输出    │    │
│  │ ✅ 完成 │    │ ⏳ 执行 │    │ ⏸ 等待  │    │
│  └─────────┘    └─────────┘    └─────────┘    │
│                                                 │
│  [查看子任务详情]                                │
└─────────────────────────────────────────────────┘
```

### 9.3 运行历史

```
┌─────────────────────────────────────────────────┐
│  📋 竞品分析报告 - 运行历史                       │
├─────────────────────────────────────────────────┤
│  Run_20260710_1  | topic=AI编程助手 | ✅ 完成    │
│  Run_20260709_3  | topic=向量数据库  | ✅ 完成    │
│  Run_20260709_1  | topic=LLM框架    | ❌ 失败    │
│  Run_20260708_2  | topic=RAG方案    | ✅ 完成    │
└─────────────────────────────────────────────────┘
```

---

## 10. 与任务中心的关系

### 10.1 Phase 1：并行共存

```
应用系统                          任务中心
evoflow_apps                      evoflow_collab_tasks
evoflow_app_runs                       ↑
    │                                  │
    └── task_id ───────────────────────┘
        （每次运行创建一个主任务，
         出现在任务中心，复用全部现有基础设施）
```

应用运行时创建的主任务仍然走 `evoflow_collab_tasks` 表，子任务走 `evoflow_collab_subtasks` 表。任务中心看到的就是普通任务，无需特殊处理。

### 10.2 Phase 3：统一

```
应用系统（取代任务中心）
evoflow_apps（应用定义，原 evoflow_collab_tasks 演变）
evoflow_app_runs（运行实例）
evoflow_collab_subtasks（子任务，保持不变）

任务中心 UI → 演变成"应用运行中心"
- 已有的任务 = 历史运行记录
- 新建任务 → 改为"运行应用"或"创建应用"
```

---

## 11. 演进路线

### Phase 1：应用定义 + 两种执行模式（MVP）

| 工作项 | 说明 |
|--------|------|
| 后端：数据模型 + 迁移 | `evoflow_apps` + `evoflow_app_runs` 表（v80 迁移） |
| 后端：Repository | `app_repositories.py` CRUD |
| 后端：参数渲染引擎 | `render_plan()` 函数 |
| 后端：运行统一入口 | `run_app()` + `run_workflow()` + `run_lead_supervised()` |
| 后端：WorkflowRuntime | 纯工作流模式的执行运行时（复用 unattended 基础设施） |
| 后端：API 路由 | `/api/apps` + `/api/apps/{id}/run` 等 |
| 后端：模型生成应用 | lead agent 生成 plan → 参数提取 → 存为 App |
| 前端：应用列表页 | 卡片浏览、分类过滤 |
| 前端：运行界面 | 参数表单 + DAG 预览 + 运行状态 |
| 前端：运行历史 | 查看历史运行记录 |

**交付标准**：模型能生成应用、用户能填参数运行、两种模式都能跑通

### Phase 2：应用编辑 + DAG 可视化

| 工作项 | 说明 |
|--------|------|
| 前端：应用编辑器 | 表单式编辑 steps / parameters / 执行模式 |
| 前端：DAG 可视化预览 | 用 Mermaid 或 React Flow 渲染节点图 |
| 后端：应用版本管理 | 版本快照、回溯 |
| 后端：从 task 沉淀 | `POST /api/tasks/{id}/save-as-app` + 参数提取 |

### Phase 3：拖拽编辑器 + 表统一

| 工作项 | 说明 |
|--------|------|
| 前端：React Flow 拖拽画布 | 节点拖拽、连线、DAG 验证 |
| 前端：节点库 | 可复用节点组件 |
| 后端：表统一 | `evoflow_collab_tasks` → `evoflow_apps` 迁移 |
| 后端：任务中心 UI 改造 | 演变成"应用运行中心" |

---

## 12. 关键设计决策

### 12.1 为什么是"应用"不是"模板"

| 维度 | 模板（v1） | 应用（v2） |
|------|-----------|-----------|
| 本质 | 静态定义，需实例化 | 可直接运行的实体 |
| 运行 | 模板 → 实例化 → 任务 → 执行 | 应用 → 运行（一步到位） |
| 心智模型 | "先做个模板，以后再用" | "做个应用，随时填参数跑" |
| 与 FastGPT 对应 | 模板 = FastGPT 的"应用模板" | 应用 = FastGPT 的"应用" |

### 12.2 为什么需要两种执行模式

| 场景 | 适合模式 | 理由 |
|------|---------|------|
| 标准化竞品分析 | workflow | 流程固定，无需人工干预 |
| 批量内容生成 | workflow | 换参数跑多次，无人值守 |
| 代码重构 | lead_supervised | 需要确认 plan、中途调整 |
| 探索性研究 | lead_supervised | 流程不确定，需要 lead 判断 |

### 12.3 纯工作流模式怎么解决 runtime 依赖

现有 `delegate_collab_subtasks_for_start_execution` 和 `auto_delegate_collab_followup_wave` 都需要 `runtime`（lead agent 的 ToolRuntime）。纯工作流模式没有 lead agent。

**解决方案**：创建 `WorkflowRuntime`，复用现有 `unattended_task_pipeline.py` 的 runtime 构建逻辑（该模块已经解决了无人值守场景下的 runtime 问题）。纯工作流模式与 unattended 模式的区别仅在于 plan 来源（应用定义渲染 vs lead 现场生成），runtime 构建方式可以共用。

### 12.4 参数化策略

- **结构性字段不参数化**：`assigned_agent`、`tools`、`skills`、`depends_on` 固化在应用定义中
- **内容性字段可参数化**：`goal`、`name`、`inputs`、`outputs`、`acceptance`、`instruction` 中可含 `{{param}}`
- **参数提取**：模型辅助为主，人工微调为辅（Phase 2 编辑器）
- **参数数量建议 ≤5**：避免填表负担过重

---

## 13. 改动面总结

| 类型 | 内容 |
|------|------|
| **新增** | 2 张表 + 1 个迁移脚本 + 1 个 Repository + 1 个渲染引擎 + 1 个 WorkflowRuntime + 1 组 API 路由 + 前端应用页 |
| **改动** | 现有代码零改动（Phase 1）；Phase 3 做表统一迁移 |
| **复用** | plan 提交、子任务同步、DAG 调度、状态机、任务中心 UI、unattended runtime 基础设施 |

---

## 附录：关键文件索引

### 新增文件

| 文件 | 职责 |
|------|------|
| `persistence/schema_migration_v80.py` | apps + app_runs 表 DDL |
| `persistence/app_repositories.py` | 应用 + 运行 CRUD |
| `collab/app_engine.py` | 参数渲染引擎 `render_plan()` |
| `collab/app_runner.py` | 运行统一入口 `run_app()` + 两种模式分发 |
| `collab/workflow_runtime.py` | 纯工作流模式执行运行时 |
| `collab/app_generator.py` | 模型生成应用（plan → 参数提取 → App） |
| `app/gateway/routers/apps.py` | REST API 路由 |
| `evopanel/src/pages/Apps.tsx` | 前端应用列表页 |
| `evopanel/src/pages/AppRun.tsx` | 前端运行界面 |

### 复用文件（零改动）

| 文件 | 复用内容 |
|------|---------|
| `tools/builtins/plan_tool.py` | PlanInput / PlanStepInput schema |
| `collab/plan_session_task.py` | `bind_plan_to_thread_task()` |
| `collab/plan_task_storage.py` | `write_plan_fields()` |
| `collab/plan_subtasks_sync.py` | `sync_subtasks_from_plan_steps()` |
| `tools/builtins/supervisor/dependency.py` | `_resolve_subtasks_for_start_execution()` DAG 解析 |
| `tools/builtins/supervisor/execution.py` | `delegate_collab_subtasks_for_start_execution()` + `auto_delegate_collab_followup_wave()` |
| `app/gateway/unattended_task_pipeline.py` | runtime 构建逻辑（WorkflowRuntime 复用） |
| `persistence/task_repositories.py` | `save_task_bundle()` / `load_task_bundle()` |
