# 08 - 状态管理详细设计

## 目录

- [1. 问题定义](#1-问题定义)
- [2. 现有机制分析](#2-现有机制分析)
- [3. 状态模型设计](#3-状态模型设计)
- [4. 状态流转设计](#4-状态流转设计)
- [5. 状态同步机制](#5-状态同步机制)
- [6. 开发事项与进度](#6-开发事项与进度)


## 1. 问题定义

### 1.1 当前问题

当前状态管理存在以下问题：
1. **状态不一致**: TaskStatus 和 CollabPhase 没有明确的映射关系
2. **状态流转混乱**: 缺少明确的状态转换规则
3. **缺少暂停状态**: CollabPhase 没有 PAUSED 阶段
4. **状态变更无记录**: 无法追溯状态变化历史
5. **前后端状态不同步**: 页面关闭后状态不一致

### 1.2 目标定义

建立完整、一致、可追溯的状态管理体系：
1. 统一 TaskStatus 和 CollabPhase
2. 明确状态流转规则
3. 支持暂停/恢复状态
4. 记录状态变更历史
5. 实现前后端状态同步


## 2. 现有机制分析

### 2.1 当前状态模型

```python
# TaskStatus（任务状态）
class TaskStatus(str, Enum):
    PENDING = "pending"        # 待开始
    PLANNING = "planning"      # 规划中
    PLANNED = "planned"        # 已规划
    EXECUTING = "executing"    # 执行中
    PAUSED = "paused"          # 已暂停（未使用）
    COMPLETED = "completed"    # 已完成
    FAILED = "failed"          # 失败
    CANCELLED = "cancelled"    # 已取消

# CollabPhase（协作阶段）
class CollabPhase(str, Enum):
    IDLE = "idle"              # 空闲
    REQ_CONFIRM = "req_confirm" # 请求确认
    PLANNING = "planning"      # 规划中
    PLAN_READY = "plan_ready"  # 规划就绪
    AWAITING_EXEC = "awaiting_exec" # 等待执行
    EXECUTING = "executing"    # 执行中
    # 【缺失】PAUSED = "paused"
    DONE = "done"              # 已完成
```

### 2.2 问题分析

| 问题 | 说明 | 影响 |
|------|------|------|
| 映射关系不明确 | TaskStatus 和 CollabPhase 没有对应关系 | 状态混乱 |
| PAUSED 缺失 | CollabPhase 没有暂停阶段 | 无法实现暂停 |
| 状态流转无规则 | 任意状态可以转换到任意状态 | 非法转换 |
| 无历史记录 | 不知道状态何时变化、由谁触发 | 无法追溯 |
| 同步机制缺失 | 前后端状态可能不一致 | 用户体验差 |


## 3. 状态模型设计

### 3.1 统一状态模型

```python
# backend/packages/harness/evoflow/collab/models.py

class TaskStatus(str, Enum):
    """任务状态 - 主状态，用于业务逻辑"""
    
    # 初始状态
    PENDING = "pending"           # 待开始 - 任务已创建，等待启动
    
    # 规划阶段
    PLANNING = "planning"         # 规划中 - AI 正在分析需求、拆分子任务
    PLANNED = "planned"           # 已规划 - 子任务已创建，等待执行授权
    
    # 执行阶段
    EXECUTING = "executing"       # 执行中 - 子任务正在执行
    PAUSED = "paused"             # 已暂停 - 执行被暂停
    
    # 终止状态
    COMPLETED = "completed"       # 已完成 - 所有子任务完成
    FAILED = "failed"             # 失败 - 有子任务失败
    CANCELLED = "cancelled"       # 已取消 - 被取消


class CollabPhase(str, Enum):
    """协作阶段 - 用于控制 AI 行为"""
    
    IDLE = "idle"                 # 空闲 - 无协作任务
    REQ_CONFIRM = "req_confirm"   # 请求确认 - 需要用户确认
    PLANNING = "planning"         # 规划中 - AI 正在规划
    PLAN_READY = "plan_ready"     # 规划就绪 - 等待用户查看规划
    AWAITING_EXEC = "awaiting_exec" # 等待执行 - 等待执行授权
    EXECUTING = "executing"       # 执行中 - 正在执行
    PAUSED = "paused"             # 【新增】已暂停 - 执行暂停
    DONE = "done"                 # 已完成 - 协作结束
```

### 3.2 状态映射关系

```python
# TaskStatus 与 CollabPhase 的映射关系

TASK_STATUS_TO_COLLAB_PHASE = {
    TaskStatus.PENDING: CollabPhase.IDLE,
    TaskStatus.PLANNING: CollabPhase.PLANNING,
    TaskStatus.PLANNED: CollabPhase.AWAITING_EXEC,
    TaskStatus.EXECUTING: CollabPhase.EXECUTING,
    TaskStatus.PAUSED: CollabPhase.PAUSED,
    TaskStatus.COMPLETED: CollabPhase.DONE,
    TaskStatus.FAILED: CollabPhase.DONE,
    TaskStatus.CANCELLED: CollabPhase.DONE,
}

COLLAB_PHASE_TO_TASK_STATUS = {
    CollabPhase.IDLE: TaskStatus.PENDING,
    CollabPhase.REQ_CONFIRM: TaskStatus.PLANNING,
    CollabPhase.PLANNING: TaskStatus.PLANNING,
    CollabPhase.PLAN_READY: TaskStatus.PLANNED,
    CollabPhase.AWAITING_EXEC: TaskStatus.PLANNED,
    CollabPhase.EXECUTING: TaskStatus.EXECUTING,
    CollabPhase.PAUSED: TaskStatus.PAUSED,
    CollabPhase.DONE: None,  # 需要进一步判断是 completed/failed/cancelled
}
```

### 3.3 子任务状态

```python
class SubtaskStatus(str, Enum):
    """子任务状态"""
    
    PENDING = "pending"           # 待执行 - 等待依赖满足
    PLANNED = "planned"           # 已规划 - 已分配智能体
    EXECUTING = "executing"       # 执行中 - 正在运行
    COMPLETED = "completed"       # 已完成
    FAILED = "failed"             # 失败
    CANCELLED = "cancelled"       # 已取消
    TIMED_OUT = "timed_out"       # 超时


# 子任务状态与主任务状态的关系
# - 所有子任务 completed → 主任务 completed
# - 任意子任务 failed → 主任务 failed
# - 任意子任务 cancelled → 主任务 cancelled（如果未完成的都被取消）
# - 其他情况 → 主任务 executing
```

### 3.4 状态历史记录

```python
# 状态变更记录

class TaskStatusChangeRecord:
    """任务状态变更记录"""
    
    id: str                       # 记录 ID
    task_id: str                  # 任务 ID
    from_status: str              # 原状态
    to_status: str                # 新状态
    changed_by: str               # 变更者（user/system/agent）
    changed_at: datetime          # 变更时间
    reason: Optional[str]         # 变更原因
    metadata: Dict[str, Any]      # 额外信息


# 存储方式：JSONL 文件或数据库表
# 文件路径：{base_dir}/logs/status_changes/{task_id}.jsonl

# 示例记录：
{"id": "sc-001", "task_id": "task-xxx", "from_status": "pending", "to_status": "planning", "changed_by": "user", "changed_at": "2025-01-17T08:30:00Z", "reason": "用户启动任务"}
{"id": "sc-002", "task_id": "task-xxx", "from_status": "planning", "to_status": "planned", "changed_by": "system", "changed_at": "2025-01-17T08:31:00Z", "reason": "AI 完成规划"}
{"id": "sc-003", "task_id": "task-xxx", "from_status": "planned", "to_status": "executing", "changed_by": "user", "changed_at": "2025-01-17T08:32:00Z", "reason": "用户授权执行"}
```


## 4. 状态流转设计

### 4.1 状态流转图

```
                            用户启动
    ┌─────────┐         ┌─────────┐
    │ PENDING │ ──────► │PLANNING │ ◄─────┐
    └─────────┘         └────┬────┘       │
                              │ AI完成规划  │
                              ▼            │
                         ┌─────────┐       │
                         │ PLANNED │ ──────┘
                         └────┬────┘ 重新规划
                              │ 用户授权
                              ▼
    ┌─────────┐         ┌─────────┐
    │  PAUSED │ ◄────── │EXECUTING│
    └────┬────┘  暂停   └────┬────┘
         │                   │
    恢复 │              执行完成/失败/取消
         │                   ▼
         └────────────► ┌─────────┐
                        │COMPLETED│
                        │ FAILED  │
                        │CANCELLED│
                        └─────────┘

状态转换规则:
- PENDING → PLANNING: 用户启动
- PLANNING → PLANNED: AI 完成规划
- PLANNED → PLANNING: 重新规划
- PLANNED → EXECUTING: 用户授权
- EXECUTING → PAUSED: 用户暂停
- PAUSED → EXECUTING: 用户恢复
- EXECUTING → COMPLETED: 所有子任务完成
- EXECUTING → FAILED: 子任务失败
- EXECUTING → CANCELLED: 用户取消
- PAUSED → CANCELLED: 用户取消
```

### 4.2 状态流转规则

```python
# backend/packages/harness/evoflow/collab/state_transitions.py

from enum import Enum
from typing import Set, Dict

class StateTransition:
    """状态流转规则"""
    
    # 定义允许的状态转换
    ALLOWED_TRANSITIONS: Dict[str, Set[str]] = {
        TaskStatus.PENDING: {
            TaskStatus.PLANNING,
        },
        TaskStatus.PLANNING: {
            TaskStatus.PLANNED,
            TaskStatus.FAILED,      # 规划失败
            TaskStatus.CANCELLED,   # 取消
        },
        TaskStatus.PLANNED: {
            TaskStatus.PLANNING,    # 重新规划
            TaskStatus.EXECUTING,   # 开始执行
            TaskStatus.CANCELLED,   # 取消
        },
        TaskStatus.EXECUTING: {
            TaskStatus.PAUSED,      # 暂停
            TaskStatus.COMPLETED,   # 完成
            TaskStatus.FAILED,      # 失败
            TaskStatus.CANCELLED,   # 取消
        },
        TaskStatus.PAUSED: {
            TaskStatus.EXECUTING,   # 恢复
            TaskStatus.CANCELLED,   # 取消
        },
        TaskStatus.COMPLETED: set(),  # 终态，不可转换
        TaskStatus.FAILED: {
            TaskStatus.EXECUTING,   # 重试
        },
        TaskStatus.CANCELLED: set(),  # 终态，不可转换
    }
    
    @classmethod
    def can_transition(cls, from_status: str, to_status: str) -> bool:
        """检查状态转换是否允许"""
        allowed = cls.ALLOWED_TRANSITIONS.get(from_status, set())
        return to_status in allowed
    
    @classmethod
    def validate_transition(cls, from_status: str, to_status: str) -> None:
        """验证状态转换，不合法则抛出异常"""
        if not cls.can_transition(from_status, to_status):
            raise InvalidStateTransitionError(
                f"Cannot transition from {from_status} to {to_status}"
            )


class InvalidStateTransitionError(Exception):
    """非法状态转换异常"""
    pass
```

### 4.3 状态流转钩子

```python
# 状态变更钩子函数

class StateTransitionHooks:
    """状态流转钩子"""
    
    @staticmethod
    def on_pending_to_planning(task: dict, context: dict):
        """PENDING → PLANNING 钩子"""
        # 1. 设置开始规划时间
        task["planning_started_at"] = datetime.utcnow().isoformat() + "Z"
        
        # 2. 触发规划事件
        emit_event("task_planning_started", {"task_id": task["id"]})
    
    @staticmethod
    def on_planning_to_planned(task: dict, context: dict):
        """PLANNING → PLANNED 钩子"""
        # 1. 设置规划完成时间
        task["planning_completed_at"] = datetime.utcnow().isoformat() + "Z"
        
        # 2. 更新协作阶段
        advance_collab_phase_to_awaiting_exec(task["id"])
        
        # 3. 触发规划完成事件
        emit_event("task_planning_completed", {"task_id": task["id"]})
    
    @staticmethod
    def on_planned_to_executing(task: dict, context: dict):
        """PLANNED → EXECUTING 钩子"""
        # 1. 设置开始执行时间
        task["execution_started_at"] = datetime.utcnow().isoformat() + "Z"
        
        # 2. 更新协作阶段
        advance_collab_phase_to_executing(task["id"])
        
        # 3. 触发执行事件
        emit_event("task_execution_started", {"task_id": task["id"]})
    
    @staticmethod
    def on_executing_to_paused(task: dict, context: dict):
        """EXECUTING → PAUSED 钩子"""
        # 1. 设置暂停时间
        task["paused_at"] = datetime.utcnow().isoformat() + "Z"
        
        # 2. 回退协作阶段
        revert_collab_phase_to_paused(task["id"])
        
        # 3. 触发暂停事件
        emit_event("task_paused", {"task_id": task["id"]})
    
    @staticmethod
    def on_paused_to_executing(task: dict, context: dict):
        """PAUSED → EXECUTING 钩子"""
        # 1. 设置恢复时间
        task["resumed_at"] = datetime.utcnow().isoformat() + "Z"
        
        # 2. 推进协作阶段
        advance_collab_phase_from_paused(task["id"])
        
        # 3. 触发恢复事件
        emit_event("task_resumed", {"task_id": task["id"]})
    
    @staticmethod
    def on_to_terminal(task: dict, to_status: str, context: dict):
        """到终态的钩子（COMPLETED/FAILED/CANCELLED）"""
        # 1. 设置完成时间
        task["completed_at"] = datetime.utcnow().isoformat() + "Z"
        
        # 2. 更新协作阶段
        advance_collab_phase_to_done(task["id"])
        
        # 3. 计算执行时长
        if task.get("execution_started_at"):
            start = datetime.fromisoformat(task["execution_started_at"].replace("Z", "+00:00"))
            end = datetime.fromisoformat(task["completed_at"].replace("Z", "+00:00"))
            task["execution_duration_seconds"] = (end - start).total_seconds()
        
        # 4. 触发完成事件
        emit_event(f"task_{to_status.lower()}", {
            "task_id": task["id"],
            "status": to_status,
        })


# 钩子注册表
TRANSITION_HOOKS = {
    (TaskStatus.PENDING, TaskStatus.PLANNING): StateTransitionHooks.on_pending_to_planning,
    (TaskStatus.PLANNING, TaskStatus.PLANNED): StateTransitionHooks.on_planning_to_planned,
    (TaskStatus.PLANNED, TaskStatus.EXECUTING): StateTransitionHooks.on_planned_to_executing,
    (TaskStatus.EXECUTING, TaskStatus.PAUSED): StateTransitionHooks.on_executing_to_paused,
    (TaskStatus.PAUSED, TaskStatus.EXECUTING): StateTransitionHooks.on_paused_to_executing,
    (TaskStatus.EXECUTING, TaskStatus.COMPLETED): lambda t, c: StateTransitionHooks.on_to_terminal(t, "COMPLETED", c),
    (TaskStatus.EXECUTING, TaskStatus.FAILED): lambda t, c: StateTransitionHooks.on_to_terminal(t, "FAILED", c),
    (TaskStatus.EXECUTING, TaskStatus.CANCELLED): lambda t, c: StateTransitionHooks.on_to_terminal(t, "CANCELLED", c),
}
```

### 4.4 状态变更服务

```python
# 统一的状态变更服务

class TaskStateService:
    """任务状态服务 - 统一的状态变更入口"""
    
    def __init__(self):
        self.storage = get_project_storage()
    
    async def transition_state(
        self,
        task_id: str,
        to_status: str,
        changed_by: str = "system",
        reason: str = None,
        context: dict = None,
    ) -> dict:
        """
        转换任务状态
        
        Args:
            task_id: 任务 ID
            to_status: 目标状态
            changed_by: 变更者
            reason: 变更原因
            context: 上下文信息
        
        Returns:
            更新后的任务
        """
        # 1. 查找任务
        row = find_main_task(self.storage, task_id)
        if not row:
            raise TaskNotFoundError(f"Task {task_id} not found")
        
        project, task = row
        from_status = task.get("status")
        
        # 2. 验证状态转换
        StateTransition.validate_transition(from_status, to_status)
        
        # 3. 执行钩子
        hook = TRANSITION_HOOKS.get((from_status, to_status))
        if hook:
            hook(task, context or {})
        
        # 4. 更新状态
        task["status"] = to_status
        task["updated_at"] = datetime.utcnow().isoformat() + "Z"
        
        # 5. 记录状态变更
        await self._record_state_change(
            task_id=task_id,
            from_status=from_status,
            to_status=to_status,
            changed_by=changed_by,
            reason=reason,
        )
        
        # 6. 保存任务
        project["tasks"] = [t if t.get("id") != task_id else task for t in project["tasks"]]
        self.storage.save_project(project)
        
        # 7. 发送事件
        emit_event("task_status_changed", {
            "task_id": task_id,
            "from_status": from_status,
            "to_status": to_status,
            "changed_by": changed_by,
        })
        
        return task
    
    async def _record_state_change(
        self,
        task_id: str,
        from_status: str,
        to_status: str,
        changed_by: str,
        reason: str = None,
    ):
        """记录状态变更"""
        record = TaskStatusChangeRecord(
            id=make_formatted_id("SC"),
            task_id=task_id,
            from_status=from_status,
            to_status=to_status,
            changed_by=changed_by,
            changed_at=datetime.utcnow(),
            reason=reason,
        )
        
        # 写入日志文件
        log_file = get_paths().base_dir / "logs" / "status_changes" / f"{task_id}.jsonl"
        log_file.parent.mkdir(parents=True, exist_ok=True)
        
        with open(log_file, "a", encoding="utf-8") as f:
            f.write(record.model_dump_json() + "\n")
```


## 5. 状态同步机制

### 5.1 前后端状态同步

```
状态同步架构:

┌─────────────┐     WebSocket/SSE     ┌─────────────┐
│   前端页面   │ ◄───────────────────► │   后端 API   │
│  (React)    │                       │  (FastAPI)   │
└──────┬──────┘                       └──────┬──────┘
       │                                      │
       │  1. 页面加载                           │
       │ ─────────────────> GET /tasks/{id}    │
       │ <──────────────── 返回完整状态         │
       │                                      │
       │  2. WebSocket 连接                     │
       │ ─────────────────> 订阅事件             │
       │                                      │
       │  3. 状态变更                           │
       │ <──────────────── 推送状态变更事件      │
       │     (task_status_changed)             │
       │                                      │
       │  4. 页面重连                           │
       │ ─────────────────> 重新订阅            │
       │ ─────────────────> 获取最新状态         │
```

### 5.2 状态变更事件

```python
# 状态变更事件定义

class TaskStatusChangedEvent:
    """任务状态变更事件"""
    
    event_type: str = "task_status_changed"
    task_id: str
    from_status: str
    to_status: str
    changed_by: str
    changed_at: str
    reason: Optional[str]
    task_snapshot: dict  # 任务完整快照


# 前端状态更新
# useTaskStatus.ts

const useTaskStatus = (taskId: string) => {
  const [task, setTask] = useState<Task | null>(null)
  
  useEffect(() => {
    // 1. 初始加载
    const loadTask = async () => {
      const response = await fetch(`/api/tasks/${taskId}`)
      const data = await response.json()
      setTask(data.data)
    }
    loadTask()
    
    // 2. WebSocket 订阅
    const ws = new WebSocket(`/api/events/tasks/${taskId}`)
    
    ws.onmessage = (event) => {
      const data = JSON.parse(event.data)
      
      if (data.type === "task_status_changed") {
        // 更新状态
        setTask(prev => ({
          ...prev,
          status: data.to_status,
          updated_at: data.changed_at,
        }))
        
        // 显示通知
        showNotification({
          type: "info",
          message: `任务状态变更为: ${getStatusText(data.to_status)}`,
        })
      }
    }
    
    return () => ws.close()
  }, [taskId])
  
  return { task, setTask }
}
```

### 5.3 状态一致性保证

```python
# 状态一致性检查

class StateConsistencyChecker:
    """状态一致性检查器"""
    
    @staticmethod
    def check_task_status_consistency(task: dict) -> list[str]:
        """检查任务状态一致性，返回问题列表"""
        issues = []
        
        # 1. 检查 TaskStatus 和 CollabPhase 是否匹配
        task_status = task.get("status")
        collab_phase = get_collab_phase_for_task(task["id"])
        
        expected_phase = TASK_STATUS_TO_COLLAB_PHASE.get(task_status)
        if expected_phase and collab_phase != expected_phase:
            issues.append(
                f"TaskStatus ({task_status}) 与 CollabPhase ({collab_phase}) 不匹配，"
                f"期望: {expected_phase}"
            )
        
        # 2. 检查时间戳逻辑
        if task.get("completed_at") and task.get("started_at"):
            completed = datetime.fromisoformat(task["completed_at"].replace("Z", "+00:00"))
            started = datetime.fromisoformat(task["started_at"].replace("Z", "+00:00"))
            if completed < started:
                issues.append("completed_at 早于 started_at")
        
        # 3. 检查终态一致性
        terminal_statuses = {"completed", "failed", "cancelled"}
        if task_status in terminal_statuses:
            if not task.get("completed_at"):
                issues.append(f"终态任务 ({task_status}) 缺少 completed_at")
            
            if collab_phase != "done":
                issues.append(f"终态任务 CollabPhase 应为 done，实际: {collab_phase}")
        
        return issues
    
    @staticmethod
    async def fix_inconsistencies(task_id: str):
        """修复状态不一致"""
        # 自动修复逻辑
        pass
```


## 6. 开发事项与进度

### 6.1 开发进度总览

| 阶段 | 内容 | 工时 | 进度 | 状态 |
|------|------|------|------|------|
| Phase 1 | 状态模型 | 4h | 0% | 未开始 |
| Phase 2 | 状态流转 | 8h | 0% | 未开始 |
| Phase 3 | 状态服务 | 6h | 0% | 未开始 |
| Phase 4 | 历史记录 | 4h | 0% | 未开始 |
| Phase 5 | 同步机制 | 4h | 0% | 未开始 |
| Phase 6 | 调试 | 4h | 0% | 未开始 |
| **总计** | - | **30h** | **0%** | **未开始** |

### 6.2 详细任务

#### Phase 1: 状态模型 (4h)

| 序号 | 任务 | 文件 | 工时 | 状态 |
|------|------|------|------|------|
| 1.1 | 添加 PAUSED 到 CollabPhase | models.py | 0.5h | 待开发 |
| 1.2 | 定义状态映射关系 | state_transitions.py | 1h | 待开发 |
| 1.3 | 定义 SubtaskStatus | models.py | 0.5h | 待开发 |
| 1.4 | 创建 TaskStatusChangeRecord | models.py | 1h | 待开发 |
| 1.5 | 编写单元测试 | test_models.py | 1h | 待开发 |

#### Phase 2: 状态流转 (8h)

| 序号 | 任务 | 文件 | 工时 | 状态 |
|------|------|------|------|------|
| 2.1 | 实现 StateTransition | state_transitions.py | 2h | 待开发 |
| 2.2 | 实现状态流转规则 | state_transitions.py | 2h | 待开发 |
| 2.3 | 实现 StateTransitionHooks | state_transitions.py | 3h | 待开发 |
| 2.4 | 编写单元测试 | test_transitions.py | 1h | 待开发 |

#### Phase 3: 状态服务 (6h)

| 序号 | 任务 | 文件 | 工时 | 状态 |
|------|------|------|------|------|
| 3.1 | 实现 TaskStateService | task_state_service.py | 3h | 待开发 |
| 3.2 | 集成到现有 API | tasks.py | 2h | 待开发 |
| 3.3 | 编写单元测试 | test_state_service.py | 1h | 待开发 |

#### Phase 4: 历史记录 (4h)

| 序号 | 任务 | 文件 | 工时 | 状态 |
|------|------|------|------|------|
| 4.1 | 实现状态变更记录 | task_state_service.py | 2h | 待开发 |
| 4.2 | 实现查询接口 | tasks.py | 1h | 待开发 |
| 4.3 | 前端展示 | RunManager.tsx | 1h | 待开发 |

#### Phase 5: 同步机制 (4h)

| 序号 | 任务 | 文件 | 工时 | 状态 |
|------|------|------|------|------|
| 5.1 | 实现 useTaskStatus hook | useTaskStatus.ts | 2h | 待开发 |
| 5.2 | 集成到 RunManager | RunManager.tsx | 1h | 待开发 |
| 5.3 | 状态一致性检查 | state_consistency.py | 1h | 待开发 |

#### Phase 6: 调试 (4h)

| 序号 | 任务 | 工时 | 状态 |
|------|------|------|------|
| 6.1 | 状态流转测试 | 2h | 待调试 |
| 6.2 | 同步机制测试 | 2h | 待调试 |


**设计完成日期**: 2025-04-17
**状态**: 待评审
