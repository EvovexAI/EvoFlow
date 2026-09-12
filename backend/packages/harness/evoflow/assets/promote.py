"""Promote Asset Hub craft → ``skills/custom/`` runtime skills."""

from __future__ import annotations

import logging
import shutil
from pathlib import Path
from typing import Any

from evoflow.assets.paths import EntityRef, entity_root

logger = logging.getLogger(__name__)


def _resolve_craft_skill_dir(entity: EntityRef, craft_name: str) -> Path:
    from evoflow.assets.hub import ensure_entity_tree

    e = entity.normalized()
    ensure_entity_tree(e)
    name = str(craft_name or "").strip().strip("/\\")
    if not name or ".." in name or "/" in name or "\\" in name:
        raise ValueError(f"invalid craft name: {craft_name!r}")
    craft_dir = entity_root(e) / "craft" / name
    if not (craft_dir / "SKILL.md").is_file():
        raise FileNotFoundError(f"craft skill not found: craft/{name}/SKILL.md")
    return craft_dir


def _patch_file_frontmatter(skill_md: Path, extra_lines: list[str]) -> None:
    try:
        text = skill_md.read_text(encoding="utf-8")
    except OSError:
        return
    if not text.startswith("---"):
        return
    parts = text.split("---", 2)
    if len(parts) < 3:
        return
    front = parts[1].rstrip("\n")
    for line in extra_lines:
        key = line.split(":", 1)[0].strip()
        # replace existing key if present
        kept = [ln for ln in front.splitlines() if not ln.strip().startswith(f"{key}:")]
        kept.append(line)
        front = "\n".join(kept)
    skill_md.write_text(f"---\n{front}\n---{parts[2]}", encoding="utf-8")


def promote_craft_to_custom(
    entity: EntityRef,
    craft_name: str,
    *,
    overwrite: bool = False,
) -> dict[str, Any]:
    """Copy ``craft/{name}/`` into ``~/.evoflow/skills/custom/``."""
    from evoflow.skills.installer import SkillAlreadyExistsError, install_skill_from_directory
    from evoflow.skills.loader import clear_skills_cache, get_skills_root_path

    e = entity.normalized()
    src = _resolve_craft_skill_dir(e, craft_name)
    skills_root = get_skills_root_path()
    custom_dir = skills_root / "custom"
    custom_dir.mkdir(parents=True, exist_ok=True)

    # Peek skill name from frontmatter for overwrite cleanup
    peek_name = src.name
    try:
        raw = (src / "SKILL.md").read_text(encoding="utf-8")
        for line in raw.splitlines():
            if line.strip().startswith("name:"):
                peek_name = line.split(":", 1)[1].strip().strip("\"'") or peek_name
                break
    except OSError:
        pass

    target = custom_dir / peek_name
    if target.exists():
        if not overwrite:
            raise SkillAlreadyExistsError(f"Skill '{peek_name}' already exists in skills/custom")
        shutil.rmtree(target)

    try:
        result = install_skill_from_directory(src, skills_root=skills_root)
    except SkillAlreadyExistsError:
        if not overwrite:
            raise
        # Name resolved differently — wipe and retry
        for p in custom_dir.iterdir():
            if p.is_dir() and p.name == peek_name:
                shutil.rmtree(p)
        result = install_skill_from_directory(src, skills_root=skills_root)

    installed_name = str(result.get("skill_name") or peek_name)
    installed_path = custom_dir / installed_name
    if installed_path.is_dir() and (installed_path / "SKILL.md").is_file():
        _patch_file_frontmatter(
            installed_path / "SKILL.md",
            [
                f"promoted_from: craft/{src.name}",
                f"promoted_entity: {e.entity_type}:{e.entity_id}",
            ],
        )
    try:
        _patch_file_frontmatter(
            src / "SKILL.md",
            [f"promoted_to: skills/custom/{installed_name}"],
        )
    except Exception:
        logger.debug("craft promoted_to annotate skipped", exc_info=True)

    try:
        clear_skills_cache()
    except Exception:
        pass

    return {
        "ok": True,
        "skillName": installed_name,
        "craftName": src.name,
        "customPath": str(installed_path.resolve()),
        "skillsRoot": str(skills_root.resolve()),
        "entityType": e.entity_type,
        "entityId": e.entity_id,
        "message": f"已晋升到 skills/custom/{installed_name}",
    }


def list_promotable_crafts(entity: EntityRef) -> list[dict[str, Any]]:
    from evoflow.assets.hub import ensure_entity_tree

    e = entity.normalized()
    ensure_entity_tree(e)
    craft_root = entity_root(e) / "craft"
    out: list[dict[str, Any]] = []
    if not craft_root.is_dir():
        return out
    for child in sorted(craft_root.iterdir(), key=lambda p: p.name.lower()):
        if not child.is_dir() or child.name.startswith("."):
            continue
        skill_md = child / "SKILL.md"
        if not skill_md.is_file():
            continue
        desc = ""
        promoted = False
        try:
            text = skill_md.read_text(encoding="utf-8")[:1200]
            for line in text.splitlines():
                if line.strip().startswith("description:"):
                    desc = line.split(":", 1)[1].strip().strip('"').strip("'")
                if line.strip().startswith("promoted_to:"):
                    promoted = True
        except OSError:
            pass
        out.append(
            {
                "name": child.name,
                "path": f"craft/{child.name}/SKILL.md",
                "description": desc[:200],
                "promoted": promoted,
            }
        )
    return out
