"""Memory admin (updater + config, no tools coupling)."""

from __future__ import annotations

from typing import Any

from evoflow.admin.errors import NotFoundError, ValidationError
from evoflow.agents.memory.updater import (
    clear_memory_data,
    delete_memory_fact,
    get_memory_data,
    list_memory_agent_slots,
    reload_memory_data,
)
from evoflow.config.agents_config import AGENT_NAME_PATTERN
from evoflow.config.memory_config import get_memory_config


def _normalize_agent(agent: str | None) -> str | None:
    if agent is None or not str(agent).strip():
        return None
    name = str(agent).strip()
    if not AGENT_NAME_PATTERN.match(name):
        raise ValidationError(f"Invalid agent '{name}'. Must match {AGENT_NAME_PATTERN.pattern}")
    return name.lower()


def list_memory_agents() -> dict[str, Any]:
    return {"agents": list_memory_agent_slots()}


def get_memory(*, agent: str | None = None) -> dict[str, Any]:
    return get_memory_data(agent_name=_normalize_agent(agent))


def reload_memory(*, agent: str | None = None) -> dict[str, Any]:
    return reload_memory_data(agent_name=_normalize_agent(agent))


def clear_memory(*, agent: str | None = None) -> dict[str, Any]:
    return clear_memory_data(agent_name=_normalize_agent(agent))


def delete_fact(fact_id: str, *, agent: str | None = None) -> dict[str, Any]:
    try:
        return delete_memory_fact(fact_id, agent_name=_normalize_agent(agent))
    except KeyError as e:
        raise NotFoundError(f"Memory fact '{fact_id}' not found") from e


def get_memory_config_status(*, agent: str | None = None) -> dict[str, Any]:
    cfg = get_memory_config()
    config_row = {
        "enabled": cfg.enabled,
        "storage_path": str(cfg.storage_path),
        "debounce_seconds": cfg.debounce_seconds,
        "max_facts": cfg.max_facts,
        "fact_confidence_threshold": cfg.fact_confidence_threshold,
        "injection_enabled": cfg.injection_enabled,
        "max_injection_tokens": cfg.max_injection_tokens,
    }
    return {"config": config_row, "data": get_memory(agent=agent)}
