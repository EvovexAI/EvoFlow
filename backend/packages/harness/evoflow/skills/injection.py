"""Build model-visible SKILL.md injection blocks."""

from __future__ import annotations

import logging
from pathlib import Path

from evoflow.skills.skill_uri import SKILL_URI_PREFIX
from evoflow.skills.types import Skill

logger = logging.getLogger(__name__)

_DEFAULT_MAX_CHARS = 48_000

_SKILL_EXECUTION_HINT_EN = (
    "Skill execution (install dir is outside the user workspace — use skill: URIs, do not search workspace):\n"
    "- Read: read(\"skill:<name>/relative/file\")\n"
    "- Run script: terminal(command=\"python scripts/foo.py\", workdir=\"skill:<name>\") "
    "or process(action=\"start\", command=..., workdir=\"skill:<name>\")\n"
    "- List skill tree: terminal(command=\"ls\" or \"dir\", workdir=\"skill:<name>\")\n"
)

_SKILL_EXECUTION_HINT_ZH = (
    "技能执行（安装在 EvoFlow skills 目录，不在用户工作区 — 用 skill: URI，勿搜工作区）：\n"
    "- 读文件：read(\"skill:<名>/相对路径\")\n"
    "- 跑脚本：terminal(command=\"python scripts/foo.py\", workdir=\"skill:<名>\") "
    "或 process(action=\"start\", command=..., workdir=\"skill:<名>\")\n"
    "- 列目录：terminal(command=\"ls\" 或 \"dir\", workdir=\"skill:<名>\")\n"
)


def skill_injection_execution_hint(*, prompt_language: str | None = None) -> str:
    lang = str(prompt_language or "").strip().lower()
    if lang.startswith("zh"):
        return _SKILL_EXECUTION_HINT_ZH
    return _SKILL_EXECUTION_HINT_EN


def _read_skill_body(skill: Skill) -> str:
    try:
        return skill.skill_file.read_text(encoding="utf-8")
    except OSError as exc:
        logger.warning("Failed to read skill %s at %s: %s", skill.name, skill.skill_file, exc)
        return ""


def format_skill_injection_block(skill: Skill, *, contents: str | None = None) -> str:
    body = contents if contents is not None else _read_skill_body(skill)
    location = f"{SKILL_URI_PREFIX}{skill.name}"
    return (
        f"<skill>\n"
        f"<name>{skill.name}</name>\n"
        f"<location>{location}</location>\n"
        f"{body.rstrip()}\n"
        f"</skill>"
    )


def build_skill_injection_message(
    skills: list[Skill],
    *,
    max_chars: int = _DEFAULT_MAX_CHARS,
    prompt_language: str | None = None,
) -> str:
    """Concatenate selected skill bodies; truncate tail if over budget."""
    if not skills:
        return ""

    parts: list[str] = []
    used = 0
    for skill in skills:
        block = format_skill_injection_block(skill)
        if used + len(block) > max_chars:
            remaining = max_chars - used
            if remaining > 256:
                trimmed = block[:remaining].rstrip() + "\n<!-- skill truncated -->\n</skill>"
                parts.append(trimmed)
            break
        parts.append(block)
        used += len(block)

    exec_hint = skill_injection_execution_hint(prompt_language=prompt_language)
    header = (
        "<skill_injection>\n"
        "The following skill instructions are loaded for this turn (composer-selected or $mentioned). "
        "They are active even if omitted from <available_skills>. "
        "Follow them for the current task. Do not call read() for SKILL.md unless a referenced file is needed.\n"
        f"{exec_hint}\n"
    )
    return header + "\n\n".join(parts) + "\n</skill_injection>"
