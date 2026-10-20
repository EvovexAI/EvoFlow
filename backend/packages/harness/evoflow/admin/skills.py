"""Skill admin (loader + SQLite registry, no tools coupling)."""

from __future__ import annotations

import logging
import shutil
from pathlib import Path
from typing import Any

from evoflow.admin.errors import ConflictError, ForbiddenError, NotFoundError, ValidationError
from evoflow.config.extensions_config import SkillStateConfig, get_extensions_config, reload_extensions_config, save_extensions_to_db
from evoflow.persistence import config_repositories as cfg_repo
from evoflow.skills import load_skills
from evoflow.skills.installer import SkillAlreadyExistsError, install_skill_from_archive
from evoflow.skills.loader import clear_skills_cache, get_skills_root_path

logger = logging.getLogger(__name__)


def _skill_row(skill: Any, *, detail: bool = False) -> dict[str, Any]:
    row: dict[str, Any] = {
        "name": skill.name,
        "description": skill.description,
        "license": skill.license,
        "category": skill.category,
        "enabled": skill.enabled,
    }
    if not detail:
        return row
    skill_dir = getattr(skill, "skill_dir", None)
    files: list[str] = []
    manifest: dict[str, Any] | None = None
    if skill_dir is not None:
        try:
            root = Path(skill_dir)
            row["path"] = str(root)
            if root.is_dir():
                for p in sorted(root.rglob("*")):
                    if not p.is_file():
                        continue
                    rel = p.relative_to(root).as_posix()
                    if rel.startswith(".") or "/." in rel:
                        continue
                    files.append(rel)
                    if len(files) >= 80:
                        break
            skill_md = root / "SKILL.md"
            if skill_md.is_file():
                # Lightweight frontmatter peek for detail views (CORE-ASSET-06).
                text = skill_md.read_text(encoding="utf-8", errors="replace")[:4000]
                if text.startswith("---"):
                    end = text.find("\n---", 3)
                    if end > 0:
                        manifest = {"frontmatter": text[3:end].strip(), "has_skill_md": True}
                if manifest is None:
                    manifest = {"has_skill_md": True, "preview": text[:240]}
        except OSError:
            logger.debug("skills detail scan failed for %s", getattr(skill, "name", ""), exc_info=True)
    row["files"] = files
    row["file_count"] = len(files)
    if manifest is not None:
        row["manifest"] = manifest
    return row


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
    out: dict[str, Any] = {"skills": [_skill_row(s) for s in skills]}
    # 生效根 + 多根告警：帮助发现「装在 ~/.evoflow/skills/custom 但 gateway 读 profiles/<id>/skills」类错位。
    try:
        from evoflow.skills.loader import describe_skills_root_context

        ctx = describe_skills_root_context()
        out["skills_root"] = ctx.get("active")
        if ctx.get("warnings"):
            out["warnings"] = ctx["warnings"]
    except Exception:
        logger.debug("describe_skills_root_context failed", exc_info=True)
    return out


def get_skill(name: str) -> dict[str, Any]:
    return _skill_row(_find_skill(name), detail=True)


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
        with httpx.Client(timeout=60.0, follow_redirects=True) as client:
            resp = client.get(url, headers={"User-Agent": "EvoFlow-CLI/1.0"})
            # Map common market misses to clear errors (CORE-ASSET-05).
            if resp.status_code in {404, 410}:
                raise NotFoundError(f"Skill slug '{clean}' not found on market")
            if resp.status_code in {301, 302, 307, 308}:
                loc = resp.headers.get("location") or ""
                raise ValidationError(
                    f"Market download redirected ({resp.status_code}) without a final body"
                    + (f": {loc}" if loc else "")
                    + f"; slug '{clean}' may not exist"
                )
            if resp.status_code >= 400:
                raise ValidationError(
                    f"Market download failed HTTP {resp.status_code} for slug '{clean}'"
                )
            data = resp.content
        if len(data) < 64:
            raise ValidationError(f"Empty or invalid download from market for slug '{clean}'")
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
    except (NotFoundError, ConflictError, ValidationError):
        raise
    except httpx.HTTPError as e:
        raise ValidationError(f"Market download failed for slug '{clean}': {e}") from e
    finally:
        if tmp_path:
            try:
                Path(tmp_path).unlink(missing_ok=True)
            except OSError:
                pass
