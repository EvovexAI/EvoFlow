"""Workspace memory admin (CLI / API helpers)."""

from __future__ import annotations

from typing import Any

from evoflow.admin.errors import ValidationError
from evoflow.agents.memory.workspace_memory import (
    bootstrap_workspace_memory,
    clear_workspace_memory,
    get_workspace_memory_data,
    prune_workspace_memory,
    seed_workspace_memory,
    workspace_scope_id,
)
from evoflow.config.memory_config import get_memory_config
from evoflow.persistence.workspace_repositories import normalize_workspace_path


def _normalize_path(path: str | None) -> str:
    normalized = normalize_workspace_path(path or "")
    if not normalized:
        raise ValidationError("workspace path is required")
    return normalized


def get_workspace_memory(path: str) -> dict[str, Any]:
    ws = _normalize_path(path)
    return {
        "scope_id": workspace_scope_id(ws),
        "workspace_path": ws,
        "memory": get_workspace_memory_data(ws),
    }


def clear_workspace_memory_admin(path: str) -> dict[str, Any]:
    ws = _normalize_path(path)
    return {
        "scope_id": workspace_scope_id(ws),
        "workspace_path": ws,
        "memory": clear_workspace_memory(ws),
    }


def bootstrap_workspace_memory_admin(
    path: str,
    *,
    model_name: str | None = None,
    force: bool = False,
) -> dict[str, Any]:
    ws = _normalize_path(path)
    return bootstrap_workspace_memory(ws, model_name=model_name, force=force)


def prune_workspace_memory_admin(path: str, *, dry_run: bool = False) -> dict[str, Any]:
    ws = _normalize_path(path)
    return prune_workspace_memory(ws, dry_run=dry_run)


def seed_workspace_memory_admin(path: str, *, force: bool = False) -> dict[str, Any]:
    ws = _normalize_path(path)
    return seed_workspace_memory(ws, force=force)


def get_workspace_memory_status(path: str) -> dict[str, Any]:
    ws = _normalize_path(path)
    cfg = get_memory_config()
    data = get_workspace_memory(ws)
    return {
        "config": {
            "enabled": cfg.enabled,
            "injection_enabled": cfg.injection_enabled,
            "max_injection_tokens": cfg.max_injection_tokens,
            "chat_compact_max_tokens": cfg.chat_compact_max_tokens,
        },
        **data,
    }
