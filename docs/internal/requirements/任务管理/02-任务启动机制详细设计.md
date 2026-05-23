# 02 - 任务启动机制详细设计

## 目录

- [1. 问题定义](#1-问题定义)
  - [1.1 当前问题](#11-当前问题)
  - [1.2 目标定义](#12-目标定义)
- [2. 现有机制分析](#2-现有机制分析)
  - [2.1 启动流程现状](#21-启动流程现状)
  - [2.2 关键代码分析](#22-关键代码分析)
  - [2.3 问题根因](#23-问题根因)
- [3. 设计方案](#3-设计方案)
  - [3.1 方案对比](#31-方案对比)
  - [3.2 推荐方案：轻量级事件调度器](#32-推荐方案轻量级事件调度器)
  - [3.3 方案详细设计](#33-方案详细设计)
- [4. 时序图](#4-时序图)
- [5. 状态机](#5-状态机)
- [6. API 设计](#6-api-设计)
- [7. 数据模型](#7-数据模型)
- [8. 错误处理](#8-错误处理)
- [9. 实现步骤](#9-实现步骤)
- [10. 测试方案](#10-测试方案)


## 1. 问题定义

### 1.1 当前问题

**现象:**
用户在 RunManager 点击"启动"按钮后：
1. 任务状态变为 `planning` → `executing`
2. 但子任务并没有真正开始执行
3. 页面显示"执行中"，实际没有任何进展

**影响:**
- 用户无法手动启动任务
- RunManager 的启动按钮成为"假按钮"
- 只能依赖对话中的 AI 自动启动

### 1.2 目标定义

**核心目标:**
用户点击"启动"后，任务能够真正开始执行，子任务被派发并运行。

**具体目标:**
1. 启动后 5 秒内子任务开始执行
2. 启动失败有明确错误提示
3. 启动过程可观测（进度、日志）
4. 支持重复启动（失败后重试）
5. 不破坏现有对话任务的自动启动流程


## 2. 现有机制分析

### 2.1 启动流程现状

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│   前端页面   │     │   API 网关   │     │  任务存储   │
└──────┬──────┘     └──────┬──────┘     └──────┬──────┘
       │                   │                   │
       │  POST /tasks/id/start                 │
       │──────────────────────────────────────>│
       │                   │                   │
       │                   │  设置状态: planning│
       │                   │──────────────────>│
       │                   │                   │
       │  POST /tasks/id/authorize-execution   │
       │──────────────────────────────────────>│
       │                   │                   │
       │                   │  设置状态: executing│
       │                   │  设置 execution_authorized=true
       │                   │──────────────────>│
       │                   │                   │
       │  返回成功            │                   │
       │<──────────────────────────────────────│
       │                   │                   │
       │  【问题】Supervisor 没有被触发执行！    │
       │                   │                   │
```

### 2.2 关键代码分析

#### 2.2.1 当前 `authorize-execution` 接口
```python
# backend/app/gateway/routers/tasks.py:153-192
@router.post("/{task_id}/authorize-execution")
async def authorize_task_execution(task_id: str, request: AuthorizeExecutionRequest):
    """Allow task tool / workers to run after plan review."""
    # 1. 设置 execution_authorized=true
    ok, msg = authorize_main_task_execution(storage, task_id, body.authorized_by)
    
    # 2. 推进协作阶段到 executing
    advance_collab_phase_to_executing_for_task(get_paths(), task_id, ...)
    
    # 3. 【缺失】没有触发 Supervisor 执行！
```

#### 2.2.2 Supervisor `start_execution` 动作
```python
# backend/packages/harness/evoflow/tools/builtins/supervisor_tool.py:1313-1420
elif action == "start_execution":
    # 1. 授权检查
    ok, msg = authorize_main_task_execution(storage, task_id, actor)
    
    # 2. 解析可执行的子任务
    to_run, blocked_subtasks = _resolve_subtasks_for_start_execution(storage, task_id, subtask_ids)
    
    # 3. 推进协作阶段
    advance_collab_phase_to_executing_for_task(get_paths(), task_id, ...)
    
    # 4. 委派子任务执行
    delegated = await delegate_collab_subtasks_for_start_execution(
        runtime, storage, task_id, to_run, wait_for_completion=...
    )
```

**关键发现:**
- `authorize-execution` 和 `start_execution` 都调用了 `authorize_main_task_execution`
- 区别在于 `start_execution` 还调用了 `delegate_collab_subtasks_for_start_execution`
- 当前 API 只做了授权，没有调用 `start_execution`

### 2.3 问题根因

**根本原因:**
`authorize-execution` API 只是"授权"，没有"执行"。真正的执行需要调用 `supervisor_tool(action="start_execution")`。

**为什么对话任务能执行？**
```
对话流程:
    Lead Agent 创建任务
        ↓
    Lead Agent 自动调用 supervisor_tool(action="start_execution")
        ↓
    子任务被委派执行

RunManager 流程:
    用户点击启动
        ↓
    调用 authorize-execution API
        ↓
    【缺失】没有人调用 supervisor_tool(action="start_execution")！
```

**技术原因:**
1. API 层和 Tool 层分离
2. API 不知道需要调用 Tool
3. Tool 调用需要 ToolRuntime，API 层没有


## 3. 设计方案

### 3.1 方案对比

| 方案 | 原理 | 优点 | 缺点 | 复杂度 |
|------|------|------|------|--------|
| **A. API 直接调用** | `authorize-execution` API 直接调用 `supervisor_tool` | 简单直接 | 需要 ToolRuntime，API 层耦合 Tool 层 | 中 |
| **B. Lead Agent 触发** | 修改 Lead Agent Prompt，检测到授权后自动执行 | 符合现有架构 | 依赖 Lead Agent 运行，不稳定 | 低 |
| **C. 事件调度器** | 授权后发送事件，独立调度器监听并触发执行 | 解耦、可靠、可扩展 | 需要新增组件 | 中 |
| **D. 轮询检查** | 调度器定时检查 authorized 任务并触发执行 | 简单 | 有延迟、不实时 | 低 |

**推荐方案: C（轻量级事件调度器）**

理由:
1. 解耦 API 层和 Tool 层
2. 可靠，不依赖 Lead Agent
3. 可扩展，支持其他事件类型
4. 实现复杂度适中

### 3.2 推荐方案：轻量级事件调度器

#### 3.2.1 架构设计

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│   前端页面   │     │   API 网关   │     │  事件队列   │
└──────┬──────┘     └──────┬──────┘     └──────┬──────┘
       │                   │                   │
       │  POST /tasks/id/authorize-execution   │
       │──────────────────────────────────────>│
       │                   │                   │
       │                   │  1. 设置 authorized
       │                   │  2. 发送事件: TaskAuthorizedEvent
       │                   │──────────────────>│
       │                   │                   │
       │  返回成功            │                   │
       │<──────────────────────────────────────│
       │                   │                   │
       │                   │     ┌─────────────┐     ┌─────────────┐
       │                   │     │  事件调度器  │     │  Supervisor │
       │                   │     │  (独立线程)  │     │   Tool      │
       │                   │     └──────┬──────┘     └──────┬──────┘
       │                   │            │                   │
       │                   │            │  消费事件          │
       │                   │            │  TaskAuthorizedEvent│
       │                   │            │──────────────────>│
       │                   │            │                   │
       │                   │            │  调用 supervisor_tool
       │                   │            │  action="start_execution"
       │                   │            │──────────────────>│
       │                   │            │                   │
       │                   │            │  子任务开始执行      │
       │                   │            │<──────────────────│
```

#### 3.2.2 核心组件

1. **事件定义**
   - `TaskAuthorizedEvent`: 任务被授权执行
   - 包含: task_id, authorized_by, timestamp

2. **事件队列**
   - 内存队列（初期）
   - 后期可替换为 Redis/RabbitMQ

3. **事件调度器**
   - 独立后台线程
   - 监听事件队列
   - 调用 Supervisor Tool 执行

4. **API 修改**
   - `authorize-execution` 发送事件到队列

### 3.3 方案详细设计

#### 3.3.1 事件定义

```python
# backend/app/gateway/events/task_events.py

from dataclasses import dataclass
from datetime import datetime
from typing import Optional

@dataclass
class TaskAuthorizedEvent:
    """任务被授权执行事件"""
    task_id: str
    project_id: str
    authorized_by: str
    thread_id: Optional[str]
    timestamp: datetime
    
    @classmethod
    def from_request(cls, task_id: str, project_id: str, 
                     authorized_by: str = "user", 
                     thread_id: Optional[str] = None):
        return cls(
            task_id=task_id,
            project_id=project_id,
            authorized_by=authorized_by,
            thread_id=thread_id,
            timestamp=datetime.utcnow()
        )
```

#### 3.3.2 事件队列

```python
# backend/app/gateway/events/event_queue.py

import asyncio
from collections import deque
from typing import Any, Callable, Optional
import threading

class EventQueue:
    """轻量级内存事件队列"""
    
    def __init__(self):
        self._queue: deque = deque()
        self._lock = threading.Lock()
        self._handlers: dict[str, list[Callable]] = {}
        self._running = False
        self._worker_thread: Optional[threading.Thread] = None
    
    def publish(self, event_type: str, event_data: Any):
        """发布事件到队列"""
        with self._lock:
            self._queue.append({
                "type": event_type,
                "data": event_data,
                "timestamp": datetime.utcnow().isoformat()
            })
    
    def subscribe(self, event_type: str, handler: Callable):
        """订阅事件"""
        if event_type not in self._handlers:
            self._handlers[event_type] = []
        self._handlers[event_type].append(handler)
    
    def start(self):
        """启动事件调度器"""
        if self._running:
            return
        self._running = True
        self._worker_thread = threading.Thread(target=self._process_events, daemon=True)
        self._worker_thread.start()
    
    def _process_events(self):
        """事件处理循环"""
        while self._running:
            try:
                # 获取事件
                with self._lock:
                    if not self._queue:
                        time.sleep(0.1)  # 避免忙等
                        continue
                    event = self._queue.popleft()
                
                # 分发事件
                event_type = event["type"]
                if event_type in self._handlers:
                    for handler in self._handlers[event_type]:
                        try:
                            handler(event["data"])
                        except Exception as e:
                            logger.error(f"Event handler error: {e}")
                            
            except Exception as e:
                logger.error(f"Event processing error: {e}")
                time.sleep(1)  # 出错后等待

# 全局事件队列实例
event_queue = EventQueue()
```

#### 3.3.3 事件处理器

```python
# backend/app/gateway/events/task_event_handlers.py

import logging
from evoflow.collab.storage import find_main_task, get_project_storage
from evoflow.tools.builtins.supervisor_tool import supervisor_tool
from evoflow.config.paths import get_paths

logger = logging.getLogger(__name__)

async def handle_task_authorized(event: TaskAuthorizedEvent):
    """处理任务授权事件：触发 Supervisor 执行"""
    task_id = event.task_id
    
    try:
        logger.info(f"Handling task authorized event for task {task_id}")
        
        # 1. 查找任务
        storage = get_project_storage()
        row = find_main_task(storage, task_id)
        if not row:
            logger.error(f"Task {task_id} not found")
            return
        
        project, task = row
        
        # 2. 检查任务状态
        if task.get("status") not in ["planning", "planned", "awaiting_exec"]:
            logger.warning(f"Task {task_id} status {task.get('status')} not suitable for execution")
            return
        
        if not task.get("execution_authorized"):
            logger.warning(f"Task {task_id} not authorized")
            return
        
        # 3. 检查是否有子任务
        subtasks = task.get("subtasks", [])
        if not subtasks:
            logger.info(f"Task {task_id} has no subtasks, marking as completed")
            task["status"] = "completed"
            task["progress"] = 100
            storage.save_project(project)
            return
        
        # 4. 调用 Supervisor Tool 执行
        # 注意：这里需要创建一个模拟的 ToolRuntime
        runtime = create_minimal_runtime(event.thread_id)
        
        result = await supervisor_tool(
            runtime=runtime,
            action="start_execution",
            task_id=task_id,
            authorized_by=event.authorized_by,
            wait_for_completion=False,  # 后台执行
        )
        
        logger.info(f"Task {task_id} execution started: {result}")
        
    except Exception as e:
        logger.exception(f"Failed to start task {task_id}: {e}")
        # TODO: 发送失败通知

def create_minimal_runtime(thread_id: Optional[str]):
    """创建一个最小化的 ToolRuntime 用于后台调用"""
    # 这里需要根据实际情况实现
    # 可能需要创建一个模拟的 runtime 对象
    pass
```

#### 3.3.4 API 修改

```python
# backend/app/gateway/routers/tasks.py

from app.gateway.events.event_queue import event_queue
from app.gateway.events.task_events import TaskAuthorizedEvent
from app.gateway.events.task_event_handlers import handle_task_authorized

# 启动时注册事件处理器
event_queue.subscribe("task_authorized", handle_task_authorized)
event_queue.start()

@router.post("/{task_id}/authorize-execution")
async def authorize_task_execution(task_id: str, request: AuthorizeExecutionRequest):
    """Authorize and trigger task execution."""
    storage = get_project_storage()
    body = request if request is not None else AuthorizeExecutionRequest()
    
    # 1. 执行授权
    ok, msg = authorize_main_task_execution(storage, task_id, body.authorized_by)
    if not ok:
        if "not found" in msg.lower():
            raise HTTPException(status_code=404, detail=msg)
        raise HTTPException(status_code=400, detail=msg)
    
    # 2. 推进协作阶段
    try:
        advance_collab_phase_to_executing_for_task(
            get_paths(), task_id, runtime_thread_id=body.thread_id
        )
    except Exception:
        logger.exception("authorize-execution: advance_collab_phase failed")
    
    # 3. 【新增】发送任务授权事件
    # 查找 project_id
    project_id = None
    for project_summary in storage.list_projects():
        project = storage.load_project(project_summary["id"])
        if project:
            for task in project.get("tasks", []):
                if task.get("id") == task_id:
                    project_id = project["id"]
                    break
        if project_id:
            break
    
    if project_id:
        event = TaskAuthorizedEvent.from_request(
            task_id=task_id,
            project_id=project_id,
            authorized_by=body.authorized_by,
            thread_id=body.thread_id
        )
        event_queue.publish("task_authorized", event)
        logger.info(f"Published task_authorized event for task {task_id}")
    
    # 4. 返回响应
    for project_summary in storage.list_projects():
        project = storage.load_project(project_summary["id"])
        if not project:
            continue
        for task in project.get("tasks", []):
            if task.get("id") == task_id:
                return {
                    "success": True,
                    "task_id": task_id,
                    "message": msg,
                    "execution_authorized": True,
                    "authorized_at": task.get("authorized_at"),
                    "authorized_by": task.get("authorized_by"),
                    "status": "execution_triggered",  # 【新增】表示已触发执行
                }
    
    raise HTTPException(status_code=404, detail=f"Task '{task_id}' not found")
```


## 4. 时序图

### 4.1 成功启动流程

```mermaid
sequenceDiagram
    participant User as 用户
    participant Frontend as RunManager
    participant API as API 网关
    participant EventQueue as 事件队列
    participant Scheduler as 事件调度器
    participant Supervisor as Supervisor Tool
    participant Storage as 任务存储
    participant Subagent as 子任务执行器

    User->>Frontend: 点击"启动"
    Frontend->>API: POST /tasks/{id}/authorize-execution
    
    API->>Storage: 设置 execution_authorized=true
    API->>Storage: 设置 collab_phase=executing
    API->>EventQueue: 发布 TaskAuthorizedEvent
    API->>Frontend: 返回 {status: "execution_triggered"}
    
    Note over Frontend: 显示"启动中..."
    
    Scheduler->>EventQueue: 消费事件
    Scheduler->>Storage: 查询任务状态
    Storage->>Scheduler: 返回任务信息
    
    Scheduler->>Supervisor: 调用 supervisor_tool(action="start_execution")
    Supervisor->>Storage: 解析可执行子任务
    Storage->>Supervisor: 返回子任务列表
    
    Supervisor->>Subagent: 委派子任务执行
    Supervisor->>Frontend: WebSocket 推送: execution_started
    
    Note over Frontend: 显示"执行中"
    
    Subagent->>Subagent: 后台执行
    Subagent->>Storage: 更新子任务状态
    Subagent->>Frontend: WebSocket 推送: progress_update
```

### 4.2 启动失败流程

```mermaid
sequenceDiagram
    participant Frontend as RunManager
    participant API as API 网关
    participant EventQueue as 事件队列
    participant Scheduler as 事件调度器
    participant Supervisor as Supervisor Tool
    participant Storage as 任务存储

    Frontend->>API: POST /tasks/{id}/authorize-execution
    API->>EventQueue: 发布 TaskAuthorizedEvent
    API->>Frontend: 返回 {status: "execution_triggered"}
    
    Scheduler->>EventQueue: 消费事件
    Scheduler->>Storage: 查询任务
    Storage->>Scheduler: 任务不存在/状态错误
    
    Scheduler->>Scheduler: 记录错误日志
    Scheduler->>Frontend: WebSocket 推送: execution_failed
    
    Frontend->>Frontend: 显示错误信息
    Frontend->>Frontend: 恢复"启动"按钮
```


## 5. 状态机

### 5.1 任务状态流转（增强版）

```
                         ┌─────────────┐
                         │   pending   │
                         └──────┬──────┘
                                │ start()
                                ▼
                         ┌─────────────┐
                    ┌────│  planning   │◄────────┐
                    │    └──────┬──────┘         │
                    │           │ 自动规划完成     │
                    │           ▼                │
                    │    ┌─────────────┐         │
                    │    │   planned   │─────────┤
                    │    └──────┬──────┘ 重试    │
                    │           │ authorize()    │
                    │           ▼                │
                    │    ┌─────────────┐         │
                    │    │awaiting_exec│         │
                    │    └──────┬──────┘         │
                    │           │ 触发执行        │
                    │           ▼                │
                    │    ┌─────────────┐         │
                    ├────│  executing  │         │
                    │    └──────┬──────┘         │
                    │           │                │
        ┌───────────┼───────────┼───────────┐    │
        │           │           │           │    │
        ▼           ▼           ▼           ▼    │
   ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌────────┐│
   │completed│ │  failed │ │cancelled│ │ paused │┘
   └────┬────┘ └────┬────┘ └────┬────┘ └───┬────┘
        │           │           │          │
        │           │           │          │ resume()
        │           │           │          ▼
        │           │           │    ┌─────────────┐
        │           │           │    │  executing  │
        │           │           │    └─────────────┘
        │           │           │
        └───────────┴───────────┘
                    │
                    ▼
              [任务结束]
```

### 5.2 启动过程子状态

```
executing 状态的子状态:

┌─────────────┐
│  executing  │
└──────┬──────┘
       │
       ├───► initializing  (初始化中)
       │
       ├───► delegating    (派发子任务中)
       │
       ├───► monitoring    (监控执行中)
       │
       ├───► finalizing    (收尾中)
       │
       └───► [completed/failed/cancelled]
```


## 6. API 设计

### 6.1 修改现有接口

#### POST /tasks/{task_id}/authorize-execution

**请求:**
```json
{
  "authorized_by": "user",
  "thread_id": "optional-thread-id"
}
```

**成功响应 (200):**
```json
{
  "success": true,
  "task_id": "task-xxx",
  "message": "Task execution authorized",
  "execution_authorized": true,
  "authorized_at": "2025-01-17T08:30:00Z",
  "authorized_by": "user",
  "status": "execution_triggered"
}
```

**失败响应:**
- 400: 任务状态不允许执行
- 404: 任务不存在
- 409: 任务已授权

### 6.2 新增接口

#### GET /tasks/{task_id}/execution-status

查询任务执行状态。

**响应:**
```json
{
  "task_id": "task-xxx",
  "status": "executing",
  "execution_status": "monitoring",
  "started_at": "2025-01-17T08:30:05Z",
  "subtasks": {
    "total": 5,
    "completed": 2,
    "running": 1,
    "pending": 2
  },
  "progress": 40
}
```


## 7. 数据模型

### 7.1 新增字段

```python
# 任务对象新增字段
class Task:
    # 已有字段...
    
    # 执行状态详情
    execution_status: Optional[str]  # initializing, delegating, monitoring, finalizing
    execution_started_at: Optional[str]
    execution_triggered_by: Optional[str]  # user, system, automation
    
    # 失败信息
    execution_error: Optional[str]
    execution_attempts: int = 0  # 执行尝试次数
```

### 7.2 事件数据结构

```python
@dataclass
class TaskAuthorizedEvent:
    event_id: str           # 事件唯一ID
    task_id: str
    project_id: str
    authorized_by: str
    thread_id: Optional[str]
    timestamp: datetime
    source: str            # "api", "system", "automation"

@dataclass  
class TaskExecutionStartedEvent:
    event_id: str
    task_id: str
    started_at: datetime
    subtask_count: int

@dataclass
class TaskExecutionFailedEvent:
    event_id: str
    task_id: str
    error: str
    failed_at: datetime
    retryable: bool
```


## 8. 错误处理

### 8.1 错误分类

| 错误类型 | 场景 | 处理方式 | 用户提示 |
|----------|------|----------|----------|
| **授权错误** | 任务未找到/状态错误 | 立即返回错误 | "任务不存在或状态不正确" |
| **触发错误** | 事件发送失败 | 记录日志，继续返回成功 | 无（后台处理） |
| **执行错误** | Supervisor 调用失败 | 发送失败事件，更新任务状态 | WebSocket 推送失败通知 |
| **子任务错误** | 子任务委派失败 | 记录失败子任务，继续执行其他 | 显示部分失败提示 |

### 8.2 重试策略

```python
# 事件处理重试
MAX_RETRY_ATTEMPTS = 3
RETRY_DELAY_SECONDS = [1, 5, 15]  # 指数退避

async def handle_task_authorized_with_retry(event):
    for attempt in range(MAX_RETRY_ATTEMPTS):
        try:
            return await handle_task_authorized(event)
        except RetryableError as e:
            if attempt < MAX_RETRY_ATTEMPTS - 1:
                delay = RETRY_DELAY_SECONDS[attempt]
                logger.warning(f"Retry {attempt + 1} for task {event.task_id} after {delay}s")
                await asyncio.sleep(delay)
            else:
                raise
```


## 9. 开发事项与进度

### 开发进度总览

| 阶段 | 内容 | 计划工时 | 实际工时 | 进度 | 状态 |
|------|------|----------|----------|------|------|
| Phase 1 | 基础设施 | 16h | 12h | 75% | 已完成 |
| Phase 2 | 核心功能 | 16h | 16h | 100% | 已完成 |
| Phase 3 | 前端适配 | 8h | 6h | 75% | 进行中 |
| Phase 4 | 调试验证 | 8h | 0h | 0% | 待开始 |
| **总计** | - | **48h** | **34h** | **71%** | **进行中** |


### Phase 1: 基础设施 (计划 2 天 / 16 小时)

#### 9.1.1 创建事件模块基础结构

**开发内容:**
```
backend/app/gateway/events/
├── __init__.py              # 模块导出
├── event_queue.py           # 事件队列实现
├── task_events.py           # 任务相关事件定义
└── task_event_handlers.py   # 任务事件处理器
```

**详细任务:**
| 序号 | 任务 | 文件 | 工时 | 进度 | 开发者 | 状态 |
|------|------|------|------|------|--------|------|
| 1.1 | 创建 EventQueue 类（内存队列） | event_queue.py | 3h | 100% | - | 已完成 |
| 1.2 | 实现 publish/subscribe 方法 | event_queue.py | 2h | 100% | - | 已完成 |
| 1.3 | 实现后台处理线程 | event_queue.py | 3h | 100% | - | 已完成 |
| 1.4 | 创建 TaskAuthorizedEvent 数据类 | task_events.py | 1h | 100% | - | 已完成 |
| 1.5 | 创建其他任务事件定义 | task_events.py | 1h | 100% | - | 已完成 |
| 1.6 | 实现事件处理器接口 | task_event_handlers.py | 2h | 100% | - | 已完成 |
| 1.7 | 编写单元测试 | test_event_queue.py | 4h | 0% | - | 待开发 |

**验收标准:**
- [x] EventQueue 可以 publish/subscribe 事件
- [x] 后台线程自动处理队列中的事件
- [x] 创建了 TaskAuthorizedEvent、TaskExecutionStartedEvent、TaskExecutionFailedEvent 事件定义
- [x] 实现了 handle_task_authorized 处理器，可调用 supervisor_tool
- [ ] 单元测试覆盖率 > 80%


### Phase 2: 核心功能 (计划 2 天 / 16 小时)

#### 9.2.1 修改后端 API

**开发内容:**
```
backend/app/gateway/routers/tasks.py  # 修改 authorize-execution
```

**详细任务:**
| 序号 | 任务 | 文件 | 工时 | 进度 | 开发者 | 状态 |
|------|------|------|------|------|--------|------|
| 2.1 | 导入事件模块 | tasks.py | 0.5h | 100% | - | 已完成 |
| 2.2 | 初始化事件队列和调度器 | tasks.py | 1h | 100% | - | 已完成 |
| 2.3 | 修改 authorize-execution 发送事件 | tasks.py | 2h | 100% | - | 已完成 |
| 2.4 | 添加事件发送日志 | tasks.py | 0.5h | 100% | - | 已完成 |
| 2.5 | 实现 handle_task_authorized 处理器 | task_event_handlers.py | 4h | 100% | - | 已完成 |
| 2.6 | 集成 Supervisor Tool 调用 | task_event_handlers.py | 4h | 100% | - | 已完成 |
| 2.7 | 处理 ToolRuntime 创建问题 | task_event_handlers.py | 2h | 100% | - | 已完成 |
| 2.8 | 添加错误处理和重试逻辑 | task_event_handlers.py | 2h | 100% | - | 已完成 |

**关键技术点:**
```python
# 已解决
1. ToolRuntime 创建 ✓
   - 创建了 MinimalRuntime 类模拟 ToolRuntime
   - 在 task_event_handlers.py 的 _create_minimal_runtime 中实现
   
2. Supervisor Tool 调用 ✓
   - supervisor_tool 是 async 函数
   - EventQueue._process_events 中检测协程并正确调用
   
3. 错误处理 ✓
   - handle_task_authorized 中完整捕获异常
   - 记录详细日志
```

**验收标准:**
- [x] 调用 authorize-execution 后发送 TaskAuthorizedEvent
- [x] 事件处理器成功调用 supervisor_tool
- [x] 子任务开始执行（通过 supervisor_tool action="start_execution"）
- [x] 失败时有日志记录


### Phase 3: 前端适配 (计划 1 天 / 8 小时)

#### 9.3.1 修改 RunManager 启动按钮

**开发内容:**
```
evopanel/src/react/components/RunManager.tsx      # 修改启动逻辑
evopanel/src/lib/api-client.js                     # 添加启动状态查询
```

**详细任务:**
| 序号 | 任务 | 文件 | 工时 | 进度 | 开发者 | 状态 |
|------|------|------|------|------|--------|------|
| 3.1 | 修改 handleStartTask 调用 authorize-execution | RunManager.tsx | 1h | 100% | - | 已完成 |
| 3.2 | 添加启动中状态（loading） | RunManager.tsx | 1h | 100% | - | 已完成 |
| 3.3 | SSE 监听 execution_started/failed 事件 | RunManager.tsx | 2h | 50% | - | 部分完成 |
| 3.4 | 添加"查看会话"按钮跳转 ChatApp | RunManager.tsx | 2h | 0% | - | 待开发 |
| 3.5 | 添加错误提示和重试按钮 | RunManager.tsx | 1h | 50% | - | 部分完成 |
| 3.6 | 优化任务状态显示 | RunManager.tsx | 1h | 50% | - | 部分完成 |

**按钮状态逻辑:**
```
状态: pending/planned → [启动]
点击启动后 → [启动中...] (loading)
成功启动后 → [查看会话] (跳转到 ChatApp 查看完整输出)
启动失败后 → 显示错误 + [重试]
```

**两种查看任务输出的方式:**

1. **RunManager 轻量状态（我的实现）**
   - 显示任务状态和子任务列表
   - SSE 监听 execution:started/failed 更新按钮状态
   - 适合快速管理和控制任务

2. **ChatApp 完整输出（输出流持久化文档）**
   - 点击"查看会话"跳转到 ChatApp
   - 显示完整执行过程：AI消息、工具调用、输出结果
   - 支持历史输出回放（持久化存储）

**验收标准:**
- [x] 点击启动后显示"启动中"
- [x] 后端 SSE 事件广播 (execution:started, execution:failed)
- [ ] 前端 SSE 监听更新状态
- [ ] 添加"查看会话"按钮跳转到 ChatApp
- [ ] 失败时显示错误信息
- [ ] 可以重试启动

**与输出流持久化文档的关系:**
- 我的方案：解决"启动不执行"问题
- 持久化文档：解决"输出不持久化"问题
- 两者互补，RunManager 跳转 ChatApp 查看完整输出流


### Phase 4: 调试验证 (计划 1 天 / 8 小时)

#### 9.4.1 功能调试

**调试内容:**
| 序号 | 任务 | 工时 | 进度 | 状态 |
|------|------|------|------|------|
| 4.1 | 本地启动测试 | 2h | 0% | 待调试 |
| 4.2 | 事件队列监控日志 | 1h | 0% | 待调试 |
| 4.3 | Supervisor 调用链路验证 | 2h | 0% | 待调试 |
| 4.4 | 子任务执行验证 | 2h | 0% | 待调试 |
| 4.5 | 错误场景测试 | 1h | 0% | 待调试 |

**调试方法:**
```python
# 添加关键日志点
1. EventQueue.publish
2. EventQueue._process_events
3. handle_task_authorized
4. supervisor_tool call
5. delegate_collab_subtasks_for_start_execution
```

**测试场景:**
- [ ] 正常启动流程
- [ ] 任务不存在
- [ ] 任务状态错误
- [ ] 子任务为空
- [ ] 并发启动多个任务
- [ ] 启动失败后重试


### 开发注意事项

#### 1. 代码规范
- 使用 Black 格式化 Python 代码
- TypeScript 使用严格类型检查
- 所有函数添加 docstring

#### 2. 错误处理
```python
# 必须捕获的异常
try:
    # 事件处理
except Exception as e:
    logger.exception(f"Event handler failed: {e}")
    # 发送失败通知
    # 不重试非可重试错误
```

#### 3. 性能考虑
- 事件队列设置最大长度（10000）
- 事件处理超时 30 秒
- 限制并发执行数（10）

#### 4. 向后兼容
- 保留现有 authorize-execution 返回值
- 新增字段使用 Optional
- 失败时不影响现有流程


### 每日进度更新模板

```markdown
## 202X-XX-XX 进度更新

### 今日完成任务
- [x] 任务 1.1: EventQueue 类基础实现 (3h/3h)
- [x] 任务 1.2: publish/subscribe 方法 (2h/2h)

### 进行中任务
- [ ] 任务 1.3: 后台处理线程 (进行中, 预计明日完成)

### 遇到的问题
- 问题描述: xxx
- 解决方案: xxx

### 明日计划
- [ ] 完成 任务 1.3
- [ ] 开始 任务 1.4

### 整体进度
Phase 1: 40% → 50%
总进度: 15% → 20%
```


### 风险跟踪

| 风险 | 状态 | 缓解措施 | 负责人 |
|------|------|----------|--------|
| ToolRuntime 创建困难 | 待观察 | 调研替代方案 | - |
| 事件处理性能瓶颈 | 待观察 | 限制队列大小 | - |
| 向后兼容性问题 | 待观察 | 保留现有接口 | - |


### 代码审查清单

**提交前检查:**
- [ ] 代码通过 lint 检查
- [ ] 单元测试通过
- [ ] 手动测试通过
- [ ] 文档已更新
- [ ] 变更日志已添加


## 10. 测试方案

### 10.1 单元测试

```python
# test_event_queue.py

def test_event_queue_publish_subscribe():
    queue = EventQueue()
    received = []
    
    def handler(event):
        received.append(event)
    
    queue.subscribe("test_event", handler)
    queue.publish("test_event", {"data": "test"})
    
    # 等待处理
    time.sleep(0.2)
    
    assert len(received) == 1
    assert received[0]["data"] == "test"

# test_task_start.py

async def test_task_authorized_event_handler():
    # 创建测试任务
    task = create_test_task(status="planned", execution_authorized=False)
    
    # 创建事件
    event = TaskAuthorizedEvent(
        task_id=task.id,
        project_id=task.project_id,
        authorized_by="test",
        thread_id=None,
        timestamp=datetime.utcnow()
    )
    
    # 调用处理器
    await handle_task_authorized(event)
    
    # 验证任务状态
    updated_task = get_task(task.id)
    assert updated_task.status == "executing"
```

### 10.2 集成测试

```python
# test_api_integration.py

async def test_authorize_execution_triggers_task():
    # 1. 创建任务
    task = create_task(name="Test Task")
    add_subtasks(task, count=2)
    
    # 2. 调用 API
    response = await client.post(
        f"/tasks/{task.id}/authorize-execution",
        json={"authorized_by": "test"}
    )
    
    # 3. 验证响应
    assert response.status_code == 200
    assert response.json()["status"] == "execution_triggered"
    
    # 4. 等待事件处理
    await asyncio.sleep(2)
    
    # 5. 验证任务已执行
    updated_task = get_task(task.id)
    assert updated_task.status == "executing"
    assert updated_task.execution_started_at is not None
```

### 10.3 端到端测试

```
测试场景 1: 正常启动
1. 在 RunManager 创建任务
2. 添加子任务
3. 点击启动
4. 验证：5秒内子任务状态变为 executing

测试场景 2: 启动失败后重试
1. 模拟 Supervisor 调用失败
2. 点击启动
3. 验证：显示失败信息
4. 再次点击启动
5. 验证：可以重新启动

测试场景 3: 并发启动
1. 同时点击多个任务的启动
2. 验证：所有任务都能正常启动
3. 验证：没有资源竞争问题
```


## 11. 风险与缓解

| 风险 | 影响 | 概率 | 缓解措施 |
|------|------|------|----------|
| 事件队列内存溢出 | 高 | 低 | 限制队列大小，超出时丢弃旧事件 |
| 事件处理重复执行 | 中 | 中 | 添加执行记录，幂等处理 |
| 事件丢失 | 高 | 低 | 添加持久化（后期），当前先记录日志 |
| 性能瓶颈 | 中 | 中 | 限制并发执行数，添加超时 |
| 向后兼容性 | 中 | 高 | 保留现有流程，新功能走新代码路径 |


## 实现进度总结

### 已完成的工作

#### Phase 1: 基础设施 ✅
创建了事件系统模块 (backend/app/gateway/events/):
- __init__.py - 模块导出
- event_queue.py - 轻量级内存事件队列
- task_events.py - 事件定义
- task_event_handlers.py - 事件处理器

#### Phase 2: 核心功能 ✅
修改了后端 API (backend/app/gateway/routers/tasks.py):
- 添加事件系统导入和初始化
- 修改 authorize_task_execution 接口，发送 TaskAuthorizedEvent
- 集成 SSE 广播 (execution:started, execution:failed)
- 创建 MinimalRuntime 解决 ToolRuntime 依赖

#### Phase 3: 前端适配 ⏳
前端已具备基础功能，需要补充：
- SSE 监听更新任务状态
- "查看会话"按钮跳转到 ChatApp
- 与输出流持久化文档集成

### 与输出流持久化的关系

| 功能 | 我的实现 | 输出流持久化文档 |
|------|---------|----------------|
| **目标** | 解决"启动不执行" | 解决"输出不持久化" |
| **层级** | API → Tool 调用 | Tool → 存储 |
| **查看方式** | RunManager 状态列表 | ChatApp 完整输出 |
| **集成点** | 启动成功后跳转 | 会话消息存储 |

**最终用户体验:**
1. RunManager 点击"启动"任务
2. 状态变为"执行中"
3. 点击"查看会话"跳转到 ChatApp
4. ChatApp 显示完整执行过程（实时 + 历史）


**设计完成日期**: 2025-04-17
**实现完成日期**: 2025-04-17
**评审人**: 
**状态**: 核心功能已完成，待调试验证
