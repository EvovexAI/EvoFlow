"""Runtime configuration stored in ``evoflow_app_settings`` (overlay on bootstrap ``config.yaml``)."""

from __future__ import annotations

import logging
from typing import Any

from evoflow.persistence import config_repositories as cfg_repo

logger = logging.getLogger(__name__)

CHANNELS_GLOBAL_KEY = "channels.global"
TOOLS_MODE_KEY = "tools_mode"

# Dict sections persisted as ``runtime.<section>`` in evoflow_app_settings.
#
# ``observability`` is intentionally NOT here: it is a bootstrap / local-debug
# flag edited in ``config.yaml`` (or ``EVOFLOW_OBSERVABILITY``). Seeding it into
# SQLite once made later YAML edits appear to "stick" until restart, then vanish
# when the stale ``runtime.observability`` row overrode the file.
RUNTIME_DICT_SECTIONS: tuple[str, ...] = (
    "paths",
    "token_usage",
    "tool_search",
    "title",
    "tool_results",
    "working_memory",
    "code_index",
    "session_intent",
    "agent_orchestration",
    "summarization",
    "memory",
    "subagents",
    "guardrails",
    "acp_agents",
    "external_agents",
    "skills",
    "data_retention",
    "sandbox",
)

LOG_LEVEL_KEY = "runtime.log_level"


def runtime_setting_key(section: str) -> str:
    return f"runtime.{section}"


def seed_runtime_settings_from_yaml(config_data: dict[str, Any]) -> None:
    """One-time copy of YAML runtime sections into ``evoflow_app_settings`` when keys are absent."""
    for section in RUNTIME_DICT_SECTIONS:
        raw = config_data.get(section)
        if raw is None:
            continue
        key = runtime_setting_key(section)
        if cfg_repo.get_app_setting(key) is not None:
            continue
        cfg_repo.set_app_setting(key, raw)

    ll = config_data.get("log_level")
    if ll is not None and cfg_repo.get_app_setting(LOG_LEVEL_KEY) is None:
        cfg_repo.set_app_setting(LOG_LEVEL_KEY, str(ll))

    channels = config_data.get("channels")
    if isinstance(channels, dict):
        global_part = {k: v for k, v in channels.items() if not isinstance(v, dict)}
        if global_part and cfg_repo.get_app_setting(CHANNELS_GLOBAL_KEY) is None:
            cfg_repo.set_app_setting(CHANNELS_GLOBAL_KEY, global_part)


def overlay_runtime_settings_from_db(config_data: dict[str, Any]) -> dict[str, Any]:
    """Replace YAML-sourced runtime sections with SQLite ``evoflow_app_settings`` values."""
    for section in RUNTIME_DICT_SECTIONS:
        yaml_val = config_data.pop(section, None)
        if yaml_val is not None:
            logger.debug(
                "Ignoring %s from config.yaml (use evoflow_app_settings key %r).",
                section,
                runtime_setting_key(section),
            )
        db_val = cfg_repo.get_app_setting(runtime_setting_key(section))
        if db_val is not None:
            config_data[section] = db_val
        elif yaml_val is not None:
            config_data[section] = yaml_val
            cfg_repo.set_app_setting(runtime_setting_key(section), yaml_val)

    yaml_ll = config_data.pop("log_level", None)
    if yaml_ll is not None:
        logger.debug("Ignoring log_level from config.yaml (use evoflow_app_settings key %r).", LOG_LEVEL_KEY)
    ll = cfg_repo.get_app_setting(LOG_LEVEL_KEY)
    if ll is not None:
        config_data["log_level"] = str(ll).strip() or "info"
    elif yaml_ll is not None:
        config_data["log_level"] = str(yaml_ll).strip() or "info"
        cfg_repo.set_app_setting(LOG_LEVEL_KEY, config_data["log_level"])

    yaml_channels = config_data.pop("channels", None)
    if yaml_channels is not None:
        logger.debug(
            "Ignoring channels from config.yaml (use evoflow_channel_configs + app_settings %r).",
            CHANNELS_GLOBAL_KEY,
        )
    merged_channels: dict[str, Any] = {}
    global_ch = cfg_repo.get_app_setting(CHANNELS_GLOBAL_KEY)
    if isinstance(global_ch, dict):
        merged_channels.update(global_ch)
    platform_ch = cfg_repo.get_all_channel_configs()
    if platform_ch:
        merged_channels.update(platform_ch)
    if merged_channels:
        config_data["channels"] = merged_channels
    elif isinstance(yaml_channels, dict):
        config_data["channels"] = yaml_channels
        global_part = {k: v for k, v in yaml_channels.items() if not isinstance(v, dict)}
        if global_part:
            cfg_repo.set_app_setting(CHANNELS_GLOBAL_KEY, global_part)
        for platform, doc in yaml_channels.items():
            if isinstance(doc, dict):
                cfg_repo.upsert_channel_config(platform, doc)

    yaml_tm = config_data.pop("tools_mode", None)
    if yaml_tm is not None:
        logger.debug(
            "Ignoring tools_mode from config.yaml (use evoflow_app_settings key %r or default host_direct).",
            TOOLS_MODE_KEY,
        )
    tm = cfg_repo.get_app_setting(TOOLS_MODE_KEY)
    if tm is not None:
        config_data["tools_mode"] = str(tm).strip() or "host_direct"
    elif yaml_tm is not None:
        config_data["tools_mode"] = str(yaml_tm).strip() or "host_direct"
        cfg_repo.set_app_setting(TOOLS_MODE_KEY, config_data["tools_mode"])
    else:
        config_data.setdefault("tools_mode", "host_direct")

    return config_data


def persist_channels_section(channels_section: dict[str, Any]) -> None:
    """Write full ``channels`` subtree (globals + per-platform) to SQLite."""
    global_part = {k: v for k, v in channels_section.items() if not isinstance(v, dict)}
    platforms = {k: v for k, v in channels_section.items() if isinstance(v, dict)}
    if global_part:
        cfg_repo.set_app_setting(CHANNELS_GLOBAL_KEY, global_part)
    elif cfg_repo.get_app_setting(CHANNELS_GLOBAL_KEY) is not None:
        cfg_repo.set_app_setting(CHANNELS_GLOBAL_KEY, {})
    for platform, doc in platforms.items():
        cfg_repo.upsert_channel_config(platform, doc)


def persist_paths_section(paths_section: dict[str, Any]) -> None:
    cfg_repo.set_app_setting(runtime_setting_key("paths"), dict(paths_section))


def keys_stripped_from_yaml_export() -> frozenset[str]:
    """Top-level keys that must not be written back to bootstrap ``config.yaml``."""
    return frozenset(
        {
            "models",
            "primary_model",
            "tools",
            "tool_groups",
            "channels",
            "tools_mode",
            "extensions",
            "log_level",
            *RUNTIME_DICT_SECTIONS,
        }
    )
