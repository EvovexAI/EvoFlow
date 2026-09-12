"""Registry for external agent instances.

Manages active agent instances and provides a factory for creating agents.
"""

import logging
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from .base import BaseExternalAgent

logger = logging.getLogger(__name__)

# Global registry of active agent instances
# Mapping: task_id -> BaseExternalAgent instance
_active_agents: dict[str, "BaseExternalAgent"] = {}


def register_active_agent(task_id: str, agent: "BaseExternalAgent") -> None:
    """Register an active agent instance.

    Args:
        task_id: EvoFlow task ID
        agent: Agent instance
    """
    _active_agents[task_id] = agent
    logger.debug(f"[ExternalAgentRegistry] Registered agent for task {task_id}")


def get_active_agent(task_id: str) -> "BaseExternalAgent | None":
    """Get an active agent instance by task ID.

    Args:
        task_id: EvoFlow task ID

    Returns:
        Agent instance or None if not found
    """
    agent = _active_agents.get(task_id)
    if not agent:
        logger.warning(f"[ExternalAgentRegistry] No agent found for task {task_id}")
    return agent


def unregister_active_agent(task_id: str) -> bool:
    """Unregister an agent instance.

    Args:
        task_id: EvoFlow task ID

    Returns:
        True if agent was found and removed
    """
    if task_id in _active_agents:
        del _active_agents[task_id]
        logger.debug(f"[ExternalAgentRegistry] Unregistered agent for task {task_id}")
        return True
    return False


def list_active_agents() -> dict[str, "BaseExternalAgent"]:
    """List all active agent instances.

    Returns:
        Dictionary mapping task_id -> agent
    """
    return dict(_active_agents)


class ExternalAgentFactory:
    """Factory for creating external agent instances.

    This factory creates appropriate agent instances based on configuration.
    It supports multiple protocols: pty, http, websocket, lsp.
    """

    # Registry of agent classes by (protocol, agent_type)
    _registry: dict[tuple[str, str], type["BaseExternalAgent"]] = {}

    @classmethod
    def register(cls, protocol: str, agent_type: str, agent_class: type["BaseExternalAgent"]) -> None:
        """Register an agent class.

        Args:
            protocol: Communication protocol (pty, http, websocket, lsp)
            agent_type: Agent type identifier
            agent_class: Agent class (subclass of BaseExternalAgent)
        """
        cls._registry[(protocol, agent_type)] = agent_class
        logger.info(f"[ExternalAgentFactory] Registered {agent_class.__name__} for {protocol}/{agent_type}")

    @classmethod
    def create(
        cls,
        agent_type: str,
        protocol: str | None = None,
        config: dict | None = None,
        **kwargs,
    ) -> "BaseExternalAgent":
        """Create an agent instance.

        Args:
            agent_type: Agent type identifier (e.g., "trae")
            protocol: Protocol type (auto-detected from config if None)
            config: Configuration dictionary
            **kwargs: Additional arguments passed to agent constructor

        Returns:
            Agent instance

        Raises:
            ValueError: If agent type not found
        """
        from .models import ExternalAgentConfig

        # Build config
        if config is None:
            config = {}

        agent_config = ExternalAgentConfig.from_dict(
            {
                **config,
                "agent_type": agent_type,
                "protocol": protocol or config.get("protocol", "pty"),
            }
        )

        # Look up agent class
        key = (agent_config.protocol, agent_type)
        agent_class = cls._registry.get(key)

        if not agent_class:
            # Try fallback to generic agent for protocol
            agent_class = cls._registry.get((agent_config.protocol, "generic"))

        if not agent_class:
            raise ValueError(f"No agent registered for {agent_config.protocol}/{agent_type}. Available: {list(cls._registry.keys())}")

        # Create instance
        agent = agent_class(config=agent_config, **kwargs)
        logger.info(f"[ExternalAgentFactory] Created {agent_class.__name__} for {agent_config.protocol}/{agent_type}")

        return agent

    @classmethod
    def list_registered(cls) -> list[tuple[str, str, str]]:
        """List all registered agent types.

        Returns:
            List of (protocol, agent_type, class_name) tuples
        """
        return [(protocol, agent_type, cls_.__name__) for (protocol, agent_type), cls_ in cls._registry.items()]


# Import and register built-in agents
def _register_builtin_agents():
    """Register built-in agent classes."""
    try:
        from .trae import TraeAgent

        ExternalAgentFactory.register("http", "trae", TraeAgent)
    except ImportError as e:
        logger.warning(f"[ExternalAgentFactory] Could not register TraeAgent: {e}")


# Register on module load
_register_builtin_agents()
