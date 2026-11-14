"""Build model-visible SKILL.md injection blocks."""

from __future__ import annotations

import logging
from pathlib import Path

from evoflow.skills.skill_uri import SKILL_URI_PREFIX
from evoflow.skills.types import Skill

logger = logging.getLogger(__name__)

_DEFAULT_MAX_CHARS = 48_000

# stat-based body cache: SkillsInjectionMiddleware rebuilds the injection block
# on every model call (2×/call — patch_request + injected-sections modal), and
# SKILL.md files rarely change, so key on (mtime_ns, size) and skip the read
# when unchanged. Same idea for the assembled block: identical selected skills
# (+ files unchanged) + budget + language → reuse the previous concatenation.
_SKILL_BODY_CACHE: dict[str, tuple[tuple[int, int], str]] = {}
_SKILL_BODY_CACHE_MAX = 64
_INJECTION_BODY_CACHE: dict[tuple, str] = {}
_INJECTION_BODY_CACHE_MAX = 16

_SKILL_EXECUTION_HINT_EN = (
    "Skill execution (dir may be outside the user workspace — use skill: URIs, do not search workspace):\n"
    '- Read: read("skill:<name>/relative/file")\n'
    '- Run script: bash(command="python skill:<name>/scripts/foo.py") '
    "(host rewrites skill: paths; long jobs → run_in_background=true + taskoutput)\n"
    '- List skill tree: bash(command="ls skill:<name>" or "ls skill:<name>/scripts")\n'
)

_SKILL_EXECUTION_HINT_ZH = (
    "技能执行（目录可能不在用户工作区 — 用 skill: URI，勿搜工作区）：\n"
    '- 读文件：read("skill:<名>/相对路径")\n'
    '- 跑脚本：bash(command="python skill:<名>/scripts/foo.py")'
    "（宿主会改写 skill: 路径；长任务用 run_in_background=true + taskoutput）\n"
    '- 列目录：bash(command="ls skill:<名>" 或 "ls skill:<名>/scripts")\n'
)


def skill_injection_execution_hint(*, prompt_language: str | None = None) -> str:
    lang = str(prompt_language or "").strip().lower()
    if lang.startswith("zh"):
        return _SKILL_EXECUTION_HINT_ZH
    return _SKILL_EXECUTION_HINT_EN


def _stat_signature(path: Path) -> tuple[int, int] | None:
    try:
        st = path.stat()
    except OSError:
        return None
    return (st.st_mtime_ns, st.st_size)


def _read_skill_body(skill: Skill) -> str:
    path = skill.skill_file
    sig = _stat_signature(path)
    cache_key = str(path)
    cached = _SKILL_BODY_CACHE.get(cache_key)
    if sig is not None and cached is not None and cached[0] == sig:
        return cached[1]
    try:
        body = path.read_text(encoding="utf-8")
    except OSError as exc:
        logger.warning("Failed to read skill %s at %s: %s", skill.name, path, exc)
        body = ""
    if sig is not None:
        if len(_SKILL_BODY_CACHE) >= _SKILL_BODY_CACHE_MAX:
            _SKILL_BODY_CACHE.pop(next(iter(_SKILL_BODY_CACHE)), None)
        _SKILL_BODY_CACHE[cache_key] = (sig, body)
    return body


def format_skill_injection_block(skill: Skill, *, contents: str | None = None) -> str:
    body = contents if contents is not None else _read_skill_body(skill)
    location = f"{SKILL_URI_PREFIX}{skill.name}"
    return f"<skill>\n<name>{skill.name}</name>\n<location>{location}</location>\n{body.rstrip()}\n</skill>"


def build_skill_injection_message(
    skills: list[Skill],
    *,
    max_chars: int = _DEFAULT_MAX_CHARS,
    prompt_language: str | None = None,
) -> str:
    """Concatenate selected skill bodies; truncate tail if over budget."""
    if not skills:
        return ""

    sig_parts: list[tuple] = []
    for skill in skills:
        stat = _stat_signature(skill.skill_file) or (0, 0)
        sig_parts.append((skill.name, str(skill.skill_file), stat[0], stat[1]))
    cache_key = (tuple(sig_parts), max_chars, str(prompt_language or "").strip().lower())
    cached = _INJECTION_BODY_CACHE.get(cache_key)
    if cached is not None:
        return cached

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
    body = header + "\n\n".join(parts) + "\n</skill_injection>"
    if len(_INJECTION_BODY_CACHE) >= _INJECTION_BODY_CACHE_MAX:
        _INJECTION_BODY_CACHE.pop(next(iter(_INJECTION_BODY_CACHE)), None)
    _INJECTION_BODY_CACHE[cache_key] = body
    return body
