"""Workspace-scoped project memory helpers (Facade over mem_*)."""

from __future__ import annotations

from typing import Any

from evoflow.agents.memory.workspace_memory import workspace_scope_id
from evoflow.memory import facade as mem_facade
from evoflow.memory.document_codec import namespace_for_agent_key
from evoflow.persistence.workspace_repositories import normalize_workspace_path


def resolve_workspace_namespace(workspace_path: str) -> tuple[str, str]:
    """Return (scope_id, namespace_id) for a workspace path."""
    path = normalize_workspace_path(workspace_path)
    if not path:
        raise ValueError("workspace path required")
    scope = workspace_scope_id(path)
    ns = namespace_for_agent_key(scope)
    return scope, ns


def list_workspace_atoms(workspace_path: str, *, limit: int = 100) -> dict[str, Any]:
    scope, ns = resolve_workspace_namespace(workspace_path)
    atoms = mem_facade.list_atoms(ns, limit=limit)
    return {
        "workspace_path": path_display(workspace_path),
        "scope_id": scope,
        "namespace": ns,
        "atoms": atoms,
        "count": len(atoms),
        "hint": "仅本工作区生效；与用户全局记忆隔离",
    }


def path_display(workspace_path: str) -> str:
    return normalize_workspace_path(workspace_path) or (workspace_path or "")


def remember_workspace_atom(
    workspace_path: str,
    content: str,
    *,
    layer: str = "semantic",
    kind: str = "convention",
    pin: bool = False,
    summary: str = "",
    subject_key: str = "",
) -> dict[str, Any]:
    scope, ns = resolve_workspace_namespace(workspace_path)
    aid = mem_facade.remember(
        ns,
        content,
        layer=layer,
        kind=kind or "convention",
        summary=summary,
        pin=pin,
        confidence=0.85,
        importance=0.8 if pin else 0.65,
        subject_key=subject_key,
        source="workspace_ui",
    )
    if not aid:
        raise ValueError("failed to create workspace atom")
    from evoflow.memory.store import get_atom

    atom = get_atom(aid) or {"id": aid, "namespace_id": ns, "content": content}
    return {"scope_id": scope, "namespace": ns, "atom": atom}
