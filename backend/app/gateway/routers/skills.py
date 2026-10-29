import asyncio
import logging
import shutil
import tempfile
from pathlib import Path
from urllib.parse import quote

import httpx
from fastapi import APIRouter, File, HTTPException, Request, UploadFile
from pydantic import BaseModel, Field

from app.gateway.path_utils import resolve_thread_virtual_path
from evoflow.authz.http_guard import require_org_admin
from evoflow.config.extensions_config import SkillStateConfig, get_extensions_config, reload_extensions_config
from evoflow.skills import Skill, load_skills
from evoflow.skills.installer import SkillAlreadyExistsError, install_skill_from_archive, install_skill_from_directory
from evoflow.skills.loader import clear_skills_cache, get_skills_root_path

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api", tags=["skills"])


class SkillResponse(BaseModel):
    """Response model for skill information."""

    name: str = Field(..., description="Name of the skill")
    description: str = Field(..., description="Description of what the skill does")
    license: str | None = Field(None, description="License information")
    category: str = Field(..., description="Category of the skill (public or custom)")
    enabled: bool = Field(default=True, description="Whether this skill is enabled")


class SkillsListResponse(BaseModel):
    """Response model for listing all skills."""

    skills: list[SkillResponse]
    skills_root: str | None = Field(default=None, description="生效的技能根目录（EVOFLOW_SKILLS_PATH > EVOFLOW_HOME > 默认 ~/.evoflow/skills）")
    warnings: list[str] = Field(default_factory=list, description="多技能根目录错位告警（装在非生效根的 custom 技能不会被加载）")


class SkillUpdateRequest(BaseModel):
    """Request model for updating a skill."""

    enabled: bool = Field(..., description="Whether to enable or disable the skill")


class SkillInstallRequest(BaseModel):
    """Request model for installing a skill from a .zip file."""

    thread_id: str = Field(..., description="The thread ID where the skill file is located")
    path: str = Field(..., description="Virtual path to the .zip file (e.g., mnt/user-data/outputs/my-skill.zip)")


class SkillInstallResponse(BaseModel):
    """Response model for skill installation."""

    success: bool = Field(..., description="Whether the installation was successful")
    skill_name: str = Field(..., description="Name of the installed skill")
    message: str = Field(..., description="Installation result message")
    install_mode: str | None = Field(
        default=None,
        description=(
            "bound = skill stays at source path (DB registry only); "
            "copy = files under skills/custom; "
            "link = legacy junction/symlink under custom/"
        ),
    )
    bound_path: str | None = Field(
        default=None,
        description="Absolute skill directory when install_mode=bound",
    )
    linked_path: str | None = Field(
        default=None,
        description="Absolute source directory when install_mode=link",
    )


class SkillMarketInstallRequest(BaseModel):
    """Install a skill by downloading its archive from the public SkillHub market."""

    slug: str = Field(..., description="Market skill slug (e.g. weather, github)")
    owner_handle: str | None = Field(default=None, description="Owner handle required when multiple publishers share a slug")


_SKILLHUB_DOWNLOAD_BASE = "https://wry-manatee-359.convex.site/api/v1/download"


class SkillDeleteResponse(BaseModel):
    """Response model for deleting a custom skill."""

    success: bool = Field(..., description="Whether the skill directory was removed")
    skill_name: str = Field(..., description="Name of the deleted skill")
    message: str = Field(..., description="Human-readable result message")


def _resolve_skills_base_path() -> Path:
    """Same root as ``load_skills`` when config is available."""
    try:
        from evoflow.config import get_app_config

        return get_app_config().skills.get_skills_path()
    except Exception:
        return get_skills_root_path()


def _scope_skill_roots_from_request(request: Request | None):
    try:
        from evoflow.authz.context import resolve_request_authz
        from evoflow.authz.skill_roots import scope_skill_roots_for_principal

        ctx = resolve_request_authz(request)
        return scope_skill_roots_for_principal(ctx.get("principal"), session_scope_id=ctx.get("scope_id"))
    except Exception:
        return None


def _load_skills_for_request(request: Request | None, *, enabled_only: bool = False):
    return load_skills(
        enabled_only=enabled_only,
        scope_skill_roots=_scope_skill_roots_from_request(request),
    )


def _install_skills_root_for_request(request: Request | None) -> Path:
    """Prefer personal scope skills root; fall back to legacy primary."""
    try:
        from evoflow.authz.context import resolve_request_principal
        from evoflow.authz.scope_paths import writable_skills_root_for_principal

        root = writable_skills_root_for_principal(resolve_request_principal(request))
        if root is not None:
            root.mkdir(parents=True, exist_ok=True)
            (root / "custom").mkdir(parents=True, exist_ok=True)
            return root
    except Exception:
        logger.debug("personal skills root unavailable; using primary", exc_info=True)
    return _resolve_skills_base_path()


def _prune_empty_parents_under_custom(skill_dir: Path, custom_root: Path) -> None:
    """Remove empty ancestor directories up to (but not including) ``custom_root``."""
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


def _skill_to_response(skill: Skill) -> SkillResponse:
    """Convert a Skill object to a SkillResponse."""
    return SkillResponse(
        name=skill.name,
        description=skill.description,
        license=skill.license,
        category=skill.category,
        enabled=skill.enabled,
    )


@router.get(
    "/skills",
    response_model=SkillsListResponse,
    summary="List All Skills",
    description="Retrieve a list of all available skills from both public and custom directories.",
)
async def list_skills(request: Request) -> SkillsListResponse:
    try:
        # 技能目录扫描（读每个 SKILL.md frontmatter）是阻塞 I/O，不下事件循环
        skills = await asyncio.to_thread(_load_skills_for_request, request, enabled_only=False)
        skills_root: str | None = None
        warnings: list[str] = []
        try:
            from evoflow.skills.loader import describe_skills_root_context

            ctx = describe_skills_root_context()
            skills_root = ctx.get("active")
            warnings = list(ctx.get("warnings") or [])
        except Exception:
            logger.debug("describe_skills_root_context failed", exc_info=True)
        return SkillsListResponse(
            skills=[_skill_to_response(skill) for skill in skills],
            skills_root=skills_root,
            warnings=warnings,
        )
    except Exception as e:
        logger.error(f"Failed to load skills: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Failed to load skills: {str(e)}")


@router.get(
    "/skills/{skill_name}",
    response_model=SkillResponse,
    summary="Get Skill Details",
    description="Retrieve detailed information about a specific skill by its name.",
)
async def get_skill(request: Request, skill_name: str) -> SkillResponse:
    try:
        # 技能目录扫描（读每个 SKILL.md frontmatter）是阻塞 I/O，不下事件循环
        skills = await asyncio.to_thread(_load_skills_for_request, request, enabled_only=False)
        wanted = str(skill_name or "").strip().lower()
        skill = next((s for s in skills if str(s.name or "").strip().lower() == wanted), None)

        if skill is None:
            raise HTTPException(status_code=404, detail=f"Skill '{skill_name}' not found")

        return _skill_to_response(skill)
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to get skill {skill_name}: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Failed to get skill: {str(e)}")


@router.put(
    "/skills/{skill_name}",
    response_model=SkillResponse,
    summary="Update Skill",
    description="Update a skill's enabled status by modifying the extensions_config.json file.",
)
async def update_skill(http_request: Request, skill_name: str, request: SkillUpdateRequest) -> SkillResponse:
    # Global enablement is install-wide — only org admins may flip it.
    require_org_admin(http_request)
    try:
        skills = await asyncio.to_thread(_load_skills_for_request, http_request, enabled_only=False)
        skill = next((s for s in skills if s.name == skill_name), None)

        if skill is None:
            raise HTTPException(status_code=404, detail=f"Skill '{skill_name}' not found")

        from evoflow.config.extensions_config import save_extensions_to_db
        from evoflow.persistence import config_repositories as cfg_repo

        cfg_repo.set_skill_enabled(skill_name, request.enabled)
        extensions_config = get_extensions_config()
        extensions_config.skills[skill_name] = SkillStateConfig(enabled=request.enabled)
        save_extensions_to_db(extensions_config)
        reload_extensions_config()
        logger.info("Skill '%s' enabled=%s saved to SQLite", skill_name, request.enabled)

        clear_skills_cache()
        skills = await asyncio.to_thread(_load_skills_for_request, http_request, enabled_only=False)
        updated_skill = next((s for s in skills if s.name == skill_name), None)

        if updated_skill is None:
            raise HTTPException(status_code=500, detail=f"Failed to reload skill '{skill_name}' after update")

        logger.info(f"Skill '{skill_name}' enabled status updated to {request.enabled}")
        return _skill_to_response(updated_skill)

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to update skill {skill_name}: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Failed to update skill: {str(e)}")


@router.delete(
    "/skills/{skill_name}",
    response_model=SkillDeleteResponse,
    summary="Delete Skill",
    description=(
        "Delete a custom skill. Bound (in-place) skills are only unregistered in SQLite — "
        "the source folder is left untouched. Copied skills under skills/custom/ are removed "
        "from disk. Built-in public skills cannot be deleted."
    ),
)
async def delete_skill(http_request: Request, skill_name: str) -> SkillDeleteResponse:
    try:
        from evoflow.persistence import config_repositories as cfg_repo
        from evoflow.skills.bound import is_bound_registry
        from evoflow.skills.installer import is_link_or_junction, remove_link_or_junction

        skills = await asyncio.to_thread(_load_skills_for_request, http_request, enabled_only=False)
        skill = next((s for s in skills if s.name == skill_name), None)

        if skill is None:
            raise HTTPException(status_code=404, detail=f"Skill '{skill_name}' not found")

        reg = cfg_repo.get_skill_registry(skill_name) or {}
        bound = is_bound_registry(reg)

        if skill.category not in ("custom", "personal") and not bound:
            # Allow deleting skills that live under a personal/custom tree.
            if not str(getattr(skill, "skill_dir", "")).replace("\\", "/").endswith(f"/custom/{skill_name}") and "/custom/" not in str(getattr(skill, "skill_dir", "")).replace("\\", "/"):
                raise HTTPException(
                    status_code=403,
                    detail="Built-in public skills cannot be deleted; only custom / bound skills",
                )

        if bound:
            cfg_repo.delete_skill_registry(skill_name)
            reload_extensions_config()
            clear_skills_cache()
            logger.info("Unregistered bound skill '%s' (source left in place)", skill_name)
            return SkillDeleteResponse(
                success=True,
                skill_name=skill_name,
                message=f"Skill '{skill_name}' unregistered (source folder left in place)",
            )

        skill_dir = skill.skill_dir.resolve()
        # Prefer the skill's own source root custom/ when known.
        source_root = getattr(skill, "source_root", None)
        if source_root is not None:
            custom_root = (Path(source_root) / "custom").resolve()
        else:
            custom_root = (_install_skills_root_for_request(http_request) / "custom").resolve()

        slot = custom_root / skill_name
        if slot.is_symlink() or is_link_or_junction(slot):
            await asyncio.to_thread(remove_link_or_junction, slot)
        else:
            try:
                skill_dir.relative_to(custom_root)
            except ValueError as e:
                raise HTTPException(
                    status_code=400,
                    detail="Skill directory is not under skills/custom; refusing to delete",
                ) from e

            # 技能目录可能包含大量文件，rmtree 是阻塞 I/O，不下事件循环
            await asyncio.to_thread(shutil.rmtree, skill_dir, ignore_errors=False)
            _prune_empty_parents_under_custom(skill_dir, custom_root)

        cfg_repo.delete_skill_registry(skill_name)
        reload_extensions_config()
        logger.info("Removed skill '%s' from SQLite registry", skill_name)

        clear_skills_cache()
        logger.info("Deleted custom skill '%s' at %s", skill_name, skill_dir)
        return SkillDeleteResponse(
            success=True,
            skill_name=skill_name,
            message=f"Skill '{skill_name}' deleted from disk",
        )

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to delete skill {skill_name}: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Failed to delete skill: {str(e)}")


@router.post(
    "/skills/install",
    response_model=SkillInstallResponse,
    summary="Install Skill",
    description="Install a skill from a .zip file located in the thread's user-data directory.",
)
async def install_skill(http_request: Request, request: SkillInstallRequest) -> SkillInstallResponse:
    try:
        skill_file_path = resolve_thread_virtual_path(request.thread_id, request.path)
        result = install_skill_from_archive(
            skill_file_path,
            skills_root=_install_skills_root_for_request(http_request),
        )
        clear_skills_cache()
        return SkillInstallResponse(**result)
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except SkillAlreadyExistsError as e:
        raise HTTPException(status_code=409, detail=str(e))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to install skill: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Failed to install skill: {str(e)}")


@router.post(
    "/skills/install-local",
    response_model=SkillInstallResponse,
    summary="Install Local Skill",
    description="Upload a .zip file directly and install it. No thread_id required.",
)
async def install_skill_local(http_request: Request, file: UploadFile = File(...)) -> SkillInstallResponse:
    """Upload a .zip file directly and install it.

    This endpoint accepts a multipart file upload of a .zip archive,
    saves it to a temporary location, and installs it into the custom skills directory.
    """
    if not file.filename:
        raise HTTPException(status_code=400, detail="No file provided")
    ext = Path(file.filename).suffix.lower()
    if ext != ".zip":
        raise HTTPException(status_code=400, detail="File must have .zip extension")

    tmp_path: str | None = None
    try:
        content = await file.read()
        if len(content) < 64:
            raise HTTPException(status_code=400, detail="File is too small or empty")

        suffix = ext  # preserve original extension
        with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
            tmp.write(content)
            tmp_path = tmp.name

        result = install_skill_from_archive(
            tmp_path,
            skills_root=_install_skills_root_for_request(http_request),
        )
        clear_skills_cache()
        return SkillInstallResponse(**result)
    except SkillAlreadyExistsError as e:
        raise HTTPException(status_code=409, detail=str(e)) from e
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to install local skill: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Failed to install local skill: {str(e)}")
    finally:
        if tmp_path:
            try:
                Path(tmp_path).unlink(missing_ok=True)
            except OSError:
                pass


class SkillInstallFromPathRequest(BaseModel):
    """Register or install a skill from a local directory path on the server."""

    path: str = Field(..., description="Absolute path to the skill directory on the server")
    mode: str | None = Field(
        default="bound",
        description=(
            "bound (default): keep skill in place; only register absolute path in DB. "
            "copy: copy into skills/custom. link: legacy junction under custom/."
        ),
    )
    link: bool = Field(
        default=False,
        description=(
            "Deprecated. When mode is omitted and link=true, treated as mode=bound "
            "(in-place register). Prefer mode=bound."
        ),
    )


@router.post(
    "/skills/install-from-path",
    response_model=SkillInstallResponse,
    summary="Install Skill from Local Path",
    description=(
        "Register a skill from a local directory (must contain SKILL.md). "
        "Default mode=bound keeps the folder in place and only writes evoflow_skills; "
        "scripts stay reachable as skill:<name>/relative/path."
    ),
)
async def install_skill_from_path(http_request: Request, request: SkillInstallFromPathRequest) -> SkillInstallResponse:
    """Register a skill from a local directory path (default: in-place / bound)."""
    try:
        mode = (request.mode or "").strip().lower() or None
        if mode is None and request.link:
            mode = "bound"
        if mode is None:
            mode = "bound"
        result = install_skill_from_directory(
            request.path,
            skills_root=_install_skills_root_for_request(http_request),
            mode=mode,
            link=bool(request.link),
        )
        clear_skills_cache()
        return SkillInstallResponse(**result)
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except SkillAlreadyExistsError as e:
        raise HTTPException(status_code=409, detail=str(e))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to install skill from path: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Failed to install skill from path: {str(e)}")


@router.post(
    "/skills/install-from-market",
    response_model=SkillInstallResponse,
    summary="Install skill from SkillHub market",
    description="Download a skill archive by slug from the public SkillHub CDN and install it into custom skills.",
)
async def install_skill_from_market(http_request: Request, request: SkillMarketInstallRequest) -> SkillInstallResponse:
    slug = str(request.slug or "").strip()
    if not slug or ".." in slug or slug.startswith("/"):
        raise HTTPException(status_code=422, detail="Invalid slug")
    owner = str(request.owner_handle or "").strip()
    url = f"{_SKILLHUB_DOWNLOAD_BASE}?slug={quote(slug, safe='')}"
    if owner:
        url += f"&ownerHandle={quote(owner, safe='')}"
    tmp_path: str | None = None
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(60.0)) as client:
            r = await client.get(url, headers={"User-Agent": "EvoFlow-Gateway/1.0"})
            r.raise_for_status()
            data = r.content
        if len(data) < 64:
            raise HTTPException(status_code=502, detail="Empty or invalid download from market")
        with tempfile.NamedTemporaryFile(suffix=".zip", delete=False) as tmp:
            tmp.write(data)
            tmp_path = tmp.name
        result = install_skill_from_archive(
            tmp_path,
            skills_root=_install_skills_root_for_request(http_request),
        )
        clear_skills_cache()
        return SkillInstallResponse(**result)
    except SkillAlreadyExistsError as e:
        raise HTTPException(status_code=409, detail=str(e)) from e
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e)) from e
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    except httpx.HTTPStatusError as e:
        logger.warning("SkillHub download failed: %s %s", e.response.status_code, url)
        raise HTTPException(
            status_code=502,
            detail=f"Market download failed: HTTP {e.response.status_code}",
        ) from e
    except HTTPException:
        raise
    except Exception as e:
        logger.error("install-from-market failed: %s", e, exc_info=True)
        raise HTTPException(status_code=500, detail=f"Failed to install from market: {e}") from e
    finally:
        if tmp_path:
            try:
                Path(tmp_path).unlink(missing_ok=True)
            except OSError:
                pass
