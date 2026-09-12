"""Skill directory layout validation."""

from __future__ import annotations

from pathlib import Path

ALLOWED_SKILL_SUBDIRS = frozenset({"references", "templates", "scripts", "assets"})
ALLOWED_SKILL_ROOT_FILES = frozenset({"SKILL.md", "README.md", "LICENSE", "LICENSE.md"})
BLOCKED_SKILL_INSTALL_PARTS = frozenset({"__MACOSX", "__pycache__", "node_modules", ".git"})


def validate_skill_relative_path(file_path: str) -> tuple[bool, str]:
    """Validate a relative path for skill_manager write_file/remove_file."""
    if not file_path:
        return False, "file_path is required"
    normalized = Path(file_path)
    if ".." in file_path:
        return False, "Path traversal ('..') is not allowed"
    if not normalized.parts or normalized.parts[0] not in ALLOWED_SKILL_SUBDIRS:
        allowed = ", ".join(sorted(ALLOWED_SKILL_SUBDIRS))
        return False, f"File must be under one of: {allowed}. Got: '{file_path}'"
    if len(normalized.parts) < 2:
        return False, f"Provide a file path, not a directory. Example: '{normalized.parts[0]}/myfile.md'"
    return True, ""


def validate_skill_tree(skill_dir: Path) -> tuple[bool, str]:
    """Ensure installed skill files follow the same layout as skill_manager."""
    root = skill_dir.resolve()
    skill_md = root / "SKILL.md"
    if not skill_md.is_file():
        return False, "SKILL.md not found"

    for path in root.rglob("*"):
        if path.is_dir():
            rel_parts = path.relative_to(root).parts
            if rel_parts and rel_parts[0] not in ALLOWED_SKILL_SUBDIRS:
                return False, f"Disallowed directory: {'/'.join(rel_parts)}"
            continue

        rel = path.relative_to(root)
        if len(rel.parts) == 1:
            if rel.name not in ALLOWED_SKILL_ROOT_FILES:
                return False, f"Disallowed root file: {rel.name}"
        elif rel.parts[0] not in ALLOWED_SKILL_SUBDIRS:
            return False, f"Disallowed path: {rel.as_posix()}"

    return True, "OK"


def validate_skill_install_layout(skill_dir: Path) -> tuple[bool, str]:
    """Relaxed layout checks for installing archives from disk or the market.

    Unlike :func:`validate_skill_tree` (used by skill_manager writes), install
    accepts any top-level folders such as ``engine`` or ``vendor`` as long as
    ``SKILL.md`` exists and paths are not hidden metadata or blocked artifacts.
    """
    root = skill_dir.resolve()
    if not (root / "SKILL.md").is_file():
        return False, "SKILL.md not found"

    for path in root.rglob("*"):
        rel = path.relative_to(root)
        for part in rel.parts:
            if part in BLOCKED_SKILL_INSTALL_PARTS:
                return False, f"Blocked path component: {part}"
            if part.startswith(".") and part not in {".", ".."}:
                return False, f"Hidden path not allowed: {rel.as_posix()}"

    return True, "OK"
