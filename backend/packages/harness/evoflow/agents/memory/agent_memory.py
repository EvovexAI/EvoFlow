"""Agent memory management - separates agent memory from task memory."""

import json
import logging
from pathlib import Path
from typing import Any

from evoflow.config.paths import get_paths

logger = logging.getLogger(__name__)


class AgentMemoryManager:
    """Manages agent memory with separation between agent memory and task memory.

    Memory structure:
    - Agent memory: {base_dir}/agents/{agent_name}/memory.json
      - Stores agent-specific knowledge, preferences, and long-term facts
      - Persists across all tasks and sessions
    - Task memory: {base_dir}/threads/{thread_id}/agent_memory/{agent_name}.json
      - Stores conversation history and context for specific tasks
      - Can be cleaned up when thread is deleted
    """

    def __init__(self, agent_name: str | None = None):
        """Initialize agent memory manager.

        Args:
            agent_name: Name of the agent. If None, uses global memory.
        """
        self.agent_name = agent_name
        self.paths = get_paths()

    def get_agent_memory_path(self) -> Path:
        """Get the path to the agent's memory file.

        Returns:
            Path to agent memory file, or global memory file if no agent name.
        """
        if self.agent_name:
            return self.paths.agent_memory_file(self.agent_name)
        return self.paths.memory_file

    def get_task_memory_path(self, thread_id: str) -> Path:
        """Get the path to the task-specific memory file.

        Args:
            thread_id: The thread/task ID.

        Returns:
            Path to task memory file.
        """
        return self.paths.thread_dir(thread_id) / "agent_memory" / f"{self.agent_name or 'global'}.json"

    def load_agent_memory(self) -> dict[str, Any]:
        """Load the agent's long-term memory.

        Returns:
            Dictionary containing agent memory data.
        """
        memory_path = self.get_agent_memory_path()
        if not memory_path.exists():
            return {"facts": [], "context": {}}

        try:
            with open(memory_path, encoding="utf-8") as f:
                return json.load(f)
        except (OSError, json.JSONDecodeError) as e:
            logger.error(f"Failed to load agent memory: {e}")
            return {"facts": [], "context": {}}

    def save_agent_memory(self, memory: dict[str, Any]) -> None:
        """Save the agent's long-term memory.

        Args:
            memory: Dictionary containing agent memory data.
        """
        memory_path = self.get_agent_memory_path()
        memory_path.parent.mkdir(parents=True, exist_ok=True)

        try:
            with open(memory_path, "w", encoding="utf-8") as f:
                json.dump(memory, f, indent=2, ensure_ascii=False)
            logger.debug(f"Saved agent memory to {memory_path}")
        except OSError as e:
            logger.error(f"Failed to save agent memory: {e}")

    def load_task_memory(self, thread_id: str) -> dict[str, Any]:
        """Load task-specific memory.

        Args:
            thread_id: The thread/task ID.

        Returns:
            Dictionary containing task memory data.
        """
        memory_path = self.get_task_memory_path(thread_id)
        if not memory_path.exists():
            return {"conversation_history": [], "task_context": {}}

        try:
            with open(memory_path, encoding="utf-8") as f:
                return json.load(f)
        except (OSError, json.JSONDecodeError) as e:
            logger.error(f"Failed to load task memory: {e}")
            return {"conversation_history": [], "task_context": {}}

    def save_task_memory(self, thread_id: str, memory: dict[str, Any]) -> None:
        """Save task-specific memory.

        Args:
            thread_id: The thread/task ID.
            memory: Dictionary containing task memory data.
        """
        memory_path = self.get_task_memory_path(thread_id)
        memory_path.parent.mkdir(parents=True, exist_ok=True)

        try:
            with open(memory_path, "w", encoding="utf-8") as f:
                json.dump(memory, f, indent=2, ensure_ascii=False)
            logger.debug(f"Saved task memory to {memory_path}")
        except OSError as e:
            logger.error(f"Failed to save task memory: {e}")

    def get_combined_memory(self, thread_id: str | None = None) -> dict[str, Any]:
        """Get combined agent and task memory.

        Args:
            thread_id: Optional thread ID to include task memory.

        Returns:
            Combined memory dictionary with agent and task sections.
        """
        result = {
            "agent_memory": self.load_agent_memory(),
        }

        if thread_id:
            result["task_memory"] = self.load_task_memory(thread_id)

        return result

    def clear_task_memory(self, thread_id: str) -> None:
        """Clear task-specific memory.

        Args:
            thread_id: The thread/task ID.
        """
        memory_path = self.get_task_memory_path(thread_id)
        if memory_path.exists():
            try:
                memory_path.unlink()
                logger.debug(f"Cleared task memory for thread {thread_id}")
            except OSError as e:
                logger.error(f"Failed to clear task memory: {e}")

    def add_fact_to_agent_memory(self, fact: str, confidence: float = 1.0) -> None:
        """Add a fact to the agent's long-term memory.

        Args:
            fact: The fact to add.
            confidence: Confidence score (0.0 to 1.0).
        """
        memory = self.load_agent_memory()
        facts = memory.get("facts", [])

        # Check if fact already exists
        if any(f.get("text") == fact for f in facts):
            logger.debug(f"Fact already exists: {fact}")
            return

        facts.append({"text": fact, "confidence": confidence, "created_at": Path(self.get_agent_memory_path()).stat().st_mtime if self.get_agent_memory_path().exists() else 0})

        memory["facts"] = facts
        self.save_agent_memory(memory)

    def add_to_task_history(self, thread_id: str, role: str, content: str) -> None:
        """Add a message to the task conversation history.

        Args:
            thread_id: The thread/task ID.
            role: Message role ('user' or 'assistant').
            content: Message content.
        """
        memory = self.load_task_memory(thread_id)
        history = memory.get("conversation_history", [])

        history.append(
            {
                "role": role,
                "content": content,
            }
        )

        memory["conversation_history"] = history
        self.save_task_memory(thread_id, memory)


# Global instance cache
_agent_memory_managers: dict[str | None, AgentMemoryManager] = {}


def get_agent_memory_manager(agent_name: str | None = None) -> AgentMemoryManager:
    """Get or create an agent memory manager.

    Args:
        agent_name: Name of the agent. If None, uses global memory.

    Returns:
        AgentMemoryManager instance.
    """
    if agent_name not in _agent_memory_managers:
        _agent_memory_managers[agent_name] = AgentMemoryManager(agent_name)
    return _agent_memory_managers[agent_name]
