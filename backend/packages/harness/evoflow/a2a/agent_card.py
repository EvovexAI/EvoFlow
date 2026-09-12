"""Agent Card generation: ProactiveRole -> A2A Agent Card JSON."""

from __future__ import annotations

import logging
from typing import Any

from evoflow.proactive.models import ProactiveRole, ProactiveRoleConfig
from evoflow.proactive.repositories import ProactiveRepository

logger = logging.getLogger(__name__)


def _lookup_skill_metadata(skill_name: str) -> dict[str, Any]:
    """Look up skill metadata by name from the skills registry.

    Returns a dict with label/description/tags/examples.
    Falls back to minimal info if skill not found.
    """
    try:
        from evoflow.admin.skills import get_skill

        row = get_skill(skill_name)
        return {
            "label": row.get("name", skill_name),
            "description": row.get("description", ""),
            "tags": [],
            "examples": [],
        }
    except Exception:
        pass
    # Fallback: use the skill name itself
    return {
        "label": skill_name,
        "description": "",
        "tags": [],
        "examples": [],
    }


def role_to_agent_card(role: ProactiveRole) -> dict[str, Any]:
    """Convert a ProactiveRole to an A2A Agent Card dict."""
    cfg: ProactiveRoleConfig = role.config

    skills = []
    for skill_name in (cfg.skills or []):
        meta = _lookup_skill_metadata(skill_name)
        skills.append(
            {
                "id": skill_name,
                "name": meta.get("label", skill_name),
                "description": meta.get("description", ""),
                "tags": meta.get("tags", []),
                "examples": meta.get("examples", []),
            }
        )

    responsibilities = "；".join(cfg.responsibilities) if cfg.responsibilities else role.role_name

    return {
        "name": role.role_name,
        "description": responsibilities,
        "url": f"/api/a2a/{role.agent_code}",
        "agent_code": role.agent_code,
        "version": "1.0.0",
        "capabilities": {
            "streaming": True,
            "pushNotifications": False,
            "stateTransitionHistory": True,
        },
        "defaultInputModes": ["text/plain"],
        "defaultOutputModes": ["text/plain", "application/json"],
        "skills": skills,
        # EvoFlow extensions
        "department": role.department,
        "workspace": cfg.workspace_path,
        "model": cfg.model_name or "",
        "tools": cfg.tool_groups or [],
    }


def list_agent_cards(*, status: str = "active") -> list[dict[str, Any]]:
    """List Agent Cards for all roles with the given status."""
    roles = ProactiveRepository.list_roles(status=status)
    return [role_to_agent_card(r) for r in roles]


def get_agent_card(agent_code: str) -> dict[str, Any] | None:
    """Get Agent Card for a single agent."""
    role = ProactiveRepository.get_role(agent_code)
    if not role:
        return None
    return role_to_agent_card(role)
