"""Rewrite skill script paths in host-direct shell commands.

Skill docs often use repo-relative paths like ``skills/public/<name>/scripts/...``
or sandbox virtual paths like ``/mnt/skills/public/...``.  When the session
workspace is ``backend/`` (or any dir without a nested ``skills/`` tree), those
paths fail unless rewritten to the configured skills install root.

Also resolves ``skill:<name>/...`` URIs and bare ``scripts/...`` when exactly one
active skill is set for the current turn (see ``evoflow.skills.active``).
"""

from __future__ import annotations

import re
from pathlib import Path

from evoflow.skills.active import get_active_skills
from evoflow.skills.skill_uri import SKILL_URI_PREFIX, resolve_skill_uri

# Match /mnt/skills/... or skills/public|custom/... (posix or Windows separators).
# Negative lookbehind avoids rewriting inside longer absolute paths.
_SKILLS_PATH_TOKEN = re.compile(
    r"(?<![\w:./\\])"
    r"(?:"
    r"(?P<virtual>/mnt/skills(?P<virtual_rest>[\\/][^\s\"';&|<>()]*)?)"
    r"|"
    r"(?P<repo>skills[\\/]+(?:public|custom)(?P<repo_rest>[\\/][^\s\"';&|<>()]*)?)"
    r"|"
    r"(?P<userhome>(?:\$env:USERPROFILE|%USERPROFILE%|~)[\\/]\.evoflow[\\/]skills(?P<user_rest>[\\/][^\s\"';&|<>()]*)?)"
    r"|"
    r"(?P<skilluri>skill:[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}(?:/[^^\s\"';&|<>()]*)?)"
    r"|"
    r"(?P<relscript>scripts[\\/][^\s\"';&|<>()]+)"
    r")",
    re.IGNORECASE,
)


def _join_skills_host(skills_host: str, relative: str) -> str:
    rel = str(relative or "").replace("\\", "/").lstrip("/")
    if not rel:
        return skills_host
    if "/" in skills_host and "\\" not in skills_host:
        return f"{skills_host.rstrip('/')}/{rel}"
    return str(Path(skills_host) / rel.replace("/", "\\" if "\\" in skills_host else "/"))


def _resolve_skills_container_path() -> str:
    try:
        from evoflow.config import get_app_config

        return str(get_app_config().skills.container_path or "/mnt/skills").rstrip("/")
    except Exception:
        return "/mnt/skills"


def _resolve_skills_host_path() -> Path | None:
    try:
        from evoflow.config import get_app_config

        p = get_app_config().skills.get_skills_path()
        if p.is_dir():
            return p.resolve()
    except Exception:
        pass
    try:
        from evoflow.skills.loader import get_skills_root_path

        p = get_skills_root_path()
        if p.is_dir():
            return p.resolve()
    except Exception:
        pass
    return None


def rewrite_skill_paths_in_command(command: str) -> str:
    """Replace virtual/repo skill paths with the host skills install directory."""
    cmd = str(command or "")
    if not cmd:
        return cmd

    skills_host_path = _resolve_skills_host_path()
    if skills_host_path is None:
        return cmd
    skills_host = str(skills_host_path)
    container_base = _resolve_skills_container_path()

    def _replace(match: re.Match[str]) -> str:
        virtual = match.group("virtual")
        if virtual is not None:
            if virtual == container_base:
                return skills_host
            if virtual.startswith(container_base + "/"):
                rel = virtual[len(container_base) + 1 :]
                return _join_skills_host(skills_host, rel)
            return match.group(0)

        repo = match.group("repo")
        if repo is not None:
            rest = (match.group("repo_rest") or "").replace("\\", "/")
            # skills/public/foo -> public/foo
            parts = repo.replace("\\", "/").split("/", 2)
            if len(parts) >= 3 and parts[0] == "skills":
                rel = parts[1] + (rest or "")
                return _join_skills_host(skills_host, rel)

        userhome = match.group("userhome")
        if userhome is not None:
            rest = (match.group("user_rest") or "").replace("\\", "/")
            return _join_skills_host(skills_host, rest.lstrip("/"))

        skilluri = match.group("skilluri")
        if skilluri is not None:
            resolved = resolve_skill_uri(skilluri, require_enabled=False)
            if resolved is not None:
                return str(resolved)
            return match.group(0)

        relscript = match.group("relscript")
        if relscript is not None:
            active = get_active_skills()
            if len(active) == 1:
                uri = f"{SKILL_URI_PREFIX}{active[0]}/{relscript.replace(chr(92), '/')}"
                resolved = resolve_skill_uri(uri, require_enabled=False)
                if resolved is not None:
                    return str(resolved)
            return match.group(0)

        return match.group(0)

    return _SKILLS_PATH_TOKEN.sub(_replace, cmd)
