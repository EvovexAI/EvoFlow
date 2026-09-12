"""Configuration for external agents.

Loads and parses external agent configuration from config.yaml.
"""

import logging
from typing import Any

from evoflow.config.app_config import get_app_config

from ..external_agents.models import ExternalAgentConfig

logger = logging.getLogger(__name__)


class ExternalAgentsConfig:
    """Manages external agent configuration.

    This class loads configuration from config.yaml and provides
    ExternalAgentConfig instances for each configured agent.

    Configuration format (config.yaml):
        external_agents:
            enabled: true
            default_agent: "trae"

            trae:
                enabled: true
                protocol: "http"
                base_url: "http://127.0.0.1:8787"
                timeout_seconds: 20
    """

    _instance: "ExternalAgentsConfig | None" = None
    _config: dict[str, Any] = {}

    def __new__(cls):
        """Singleton pattern to cache config."""
        if cls._instance is None:
            cls._instance = super().__new__(cls)
            cls._instance._load_config()
        return cls._instance

    def _load_config(self) -> None:
        """Load configuration from app config."""
        try:
            app_config = get_app_config()

            # Get external_agents section from config.yaml
            # Handle both dict and object configs
            if hasattr(app_config, "external_agents"):
                self._config = app_config.external_agents or {}
            elif isinstance(app_config, dict):
                self._config = app_config.get("external_agents", {})
            else:
                self._config = {}

                # Also try direct access
                try:
                    self._config = getattr(app_config, "external_agents", {})
                except Exception:
                    pass

            logger.info(f"[ExternalAgentsConfig] Loaded: {list(self._config.keys())}")

        except Exception as e:
            logger.warning(f"[ExternalAgentsConfig] Failed to load: {e}")
            self._config = {}

    @property
    def enabled(self) -> bool:
        """Check if external agents are enabled."""
        return self._config.get("enabled", False)

    @property
    def default_agent(self) -> str:
        """Get default agent type."""
        return self._config.get("default_agent", "trae")

    def get_agent_config(self, agent_type: str) -> ExternalAgentConfig | None:
        """Get configuration for a specific agent type.

        Args:
            agent_type: Agent type (e.g., "trae")

        Returns:
            ExternalAgentConfig or None if not configured
        """
        if not self.enabled:
            return None

        agent_config = self._config.get(agent_type)
        if not agent_config:
            return None

        if not agent_config.get("enabled", True):
            return None

        # Build config
        return ExternalAgentConfig(
            agent_type=agent_type,
            protocol=agent_config.get("protocol", "pty"),
            executable=agent_config.get("executable", ""),
            default_args=agent_config.get("default_args", []),
            base_url=agent_config.get("base_url", ""),
            ws_url=agent_config.get("ws_url", ""),
            api_key=agent_config.get("api_key"),
            timeout_seconds=agent_config.get("timeout_seconds", 3600),
            max_output_lines=agent_config.get("max_output_lines", 10000),
            waiting_input_patterns=agent_config.get("waiting_input_patterns"),
            progress_patterns=agent_config.get("progress_patterns"),
            env=agent_config.get("env", {}),
        )

    def list_enabled_agents(self) -> list[str]:
        """List all enabled agent types."""
        if not self.enabled:
            return []

        enabled = []
        for agent_type, config in self._config.items():
            if agent_type in ["enabled", "default_agent"]:
                continue
            if isinstance(config, dict) and config.get("enabled", True):
                enabled.append(agent_type)

        return enabled

    def is_agent_enabled(self, agent_type: str) -> bool:
        """Check if an agent type is enabled."""
        return self.get_agent_config(agent_type) is not None


def get_external_agents_config() -> ExternalAgentsConfig:
    """Get external agents configuration singleton."""
    return ExternalAgentsConfig()


def load_external_agent_config(agent_type: str) -> ExternalAgentConfig | None:
    """Convenience function to load config for an agent type."""
    return get_external_agents_config().get_agent_config(agent_type)
