"""Resolve skill discovery roots from AuthzContext / principal."""

from __future__ import annotations

from pathlib import Path

from evoflow.authz.scope_paths import skill_roots_for_principal
from evoflow.authz.types import Principal
from evoflow.skills.skill_scope import SkillScope

_LABEL_TO_SCOPE = {
    "org": SkillScope.ORG,
    "group": SkillScope.GROUP,
    "personal": SkillScope.PERSONAL,
}


def scope_skill_roots_for_principal(
    principal: Principal | None,
    *,
    session_scope_id: str | None = None,
    ensure: bool = True,
) -> list[tuple[Path, SkillScope]]:
    if principal is None:
        return []
    out: list[tuple[Path, SkillScope]] = []
    for path, label in skill_roots_for_principal(
        principal,
        session_scope_id=session_scope_id,
        ensure=ensure,
    ):
        scope = _LABEL_TO_SCOPE.get(label)
        if scope is None:
            continue
        out.append((path, scope))
    return out
