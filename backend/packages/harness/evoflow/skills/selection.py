"""Select skills to load for the current model turn."""

from __future__ import annotations

import re

from evoflow.skills.loader import load_skills
from evoflow.skills.types import Skill

_MENTION_RE = re.compile(r"(?<![\w:/\\-])\$([a-zA-Z0-9][a-zA-Z0-9_-]{0,63})")


def extract_skill_mentions(text: str) -> list[str]:
    """Parse ``$skill-name`` tokens from user text (native-style explicit mention)."""
    if not text:
        return []
    seen: set[str] = set()
    out: list[str] = []
    for match in _MENTION_RE.finditer(text):
        name = match.group(1).strip().lower()
        if not name or name in seen:
            continue
        seen.add(name)
        out.append(name)
    return out


def select_skills_for_turn(
    *,
    preferred_skills: list[str] | None = None,
    user_message: str = "",
    enabled_only: bool = True,
    workspace_root: str | None = None,
) -> list[Skill]:
    """Resolve ordered skills to inject for this turn (native-style explicit selection).

    Sources: composer ``preferred_skills``, then ``$skill-name`` mentions in user text.
    Only checks installed + enabled registry — **not** agent skill allowlists.
    """
    enabled = load_skills(enabled_only=enabled_only, workspace_root=workspace_root)
    by_name = {s.name.strip().lower(): s for s in enabled}

    ordered_keys: list[str] = []
    seen: set[str] = set()

    def _add(name: str) -> None:
        key = str(name or "").strip().lower()
        if not key or key in seen:
            return
        seen.add(key)
        ordered_keys.append(key)

    for name in preferred_skills or []:
        _add(name)
    for name in extract_skill_mentions(user_message):
        _add(name)

    if not ordered_keys:
        return []

    selected: list[Skill] = []
    for key in ordered_keys:
        skill = by_name.get(key)
        if skill is not None:
            selected.append(skill)
    return selected
