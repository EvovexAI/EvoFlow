"""External Agent execution integration for Supervisor.

This module integrates external agents (currently Trae) into the supervisor
execution flow without modifying the existing execution.py.

Usage:
    Import the dispatch function in supervisor_tool.py and call it when
    assigned_to indicates an external agent.
"""

import asyncio
import logging
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from evoflow.external_agents.base import BaseExternalAgent

logger = logging.getLogger(__name__)


# Mapping of assigned_to values to agent types
EXTERNAL_AGENT_ALIASES = {
    "trae": "trae",
    "trae-editor": "trae",
}


def is_external_agent(assigned_to: str | None) -> bool:
    """Check if the assigned agent is an external agent.

    Args:
        assigned_to: The assigned_to field from subtask

    Returns:
        True if it's an external agent, False for built-in subagents
    """
    if not assigned_to:
        return False

    normalized = assigned_to.lower().strip()
    return normalized in EXTERNAL_AGENT_ALIASES


def get_external_agent_type(assigned_to: str) -> str:
    """Get the external agent type from assigned_to.

    Args:
        assigned_to: The assigned_to field

    Returns:
        External agent type (e.g., "trae")
    """
    normalized = assigned_to.lower().strip()
    return EXTERNAL_AGENT_ALIASES.get(normalized, "trae")


async def execute_with_external_agent(
    subtask: dict[str, Any],
    thread_id: str | None = None,
    wait_for_completion: bool = False,
) -> dict[str, Any]:
    """Execute a subtask using an external agent.

    This is the entry point for supervisor to delegate tasks to external agents.
    It replaces the subagent delegation for external agent types.

    Args:
        subtask: Subtask configuration dict
        thread_id: Thread ID for context
        wait_for_completion: Whether to wait for completion or run in background

    Returns:
        Result dict compatible with supervisor response format
    """
    task_id = subtask.get("id", "unknown")
    assigned_to = subtask.get("assigned_to", "")

    logger.info(f"[ExternalAgentExecute] Executing task {task_id} with {assigned_to}")

    try:
        # Get agent type
        agent_type = get_external_agent_type(assigned_to)

        # Load configuration
        from evoflow.config.external_agents_config import load_external_agent_config

        config = load_external_agent_config(agent_type)

        if not config:
            return _error_result(task_id, f"External agent '{agent_type}' not configured. Please add to config.yaml under external_agents.")

        # Create agent instance
        from evoflow.external_agents import ExternalAgentFactory

        callbacks = _build_callbacks(task_id, subtask)

        agent = ExternalAgentFactory.create(agent_type=agent_type, config=config.__dict__ if config else {}, **callbacks)

        # Register active agent (for send_message_to_agent)
        from evoflow.external_agents.registry import register_active_agent

        register_active_agent(task_id, agent)

        # Execute
        if wait_for_completion:
            # Synchronous execution (wait for completion)
            from evoflow.runtime.long_run_limits import LONG_RUN_WALL_SECONDS

            result = await agent.execute(
                task=subtask,
                timeout=config.timeout_seconds if config else LONG_RUN_WALL_SECONDS,
            )

            return _success_result(
                task_id=task_id,
                session_id=agent.runtime.session_id if agent.runtime else task_id,
                status=result.status.value,
                result=result.result,
                error=result.error,
            )
        else:
            # Asynchronous execution (background)
            asyncio.create_task(_execute_background(agent, subtask))

            return _success_result(task_id=task_id, session_id=agent.runtime.session_id if agent.runtime else task_id, status="running", message="External agent started in background")

    except Exception as e:
        logger.error(f"[ExternalAgentExecute] Failed to execute {task_id}: {e}")
        return _error_result(task_id, str(e))


async def _execute_background(agent: "BaseExternalAgent", subtask: dict) -> None:
    """Execute agent in background and update storage."""
    task_id = subtask.get("id", "unknown")

    try:
        result = await agent.execute(task=subtask)

        # Update storage with result
        from evoflow.collab.storage import get_project_storage

        storage = get_project_storage()
        storage.patch_subtask(
            task_id,
            {
                "status": result.status.value,
                "result": result.result,
                "error": result.error,
                "completed_at": result.completed_at.isoformat() if result.completed_at else None,
            },
        )

        # Update task memory
        from evoflow.collab.storage import load_task_memory, save_task_memory

        memory = load_task_memory(task_id)
        memory.update(
            {
                "status": result.status.value,
                "output_summary": result.result or result.error or "",
                "completed_at": result.completed_at.isoformat() if result.completed_at else None,
            }
        )
        save_task_memory(task_id, memory)

        logger.info(f"[ExternalAgentExecute] Background execution completed: {task_id}")

    except Exception as e:
        logger.error(f"[ExternalAgentExecute] Background execution failed: {task_id}: {e}")

        # Update with error
        from evoflow.collab.storage import get_project_storage

        storage = get_project_storage()
        storage.patch_subtask(
            task_id,
            {
                "status": "failed",
                "error": str(e),
            },
        )


async def send_message_to_external_agent(
    task_id: str,
    message: str,
) -> dict[str, Any]:
    """Send a message to a running external agent.

    This is called by supervisor_tool with action="send_message_to_agent".

    Args:
        task_id: Task ID
        message: Message to send

    Returns:
        Result dict
    """
    from evoflow.external_agents.registry import get_active_agent

    agent = get_active_agent(task_id)
    if not agent:
        return {
            "success": False,
            "task_id": task_id,
            "error": "No active external agent found for this task",
        }

    success = await agent.send_message(message)

    return {
        "success": success,
        "task_id": task_id,
        "sent": message[:100] if len(message) > 100 else message,
    }


def _build_callbacks(task_id: str, subtask: dict) -> dict:
    """Build callback functions for agent events."""

    async def on_output(line: str) -> None:
        """Handle output from agent."""
        # Push to SSE for frontend
        try:
            from evoflow.collab.sse_notify import notify_task_update

            notify_task_update(
                task_id,
                {
                    "type": "stream_output",
                    "content": line,
                },
            )
        except Exception:
            pass

    def on_state_change(old_state, new_state) -> None:
        """Handle state changes."""
        logger.info(f"[ExternalAgent] {task_id}: {old_state.value} -> {new_state.value}")

        # Special handling for waiting input
        if new_state.value == "waiting":
            try:
                from evoflow.collab.sse_notify import notify_task_update

                notify_task_update(
                    task_id,
                    {
                        "type": "requires_input",
                        "message": "Agent is waiting for your input",
                    },
                )
            except Exception:
                pass

        # Update storage
        try:
            from evoflow.collab.storage import get_project_storage

            storage = get_project_storage()
            storage.patch_subtask(task_id, {"status": new_state.value})
        except Exception:
            pass

    def on_progress(progress: int) -> None:
        """Handle progress updates."""
        try:
            from evoflow.collab.storage import get_project_storage

            storage = get_project_storage()
            storage.patch_subtask(task_id, {"progress": progress})
        except Exception:
            pass

    return {
        "on_output": on_output,
        "on_state_change": on_state_change,
        "on_progress": on_progress,
    }


def _success_result(
    task_id: str,
    session_id: str,
    status: str,
    result: str | None = None,
    error: str | None = None,
    message: str | None = None,
) -> dict[str, Any]:
    """Build success result dict."""
    return {
        "subtask_id": task_id,
        "ok": True,
        "session_id": session_id,
        "status": status,
        "result": result,
        "error": error,
        "message": message,
    }


def _error_result(task_id: str, error: str) -> dict[str, Any]:
    """Build error result dict."""
    return {
        "subtask_id": task_id,
        "ok": False,
        "error": error,
    }


# Convenience function for supervisor integration
def should_use_external_agent(subtask: dict) -> bool:
    """Check if a subtask should use external agent.

    Usage in supervisor_tool:
        if should_use_external_agent(subtask):
            result = await execute_with_external_agent(subtask, ...)
        else:
            # Use built-in subagent
            result = await delegate_collab_subtasks_for_start_execution(...)
    """
    assigned_to = subtask.get("assigned_to", "")
    return is_external_agent(assigned_to)
