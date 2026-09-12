"""Compact ``skill:<key>`` references for tools and prompts (saves tokens vs long paths)."""

from __future__ import annotations

from pathlib import Path

SKILL_URI_PREFIX = "skill:"


def parse_skill_uri(path: str) -> tuple[str, str] | None:
    """Split ``skill:<key>`` or ``skill:<key>/<rel>`` into (key, relative_path_under_skill).

    ``relative_path_under_skill`` uses ``/``; empty string means "main SKILL.md only".
    Rejects ``..`` path segments at parse time (defense in depth before resolve).
    """
    if not isinstance(path, str) or not path.startswith(SKILL_URI_PREFIX):
        return None
    rest = path[len(SKILL_URI_PREFIX) :].strip()
    if not rest:
        return None
    rest = rest.replace("\\", "/")
    if "/" in rest:
        head, tail = rest.split("/", 1)
        key = head.strip().lower()
        rel = tail.strip()
        if not key:
            return None
        # Reject traversal / absolute segments early.
        parts = [p for p in rel.split("/") if p not in ("", ".")]
        if any(p == ".." for p in parts) or rel.startswith("/"):
            return None
        return (key, "/".join(parts) if parts else "")
    return (rest.strip().lower(), "")


def resolve_skill_uri(path: str, *, default_file: str = "SKILL.md", require_enabled: bool = True) -> Path | None:
    """Resolve ``skill:`` path to an absolute file path, or None if missing / traversal / policy."""
    parsed = parse_skill_uri(path)
    if parsed is None:
        return None
    key, rel = parsed
    from evoflow.skills.loader import find_skill_directory

    skill_dir = find_skill_directory(key, require_enabled=require_enabled)
    if skill_dir is None:
        return None
    base = skill_dir.resolve()
    if not rel:
        target = (base / default_file).resolve()
    else:
        cand = (base / rel).resolve()
        try:
            cand.relative_to(base)
        except ValueError:
            return None
        target = cand
    if not target.is_file():
        return None
    return target


def _sample_enabled_skill_names(limit: int = 12) -> list[str]:
    try:
        from evoflow.skills.loader import load_skills

        skills = load_skills(enabled_only=True)
        names = sorted({str(getattr(s, "name", "") or "").strip().lower() for s in skills if getattr(s, "name", None)})
        return [n for n in names if n][:limit]
    except Exception:
        return []


def format_skill_uri_error(path: str, *, require_enabled: bool = True) -> str:
    """Human-readable error when ``resolve_skill_uri`` would return None."""
    raw = str(path or "").strip()
    parsed = parse_skill_uri(raw)
    if parsed is None:
        return f"Error: Invalid skill URI: {raw or '(empty)'}"
    key, rel = parsed
    from evoflow.skills.loader import find_skill_directory

    skill_dir = find_skill_directory(key, require_enabled=False)
    if skill_dir is None:
        sample = _sample_enabled_skill_names()
        hint = f" Enabled skills include: {', '.join(sample)}." if sample else ""
        return f"Error: Unknown skill '{key}'.{hint} Use read_file('skill:<name>') for SKILL.md only."
    if require_enabled and find_skill_directory(key, require_enabled=True) is None:
        return f"Error: Skill '{key}' exists but is disabled in config."
    base = skill_dir.resolve()
    if not rel:
        target = (base / "SKILL.md").resolve()
        if not target.is_file():
            return f"Error: Skill '{key}' has no SKILL.md."
        return f"Error: Cannot resolve skill path: {raw}"
    cand = (base / rel.replace("\\", "/")).resolve()
    try:
        cand.relative_to(base)
    except ValueError:
        return f"Error: Skill path escapes skill root: {raw}"
    if cand.is_dir():
        return (
            f"Error: '{raw}' is a directory, not a file. "
            f'Use terminal (e.g. dir / ls) on skill:{key} to browse, or read_file("skill:{key}/SKILL.md").'
        )
    if not cand.is_file():
        return (
            f"Error: File not found under skill '{key}': {rel}. "
            f'Use terminal (e.g. dir / ls) on skill:{key} to browse; do not guess paths like scripts/.'
        )
    return f"Error: Unknown, disabled, or invalid skill path: {raw}"


def resolve_skill_workdir(workdir: str, *, require_enabled: bool = True) -> Path | None:
    """Resolve ``skill:<key>`` (no subpath) to the skill root directory for ``terminal`` / ``process`` workdir."""
    parsed = parse_skill_uri(workdir)
    if parsed is None:
        return None
    key, rel = parsed
    if rel:
        return None
    from evoflow.skills.loader import find_skill_directory

    d = find_skill_directory(key, require_enabled=require_enabled)
    if d is None or not d.is_dir():
        return None
    return d.resolve()
