"""Compat facade: org roster + collab rules.

Prefer importing ``org_roster`` / ``collab_rules`` directly. This module keeps
legacy ``build_employee_org_section`` / ``build_org_*`` names working by
concatenating the two blocks (assemble injects them separately).
"""

from __future__ import annotations

from typing import Literal

from evoflow.proactive.models import ProactiveRole
from evoflow.proactive.employee_prompting.collab_rules import build_employee_collab_block
from evoflow.proactive.employee_prompting.org_roster import (
    ORG_CLOSE,
    ORG_OPEN,
    build_employee_org_roster_block,
)

OrgDetail = Literal["compact", "full"]


def build_employee_org_section(
    role: ProactiveRole | None,
    *,
    roster: list[ProactiveRole] | None = None,
    detail: OrgDetail = "compact",
) -> str:
    """Legacy combined block (roster + collab). New code: use the two builders."""
    roster_block = build_employee_org_roster_block(role, roster=roster, detail=detail)
    collab = build_employee_collab_block(role, roster=roster)
    parts = [p for p in (roster_block, collab) if p]
    return "\n\n".join(parts)


def build_org_system_section(
    role: ProactiveRole,
    *,
    roster: list[ProactiveRole] | None = None,
) -> str:
    return build_employee_org_section(role, roster=roster, detail="full")


def build_org_collab_section(
    role: ProactiveRole,
    *,
    roster: list[ProactiveRole] | None = None,
) -> str:
    """Prefer ``build_employee_collab_block``; this returns collab-only."""
    return build_employee_collab_block(role, roster=roster)


def build_collab_rules_section(
    role: ProactiveRole,
    *,
    roster: list[ProactiveRole] | None = None,
) -> str:
    return build_employee_collab_block(role, roster=roster)


__all__ = [
    "ORG_CLOSE",
    "ORG_OPEN",
    "OrgDetail",
    "build_collab_rules_section",
    "build_employee_org_section",
    "build_org_collab_section",
    "build_org_system_section",
]
