"""Configuration for deferred tool loading via tool_search."""

from pydantic import BaseModel, Field

# Temporary product kill-switch: deferred tool_search / progressive loading is shelved.
# Main chat uses flat bind (agent ∩ mode tools). Set to False to restore the feature.
TOOL_SEARCH_TEMPORARILY_DISABLED = True


class ToolSearchConfig(BaseModel):
    """Configuration for deferred tool loading via tool_search.

    When enabled, MCP tools are not loaded into the agent's context directly.
    Instead, they are listed by name in the system prompt and discoverable
    via the tool_search tool at runtime.
    """

    enabled: bool = Field(
        default=False,
        description="Defer tools and enable tool_search. When True, only core tools are sent to the LLM; others are discovered at runtime via the tool_search tool.",
    )


_tool_search_config: ToolSearchConfig | None = None


def is_tool_search_enabled() -> bool:
    """Effective flag after temporary kill-switch (and AppConfig when feature is restored)."""
    if TOOL_SEARCH_TEMPORARILY_DISABLED:
        return False
    try:
        from evoflow.config.app_config import get_app_config

        return bool(get_app_config().tool_search.enabled)
    except Exception:
        cfg = get_tool_search_config()
        return bool(cfg.enabled)


def get_tool_search_config() -> ToolSearchConfig:
    """Get the tool search config, loading from AppConfig if needed."""
    global _tool_search_config
    if _tool_search_config is None:
        _tool_search_config = ToolSearchConfig(enabled=False)
    if TOOL_SEARCH_TEMPORARILY_DISABLED:
        _tool_search_config = ToolSearchConfig(enabled=False)
    return _tool_search_config


def load_tool_search_config_from_dict(data: dict) -> ToolSearchConfig:
    """Load tool search config from a dict (called during AppConfig loading)."""
    global _tool_search_config
    payload = dict(data) if isinstance(data, dict) else {}
    if TOOL_SEARCH_TEMPORARILY_DISABLED:
        payload["enabled"] = False
    _tool_search_config = ToolSearchConfig.model_validate(payload)
    return _tool_search_config


def sync_tool_search_enabled_from_db() -> bool:
    """Pull ``runtime.tool_search.enabled`` from SQLite into process AppConfig.

    Gateway settings writes only reload the Gateway process; LangGraph workers must
    re-read this flag on lead-agent builds or they keep a stale in-memory value.
    Returns the effective ``enabled`` flag.
    """
    if TOOL_SEARCH_TEMPORARILY_DISABLED:
        enabled = False
    else:
        enabled = False
        try:
            from evoflow.persistence import config_repositories as cfg_repo

            raw = cfg_repo.get_app_setting("runtime.tool_search")
            if isinstance(raw, dict) and "enabled" in raw:
                enabled = bool(raw.get("enabled"))
            elif raw is False:
                enabled = False
            elif raw is True:
                enabled = True
        except Exception:
            try:
                from evoflow.config.app_config import get_app_config

                return bool(get_app_config().tool_search.enabled)
            except Exception:
                return False

    load_tool_search_config_from_dict({"enabled": enabled})
    try:
        from evoflow.config.app_config import get_app_config

        cfg = get_app_config()
        prev = bool(getattr(getattr(cfg, "tool_search", None), "enabled", False))
        cfg.tool_search = ToolSearchConfig(enabled=enabled)
        if prev != enabled:
            try:
                from evoflow.tools.tools import invalidate_available_tools_cache

                invalidate_available_tools_cache()
            except Exception:
                pass
            try:
                from evoflow.agents.lead_agent.graph_cache import clear_lead_agent_graph_cache

                clear_lead_agent_graph_cache()
            except Exception:
                pass
    except Exception:
        pass
    return enabled
