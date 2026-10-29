"""In-place (bound) skill registration — skill stays on disk; only DB points at it.

Unlike copy/link installs under ``skills/custom/``, a bound skill keeps its
authoritative tree wherever the user pointed (e.g. ``D:/demo/my-skill``).
Discovery merges those absolute dirs; ``skill:<name>/…`` resolves via
``find_skill_directory`` → real ``skill_dir``.
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any

from evoflow.skills.skill_scope import SkillScope
from evoflow.skills.types import Skill

logger = logging.getLogger(__name__)

INSTALL_MODE_BOUND = "bound"


def is_bound_meta(meta: Any) -> bool:
    return isinstance(meta, dict) and str(meta.get("install_mode") or "").strip().lower() == INSTALL_MODE_BOUND


def is_bound_registry(reg: dict[str, Any] | None) -> bool:
    if not isinstance(reg, dict):
        return False
    if is_bound_meta(reg.get("meta")):
        return True
    # Absolute source_path with SKILL.md also counts (legacy / repaired rows).
    raw = str(reg.get("source_path") or "").strip()
    if not raw:
        return False
    try:
        p = Path(raw).expanduser()
        if p.is_absolute() and (p / "SKILL.md").is_file():
            return True
    except OSError:
        return False
    return False


def list_bound_skill_dirs() -> list[Path]:
    """Absolute skill directories registered as install_mode=bound (or absolute source_path)."""
    try:
        from evoflow.persistence import config_repositories as cfg_repo
    except Exception:
        return []

    out: list[Path] = []
    seen: set[str] = set()
    try:
        registry = cfg_repo.list_skill_registry()
    except Exception:
        logger.debug("list_bound_skill_dirs: registry unavailable", exc_info=True)
        return []

    for _name, reg in (registry or {}).items():
        if not is_bound_registry(reg):
            continue
        meta = reg.get("meta") if isinstance(reg.get("meta"), dict) else {}
        raw = str(meta.get("bound_path") or reg.get("source_path") or "").strip()
        if not raw:
            continue
        try:
            p = Path(raw).expanduser().resolve()
        except OSError:
            continue
        if not p.is_dir() or not (p / "SKILL.md").is_file():
            continue
        key = str(p).replace("\\", "/").lower()
        if key in seen:
            continue
        seen.add(key)
        out.append(p)
    return out


def parse_bound_skill(skill_dir: Path, *, name_hint: str | None = None) -> Skill | None:
    """Parse a single-folder skill into a CUSTOM-scope Skill for discovery."""
    from evoflow.skills.parser import parse_skill_file

    skill_file = skill_dir / "SKILL.md"
    if not skill_file.is_file():
        return None
    parsed = parse_skill_file(skill_file, category="custom", relative_path=Path("."))
    if parsed is None:
        return None
    return Skill(
        name=parsed.name or (name_hint or skill_dir.name),
        description=parsed.description,
        license=parsed.license,
        skill_dir=parsed.skill_dir,
        skill_file=parsed.skill_file,
        relative_path=Path("."),
        category="custom",
        enabled=True,
        scope=SkillScope.CUSTOM,
        source_root=skill_dir.resolve(),
        when_to_use=getattr(parsed, "when_to_use", "") or "",
    )


def merge_bound_skills(skills: list[Skill]) -> list[Skill]:
    """Ensure DB-bound skills appear in the loaded list (CUSTOM scope)."""
    bound_dirs = list_bound_skill_dirs()
    if not bound_dirs:
        return skills

    existing_dirs = {str(s.skill_dir.resolve()).replace("\\", "/").lower() for s in skills if s.skill_dir}
    by_name = {s.name.strip().lower(): s for s in skills if s.name}

    out = list(skills)
    for skill_dir in bound_dirs:
        key = str(skill_dir.resolve()).replace("\\", "/").lower()
        if key in existing_dirs:
            # Upgrade a same-path EXTERNAL discovery hit to CUSTOM if needed.
            for i, s in enumerate(out):
                try:
                    if str(s.skill_dir.resolve()).replace("\\", "/").lower() != key:
                        continue
                except OSError:
                    continue
                if int(getattr(s, "scope", SkillScope.PUBLIC)) < int(SkillScope.CUSTOM):
                    out[i] = Skill(
                        name=s.name,
                        description=s.description,
                        license=s.license,
                        skill_dir=s.skill_dir,
                        skill_file=s.skill_file,
                        relative_path=s.relative_path,
                        category="custom",
                        enabled=s.enabled,
                        scope=SkillScope.CUSTOM,
                        source_root=skill_dir,
                        when_to_use=getattr(s, "when_to_use", "") or "",
                    )
            continue

        parsed = parse_bound_skill(skill_dir)
        if parsed is None:
            continue
        nkey = parsed.name.strip().lower()
        prior = by_name.get(nkey)
        if prior is not None and int(getattr(prior, "scope", SkillScope.PUBLIC)) >= int(SkillScope.CUSTOM):
            # Same name already present at user scope from another path — keep prior.
            logger.debug(
                "Bound skill %r at %s shadowed by existing %s",
                parsed.name,
                skill_dir,
                prior.skill_dir,
            )
            continue
        out.append(parsed)
        by_name[nkey] = parsed
        existing_dirs.add(key)
    return out


def upsert_bound_registry(
    *,
    skill_name: str,
    skill_dir: Path,
    skill_md: str | None,
    description: str = "",
    enabled: bool = True,
) -> None:
    from evoflow.persistence import config_repositories as cfg_repo

    resolved = skill_dir.resolve()
    cfg_repo.upsert_skill_registry(
        skill_name,
        enabled=enabled,
        skill_md=skill_md,
        source_path=str(resolved),
        category="custom",
        meta={
            "install_mode": INSTALL_MODE_BOUND,
            "bound_path": str(resolved),
            "description": description or "",
        },
    )
