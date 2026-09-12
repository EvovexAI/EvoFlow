"""Project and Task data models for multi-agent collaboration."""

from enum import Enum
from typing import Any

from evoflow.timeutil import beijing_now_iso

try:
    from enum import StrEnum
except ImportError:  # pragma: no cover
    # Python 3.10 fallback
    class StrEnum(str, Enum):
        pass


from pydantic import BaseModel, ConfigDict, Field


def _utc_iso_z() -> str:
    return beijing_now_iso()


class CollabPhase(StrEnum):
    """Per-thread collaboration state machine phase (design §6.1)."""

    IDLE = "idle"  # 空闲
    REQ_CONFIRM = "req_confirm"  # 请求确认
    PLANNING = "planning"  # 规划中
    PLAN_READY = "plan_ready"  # 规划就绪
    AWAITING_EXEC = "awaiting_exec"  # 等待执行
    EXECUTING = "executing"  # 执行中
    VERIFYING = "verifying"  # 验证中（测试/检查，限制副作用工具）
    REFLECTING = "reflecting"  # 反思/验收总结（只读 + 编排，禁止写文件）
    PAUSED = "paused"  # 已暂停 【新增】
    DONE = "done"  # 已完成


class ThreadCollabState(BaseModel):
    """Persisted under ``threads/{thread_id}/task_state.json`` (deleted with thread)."""

    collab_phase: CollabPhase = Field(default=CollabPhase.IDLE, description="Collaboration phase")
    bound_task_id: str | None = Field(default=None, description="Main task id bound to this thread")
    # scenario() 工具写入；与 mission_state 双写兼容，但此处保证「无 mission 文件」也能持久化（摘要轮/trace 仍可读）。
    activated_scenarios: list[str] = Field(
        default_factory=list,
        description="Keys from scenario(activate/deactivate); authoritative per-thread alongside collab_phase",
    )
    sidebar_supervisor_steps: list[dict[str, Any]] = Field(
        default_factory=list,
        description="Persisted supervisor UI timeline steps for task sidebar restore",
    )
    user_execution_confirmed_at: str | None = Field(
        default=None,
        description="When the user confirmed start (UI「开始执行」or chat); gates execution via plan_guard / authorize",
    )
    updated_at: str = Field(default_factory=_utc_iso_z, description="Last update (ISO8601 Z)")


class TaskStatus(StrEnum):
    INBOX = "inbox"  # 随手待办（未开跑；可未分配）
    PENDING = "pending"  # 待开始
    PLANNING = "planning"  # 规划中
    PLANNED = "planned"  # 已规划
    EXECUTING = "executing"  # 执行中
    PAUSED = "paused"  # 已暂停
    REVIEWED = "reviewed"  # legacy；写入时映射为 completed
    COMPLETED = "completed"  # 已完成（上级已确认/无需审核直接完成）
    FAILED = "failed"  # 失败
    CANCELLED = "cancelled"  # 已取消


class ProjectStatus(StrEnum):
    PENDING = "pending"  # 待开始
    PLANNING = "planning"  # 规划中
    EXECUTING = "executing"  # 执行中
    PAUSED = "paused"  # 已暂停
    COMPLETED = "completed"  # 已完成
    FAILED = "failed"  # 失败
    CANCELLED = "cancelled"  # 已取消


class WorkerProfile(BaseModel):
    """Per-subtask worker constraints (design §5.2). Stored on subtask as ``worker_profile``."""

    model_config = ConfigDict(extra="ignore")

    base_subagent: str = Field(..., description="Subagent template name, e.g. general-purpose")
    model: str | None = Field(
        default=None,
        description="Rare per-subtask override; omit in normal use (worker uses the session default chat model).",
    )
    instruction: str | None = Field(default=None, description="Extra system instructions for this worker")
    tools: list[str] | None = Field(
        default=None,
        description="Override tools; if None, resolve from assignee AgentConfig / SubagentConfig / parent session agent (not the global catalog).",
    )
    skills: list[str] | None = Field(default=None, description="Override default skills (load from AgentConfig if None)")
    depends_on: list[str] = Field(
        default_factory=list,
        description="Upstream subtask ids that must be status completed before this subtask may run (enforced by supervisor start_execution).",
    )
    expected_outputs: list[str] = Field(
        default_factory=list,
        description="Expected output file paths this subtask must produce (e.g. ['outputs/design.md', 'src/api.py']). Used for artifact verification after completion.",
    )
    validation: str | None = Field(
        default=None,
        description="Validation command to run after subtask completion (e.g. 'pytest tests/ -v'). Output is checked for pass/fail.",
    )
    max_retries: int = Field(
        default=3,
        description="Maximum retry count for this subtask before escalating to lead agent.",
    )

    def to_storage_dict(self) -> dict[str, Any]:
        return self.model_dump(exclude_none=True)


class TaskFact(BaseModel):
    """A key fact extracted from task execution."""

    id: str = Field(default="", description="Unique identifier for the fact")
    content: str = Field(default="", description="Fact content")
    category: str = Field(default="finding", description="Fact category: finding, decision, data, conclusion")
    confidence: float = Field(default=0.5, description="Confidence score (0-1)")
    source_message: str | None = Field(default=None, description="Source message ID")


class TaskDetail(BaseModel):
    """Detail snapshot for a single task/subtask execution."""

    task_id: str = Field(default="", description="Task ID")
    agent_id: str = Field(default="", description="Agent ID")
    main_task_id: str = Field(default="", description="Main task ID (storage bucket)")
    status: TaskStatus = Field(default=TaskStatus.PENDING, description="Task status")

    facts: list[TaskFact] = Field(default_factory=list, description="Extracted key facts")

    output_summary: str = Field(default="", description="Output summary")
    current_step: str = Field(default="", description="Current step description")
    progress: int = Field(default=0, description="Progress 0-100")

    created_at: str = Field(default="", description="Creation timestamp")
    updated_at: str = Field(default="", description="Last update timestamp")
    completed_at: str | None = Field(default=None, description="Completion timestamp")

    def to_dict(self) -> dict[str, Any]:
        return {
            "task_id": self.task_id,
            "agent_id": self.agent_id,
            "main_task_id": self.main_task_id,
            "status": self.status.value if isinstance(self.status, TaskStatus) else self.status,
            "facts": [{"id": f.id, "content": f.content, "category": f.category, "confidence": f.confidence, "source_message": f.source_message} for f in self.facts],
            "output_summary": self.output_summary,
            "current_step": self.current_step,
            "progress": self.progress,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
            "completed_at": self.completed_at,
        }


class Task(BaseModel):
    """A task in a project."""

    id: str = Field(default="", description="Unique task identifier")
    name: str = Field(default="", description="Task name")
    description: str = Field(default="", description="Task description")
    status: TaskStatus = Field(default=TaskStatus.PENDING, description="Current status")
    parent_id: str | None = Field(default=None, description="Parent task ID for subtasks")
    dependencies: list[str] = Field(default_factory=list, description="List of task IDs this task depends on")
    assigned_to: str | None = Field(default=None, description="Assigned agent ID")
    result: Any = Field(default=None, description="Execution result")
    error: str | None = Field(default=None, description="Error message if failed")
    created_at: str = Field(default="", description="Creation timestamp")
    started_at: str | None = Field(default=None, description="Start timestamp")
    completed_at: str | None = Field(default=None, description="Completion timestamp")
    progress: int = Field(default=0, description="Progress 0-100")
    execution_authorized: bool = Field(default=False, description="Gate: allow task tool to run workers for this task")
    thread_id: str | None = Field(default=None, description="LangGraph / chat thread bound to this task")
    authorized_at: str | None = Field(default=None, description="When execution was authorized (ISO8601 Z)")
    authorized_by: str | None = Field(default=None, description="user | lead | system")

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "name": self.name,
            "description": self.description,
            "status": self.status.value if isinstance(self.status, TaskStatus) else self.status,
            "parent_id": self.parent_id,
            "dependencies": self.dependencies,
            "assigned_to": self.assigned_to,
            "result": self.result,
            "error": self.error,
            "created_at": self.created_at,
            "started_at": self.started_at,
            "completed_at": self.completed_at,
            "progress": self.progress,
            "execution_authorized": self.execution_authorized,
            "thread_id": self.thread_id,
            "authorized_at": self.authorized_at,
            "authorized_by": self.authorized_by,
        }


class Project(BaseModel):
    """A project containing multiple tasks."""

    id: str = Field(default="", description="Unique project identifier")
    name: str = Field(default="", description="Project name")
    description: str = Field(default="", description="Project description")
    tasks: list[Task] = Field(default_factory=list, description="List of tasks")
    status: ProjectStatus = Field(default=ProjectStatus.PENDING, description="Project status")
    supervisor_session_id: str | None = Field(default=None, description="Supervisor session ID")
    created_at: str = Field(default="", description="Creation timestamp")
    updated_at: str = Field(default="", description="Last update timestamp")

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "name": self.name,
            "description": self.description,
            "tasks": [t.to_dict() for t in self.tasks],
            "status": self.status.value if isinstance(self.status, ProjectStatus) else self.status,
            "supervisor_session_id": self.supervisor_session_id,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
        }


class AgentRuntime(BaseModel):
    """Runtime status of an agent."""

    agent_id: str = Field(default="", description="Agent identifier")
    agent_name: str = Field(default="", description="Agent display name")
    status: str = Field(default="idle", description="Status: idle, busy, failed")
    current_task_id: str | None = Field(default=None, description="Current executing task ID")
    last_heartbeat: str | None = Field(default=None, description="Last heartbeat timestamp")
    progress: int = Field(default=0, description="Current task progress 0-100")
    main_task_id: str | None = Field(default=None, description="Current main task ID")

    def to_dict(self) -> dict[str, Any]:
        return {
            "agent_id": self.agent_id,
            "agent_name": self.agent_name,
            "status": self.status,
            "current_task_id": self.current_task_id,
            "last_heartbeat": self.last_heartbeat,
            "progress": self.progress,
            "main_task_id": self.main_task_id,
        }


# Backward alias; external/API naming should use TaskDetail.
TaskMemory = TaskDetail
