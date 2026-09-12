"""External Agent execution module for EvoFlow."""

from .base import BaseExternalAgent
from .models import (
    AgentState,
    ExternalAgentConfig,
    ExternalAgentRuntime,
)
from .registry import ExternalAgentFactory, get_active_agent, register_active_agent
from .trae import TraeAgent

__all__ = [
    # Base classes
    "BaseExternalAgent",
    # Agent implementations
    "TraeAgent",
    # Models
    "AgentState",
    "ExternalAgentConfig",
    "ExternalAgentRuntime",
    # Registry
    "ExternalAgentFactory",
    "get_active_agent",
    "register_active_agent",
]
