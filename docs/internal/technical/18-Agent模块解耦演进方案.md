# 18-Agent 模块解耦演进方案

> **文档状态**：草案 / Draft
> **版本**：v0.1
> **创建日期**：2026-06-05
> **范围**：`backend/packages/harness/evoflow/agents/` 及其所有关联模块
> **目标**：支撑未来成千上万 Agent 的创建、调度、生命周期管理，同时保持核心运行时稳定

---

## 目录

- [一、现状诊断](#一现状诊断)
- [二、演进目标与原则](#二演进目标与原则)
- [三、总体架构设计](#三总体架构设计)
- [四、分阶段改造计划](#四分阶段改造计划)
- [五、核心模块详细设计](#五核心模块详细设计)
- [六、兼容性迁移策略](#六兼容性迁移策略)
- [七、风险与缓解](#七风险与缓解)
- [八、验证指标](#八验证指标)

---

## 一、现状诊断

### 1.1 耦合度量化指标

| 维度 | 当前值 | 说明 | 严重程度 |
|------|--------|------|----------|
| Middleware 文件总数 | 60+ | `agents/middlewares/` 下全部 .py 文件 | 严重 |
| 最大单文件行数 | 1564 | `plan_guard_middleware.py` | 严重 |
| `lead_agent/agent.py` 跨模块 import 数 | 47 处 | 直接 `from evoflow.* import` | 严重 |
| 单 middleware 跨模块 import 数 | 32 处 | `plan_guard_middleware.py` | 严重 |
| `evoflow/` 包内互引总数 | ~2541 处 | `from evoflow.*` 统计 | 严重 |
| Factory 硬编码 middleware 链 | 14 个 | `_assemble_from_features()` 内联组装 | 中等 |

### 1.2 耦合模式识别

#### 模式 A：Middleware 全链路跨模块依赖

每个 middleware 在初始化或 `invoke` 方法中大量导入 `evoflow.*` 子模块：

```
PlanGuardMiddleware 导入 →
├── evoflow.collab.storage        (5-10 个函数/类)
├── evoflow.collab.thread_collab  (状态加载/保存)
├── evoflow.collab.authorize      (授权检查)
├── evoflow.persistence.*         (session, chat, artifact repo)
├── evoflow.agents.mission_state  (任务状态管理)
├── evoflow.agents.lead_agent     (intent_tool_profile, prompt)
├── evoflow.tools.builtins        (scenario_activation, tool_search)
├── evoflow.config.paths          (文件路径)
├── evoflow.debug.*               (日志追踪)
└── evoflow.timeutil              (时间工具)
```

**本质问题**：Middleware 之间、Middleware 与其他模块之间通过 `from evoflow.xxx import` 建立**编译期紧耦合**，无法独立编译、测试、替换。

#### 模式 B：Factory 硬编码编排

`create_evoflow_agent()` 通过 `_assemble_from_features()` 函数硬编码了 14 个 middleware 的创建顺序和条件：

```python
# factory.py 中的硬编码链（不可扩展）
chain = [
    ThreadDataMiddleware,
    UploadsMiddleware,
    SandboxMiddleware,
    DanglingToolCallMiddleware,
    # guardrail/summarization 需要自定义实例
    ToolErrorHandlingMiddleware,
    TodoMiddleware,
    TitleMiddleware,
    MemoryMiddleware,
    ViewImageMiddleware,
    SubagentLimitMiddleware,
    LoopDetectionMiddleware,
    AutomationRunGuardMiddleware,
    ClarificationMiddleware,  # 永远在最后
]
```

**本质问题**：新增/替换 middleware 必须修改 `factory.py`，违反**开闭原则**；feature 的 `True/False` 语义与自定义实例混用，增加了状态空间复杂度。

#### 模式 C：上帝文件 `lead_agent/agent.py`

单个文件承担了 5 种职责：
1. **Middleware 组装**：34+ 个 middleware 类直接导入
2. **Prompt 组装**：多语言 prompt template、动态系统提示
3. **场景策略**：intent_tool_profile、scenario 激活
4. **工具过滤**：基于场景的工具白名单/黑名单
5. **运行时上下文**：LeadAgentRuntimeContext

**本质问题**：文件长度 > 500 行，import 47 个跨模块依赖，**任何一处修改都可能引发不可预见的连锁反应**。

#### 模式 D：State Schema 无界膨胀

`ThreadState` 通过 LangGraph `ReduceAnnotation` 被所有 middleware 共享读写：

- 无类型安全约束：任何 middleware 都可以修改任意 key
- 字段无限增长：每个 middleware 都往 state 里塞自己的数据
- 无读写权限隔离：middleware 间状态隔离靠约定而非机制

---

## 二、演进目标与原则

### 2.1 演进目标

| 阶段 | 目标 | 时间线 | 可验证指标 |
|------|------|--------|------------|
| **Phase 1** | 消除单体文件、拆分职责 | 2-3 周 | 最大单文件 < 300 行 |
| **Phase 2** | 引入 Capability 接口层、解耦依赖 | 3-4 周 | middleware 不直接 import 子模块 |
| **Phase 3** | AgentProfile + Registry 声明式注册 | 3-4 周 | 新增 Agent 无需修改核心代码 |
| **Phase 4** | Runtime 与 Agent 实例完全分离 | 4-6 周 | 万级 Agent 热加载 < 100ms |

### 2.2 设计原则

1. **依赖倒置**：中间件通过抽象接口依赖，不依赖具体模块实现
2. **单一职责**：每个文件 < 300 行，只做一件事
3. **开闭原则**：扩展 middleware/工具/能力无需修改核心组装代码
4. **显式优于隐式**：依赖通过构造函数注入，不隐式 `import`
5. **向后兼容**：渐进式迁移，保持现有 API `create_evoflow_agent()` 可用
6. **编译期可验证**：接口用 Python `Protocol`/`ABC` 声明，类型检查可检测

---

## 三、总体架构设计

### 3.1 目标架构

```
┌──────────────────────────────────────────────────────────────────────┐
│                        Agent Registry 注册中心                       │
│                                                                      │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐            │
│  │ Profile A │  │ Profile B │  │ Profile C │  │ Profile N │            │
│  │ code-gen  │  │ code-rev │  │ doc-writer│  │ custom   │            │
│  │ (声明式)  │  │ (声明式)  │  │ (声明式)  │  │ (声明式)  │            │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └────┬─────┘            │
│       │              │              │              │                  │
│       └──────────────┴──────────────┴──────────────┘                  │
│                            │                                         │
│                  ┌─────────▼─────────┐                               │
│                  │  Deploy() 实例化    │                               │
│                  │  → 组装 Middleware  │                               │
│                  │  → 绑定 Tools      │                               │
│                  │  → 创建 State      │                               │
│                  └─────────┬─────────┘                               │
└────────────────────────────┼─────────────────────────────────────────┘
                             │
┌────────────────────────────┼─────────────────────────────────────────┐
│                     Agent Runtime 运行时层                            │
│                     (核心，不随 Agent 变化)                            │
│                                                                      │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐      │
│  │ Middleware Chain │  │  Tool Dispatcher │  │  Checkpoint     │      │
│  │  引擎             │  │  分发器           │  │  管理器         │      │
│  │  - 顺序执行       │  │  - 按名查找      │  │  - 状态持久化  │      │
│  │  - @Next/@Prev    │  │  - 动态注册      │  │  - 崩溃恢复    │      │
│  │  - 并行调度       │  │  - 权限过滤      │  │  - 过期清理    │      │
│  └─────────────────┘  └─────────────────┘  └─────────────────┘      │
└────────────────────────────┼─────────────────────────────────────────┘
                             │
┌────────────────────────────┼─────────────────────────────────────────┐
│                    Capability 能力接口层                              │
│                    (稳定抽象，实现可替换)                              │
│                                                                      │
│  ┌──────────────┐ ┌──────────────┐ ┌──────────────┐                │
│  │ ICollabCap   │ │ IPersistCap  │ │ IToolCap     │                │
│  │ ── 协作能力   │ │ ── 持久化     │ │ ── 工具能力   │                │
│  └──────────────┘ └──────────────┘ └──────────────┘                │
│  ┌──────────────┐ ┌──────────────┐ ┌──────────────┐                │
│  │ IConfigCap   │ │ IModelCap    │ │ IDebugCap    │                │
│  │ ── 配置能力   │ │ ── 模型能力   │ │ ── 调试能力   │                │
│  └──────────────┘ └──────────────┘ └──────────────┘                │
└────────────────────────────┼─────────────────────────────────────────┘
                             │
┌────────────────────────────┼─────────────────────────────────────────┐
│                   evoflow.* 实现层                                   │
│                   (具体实现，可独立演进)                               │
│                                                                      │
│  evoflow.collab/  evoflow.persistence/  evoflow.tools/  evoflow.config/│
└──────────────────────────────────────────────────────────────────────┘
```

### 3.2 目录结构演进

```
backend/packages/harness/evoflow/
│
├── runtime/                        # [新增] 核心运行时（不变）
│   ├── engine.py                   # Agent 执行引擎入口
│   ├── middleware_chain.py         # Middleware 链管理器
│   ├── tool_dispatcher.py          # 工具分发器
│   ├── checkpoint_manager.py       # Checkpoint 管理器
│   └── protocol.pyi                # 内部接口定义
│
├── registry/                       # [新增] Agent 注册中心
│   ├── __init__.py
│   ├── agent_profile.py            # AgentProfile 数据模型
│   ├── registry.py                 # AgentRegistry 核心类
│   ├── plugin_loader.py            # 插件加载器
│   └── profile_store.py            # Profile 持久化 (DB/YAML)
│
├── capabilities/                   # [新增] 能力接口层
│   ├── __init__.pyi
│   ├── collab.pyi                  # ICollabStorage, ICollabState
│   ├── persistence.pyi             # ISessionRepo, IChatRepo
│   ├── tools.pyi                   # IToolRegistry
│   ├── config.pyi                  # IConfigStore
│   ├── model.pyi                   # IModelProvider
│   └── debug.pyi                   # IDebugLogger
│
├── agents/                         # [保留] Agent 组装层
│   ├── __init__.py                 # 向后兼容入口：create_evoflow_agent
│   ├── factory.py                  # 简化：委托给 Registry
│   ├── features.py                 # RuntimeFeatures (保留)
│   ├── thread_state.py             # ThreadState (保留, 见 Phase 2)
│   ├── middleware_chain_builder.py # [新增] 组装逻辑抽离
│   │
│   ├── lead_agent/                 # [简化] 仅保留 prompt + 场景
│   │   ├── prompt/                 # [重构] prompt 模板
│   │   │   ├── core.py
│   │   │   ├── language.py
│   │   │   └── dynamic.py
│   │   ├── scenario/               # [重构] 场景策略
│   │   │   ├── activation.py
│   │   │   ├── tool_profile.py
│   │   │   └── policy.py
│   │   └── runtime_context.py      # [保留] 运行时上下文
│   │
│   ├── middlewares/                # [重构] 按功能域分组
│   │   ├── __init__.py
│   │   ├── base.py                 # [新增] 基础 middleware + 依赖注入
│   │   │
│   │   ├── sandbox/                # 基础设施域
│   │   │   ├── thread_data.py
│   │   │   ├── uploads.py
│   │   │   └── sandbox.py
│   │   │
│   │   ├── workflow/               # 工作流控制域
│   │   │   ├── plan_guard_core.py       # [拆分] 原 plan_guard_middleware.py
│   │   │   ├── plan_guard_auth.py       # [拆分]
│   │   │   ├── plan_guard_snapshot.py   # [拆分]
│   │   │   ├── mission_state.py
│   │   │   ├── clarification_core.py    # [拆分] 原 clarification_middleware.py
│   │   │   ├── clarification_answers.py
│   │   │   └── collab/               # 协作相关
│   │   │       ├── phase.py
│   │   │       ├── lifecycle.py
│   │   │       ├── trace.py
│   │   │       └── thread_context.py
│   │   │
│   │   ├── observability/          # 可观测性域
│   │   │   ├── transcript.py          # [拆分] 原 transcript_middleware.py
│   │   │   ├── transcript_persist.py  # [拆分] DB 写入部分
│   │   │   ├── trace.py
│   │   │   ├── timing.py
│   │   │   └── token_usage.py
│   │   │
│   │   ├── tools/                  # 工具相关域
│   │   │   ├── approval_core.py       # [拆分] 原 tool_approval
│   │   │   ├── approval_config.py
│   │   │   ├── error_handling_core.py  # [拆分] 原 tool_error_handling (544行)
│   │   │   ├── error_handling_strategy.py
│   │   │   ├── history_ager.py
│   │   │   └── timeout.py
│   │   │
│   │   └── context/                # 上下文管理域
│   │       ├── compaction_core.py     # [拆分] 原 context_compaction
│   │       ├── compaction_queue.py
│   │       ├── files.py
│   │       └── reference.py
│   │
│   ├── checkpointer/               # [保留] 检查点
│   ├── memory/                     # [保留] 记忆系统
│   ├── mission_state/              # [保留] 任务状态
│   └── subagents/                  # [保留] 子代理
│
├── collab/                         # [保留] 协作模块
├── persistence/                    # [保留] 持久化模块
├── tools/                          # [保留] 工具模块
├── config/                         # [保留] 配置模块
├── debug/                          # [保留] 调试模块
├── context/                        # [保留] 上下文工程
└── (其他现有模块保持不变)
```

---

## 四、分阶段改造计划

### Phase 1：消除单体文件（2-3 周）

**目标**：将所有超过 300 行的 middleware 拆分，为后续解耦打下基础。

#### 1.1 `plan_guard_middleware.py` (1564 行) → 拆分

```
plan_guard_middleware.py (1564 行)
├── plan_guard_core.py        (200-300 行)  核心 guard 逻辑
├── plan_guard_auth.py        (200-300 行)  授权检查逻辑
├── plan_guard_snapshot.py    (150-200 行)  进度快照
├── plan_guard_prompts.py     (100-150 行)  prompt 模板
└── plan_guard_types.py       (50-100 行)   类型定义
```

拆分依据（按关注点）：
- **授权检查**：`is_task_execution_authorized_*`、`user_execution_confirm` 系列 → `plan_guard_auth.py`
- **快照管理**：`build_task_progress_snapshot`、`thread_has_committed_plan_on_task` → `plan_guard_snapshot.py`
- **Prompt 模板**：所有 `PLAN_*_PROMPT` 常量 → `plan_guard_prompts.py`
- **类型**：`PlanGuardMode`、`ExecutionPhase` → `plan_guard_types.py`

#### 1.2 `clarification_middleware.py` (430 行) → 拆分

```
clarification_middleware.py (430 行)
├── clarification_core.py       (200 行)    核心拦截逻辑
├── clarification_questions.py  (150 行)    问题解析/修复 (已有 clarification_questions_repair.py)
└── clarification_prompts.py    (80 行)     prompt 模板
```

#### 1.3 `tool_error_handling_middleware.py` (544 行) → 拆分

```
tool_error_handling_middleware.py (544 行)
├── error_handling_core.py      (200 行)    核心错误处理流程
├── error_handling_strategies.py (250 行)   降级/重试/回退策略
└── error_handling_prompts.py   (94 行)     prompt 模板
```

#### 1.4 `transcript_middleware.py` (463 行) → 拆分

```
transcript_middleware.py (463 行)
├── transcript_core.py          (180 行)    核心 transcript 收集
├── transcript_persist.py       (200 行)    DB 写入逻辑（已部分在 persistence 层）
└── transcript_accumulator.py   (83 行)     流式累积（已有 stream_accumulator.py）
```

#### 1.5 `context_compaction_core.py` (1145 行) → 拆分

```
context_compaction_core.py (1145 行)
├── compaction_core.py          (300 行)    核心压缩算法
├── compaction_strategies.py    (300 行)    压缩策略选择
├── compaction_prompts.py       (200 行)    prompt 模板
├── compaction_models.py        (200 行)    数据模型
└── compaction_utils.py         (145 行)    工具函数
```

#### 1.6 其他 > 300 行文件

| 文件 | 行数 | 拆分策略 |
|------|------|----------|
| `collab_phase_middleware.py` | 548 | 拆分 prompt + 类型 |
| `dynamic_system_prompt_middleware.py` | 395 | 拆分 prompt 生成 |
| `scenario_runtime_hint_middleware.py` | 372 | 拆分 prompt + 逻辑 |
| `collab_lifecycle_stage_middleware.py` | 287 | 拆分日志 + 逻辑 |
| `invalid_tool_call_middleware.py` | 213 | 拆分 prompt |
| `tool_approval_middleware.py` | 316 | 拆分 prompt |
| `ui_messages_snapshot_middleware.py` | 340 | 拆分 snapshot 逻辑 |
| `deferred_tool_filter_middleware.py` | 293 | 拆分 prompt |
| `session_transcript_hydration_middleware.py` | 211 | 拆分 prompt |
| `view_image_middleware.py` | 229 | 拆分 prompt |

#### Phase 1 交付物

- [ ] 所有 middleware 文件 ≤ 300 行
- [ ] 原有 `plan_guard_middleware.PlanGuardMiddleware` 类保持向后兼容（内部 delegate 到新模块）
- [ ] 类型检查 `mypy` 通过
- [ ] 现有测试通过

---

## 五、核心模块详细设计

### 5.1 Capability 接口规范

#### 5.1.1 ICollabStorage

```python
class ICollabStorage(Protocol):
    """协作数据存储接口"""

    @abstractmethod
    async def find_main_task(self, thread_id: str) -> Any | None:
        """查找主线任务"""

    @abstractmethod
    async def get_project_storage(self, project_id: str) -> Any:
        """获取项目存储"""

    @abstractmethod
    async def build_task_progress_snapshot(self, thread_id: str) -> Any:
        """构建任务进度快照"""
```

#### 5.1.2 ICollabState

```python
class ICollabState(Protocol):
    """协作状态接口"""

    @abstractmethod
    async def load_thread_collab_state(self, thread_id: str) -> Any:
        """加载线程协作状态"""

    @abstractmethod
    async def save_thread_collab_state(self, thread_id: str, state: Any) -> None:
        """保存线程协作状态"""

    @abstractmethod
    async def load_merged_collab_phase(self, thread_id: str) -> str:
        """加载合并后的协作阶段"""
```

#### 5.1.3 ICollabAuth

```python
class ICollabAuth(Protocol):
    """协作授权接口"""

    @abstractmethod
    async def is_task_execution_authorized(
        self, thread_id: str, user_id: str | None = None
    ) -> bool:
        """检查任务执行是否授权"""

    @abstractmethod
    async def mark_user_execution_confirmed(self, thread_id: str) -> None:
        """标记用户已确认执行"""
```

#### 5.1.4 IPersistence 接口

```python
class ISessionRepo(Protocol):
    @abstractmethod
    async def find_session_key_by_thread_id(self, thread_id: str) -> str | None: ...
    @abstractmethod
    async def mark_session_run_ended(self, session_id: str, ...) -> None: ...

class IChatRepo(Protocol):
    @abstractmethod
    async def save_artifacts(self, *, thread_id: str, artifacts: list, ...) -> None: ...
    @abstractmethod
    async def save_chat_message(self, *, ...) -> None: ...

class IArtifactRepo(Protocol):
    @abstractmethod
    async def save_artifacts(self, *, ...) -> None: ...
```

#### 5.1.5 IConfig 接口

```python
class IConfigStore(Protocol):
    @abstractmethod
    def get_paths(self) -> Any: ...
    @abstractmethod
    def get_summarization_config(self) -> Any: ...
    @abstractmethod
    def get_compaction_settings(self) -> Any: ...
    @abstractmethod
    def get_app_config(self) -> Any: ...
    @abstractmethod
    def get_agent_orchestration_config(self) -> Any: ...
```

#### 5.1.6 接口设计决策

| 决策 | 选项 A | 选项 B | 选择 | 理由 |
|------|--------|--------|------|------|
| 接口类型 | Protocol | ABC | **Protocol** | 结构化子类型，无需显式继承，更灵活 |
| 接口数量 | 6 个（Collab×3, Persistence×3, Config, Model, Debug） | 更多细粒度接口 | **按功能域分组** | 避免过细导致组装复杂 |
| 异步接口 | `async def` | 同步 + ThreadPool | **异步** | 持久化/DB 操作天然异步 |
| 配置注入 | `__init__` 参数 | 属性赋值 | **构造函数** | 不可变性，测试友好 |

### 5.2 AgentProfile 数据模型

```python
# evoflow/registry/agent_profile.py
from __future__ import annotations
from dataclasses import dataclass, field
from typing import Any

@dataclass(frozen=True)
class MiddlewareRef:
    """Middleware 引用"""
    name: str                    # 注册名，如 "sandbox"
    config: dict[str, Any] = field(default_factory=dict)  # 配置参数

@dataclass(frozen=True)
class ToolRef:
    """工具引用"""
    name: str                    # 注册名，如 "file_read"
    config: dict[str, Any] = field(default_factory=dict)

@dataclass(frozen=True)
class StateSchema:
    """State Schema 引用"""
    base: str = "thread"         # 基础 schema: "thread" / "minimal"
    extra_keys: list[str] = field(default_factory=list)  # 额外 key

@dataclass(frozen=True)
class AgentProfile:
    """Agent 声明式配置"""
    name: str                    # 唯一标识，如 "code-reviewer"
    display_name: str            # 显示名

    # 模型
    model_name: str = "gpt-5.5"  # 模型标识
    model_config: dict[str, Any] = field(default_factory=dict)

    # Middleware 链（声明式，按顺序）
    middleware_chain: list[MiddlewareRef] = field(default_factory=list)

    # 工具列表
    tools: list[ToolRef] = field(default_factory=list)

    # 系统提示
    system_prompt: str = ""
    system_prompt_template: str = ""  # 可选，从模板加载

    # 状态 Schema
    state_schema: StateSchema = field(default_factory=StateSchema)

    # 运行时约束
    recursion_limit: int = 100
    timeout_seconds: int = 3600

    # 元数据
    tags: list[str] = field(default_factory=list)       # 标签，如 ["coding", "core"]
    version: str = "1.0.0"
    description: str = ""

    # 场景策略（可选）
    scenario_keys: list[str] = field(default_factory=list)
    auto_activate_scenarios: bool = True

    # 扩展点
    extra: dict[str, Any] = field(default_factory=dict)
```

### 5.3 AgentRegistry 核心类

```python
# evoflow/registry/registry.py
from __future__ import annotations
from typing import Any, ClassVar

from langgraph.graph.state import CompiledStateGraph

from evoflow.registry.agent_profile import AgentProfile
from evoflow.capabilities.registry import CapabilityRegistry


class AgentRegistry:
    """Agent 注册中心"""

    def __init__(self, capabilities: CapabilityRegistry | None = None):
        self.capabilities = capabilities or CapabilityRegistry.instance()

        # Plugin 注册表
        self._middleware_plugins: dict[str, type] = {}
        self._tool_plugins: dict[str, Any] = {}
        self._state_schemas: dict[str, Any] = {}
        self._model_factories: dict[str, Any] = {}

        # Profile 注册表
        self._profiles: dict[str, AgentProfile] = {}
        self._profiles_by_tag: dict[str, list[str]] = {}

        # Middleware 链模板缓存
        self._middleware_template_cache: MiddlewareTemplateCache | None = None

        # 注册内置插件
        self._register_builtins()

    def _register_builtins(self) -> None:
        """注册所有内置 middleware、工具、schema"""
        from evoflow.agents.middlewares.sandbox.thread_data import ThreadDataMiddleware
        from evoflow.agents.middlewares.sandbox.uploads import UploadsMiddleware
        from evoflow.agents.middlewares.sandbox.sandbox import SandboxMiddleware
        from evoflow.agents.middlewares.workflow.plan_guard_core import PlanGuardMiddleware
        # ... 注册所有内置 middleware

        self.register_middleware("sandbox_thread", ThreadDataMiddleware)
        self.register_middleware("sandbox_uploads", UploadsMiddleware)
        self.register_middleware("sandbox", SandboxMiddleware)
        self.register_middleware("plan_guard", PlanGuardMiddleware)

    # ---- 注册 API ----

    def register_middleware(self, name: str, middleware_cls: type) -> None:
        self._middleware_plugins[name] = middleware_cls

    def register_tool(self, name: str, tool: Any) -> None:
        self._tool_plugins[name] = tool

    def register_state_schema(self, name: str, schema: Any) -> None:
        self._state_schemas[name] = schema

    def register_model_factory(self, name: str, factory: Any) -> None:
        self._model_factories[name] = factory

    def register_profile(self, profile: AgentProfile) -> None:
        self._profiles[profile.name] = profile
        for tag in profile.tags:
            self._profiles_by_tag.setdefault(tag, []).append(profile.name)

    # ---- 查询 API ----

    def get_profile(self, name: str) -> AgentProfile:
        return self._profiles[name]

    def list_profiles(self, tag: str | None = None) -> list[str]:
        if tag:
            return list(self._profiles_by_tag.get(tag, []))
        return list(self._profiles.keys())

    # ---- 实例化 API ----

    def deploy(self, profile: AgentProfile | str) -> CompiledStateGraph:
        """从 Profile 部署一个可执行的 Agent Graph"""
        if isinstance(profile, str):
            profile = self._profiles[profile]

        # 1. 创建/获取模型
        model = self._model_factories.get(profile.model_name)
        model = model(**profile.model_config) if model else None

        # 2. 构建 Middleware 链
        middleware_chain = []
        for mw_ref in profile.middleware_chain:
            cls = self._middleware_plugins[mw_ref.name]
            mw_instance = cls(**mw_ref.config)
            middleware_chain.append(mw_instance)

        # 3. 构建 Tools 列表
        tools = []
        for tool_ref in profile.tools:
            tool = self._tool_plugins[tool_ref.name]
            if tool_ref.config:
                tool = tool.with_config(tool_ref.config) if hasattr(tool, "with_config") else tool
            tools.append(tool)

        # 4. 获取 State Schema
        schema_name = profile.state_schema.base
        state_schema = self._state_schemas.get(schema_name)
        if profile.state_schema.extra_keys:
            state_schema = self._extend_state_schema(
                state_schema, profile.state_schema.extra_keys
            )

        # 5. 解析 System Prompt
        system_prompt = profile.system_prompt
        if profile.system_prompt_template:
            system_prompt = self._render_prompt_template(
                profile.system_prompt_template, profile.extra
            )

        # 6. 调用 LangGraph create_agent
        from langchain.agents import create_agent
        return create_agent(
            model=model,
            tools=tools or None,
            middleware=middleware_chain,
            system_prompt=system_prompt or None,
            state_schema=state_schema,
            name=profile.name,
        )

    def _extend_state_schema(self, base_schema, extra_keys):
        """动态扩展 State Schema"""
        ...

    def _render_prompt_template(self, template, context):
        """渲染 Prompt 模板"""
        ...
```

---

## 六、兼容性迁移策略

### 6.1 迁移路线图

```
时间线:  第1周   第2周   第3周   第4周   第5周   第6周   第7周   第8周   第9周   第10周
        ┌─────┬─────┬─────┬─────┬─────┬─────┬─────┬─────┬─────┬─────┐
Phase1: │ 拆分单体文件 ████████████████
Phase2:         │ 定义接口 ██████████████
Phase2:                     │ 改造核心 middleware ████████████████
Phase3:                             │ 注册中心 ████████████████
Phase3:                                         │ 向后兼容层 ██████
Phase4:                                                     │ Runtime 分离 ████████████████████
```

### 6.2 向后兼容保障

#### 6.2.1 API 兼容层

```python
# evoflow/agents/__init__.py (保持不变)
"""向后兼容：所有现有导入路径保持可用"""

from .factory import create_evoflow_agent        # 原有 API
from .features import RuntimeFeatures, Next, Prev # 原有 API
from .thread_state import SandboxState, ThreadState # 原有 API
from .checkpointer import get_checkpointer        # 原有 API
from .claude_code_chat_graph import make_claude_code_chat_graph
from .lead_agent import make_lead_agent           # 原有 API

# 新增（不影响现有导入）
from .registry import AgentRegistry, AgentProfile

__all__ = [
    "create_evoflow_agent",
    "RuntimeFeatures", "Next", "Prev",
    "make_claude_code_chat_graph",
    "make_lead_agent",
    "SandboxState", "ThreadState",
    "get_checkpointer", "reset_checkpointer", "make_checkpointer",
    # 新增
    "AgentRegistry", "AgentProfile",
]
```

#### 6.2.2 过渡期双模式

```python
# Phase 1-2：所有中间修改保持类名和导入路径不变
# plan_guard_middleware.py 内部 delegate：
class PlanGuardMiddleware:
    """向后兼容：内部委托给新模块"""
    def __init__(self, *args, **kwargs):
        from evoflow.agents.middlewares.workflow.plan_guard_core import PlanGuardCoreMiddleware
        self._core = PlanGuardCoreMiddleware(*args, **kwargs)

    async def invoke(self, *args, **kwargs):
        return await self._core.invoke(*args, **kwargs)

# Phase 3+：新代码使用 AgentRegistry
# 旧代码无需修改，继续使用 create_evoflow_agent()
```

#### 6.2.3 渐进式 middleware 改造优先级

| 优先级 | 文件 | 行数 | 改造方式 |
|--------|------|------|----------|
| 1 | `loop_detection_middleware` | 444 | Phase 1 拆分 + Phase 2 注入 |
| 2 | `dangling_tool_call_middleware` | 114 | Phase 2 直接注入（文件小） |
| 3 | `tool_error_handling` | 544 | Phase 1 拆分 + Phase 2 注入 |
| 4 | `clarification_middleware` | 430 | Phase 1 拆分 + Phase 2 注入 |
| 5 | `plan_guard_middleware` | 1564 | Phase 1 拆分 + Phase 2 注入 |
| 6 | `transcript_middleware` | 463 | Phase 1 拆分 + Phase 2 注入 |
| 7 | 其余 50+ 文件 | < 300 | 按优先级逐步改造 |

---

## 七、风险与缓解

### 7.1 风险矩阵

| 风险 | 概率 | 影响 | 缓解措施 |
|------|------|------|----------|
| 拆分后回归 bug | 高 | 中 | 每个拆分文件保留旧类作为 delegate；全量回归测试 |
| Capability 接口设计不完整 | 中 | 高 | Phase 1 期间收集所有 middleware 的 import 依赖，一次性定义完整接口 |
| 性能退化 | 中 | 中 | 每个 Phase 结束做性能基准测试；模板缓存 |
| 团队学习成本 | 中 | 中 | 编写迁移指南；先改造 2-3 个 middleware 作为样板 |
| 向后兼容层维护负担 | 低 | 低 | 设定弃用期限，Phase 4 完成后移除兼容层 |
| 中间件链顺序变更导致行为不一致 | 中 | 高 | 维护 `middleware_order.md` 文档；集成测试验证链顺序 |

### 7.2 关键决策记录

| 决策 | 选项 A | 选项 B | 选择 | 理由 |
|------|--------|--------|------|------|
| 接口类型 | Protocol | ABC | **Protocol** | 无需显式继承，duck typing |
| 依赖注入方式 | 构造函数 | 属性赋值 | **构造函数** | 不可变性，测试友好 |
| 状态分区 | 嵌套 dataclass | 扁平 + 命名空间 | **嵌套 dataclass** | 类型安全，IDE 提示 |
| Profile 格式 | YAML | JSON/YAML 都支持 | **两者都支持** | YAML 人工编辑，JSON 程序生成 |
| 模板缓存 | lru_cache | 独立 Cache 类 | **独立类** | 可控 TTL、手动清除 |
| 热加载方式 | 文件系统 watch | HTTP webhook | **文件系统 watch** | 简单可靠 |

---

## 八、验证指标

### 8.1 代码质量指标

| 指标 | 当前值 | 目标值 | 测量方式 |
|------|--------|--------|----------|
| 最大单文件行数 | 1564 | ≤ 300 | `wc -l *.py` |
| 单个文件跨模块 import 数 | 47 | ≤ 5 | `rg "from evoflow\." | grep -v "当前模块"` |
| middleware 内部循环依赖 | 高 | 无 | `pytest --test-middleware-no-circular-deps` |
| 公共接口数 | ~0 | 6 个 Capability 接口 | `evoflow/capabilities/*.pyi` |
| 测试覆盖率（middleware） | ~50% | ≥ 80% | `pytest-cov` |

### 8.2 性能指标

| 指标 | 当前值 | 目标值 | 测量方式 |
|------|--------|--------|----------|
| Agent 实例化时间 | ~50ms | < 100ms | 1000 个 Agent 总时间 < 1s |
| Middleware 链构建时间 | ~10ms | < 20ms | `timeit` 测量 |
| Memory 使用（1000 Agent） | N/A | < 1GB | `tracemalloc` |
| 依赖注入 overhead | N/A | < 1% | `pytest-benchmark` |

### 8.3 可扩展性指标

| 指标 | 目标 | 测量方式 |
|------|------|----------|
| 注册 Agent Profile 数量 | ≥ 10000 | 性能测试 |
| Profile 热加载时间 | < 100ms/个 | `timeit` |
| 新增 Agent 类型所需代码行 | < 20 行 | 仅新增 Profile 注册 |
| 修改核心代码需求 | 零 | 审计 git diff |

---

## 附录 A：现有文件清单与拆分映射

| 原文件 | 原行数 | 拆分目标 | 拆分后行数(预估) |
|--------|--------|----------|-----------------|
| `plan_guard_middleware.py` | 1564 | plan_guard_core/auth/snapshot/prompts/types | 200/200/150/100/75 |
| `context_compaction_core.py` | 1145 | compaction_core/strategies/prompts/models/utils | 300/300/200/200/145 |
| `clarification_middleware.py` | 430 | clarification_core/questions/prompts | 200/150/80 |
| `tool_error_handling_middleware.py` | 544 | error_handling_core/strategies/prompts | 200/250/94 |
| `transcript_middleware.py` | 463 | transcript_core/persist/accumulator | 180/200/83 |
| `collab_phase_middleware.py` | 548 | phase_core/auth/prompts/types | 250/150/148 |
| `dynamic_system_prompt_middleware.py` | 395 | dynamic_core/prompts/render | 150/150/95 |
| `scenario_runtime_hint_middleware.py` | 372 | hint_core/prompts | 200/172 |
| `ui_messages_snapshot_middleware.py` | 340 | snapshot_core | 340 (保持单文件) |
| `tool_approval_middleware.py` | 316 | approval_core/config/prompts | 158/185/73 |
| `deferred_tool_filter_middleware.py` | 293 | filter_core/prompts | 150/143 |
| `session_transcript_hydration_middleware.py` | 211 | hydration_core/prompts | 120/91 |
| `view_image_middleware.py` | 229 | view_image_core/prompts | 130/99 |
| `invalid_tool_call_middleware.py` | 213 | invalid_core/prompts | 120/93 |
| `tool_history_ager_middleware.py` | 202 | ager_core/prompts | 120/82 |
| `todo_middleware.py` | 207 | todo_core/prompts | 120/87 |
| `title_middleware.py` | 257 | title_core/prompts | 150/107 |

---

## 附录 B：Middleware 链顺序参考

```
固定链顺序（不可更改）:

[0]  ThreadDataMiddleware          # 线程数据初始化
[1]  UploadsMiddleware             # 上传处理
[2]  SandboxMiddleware             # 沙箱环境
[3]  DanglingToolCallMiddleware    # 悬挂工具调用（总是）
[4]  GuardrailMiddleware           # 安全护栏（自定义实例）
[5]  ToolErrorHandlingMiddleware   # 工具错误处理（总是）
[6]  SummarizationMiddleware       # 上下文摘要（自定义实例）
[7]  TodoMiddleware                # 任务追踪（plan_mode 开启时）
[8]  TitleMiddleware               # 自动标题
[9]  MemoryMiddleware              # 记忆更新
[10] ViewImageMiddleware           # 图片查看
[11] SubagentLimitMiddleware       # 子代理限制
[12] LoopDetectionMiddleware       # 环路检测（总是）
[12.5] AutomationRunGuardMiddleware # 自动化运行保护
[13]  ClarificationMiddleware       # 澄清拦截（永远最后）
```

---

## 附录 C：依赖关系矩阵

```
Middleware 依赖的 Capability（改造后）:

Middleware                    ICollab  IPersist  IConfig  IDebug  IModel
───────────────────────────── ─────── ──────── ─────── ─────── ──────
ThreadData                    ✗       ✗        ✗       ✗       ✗
Uploads                       ✗       ✗        ✗       ✗       ✗
Sandbox                       ✗       ✗        ✗       ✗       ✗
DanglingToolCall              ✗       ✗        ✗       ✗       ✗
PlanGuard                     ✓       ✓        ✓       ✓       ✗
ToolErrorHandling             ✗       ✓        ✓       ✗       ✗
Summarization                 ✗       ✗        ✓       ✗       ✓
Todo                          ✗       ✗        ✗       ✗       ✗
Title                         ✗       ✓        ✗       ✗       ✗
Memory                        ✗       ✓        ✗       ✗       ✗
ViewImage                     ✗       ✗        ✗       ✗       ✓
SubagentLimit                 ✗       ✗        ✗       ✗       ✗
LoopDetection                 ✗       ✗        ✗       ✗       ✗
Clarification                 ✗       ✗        ✗       ✗       ✗
Transcript                    ✗       ✓        ✗       ✓       ✗
ToolApproval                  ✗       ✓        ✓       ✗       ✗
ContextCompaction             ✗       ✗        ✓       ✗       ✓
MissionState                  ✗       ✓        ✓       ✗       ✗
CollabPhase                   ✓       ✓        ✓       ✗       ✗
DynamicSystemPrompt           ✗       ✓        ✓       ✓       ✓
ScenarioRuntimeHint           ✗       ✗        ✓       ✗       ✗
```
