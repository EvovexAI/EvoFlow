"""Skill discovery scope / precedence (native-style multi-root)."""

from __future__ import annotations

from enum import IntEnum


class SkillScope(IntEnum):
    """Higher ``value`` wins when two skills share the same ``name`` (see SkillIndex dedupe)."""

    SYSTEM = 10
    PUBLIC = 20  # legacy primary ~/.evoflow/skills (install-wide)
    ORG = 25  # scopes/org/<id>/skills
    REPO = 30  # workspace .evoflow/skills
    GROUP = 35  # scopes/group/<id>/skills
    CUSTOM = 40  # legacy custom under primary
    PERSONAL = 45  # scopes/personal/<id>/skills — per-user overrides
    EXTERNAL = 50
