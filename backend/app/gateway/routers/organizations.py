"""Organization Pack / 资源包 Gateway API — Phase 1."""

from __future__ import annotations

import json
import logging
from typing import Any, Literal

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field

from evoflow.organizations.export import OrganizationExportError, export_organization
from evoflow.organizations.installer import (
    OrganizationInstallError,
    install_organization,
    preflight_organization,
    uninstall_organization,
)
from evoflow.organizations.registry import get_org_instance, list_org_instances

router = APIRouter(prefix="/api/organizations", tags=["organizations"])

logger = logging.getLogger(__name__)


class SourceSpec(BaseModel):
    type: Literal["path", "zip_path", "zip_url", "market_path"] = "path"
    path: str | None = None
    url: str | None = None
    repo: str | None = None


class InstallOptions(BaseModel):
    id_prefix: str = ""
    conflict_policy: Literal["fail", "skip", "replace"] = "fail"


class PreflightRequest(BaseModel):
    source: SourceSpec
    workspace_path: str | None = None
    options: InstallOptions | None = None


class InstallRequest(BaseModel):
    source: SourceSpec
    workspace_path: str | None = None
    options: InstallOptions | None = None


class UpgradeRequest(BaseModel):
    pack_id: str
    source: SourceSpec | None = None
    workspace_path: str | None = None
    options: InstallOptions | None = None


class UninstallOptions(BaseModel):
    keep_primitives: bool = False
    keep_workspace: bool = True
    keep_vault_data: bool = True


class UninstallRequest(BaseModel):
    org_instance_id: str
    options: UninstallOptions | None = None


class ExportPackMeta(BaseModel):
    id: str = "exported-pack"
    name: str = "导出的资源包"
    version: str = "1.0.0"
    kind: str | None = None
    description: str = ""


class ExportInclude(BaseModel):
    employee_codes: list[str] = Field(default_factory=list)
    app_ids: list[str] = Field(default_factory=list)
    agent_codes: list[str] = Field(default_factory=list)
    skill_names: list[str] = Field(default_factory=list)
    extension_ids: list[str] = Field(default_factory=list)
    mcp_ids: list[str] = Field(default_factory=list)
    vault_ids: list[str] = Field(default_factory=list)
    include_vault_data: bool = False


class ExportOutput(BaseModel):
    dir: str
    zip: bool = False
    zip_path: str | None = None


class ExportRequest(BaseModel):
    pack: ExportPackMeta
    include: ExportInclude
    output: ExportOutput


def _source_dict(src: SourceSpec) -> dict[str, Any]:
    return {
        "type": src.type,
        "path": src.path,
        "url": src.url,
        "repo": src.repo,
    }


def _options_dict(opts: InstallOptions | None) -> dict[str, Any]:
    if opts is None:
        return {}
    return opts.model_dump()


@router.post("/preflight")
async def api_preflight(body: PreflightRequest) -> dict[str, Any]:
    return preflight_organization(
        source=_source_dict(body.source),
        workspace_path=body.workspace_path,
        options=_options_dict(body.options),
    )


@router.post("/install")
async def api_install(body: InstallRequest) -> dict[str, Any]:
    try:
        return install_organization(
            source=_source_dict(body.source),
            workspace_path=body.workspace_path,
            options=_options_dict(body.options),
        )
    except OrganizationInstallError as e:
        status = 422
        raise HTTPException(
            status_code=status,
            detail={"ok": False, "error": str(e), "rolled_back": e.rolled_back},
        ) from e


@router.get("")
@router.get("/")
async def api_list(
    status: str | None = Query("active", description="active|uninstalled|empty for all"),
) -> dict[str, Any]:
    st = None if status == "" else status
    items = list_org_instances(status=st)
    return {"items": items, "count": len(items)}


_market_catalog_cache: dict[str, Any] | None = None
"""上次成功拉取的市场目录。外网 GitHub 不可达时兜底返回（stale-while-error），
避免资源中心/插件市场每次打开都干等外网超时。"""

_market_catalog_failed_until: float = 0.0
"""负缓存：外网连续不可达时，5 分钟内直接返回空目录，不再每次干等超时。"""

_MARKET_CATALOG_TIMEOUT_S = 8
_MARKET_CATALOG_FAILURE_TTL_S = 300


def _market_cache_path():
    from evoflow.config.data_paths import resolve_data_base_dir

    base = resolve_data_base_dir()
    cache_dir = base / "cache"
    try:
        cache_dir.mkdir(parents=True, exist_ok=True)
    except Exception:
        return None
    return cache_dir / "market-catalog.json"


def _load_market_cache_from_disk() -> dict[str, Any] | None:
    """跨进程/重启的市场目录缓存：外网不可达的机器首次打开也能秒回。"""
    global _market_catalog_cache
    if _market_catalog_cache:
        return _market_catalog_cache
    path = _market_cache_path()
    if not path or not path.is_file():
        return None
    try:
        with path.open("r", encoding="utf-8") as f:
            data = json.load(f)
        if isinstance(data, dict) and isinstance(data.get("packs"), list):
            _market_catalog_cache = data
            return data
    except Exception:
        logger.debug("market catalog disk cache unreadable", exc_info=True)
    return None


def _save_market_cache_to_disk(data: dict[str, Any]) -> None:
    path = _market_cache_path()
    if not path:
        return
    try:
        tmp = path.with_suffix(".tmp")
        with tmp.open("w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False)
        tmp.replace(path)
    except Exception:
        logger.debug("market catalog disk cache write failed", exc_info=True)


def _annotate_catalog_install_state(data: dict[str, Any]) -> dict[str, Any]:
    from evoflow.organizations.pack_upgrade import annotate_catalog_packs

    out = dict(data or {})
    out["packs"] = annotate_catalog_packs(list(out.get("packs") or []))
    out["updates"] = [
        {
            "pack_id": p.get("id"),
            "installed_version": p.get("_installedVersion"),
            "available_version": p.get("version"),
        }
        for p in out["packs"]
        if p.get("_updateAvailable")
    ]
    return out


@router.get("/market/catalog")
async def api_market_catalog(force: bool = Query(False)) -> dict[str, Any]:
    """Merged catalog from official GitHub + user-added market sources (LAN/custom)."""
    import asyncio

    from evoflow.organizations.market_sources import fetch_merged_catalog

    global _market_catalog_cache, _market_catalog_failed_until

    def _fetch() -> dict[str, Any]:
        return fetch_merged_catalog(force=bool(force))

    try:
        data = await asyncio.to_thread(_fetch)
        data = _annotate_catalog_install_state(data)
        _market_catalog_cache = data
        _market_catalog_failed_until = 0.0
        _save_market_cache_to_disk(data)
        return data
    except Exception as e:
        import time

        _market_catalog_failed_until = time.monotonic() + _MARKET_CATALOG_FAILURE_TTL_S
        cached = _market_catalog_cache or _load_market_cache_from_disk()
        if cached:
            stale = _annotate_catalog_install_state(dict(cached))
            stale["stale"] = True
            return stale
        raise HTTPException(
            status_code=502,
            detail=f"Failed to fetch market catalog: {e}",
        ) from e


@router.get("/market/updates")
async def api_market_updates() -> dict[str, Any]:
    """Installed packs that have a newer version available in the market catalog."""
    import asyncio

    from evoflow.organizations.pack_upgrade import list_available_updates

    try:
        items = await asyncio.to_thread(list_available_updates)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Failed to list updates: {e}") from e
    return {"ok": True, "items": items, "count": len(items)}


@router.post("/upgrade")
async def api_upgrade(body: UpgradeRequest) -> dict[str, Any]:
    """Upgrade an installed pack to the catalog version (replace + drop stale instances)."""
    from evoflow.organizations.pack_upgrade import upgrade_organization

    try:
        src = _source_dict(body.source) if body.source is not None else None
        return upgrade_organization(
            pack_id=body.pack_id,
            source=src,
            workspace_path=body.workspace_path,
            options=_options_dict(body.options),
        )
    except OrganizationInstallError as e:
        raise HTTPException(
            status_code=422,
            detail={"ok": False, "error": str(e), "rolled_back": e.rolled_back},
        ) from e
    except ValueError as e:
        raise HTTPException(status_code=422, detail={"ok": False, "error": str(e)}) from e


@router.get("/{org_instance_id}")
async def api_get(org_instance_id: str) -> dict[str, Any]:
    if org_instance_id in ("market", "upgrade"):
        raise HTTPException(status_code=404, detail="Not found")
    inst = get_org_instance(org_instance_id)
    if not inst:
        raise HTTPException(status_code=404, detail=f"Organization not found: {org_instance_id}")
    out = dict(inst)
    arts = out.get("artifacts") if isinstance(out.get("artifacts"), dict) else {}
    pack_roots = arts.get("pack_root") if isinstance(arts.get("pack_root"), list) else []
    if pack_roots:
        out["pack_root"] = str(pack_roots[0] or "")
    # Resolve live extension install paths from registry (survives relinks)
    ext_ids = arts.get("extensions") if isinstance(arts.get("extensions"), list) else []
    if ext_ids:
        try:
            from evoflow.admin.ui_extensions_registry import read_registry

            by_id = {str(r.get("id") or ""): r for r in read_registry() if isinstance(r, dict)}
            paths = []
            for eid in ext_ids:
                row = by_id.get(str(eid))
                if not row:
                    continue
                paths.append(
                    {
                        "id": str(eid),
                        "name": str((row.get("manifest") or {}).get("name") or eid),
                        "install_path": str(row.get("install_path") or ""),
                        "source": str(row.get("source") or ""),
                    }
                )
            if paths:
                out["extension_installs"] = paths
        except Exception:
            logger.debug("enrich extension_installs failed", exc_info=True)
    return out


@router.post("/uninstall")
async def api_uninstall(body: UninstallRequest) -> dict[str, Any]:
    try:
        opts = body.options.model_dump() if body.options else {}
        return uninstall_organization(body.org_instance_id, options=opts)
    except OrganizationInstallError as e:
        raise HTTPException(status_code=404, detail=str(e)) from e


@router.post("/export")
async def api_export(body: ExportRequest) -> dict[str, Any]:
    try:
        return export_organization(
            pack=body.pack.model_dump(),
            include=body.include.model_dump(),
            output=body.output.model_dump(),
        )
    except OrganizationExportError as e:
        raise HTTPException(status_code=422, detail={"ok": False, "error": str(e)}) from e
