"""Collaboration module for multi-agent project and task management."""

from evoflow.collab.models import (
    AgentRuntime,
    CollabPhase,
    Project,
    ProjectStatus,
    Task,
    TaskFact,
    TaskMemory,
    TaskStatus,
    ThreadCollabState,
    WorkerProfile,
)
from evoflow.collab.state_transitions import (
    ALLOWED_TRANSITIONS,
    COLLAB_PHASE_TO_TASK_STATUS,
    TASK_STATUS_TO_COLLAB_PHASE,
    InvalidStateTransitionError,
    can_transition,
    execute_transition_hooks,
    get_allowed_transitions,
    map_collab_phase_to_task_status,
    map_task_status_to_collab_phase,
    register_transition_hook,
    unregister_transition_hook,
    validate_transition,
)

__all__ = [
    # Models
    "AgentRuntime",
    "CollabPhase",
    "Project",
    "ProjectStatus",
    "Task",
    "TaskFact",
    "TaskMemory",
    "TaskStatus",
    "ThreadCollabState",
    "WorkerProfile",
    # State transitions
    "InvalidStateTransitionError",
    "TASK_STATUS_TO_COLLAB_PHASE",
    "COLLAB_PHASE_TO_TASK_STATUS",
    "ALLOWED_TRANSITIONS",
    "can_transition",
    "validate_transition",
    "get_allowed_transitions",
    "map_task_status_to_collab_phase",
    "map_collab_phase_to_task_status",
    "register_transition_hook",
    "unregister_transition_hook",
    "execute_transition_hooks",
]
