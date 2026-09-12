"""State transition rules and validation for task status management.

This module defines the allowed state transitions, validation logic,
and hooks for task status changes.
"""

from collections.abc import Callable
from typing import Any

from evoflow.collab.models import CollabPhase, TaskStatus

# ============================================================================
# State Mapping Definitions
# ============================================================================

TASK_STATUS_TO_COLLAB_PHASE: dict[TaskStatus, CollabPhase] = {
    TaskStatus.INBOX: CollabPhase.IDLE,
    TaskStatus.PENDING: CollabPhase.IDLE,
    TaskStatus.PLANNING: CollabPhase.PLANNING,
    TaskStatus.PLANNED: CollabPhase.AWAITING_EXEC,
    TaskStatus.EXECUTING: CollabPhase.EXECUTING,
    TaskStatus.PAUSED: CollabPhase.PAUSED,
    TaskStatus.REVIEWED: CollabPhase.VERIFYING,  # 已完成待审核，对应验证阶段
    TaskStatus.COMPLETED: CollabPhase.DONE,
    TaskStatus.FAILED: CollabPhase.DONE,
    TaskStatus.CANCELLED: CollabPhase.DONE,
}

COLLAB_PHASE_TO_TASK_STATUS: dict[CollabPhase, TaskStatus | None] = {
    CollabPhase.IDLE: TaskStatus.PENDING,
    CollabPhase.REQ_CONFIRM: TaskStatus.PLANNING,
    CollabPhase.PLANNING: TaskStatus.PLANNING,
    CollabPhase.PLAN_READY: TaskStatus.PLANNED,
    CollabPhase.AWAITING_EXEC: TaskStatus.PLANNED,
    CollabPhase.EXECUTING: TaskStatus.EXECUTING,
    CollabPhase.PAUSED: TaskStatus.PAUSED,
    CollabPhase.DONE: None,  # 需要进一步判断是 completed/failed/cancelled
}


# ============================================================================
# Allowed State Transitions
# ============================================================================

ALLOWED_TRANSITIONS: dict[TaskStatus, set[TaskStatus]] = {
    TaskStatus.INBOX: {
        TaskStatus.PENDING,  # 分配 / 升级为正式任务
        TaskStatus.COMPLETED,  # 用户自己勾完成
        TaskStatus.CANCELLED,
    },
    TaskStatus.PENDING: {
        TaskStatus.PLANNING,
        TaskStatus.PLANNED,
        TaskStatus.EXECUTING,  # 直接开跑（事项派发 / progress）
        TaskStatus.CANCELLED,  # 未开始即可取消（误派发清理）
    },
    TaskStatus.PLANNING: {
        TaskStatus.PLANNED,
        TaskStatus.FAILED,  # 规划失败
        TaskStatus.CANCELLED,  # 取消
    },
    TaskStatus.PLANNED: {
        TaskStatus.PLANNING,  # 重新规划
        TaskStatus.EXECUTING,  # 开始执行
        TaskStatus.CANCELLED,  # 取消
    },
    TaskStatus.EXECUTING: {
        TaskStatus.PAUSED,  # 暂停
        TaskStatus.COMPLETED,  # 直接完成（无需审核的任务）
        TaskStatus.REVIEWED,  # 完成待审核（员工干完，等上级确认）
        TaskStatus.FAILED,  # 失败
        TaskStatus.CANCELLED,  # 取消
    },
    TaskStatus.PAUSED: {
        TaskStatus.EXECUTING,  # 恢复
        TaskStatus.CANCELLED,  # 取消
    },
    TaskStatus.REVIEWED: {
        TaskStatus.COMPLETED,  # 审核通过
        TaskStatus.EXECUTING,  # 打回重做
        TaskStatus.CANCELLED,  # 取消
    },
    TaskStatus.COMPLETED: set(),  # 终态，不可转换
    TaskStatus.FAILED: {
        TaskStatus.EXECUTING,  # 重试
    },
    TaskStatus.CANCELLED: set(),  # 终态，不可转换
}


# ============================================================================
# State Transition Validation
# ============================================================================


class InvalidStateTransitionError(Exception):
    """Raised when an invalid state transition is attempted."""

    pass


def can_transition(from_status: TaskStatus, to_status: TaskStatus) -> bool:
    """Check if a state transition is allowed.

    Args:
        from_status: Current status
        to_status: Target status

    Returns:
        True if transition is allowed, False otherwise
    """
    allowed = ALLOWED_TRANSITIONS.get(from_status, set())
    return to_status in allowed


def validate_transition(from_status: TaskStatus, to_status: TaskStatus) -> None:
    """Validate a state transition, raise exception if invalid.

    Args:
        from_status: Current status
        to_status: Target status

    Raises:
        InvalidStateTransitionError: If transition is not allowed
    """
    if not can_transition(from_status, to_status):
        raise InvalidStateTransitionError(f"Cannot transition from {from_status.value} to {to_status.value}")


def get_allowed_transitions(status: TaskStatus) -> set[TaskStatus]:
    """Get all allowed transitions from a given status.

    Args:
        status: Current status

    Returns:
        Set of allowed target statuses
    """
    return ALLOWED_TRANSITIONS.get(status, set()).copy()


# ============================================================================
# Status Mapping Helpers
# ============================================================================


def map_task_status_to_collab_phase(task_status: TaskStatus) -> CollabPhase:
    """Map TaskStatus to CollabPhase.

    Args:
        task_status: Task status

    Returns:
        Corresponding collaboration phase
    """
    return TASK_STATUS_TO_COLLAB_PHASE.get(task_status, CollabPhase.IDLE)


def map_collab_phase_to_task_status(collab_phase: CollabPhase) -> TaskStatus | None:
    """Map CollabPhase to TaskStatus.

    Args:
        collab_phase: Collaboration phase

    Returns:
        Corresponding task status, or None if ambiguous
    """
    return COLLAB_PHASE_TO_TASK_STATUS.get(collab_phase)


# ============================================================================
# State Change Hooks
# ============================================================================

StateTransitionHook = Callable[[dict[str, Any]], None]

# Registry of hooks: (from_status, to_status) -> list of hooks
_transition_hooks: dict[tuple, list] = {}


def register_transition_hook(from_status: TaskStatus, to_status: TaskStatus, hook: StateTransitionHook) -> None:
    """Register a hook to be called when a specific transition occurs.

    Args:
        from_status: Source status
        to_status: Target status
        hook: Function to call when transition occurs
    """
    key = (from_status, to_status)
    if key not in _transition_hooks:
        _transition_hooks[key] = []
    _transition_hooks[key].append(hook)


def unregister_transition_hook(from_status: TaskStatus, to_status: TaskStatus, hook: StateTransitionHook) -> None:
    """Unregister a previously registered hook.

    Args:
        from_status: Source status
        to_status: Target status
        hook: Hook function to remove
    """
    key = (from_status, to_status)
    if key in _transition_hooks and hook in _transition_hooks[key]:
        _transition_hooks[key].remove(hook)


def execute_transition_hooks(from_status: TaskStatus, to_status: TaskStatus, context: dict[str, Any]) -> None:
    """Execute all registered hooks for a transition.

    Args:
        from_status: Source status
        to_status: Target status
        context: Context data to pass to hooks
    """
    # Execute specific hooks for this transition
    key = (from_status, to_status)
    if key in _transition_hooks:
        for hook in _transition_hooks[key]:
            try:
                hook(context)
            except Exception as e:
                # Log error but don't fail the transition
                print(f"Hook error for transition {from_status} -> {to_status}: {e}")


# ============================================================================
# Version Info
# ============================================================================

__version__ = "1.0.0"
