"""Skill admin (loader + SQLite registry, no tools coupling)."""

from __future__ import annotations

import shutil
from pathlib import Path
from typing import Any

from evoflow.admin.errors import ConflictError, ForbiddenError, NotFoundError, ValidationError
from evoflow.config.extensions_config import SkillStateConfig, get_extensions_config, reload_extensions_config, save_extensions_to_db
from evoflow.persistence import config_repositories as cfg_repo
from evoflow.skills import load_skills
from evoflow.skills.installer import SkillAlreadyExistsError, install_skill_from_archive
from evoflow.skills.loader import clear_skills_cache, get_skills_root_path


def _skill_row(skill: Any) -> dict[str, Any]:
    return {
        "name": skill.name,
        "description": skill.description,
        "license": skill.license,
        "category": skill.category,
        "enabled": skill.enabled,
    }


def _find_skill(name: str) -> Any:
    wanted = str(name or "").strip().lower()
    skill = next(
        (s for s in load_skills(enabled_only=False) if str(s.name or "").strip().lower() == wanted),
        None,
    )
    if skill is None:
        raise NotFoundError(f"Skill '{name}' not found")
    return skill


def _resolve_skills_base_path() -> Path:
    try:
        from evoflow.config import get_app_config

        return get_app_config().skills.get_skills_path()
    except Exception:
        return get_skills_root_path()


def _prune_empty_parents_under_custom(skill_dir: Path, custom_root: Path) -> None:
    cr = custom_root.resolve()
    p = skill_dir.resolve().parent
    while p != cr:
        try:
            p.relative_to(cr)
        except ValueError:
            break
        if not p.exists() or any(p.iterdir()):
            break
        nxt = p.parent
        p.rmdir()
        p = nxt


def list_skills(*, enabled_only: bool = False) -> dict[str, Any]:
    skills = load_skills(enabled_only=enabled_only)
    return {"skills": [_skill_row(s) for s in skills]}


def get_skill(name: str) -> dict[str, Any]:
    return _skill_row(_find_skill(name))


def set_skill_enabled(name: str, *, enabled: bool) -> dict[str, Any]:
    _find_skill(name)
    cfg_repo.set_skill_enabled(name, enabled)
    extensions_config = get_extensions_config()
    extensions_config.skills[name] = SkillStateConfig(enabled=enabled)
    save_extensions_to_db(extensions_config)
    reload_extensions_config()
    clear_skills_cache()
    return _skill_row(_find_skill(name))


def install_skill(path: str | Path) -> dict[str, Any]:
    archive = Path(path)
    if not archive.is_file():
        raise NotFoundError(f"Skill archive not found: {archive}")
    try:
        result = install_skill_from_archive(archive)
    except SkillAlreadyExistsError as e:
        raise ConflictError(str(e)) from e
    clear_skills_cache()
    skill_name = result.get("skill_name") if isinstance(result, dict) else result
    return {
        "success": True,
        "skill_name": skill_name,
        "message": f"Skill '{skill_name}' installed successfully",
    }


def delete_skill(name: str) -> dict[str, Any]:
    skill = _find_skill(name)
    if skill.category != "custom":
        raise ForbiddenError("Built-in public skills cannot be deleted; only custom skills under skills/custom/")

    skills_root = _resolve_skills_base_path().resolve()
    custom_root = (skills_root / "custom").resolve()
    skill_dir = skill.skill_dir.resolve()

    try:
        skill_dir.relative_to(custom_root)
    except ValueError as e:
        raise ValidationError("Skill directory is not under skills/custom; refusing to delete") from e

    if skill_dir.exists():
        shutil.rmtree(skill_dir)
        _prune_empty_parents_under_custom(skill_dir, custom_root)

    cfg_repo.delete_skill_registry(name)
    extensions_config = get_extensions_config()
    if name in extensions_config.skills:
        del extensions_config.skills[name]
        save_extensions_to_db(extensions_config)
    reload_extensions_config()
    clear_skills_cache()
    return {
        "success": True,
        "skill_name": name,
        "message": f"Skill '{name}' deleted successfully",
    }


_SKILLHUB_DOWNLOAD_BASE = "https://wry-manatee-359.convex.site/api/v1/download"


def install_skill_from_market(slug: str, owner_handle: str | None = None) -> dict[str, Any]:
    from urllib.parse import quote

    import httpx

    clean = str(slug or "").strip()
    if not clean or ".." in clean or clean.startswith("/"):
        raise ValidationError("Invalid market slug")
    url = f"{_SKILLHUB_DOWNLOAD_BASE}?slug={quote(clean, safe='')}"
    owner = str(owner_handle or "").strip()
    if owner:
        url += f"&ownerHandle={quote(owner, safe='')}"
    import tempfile

    tmp_path: str | None = None
    try:
        with httpx.Client(timeout=60.0) as client:
            resp = client.get(url, headers={"User-Agent": "EvoFlow-CLI/1.0"})
            resp.raise_for_status()
            data = resp.content
        if len(data) < 64:
            raise ValidationError("Empty or invalid download from market")
        with tempfile.NamedTemporaryFile(suffix=".skill", delete=False) as tmp:
            tmp.write(data)
            tmp_path = tmp.name
        try:
            result = install_skill_from_archive(tmp_path)
        except SkillAlreadyExistsError as e:
            raise ConflictError(str(e)) from e
        clear_skills_cache()
        skill_name = result.get("skill_name") if isinstance(result, dict) else result
        return {
            "success": True,
            "skill_name": skill_name,
            "message": f"Skill '{skill_name}' installed from market slug '{clean}'",
        }
    except httpx.HTTPError as e:
        raise ValidationError(f"Market download failed: {e}") from e
    finally:
        if tmp_path:
            try:
                Path(tmp_path).unlink(missing_ok=True)
            except OSError:
                pass
