import logging
import os
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

try:
    # Python 3.11+
    from typing import Self
except ImportError:  # pragma: no cover
    # Python 3.10 fallback
    from typing import Self

import yaml
from dotenv import find_dotenv, load_dotenv
from pydantic import BaseModel, ConfigDict, Field, model_validator

from evoflow.config.acp_config import load_acp_config_from_dict
from evoflow.config.agent_orchestration_config import load_agent_orchestration_config_from_dict
from evoflow.config.checkpointer_config import CheckpointerConfig, load_checkpointer_config_from_dict
from evoflow.config.code_index_config import load_code_index_config_from_dict
from evoflow.config.data_retention_config import DataRetentionConfig
from evoflow.config.extensions_config import ExtensionsConfig
from evoflow.config.guardrails_config import load_guardrails_config_from_dict
from evoflow.config.memory_config import load_memory_config_from_dict
from evoflow.config.model_config import ModelConfig
from evoflow.config.models_yaml import coerce_models_field_for_appconfig
from evoflow.config.observability_config import ObservabilityConfig
from evoflow.config.sandbox_config import SandboxConfig
from evoflow.config.session_intent_config import load_session_intent_config_from_dict
from evoflow.config.skills_config import SkillsConfig
from evoflow.config.storage_config import StorageConfig
from evoflow.config.subagents_config import load_subagents_config_from_dict
from evoflow.config.summarization_config import load_summarization_config_from_dict
from evoflow.config.title_config import load_title_config_from_dict
from evoflow.config.token_usage_config import TokenUsageConfig
from evoflow.config.tool_config import ToolConfig, ToolGroupConfig
from evoflow.config.tool_results_config import load_tool_results_config_from_dict
from evoflow.config.tool_search_config import ToolSearchConfig, load_tool_search_config_from_dict
from evoflow.config.web_config import WebConfig, coerce_web_config
from evoflow.config.working_memory_config import load_working_memory_config_from_dict
from evoflow.execution_security.config import load_execution_security_config_from_dict
from evoflow.exploration_graph.config import load_exploration_graph_config_from_dict

# Prefer the nearest ``.env`` upward from cwd (so ``backend/`` dev still picks repo-root ``.env``).
_dotenv_path = find_dotenv(usecwd=True)
if _dotenv_path:
    load_dotenv(_dotenv_path)
else:
    load_dotenv()

logger = logging.getLogger(__name__)


def _ensure_desktop_tools_mode_defaults(config_data: dict[str, Any], resolved_path: Path) -> None:
    """Desktop minimal ``~/.evoflow/config.yaml`` lacks ``tools_mode``; default to host_direct.

    Without this, ``search_code_index`` and other host_direct-only tools never load (sandbox default),
    and ``tool_search(query="select:search_code_index")`` returns no match on first run.
    """
    if config_data.get("tools_mode"):
        return
    norm = str(resolved_path).replace("\\", "/").lower()
    if "/.evoflow/config.yaml" not in norm and not norm.endswith(".evoflow/config.yaml"):
        return
    tools = config_data.get("tools")
    if tools is None or tools == []:
        config_data["tools_mode"] = "host_direct"
        logger.info("Applied desktop default tools_mode=host_direct for %s", resolved_path)


def _ensure_tool_search_defaults(config_data: dict[str, Any]) -> None:
    """Merge deferred-tool defaults.

    Temporary: feature is shelved — default and force ``enabled: false``.
    Explicit YAML true is still overridden while ``TOOL_SEARCH_TEMPORARILY_DISABLED``.
    """
    from evoflow.config.tool_search_config import TOOL_SEARCH_TEMPORARILY_DISABLED

    if TOOL_SEARCH_TEMPORARILY_DISABLED:
        config_data["tool_search"] = {"enabled": False}
        return
    raw = config_data.get("tool_search")
    if raw is None or raw is False:
        config_data["tool_search"] = {"enabled": False}
        return
    if not isinstance(raw, dict):
        config_data["tool_search"] = {"enabled": False}
        return
    if "enabled" not in raw:
        config_data["tool_search"] = {**raw, "enabled": False}


class AppConfig(BaseModel):
    """Config for the EvoFlow application"""

    log_level: str = Field(default="info", description="Logging level for evoflow modules (debug/info/warning/error)")
    token_usage: TokenUsageConfig = Field(default_factory=TokenUsageConfig, description="Token usage tracking configuration")
    models: list[ModelConfig] = Field(default_factory=list, description="Available models")
    primary_model: str | None = Field(default=None, description="Name of the primary (default) model to use")
    sandbox: SandboxConfig = Field(description="Sandbox configuration")
    tools: list[ToolConfig] = Field(default_factory=list, description="Available tools")
    tool_groups: list[ToolGroupConfig] = Field(default_factory=list, description="Available tool groups")
    web: WebConfig = Field(
        default_factory=WebConfig,
        description="Hermes-style web search/extract backends (web.backend / search_backend)",
    )
    skills: SkillsConfig = Field(default_factory=SkillsConfig, description="Skills configuration")
    extensions: ExtensionsConfig = Field(default_factory=ExtensionsConfig, description="Extensions configuration (MCP servers and skills state)")
    tool_search: ToolSearchConfig = Field(default_factory=ToolSearchConfig, description="Tool search / deferred loading configuration")
    model_config = ConfigDict(extra="allow", frozen=False)
    checkpointer: CheckpointerConfig | None = Field(default=None, description="Checkpointer configuration")
    observability: ObservabilityConfig = Field(
        default_factory=ObservabilityConfig,
        description="SQLite observability (evoflow_obs_* tables): trace, tools, model payloads, lifecycle",
    )
    storage: StorageConfig = Field(
        default_factory=StorageConfig,
        description="Application SQLite (tasks, memory, threads, channels); default data/app/evoflow.db",
    )
    data_retention: DataRetentionConfig = Field(
        default_factory=DataRetentionConfig,
        description="Periodic cleanup for logs, observability, stream events, and orphan checkpoints",
    )

    @model_validator(mode="before")
    @classmethod
    def _normalize_models_yaml(cls, data: Any) -> Any:
        """Accept legacy ``models: [ ... ]`` or ``models: { providers: { ... } }``."""
        if not isinstance(data, dict):
            return data
        if "web" in data:
            data["web"] = coerce_web_config(data.get("web"))
        if "models" not in data:
            return data
        raw = data["models"]
        if isinstance(raw, list) or (isinstance(raw, dict) and "providers" in raw):
            data["models"] = coerce_models_field_for_appconfig(raw)
        return data

    @classmethod
    def resolve_config_path(cls, config_path: str | None = None) -> Path:
        """Resolve the config file path.

        Priority:
        1. If provided `config_path` argument, use it.
        2. If provided `EVOFLOW_CONFIG_PATH` environment variable, use it.
        3. Otherwise, first check the `config.yaml` in the current directory, then fallback to `config.yaml` in the parent directory.
        """
        if config_path:
            path = Path(config_path)
            if not Path.exists(path):
                raise FileNotFoundError(f"Config file specified by param `config_path` not found at {path}")
            return path
        elif os.getenv("EVOFLOW_CONFIG_PATH"):
            path = Path(os.getenv("EVOFLOW_CONFIG_PATH"))
            if not Path.exists(path):
                raise FileNotFoundError(f"Config file specified by environment variable `EVOFLOW_CONFIG_PATH` not found at {path}")
            return path
        else:
            # Check if the config.yaml is in the current directory
            path = Path(os.getcwd()) / "config.yaml"
            if not path.exists():
                # Check if the config.yaml is in the parent directory of CWD
                path = Path(os.getcwd()).parent / "config.yaml"
                if not path.exists():
                    raise FileNotFoundError("`config.yaml` file not found at the current directory nor its parent directory")
            return path

    @classmethod
    def from_file(cls, config_path: str | None = None) -> Self:
        """Load config from YAML file.

        See `resolve_config_path` for more details.

        Args:
            config_path: Path to the config file.

        Returns:
            AppConfig: The loaded config.
        """
        resolved_path = cls.resolve_config_path(config_path)
        try:
            with open(resolved_path, encoding="utf-8") as f:
                config_data = yaml.safe_load(f) or {}
        except UnicodeDecodeError as e:
            raise ValueError(
                f"Config file is not valid UTF-8: {resolved_path} ({e}). "
                "Re-save as UTF-8 without BOM (PowerShell Set-Content often corrupts YAML)."
            ) from e

        # Check config version before processing
        cls._check_config_version(config_data, resolved_path)

        _ensure_desktop_tools_mode_defaults(config_data, resolved_path)

        cls._strip_optional_channel_env_placeholders(config_data)

        config_data = cls.resolve_env_variables(config_data)

        # Load title config if present
        if "title" in config_data:
            load_title_config_from_dict(config_data["title"])

        # YAML bootstrap only — SQLite overlay must run *after* DB init below.
        if "execution_security" in config_data and isinstance(config_data["execution_security"], dict):
            load_execution_security_config_from_dict(config_data["execution_security"])

        # Load summarization config if present
        if "summarization" in config_data:
            load_summarization_config_from_dict(config_data["summarization"])

        if "tool_results" in config_data:
            load_tool_results_config_from_dict(config_data["tool_results"])

        if "working_memory" in config_data:
            load_working_memory_config_from_dict(config_data["working_memory"])
        if "exploration_graph" in config_data:
            load_exploration_graph_config_from_dict(config_data["exploration_graph"])

        if "code_index" in config_data:
            load_code_index_config_from_dict(config_data["code_index"])

        if "session_intent" in config_data:
            load_session_intent_config_from_dict(config_data["session_intent"])

        if "agent_orchestration" in config_data:
            load_agent_orchestration_config_from_dict(config_data["agent_orchestration"])

        # Load memory config if present
        if "memory" in config_data:
            load_memory_config_from_dict(config_data["memory"])

        # Load subagents config if present
        if "subagents" in config_data:
            load_subagents_config_from_dict(config_data["subagents"])

        # Deferred tool loading: default on when section missing or no ``enabled`` key.
        _ensure_tool_search_defaults(config_data)
        if isinstance(config_data.get("tool_search"), dict):
            load_tool_search_config_from_dict(config_data["tool_search"])

        # Load guardrails config if present
        if "guardrails" in config_data:
            load_guardrails_config_from_dict(config_data["guardrails"])

        # Load checkpointer config if present
        if "checkpointer" in config_data:
            load_checkpointer_config_from_dict(config_data["checkpointer"])

        # Always refresh ACP agent config so removed entries do not linger across reloads.
        load_acp_config_from_dict(config_data.get("acp_agents", {}))

        config_data = _apply_db_backed_config_overrides(config_data)

        # After get_db() is primed — UI writes ``execution.security`` here.
        try:
            from evoflow.execution_security.persist import (
                apply_persisted_execution_security_overrides,
            )

            apply_persisted_execution_security_overrides()
        except Exception:
            logger.warning(
                "execution_security SQLite overlay skipped (UI OS sandbox toggles may not stick)",
                exc_info=True,
            )

        return cls.model_validate(config_data)

    @classmethod
    def _strip_optional_channel_env_placeholders(cls, config_data: dict[str, Any]) -> None:
        """Remove ``$ENV`` channel values when the env var is unset so :meth:`resolve_env_variables` does not abort.

        Feishu ``push_secret`` is optional at startup; :func:`get_feishu_push_secret` in the Gateway may still read
        ``EVOFLOW_FEISHU_PUSH_SECRET`` from the process environment at request time.
        """
        channels = config_data.get("channels")
        if not isinstance(channels, dict):
            return
        feishu = channels.get("feishu")
        if not isinstance(feishu, dict):
            return
        ps = feishu.get("push_secret")
        if isinstance(ps, str) and ps.startswith("$") and len(ps) > 1:
            env_name = ps[1:]
            if not os.getenv(env_name):
                feishu.pop("push_secret", None)

    @classmethod
    def _check_config_version(cls, config_data: dict, config_path: Path) -> None:
        """Check if the user's config.yaml is outdated compared to config.example.yaml.

        Emits a warning if the user's config_version is lower than the example's.
        Missing config_version is treated as version 0 (pre-versioning).
        """
        try:
            user_version = int(config_data.get("config_version", 0))
        except (TypeError, ValueError):
            user_version = 0

        # Find config.example.yaml by searching config.yaml's directory and its parents
        example_path = None
        search_dir = config_path.parent
        for _ in range(5):  # search up to 5 levels
            candidate = search_dir / "config.example.yaml"
            if candidate.exists():
                example_path = candidate
                break
            parent = search_dir.parent
            if parent == search_dir:
                break
            search_dir = parent
        if example_path is None:
            return

        try:
            with open(example_path, encoding="utf-8") as f:
                example_data = yaml.safe_load(f)
            raw = example_data.get("config_version", 0) if example_data else 0
            try:
                example_version = int(raw)
            except (TypeError, ValueError):
                example_version = 0
        except Exception:
            return

        if user_version < example_version:
            logger.warning(
                "Your config.yaml (version %d) is outdated — the latest version is %d. Run `make config-upgrade` to merge new fields into your config.",
                user_version,
                example_version,
            )

    @classmethod
    def resolve_env_variables(cls, config: Any) -> Any:
        """Recursively resolve environment variables in the config.

        Environment variables are resolved using the `os.getenv` function. Example: $OPENAI_API_KEY

        Args:
            config: The config to resolve environment variables in.

        Returns:
            The config with environment variables resolved.
        """
        if isinstance(config, str):
            if config.startswith("$"):
                env_value = os.getenv(config[1:])
                if env_value is None:
                    raise ValueError(f"Environment variable {config[1:]} not found for config value {config}")
                return env_value
            return config
        elif isinstance(config, dict):
            return {k: cls.resolve_env_variables(v) for k, v in config.items()}
        elif isinstance(config, list):
            return [cls.resolve_env_variables(item) for item in config]
        return config

    def get_model_config(self, name: str) -> ModelConfig | None:
        """Get the model config by name.

        Args:
            name: The name of the model to get the config for.

        Returns:
            The model config if found, otherwise None.
        """
        name = (name or "").strip()
        if not name:
            return None

        def _entries() -> list[ModelConfig]:
            out: list[ModelConfig] = []
            for model in self.models:
                if isinstance(model, ModelConfig):
                    out.append(model)
                else:
                    logger.warning(
                        "Ignoring non-ModelConfig entry in AppConfig.models: %s",
                        type(model).__name__,
                    )
            return out

        models = _entries()

        # 1) Exact match (the canonical form).
        found = next((model for model in models if model.name == name), None)
        if found is not None:
            return found

        # 2) Backward/compatibility match:
        # Frontend may send `vendor/model_name` (e.g. `aliyun/kimi-k2.5`),
        # while config.yaml usually stores only `model_name` (e.g. `kimi-k2.5`).
        # When multiple vendors share the same model ID, we must match vendor
        # first to avoid returning the wrong provider's model.
        if "/" in name:
            parts = name.rsplit("/", 1)
            vendor_prefix = parts[0].strip().lower()
            suffix = parts[1].strip()
            if suffix and suffix != name:
                # 2a) Exact name match on the suffix (ignores vendor).
                found = next((model for model in models if model.name == suffix), None)
                if found is not None:
                    return found

                # 2b) Match by vendor + model field when vendor is specified.
                #     This ensures different vendors with the same model ID
                #     (e.g. aliyun/kimi-k2.5 vs moonshot/kimi-k2.5) resolve
                #     to the correct provider.
                if vendor_prefix:
                    found = next(
                        (
                            model
                            for model in models
                            if str(getattr(model, "model", "")) == suffix
                            and str(getattr(model, "vendor", "") or "").strip().lower() == vendor_prefix
                        ),
                        None,
                    )
                    if found is not None:
                        return found

                # 2c) Last-resort fallback: match by model field only.
                #     Only used when vendor is not specified or no vendor match
                #     was found (preserves original behavior for single-vendor setups).
                found = next((model for model in models if str(getattr(model, "model", "")) == suffix), None)
                if found is not None:
                    return found

        return None

    def get_tool_config(self, name: str) -> ToolConfig | None:
        """Get the tool config by name.

        Args:
            name: The name of the tool to get the config for.

        Returns:
            The tool config if found, otherwise None.
        """
        return next((tool for tool in self.tools if tool.name == name), None)

    def get_tool_group_config(self, name: str) -> ToolGroupConfig | None:
        """Get the tool group config by name.

        Args:
            name: The name of the tool group to get the config for.

        Returns:
            The tool group config if found, otherwise None.
        """
        return next((group for group in self.tool_groups if group.name == name), None)


_app_config: AppConfig | None = None
_app_config_path: Path | None = None
_app_config_mtime: float | None = None
_app_config_is_custom = False
_app_config_loading = False


def _storage_sqlite_path_from_config_data(config_data: dict[str, Any]) -> str:
    storage = config_data.get("storage")
    if isinstance(storage, dict):
        raw = str(storage.get("sqlite_path") or "").strip()
        if raw:
            return raw
    return "evoflow.db"


def _apply_db_backed_config_overrides(config_data: dict[str, Any]) -> dict[str, Any]:
    """Seed/overlay SQLite config without re-entering :func:`get_app_config` during load."""
    from evoflow.persistence.bootstrap import (
        apply_config_from_db,
        seed_config_from_app_yaml,
    )
    from evoflow.persistence.db import get_db
    from evoflow.persistence.runtime_settings import seed_runtime_settings_from_yaml

    get_db(storage_sqlite_path=_storage_sqlite_path_from_config_data(config_data))
    seed_config_from_app_yaml(config_data)
    seed_runtime_settings_from_yaml(config_data)
    # Skills FS scan is expensive (rglob + read SKILL.md); run from gateway startup or skills UI, not each config load.
    config_data = apply_config_from_db(config_data)
    extensions_config = ExtensionsConfig.from_db()
    config_data["extensions"] = extensions_config.model_dump()
    return config_data


def _get_config_mtime(config_path: Path) -> float | None:
    """Get the modification time of a config file if it exists."""
    try:
        return config_path.stat().st_mtime
    except OSError:
        return None


def _load_and_cache_app_config(config_path: str | None = None) -> AppConfig:
    """Load config from disk and refresh cache metadata."""
    global _app_config, _app_config_path, _app_config_mtime, _app_config_is_custom, _app_config_loading

    resolved_path = AppConfig.resolve_config_path(config_path).resolve()
    _app_config_loading = True
    try:
        _app_config = AppConfig.from_file(str(resolved_path))
        _app_config_path = resolved_path
        _app_config_mtime = _get_config_mtime(resolved_path)
        _app_config_is_custom = False
        return _app_config
    finally:
        _app_config_loading = False


def get_app_config() -> AppConfig:
    """Get the EvoFlow config instance.

    Returns a cached singleton instance and automatically reloads it when the
    underlying config file path or modification time changes. Use
    `reload_app_config()` to force a reload, or `reset_app_config()` to clear
    the cache.
    """
    global _app_config, _app_config_path, _app_config_mtime

    if _app_config is not None and _app_config_is_custom:
        return _app_config

    resolved_path = AppConfig.resolve_config_path().resolve()
    current_mtime = _get_config_mtime(resolved_path)
    cached_path = _app_config_path.resolve() if _app_config_path is not None else None

    should_reload = _app_config is None or cached_path != resolved_path or _app_config_mtime != current_mtime
    if should_reload:
        if _app_config_path == resolved_path and _app_config_mtime is not None and current_mtime is not None and _app_config_mtime != current_mtime:
            logger.info(
                "Config file has been modified (mtime: %s -> %s), reloading AppConfig",
                _app_config_mtime,
                current_mtime,
            )
        _load_and_cache_app_config(str(resolved_path))
    return _app_config


def reload_app_config(config_path: str | None = None) -> AppConfig:
    """Reload the config from file and update the cached instance.

    This is useful when the config file has been modified and you want
    to pick up the changes without restarting the application.

    Args:
        config_path: Optional path to config file. If not provided,
                     uses the default resolution strategy.

    Returns:
        The newly loaded AppConfig instance.
    """
    cfg = _load_and_cache_app_config(config_path)
    try:
        from evoflow.tools.tools import invalidate_available_tools_cache

        invalidate_available_tools_cache()
    except Exception:
        pass
    try:
        from evoflow.session_tool_binding.agent_tools import invalidate_agent_tool_names_cache

        invalidate_agent_tool_names_cache()
    except Exception:
        pass
    try:
        from evoflow.agents.lead_agent.graph_cache import clear_lead_agent_graph_cache

        clear_lead_agent_graph_cache()
    except Exception:
        pass
    return cfg


def reset_app_config() -> None:
    """Reset the cached config instance.

    This clears the singleton cache, causing the next call to
    `get_app_config()` to reload from file. Useful for testing
    or when switching between different configurations.
    """
    global _app_config, _app_config_path, _app_config_mtime, _app_config_is_custom
    _app_config = None
    _app_config_path = None
    _app_config_mtime = None
    _app_config_is_custom = False


def set_app_config(config: AppConfig) -> None:
    """Set a custom config instance.

    This allows injecting a custom or mock config for testing purposes.

    Args:
        config: The AppConfig instance to use.
    """
    global _app_config, _app_config_path, _app_config_mtime, _app_config_is_custom
    _app_config = config
    _app_config_path = None
    _app_config_mtime = None
    _app_config_is_custom = True


def update_channels_section_and_save(channels_section: dict[str, Any]) -> None:
    """Persist ``channels`` to SQLite and refresh in-memory :class:`AppConfig`."""
    from evoflow.persistence.runtime_settings import persist_channels_section

    persist_channels_section(channels_section)
    reload_app_config()


def update_paths_section_and_save(paths_section: dict[str, Any]) -> None:
    """Persist ``paths`` to SQLite and refresh in-memory :class:`AppConfig`."""
    from evoflow.config.paths import reset_paths_cache
    from evoflow.persistence.runtime_settings import persist_paths_section

    persist_paths_section(paths_section)
    reset_paths_cache()
    reload_app_config()


def reload_models_from_db() -> AppConfig:
    """Refresh in-memory chat models and ``primary_model`` from SQLite (not from config.yaml).

    When api_key / base_url / provider class changes, also clear the lead-agent graph
    cache so the next chat rebuilds ``ChatOpenAI`` (etc.) with the new credentials.
    Without that, same model name keeps hitting a cached graph that still holds the
    old key until process restart.
    """
    from evoflow.config.model_config import ModelConfig
    from evoflow.models.credential_sanitize import sanitize_model_document
    from evoflow.persistence import config_repositories as cfg_repo

    global _app_config
    config = get_app_config()
    prev_fp = _models_credential_fingerprint(getattr(config, "models", None) or [])
    rows = cfg_repo.list_models()
    config.models = [ModelConfig.model_validate(sanitize_model_document(row)) for row in rows]
    pm = cfg_repo.get_app_setting("primary_model")
    if pm is not None:
        stripped = str(pm).strip()
        config.primary_model = stripped or None
    _app_config = config
    next_fp = _models_credential_fingerprint(config.models)
    if prev_fp != next_fp:
        try:
            from evoflow.agents.lead_agent.graph_cache import clear_lead_agent_graph_cache

            clear_lead_agent_graph_cache()
            logging.getLogger(__name__).info(
                "reload_models_from_db: credentials changed; cleared lead-agent graph cache"
            )
        except Exception:
            pass
    return config


def _models_credential_fingerprint(models: list[Any]) -> tuple[Any, ...]:
    """Stable fingerprint of fields baked into LLM clients (not display-only fields)."""
    rows: list[tuple[Any, ...]] = []
    for m in models or []:
        if isinstance(m, dict):
            name = m.get("name")
            use = m.get("use")
            model = m.get("model")
            base_url = m.get("base_url")
            api_key = m.get("api_key")
            credentials = m.get("credentials")
            strategy = m.get("credential_strategy")
        else:
            name = getattr(m, "name", None)
            use = getattr(m, "use", None)
            model = getattr(m, "model", None)
            base_url = getattr(m, "base_url", None)
            api_key = getattr(m, "api_key", None)
            credentials = getattr(m, "credentials", None)
            strategy = getattr(m, "credential_strategy", None)
        rows.append(
            (
                str(name or ""),
                str(use or ""),
                str(model or ""),
                str(base_url or ""),
                str(api_key or ""),
                repr(credentials or ()),
                str(strategy or ""),
            )
        )
    rows.sort()
    return tuple(rows)


def save_config() -> None:
    """Save the current config to the config.yaml file.

    This persists any in-memory changes back to disk.
    """
    global _app_config, _app_config_path
    import traceback

    if _app_config is None:
        raise ValueError("No config loaded to save")

    config_path = _app_config_path or AppConfig.resolve_config_path()

    try:
        # Convert AppConfig to dict for YAML serialization.
        # Business config lives in SQLite — bootstrap yaml keeps storage/checkpointer only.
        from evoflow.persistence.runtime_settings import keys_stripped_from_yaml_export

        config_dict = _app_config.model_dump(mode="json", exclude_none=True)
        for key in keys_stripped_from_yaml_export():
            config_dict.pop(key, None)

        # Preserve config_version if it exists
        try:
            with open(config_path, encoding="utf-8") as f:
                existing = yaml.safe_load(f) or {}
            if "config_version" in existing:
                config_dict["config_version"] = existing["config_version"]
        except Exception:
            pass

        with open(config_path, "w", encoding="utf-8") as f:
            yaml.dump(config_dict, f, default_flow_style=False, allow_unicode=True, sort_keys=False)

        # Update mtime cache
        global _app_config_mtime
        _app_config_mtime = _get_config_mtime(config_path)
        logger.info("Config saved to %s", config_path)
    except Exception as e:
        error_detail = f"{str(e)}\n{traceback.format_exc()}"
        logger.error(f"Failed to save config: {error_detail}")
        raise


def _normalize_model_api_key_fields(model_data: dict[str, Any]) -> dict[str, Any]:
    """Drop masked/empty api_key so partial sync does not persist ``****`` or wipe keys."""
    from evoflow.models.credential_sanitize import is_masked_api_key

    data = dict(model_data)
    raw = data.get("api_key")
    if raw is None:
        return data
    text = str(raw).strip()
    if not text or is_masked_api_key(text):
        data.pop("api_key", None)
    return data


def _inherit_connection_api_key(model_data: dict[str, Any]) -> dict[str, Any]:
    """Copy api_key from the Panel connection or a sibling model on the same vendor."""
    from evoflow.models.credential_sanitize import is_masked_api_key

    data = _normalize_model_api_key_fields(model_data)
    if data.get("api_key"):
        return data

    vendor = str(data.get("vendor") or "").strip()
    base_url = str(data.get("base_url") or "").strip().rstrip("/")
    if not vendor:
        return data

    # Prefer the dedicated connections table (source of truth for shared credentials).
    try:
        from evoflow.persistence.model_connections import get_model_connection

        conn = get_model_connection(vendor)
    except Exception:
        conn = None
    if conn:
        conn_key = str(conn.get("api_key") or "").strip()
        if conn_key and not is_masked_api_key(conn_key):
            conn_url = str(conn.get("base_url") or "").strip().rstrip("/")
            if not base_url or not conn_url or conn_url == base_url:
                data["api_key"] = conn_key
                return data

    config = get_app_config()
    for sibling in config.models:
        if str(getattr(sibling, "vendor", "") or "").strip() != vendor:
            continue
        sibling_key = getattr(sibling, "api_key", None)
        if not sibling_key or is_masked_api_key(sibling_key):
            continue
        sibling_url = str(getattr(sibling, "base_url", "") or "").strip().rstrip("/")
        if base_url and sibling_url and sibling_url != base_url:
            continue
        data["api_key"] = sibling_key
        break
    return data


def add_model_to_config(model_data: dict) -> "ModelConfig":
    """Add a new model to the config.

    Args:
        model_data: Dictionary containing model configuration.

    Returns:
        The created ModelConfig instance.

    Raises:
        ValueError: If a model with the same name already exists.
    """
    from evoflow.config.model_config import ModelConfig

    global _app_config
    config = get_app_config()

    # Check if model already exists
    if any(m.name == model_data["name"] for m in config.models):
        raise ValueError(f"Model '{model_data['name']}' already exists")

    model_data = _inherit_connection_api_key(_apply_default_thinking_payload(model_data))

    # Create new model config
    new_model = ModelConfig.model_validate(model_data)

    # Add to config
    config.models.append(new_model)
    _app_config = config

    from evoflow.persistence import config_repositories as cfg_repo

    cfg_repo.upsert_model(new_model.model_dump(mode="json"))

    return new_model


def update_model_in_config(model_name: str, model_data: dict) -> "ModelConfig":
    """Update an existing model in the config.

    Args:
        model_name: The name of the model to update.
        model_data: Dictionary containing updated model configuration.

    Returns:
        The updated ModelConfig instance.

    Raises:
        ValueError: If the model is not found.
    """
    from evoflow.config.model_config import ModelConfig

    global _app_config
    config = get_app_config()

    # Find the model
    model_index = None
    for i, m in enumerate(config.models):
        if not hasattr(m, "name"):
            logger.warning(
                "Ignoring non-ModelConfig entry while updating models: %s",
                type(m).__name__,
            )
            continue
        if m.name == model_name:
            model_index = i
            break

    if model_index is None:
        raise ValueError(f"Model '{model_name}' not found")

    existing = config.models[model_index]
    if not hasattr(existing, "model_dump") or not callable(getattr(existing, "model_dump", None)):
        raise TypeError(
            f"Model '{model_name}' entry must be a ModelConfig instance, "
            f"got {type(existing).__name__}"
        )
    # Merge so partial updates (e.g. only supports_thinking) do not wipe YAML-only
    # fields like when_thinking_enabled / thinking. Callers should pass model_data
    # from request.model_dump(exclude_unset=True).
    existing_dump = existing.model_dump(mode="json")
    existing_dump.pop("model_config", None)
    normalized = _normalize_model_api_key_fields(model_data)
    merged = {**existing_dump, **normalized}
    merged["name"] = model_name
    merged = _apply_default_thinking_payload(merged)

    updated_model = ModelConfig.model_validate(merged)
    config.models[model_index] = updated_model
    _app_config = config

    from evoflow.persistence import config_repositories as cfg_repo

    dump = updated_model.model_dump(mode="json")
    # Omitted / masked / empty api_key must not clobber a newer DB value (e.g. just
    # propagated from evoflow_model_connections). upsert_model uses COALESCE(NULL, existing).
    if "api_key" not in normalized:
        dump["api_key"] = None
    cfg_repo.upsert_model(dump)

    return updated_model


def _is_aliyun_like_model(model_data: dict[str, Any]) -> bool:
    vendor = str(model_data.get("vendor") or "").strip().lower()
    if "aliyun" in vendor:
        return True

    base_url = str(model_data.get("base_url") or "").strip().lower()
    host = (urlparse(base_url).hostname or "").lower() if base_url else ""
    return ("dashscope" in host) or ("aliyuncs.com" in host)


def _is_minimax_like_model(model_data: dict[str, Any]) -> bool:
    vendor = str(model_data.get("vendor") or "").strip().lower()
    if "minimax" in vendor:
        return True
    base_url = str(model_data.get("base_url") or "").strip().lower()
    host = (urlparse(base_url).hostname or "").lower() if base_url else ""
    # https://api.minimax.io/v1 (intl) or https://api.minimaxi.com/v1 (CN)
    return ("minimax.io" in host) or ("minimaxi.com" in host)


def _apply_default_thinking_payload(model_data: dict[str, Any]) -> dict[str, Any]:
    """Populate when_thinking_enabled defaults when only supports_thinking is set."""
    data = dict(model_data)
    if not bool(data.get("supports_thinking")):
        return data
    if data.get("when_thinking_enabled") is not None:
        return data
    if data.get("thinking") is not None:
        return data

    if _is_aliyun_like_model(data):
        # DashScope OpenAI-compatible: non-standard switch
        data["when_thinking_enabled"] = {"extra_body": {"enable_thinking": True}}
    elif _is_minimax_like_model(data):
        # MiniMax OpenAI-compatible: enable split reasoning so EvoFlow can map reasoning_details -> reasoning_content
        data["when_thinking_enabled"] = {"extra_body": {"thinking": {"type": "enabled"}, "reasoning_split": True}}
    else:
        # Generic OpenAI-compatible thinking switch (Moonshot/DeepSeek/Novita/most gateways)
        data["when_thinking_enabled"] = {"extra_body": {"thinking": {"type": "enabled"}}}
    return data


def remove_model_from_config(model_name: str) -> None:
    """Remove a model from the config.

    Args:
        model_name: The name of the model to remove.

    Raises:
        ValueError: If the model is not found.
    """
    global _app_config
    config = get_app_config()

    # Find and remove the model
    original_count = len(config.models)
    was_primary = (config.primary_model or "").strip() == model_name.strip()
    config.models = [m for m in config.models if m.name != model_name]

    if len(config.models) == original_count:
        raise ValueError(f"Model '{model_name}' not found")

    if was_primary:
        config.primary_model = config.models[0].name if config.models else None

    _app_config = config

    from evoflow.persistence import config_repositories as cfg_repo

    if was_primary and config.primary_model:
        cfg_repo.set_app_setting("primary_model", config.primary_model)

    cfg_repo.delete_model(model_name)
