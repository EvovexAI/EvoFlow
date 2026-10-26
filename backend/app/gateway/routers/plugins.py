"""ZCode-style plugin management REST API.

All endpoints return the exact wire shapes the vendored ZCode settings UI
consumes (``ZCodePluginsOverviewResult`` and friends), so the frontend
``IPluginManagementService`` HTTP client is a thin pass-through. Plugin state
lives in the ZCode-compatible file layout under the plugin storage root, not
in SQLite — the plugin domain is file-shaped (marketplace caches, install
dirs) and mirrors ZCode storage 1:1.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from evoflow.authz.http_guard import require_org_admin
from evoflow.plugins.service import PluginManagementService
from evoflow.plugins.storage import resolve_storage_root

logger = logging.getLogger(__name__)


def _org_admin_guard(request: Request) -> None:
    require_org_admin(request)


# Read endpoints (overview/list/icon/…) are used by every user for the 「+」插件目录
# and skill picker. Requiring org_admin there spammed ``org_admin required`` on
# session open for non-admins. Mutating routes keep ``Depends(_org_admin_guard)``.
router = APIRouter(prefix="/api/plugins", tags=["plugins"])


def _get_service() -> PluginManagementService:
    return PluginManagementService(resolve_storage_root())


def _to_http_error(error: Exception) -> HTTPException:
    message = str(error)
    lowered = message.lower()
    status = 404 if ("not found" in lowered or "not installed" in lowered) else 400
    return HTTPException(status_code=status, detail=message)


# ---------------------------------------------------------------------------
# Request models
# ---------------------------------------------------------------------------


class AddMarketplaceRequest(BaseModel):
    source: str = Field(..., description="Marketplace source: URL, git URL, owner/repo, or local path")
    dryRun: bool = Field(default=False, description="Validate the source without persisting")


class InstallPluginRequest(BaseModel):
    pluginName: str = Field(..., description="Plugin name inside the marketplace")
    marketplace: str = Field(..., description="Marketplace id")
    scope: str = Field(default="user", description="Install scope: user or workspace")


class SetEnabledRequest(BaseModel):
    enabled: bool


class ConfigurePluginRequest(BaseModel):
    options: dict[str, Any] = Field(default_factory=dict)
    clearOptionKeys: list[str] = Field(default_factory=list)


class ValidateSourceRequest(BaseModel):
    source: str = Field(..., description="Marketplace or git source to validate")


# ---------------------------------------------------------------------------
# Read endpoints
# ---------------------------------------------------------------------------


@router.get("/overview")
async def get_plugins_overview() -> dict[str, Any]:
    """Marketplaces + available + installed plugins (ZCodePluginsOverviewResult)."""
    service = _get_service()
    return await asyncio.to_thread(service.overview)


@router.get("/list")
async def list_plugins() -> dict[str, Any]:
    service = _get_service()
    return await asyncio.to_thread(service.list_plugins)


@router.get("/reference-catalog")
async def get_reference_catalog() -> dict[str, Any]:
    service = _get_service()
    return await asyncio.to_thread(service.reference_catalog)


@router.get("/describe")
async def describe_plugin(
    marketplace: str = Query(...), name: str = Query(...)
) -> dict[str, Any]:
    service = _get_service()
    return await asyncio.to_thread(service.describe_plugin, marketplace, name)


_ICON_SUFFIXES = (".png", ".jpg", ".jpeg", ".svg", ".webp")


@router.get("/icon/{plugin_name}")
async def get_plugin_icon(plugin_name: str) -> FileResponse:
    """Serve the locally cached official plugin icon (seeded from ZCode CDN)."""
    import re as _re

    from evoflow.plugins.builtin import icons_dir

    safe = _re.sub(r"[^a-zA-Z0-9._-]", "", plugin_name)
    if not safe or safe != plugin_name:
        raise HTTPException(status_code=404, detail="icon not found")
    base = icons_dir(resolve_storage_root())
    for suffix in _ICON_SUFFIXES:
        candidate = base / f"{safe}{suffix}"
        if candidate.is_file():
            media = {
                ".png": "image/png",
                ".jpg": "image/jpeg",
                ".jpeg": "image/jpeg",
                ".svg": "image/svg+xml",
                ".webp": "image/webp",
            }[suffix]
            return FileResponse(candidate, media_type=media)
    raise HTTPException(status_code=404, detail="icon not found")


# ---------------------------------------------------------------------------
# Marketplace endpoints
# ---------------------------------------------------------------------------


@router.post("/marketplaces", dependencies=[Depends(_org_admin_guard)])
async def add_marketplace(payload: AddMarketplaceRequest) -> dict[str, Any]:
    service = _get_service()
    if payload.dryRun:
        result = await asyncio.to_thread(service.validate_source, payload.source)
        return {"marketplace": None, "marketplaces": [], "diagnostics": result["diagnostics"]}
    try:
        record, _diagnostics = await asyncio.to_thread(service.add_marketplace, payload.source)
    except Exception as error:  # PluginSourceError / PluginManifestError
        raise _to_http_error(error) from error
    overview = await asyncio.to_thread(service.overview)
    marketplace = next(
        (item for item in overview["marketplaces"] if item["id"] == record.id), None
    )
    return {
        "marketplace": marketplace,
        "marketplaces": overview["marketplaces"],
        "diagnostics": [],
    }


@router.delete("/marketplaces/{marketplace_id}", dependencies=[Depends(_org_admin_guard)])
async def remove_marketplace(marketplace_id: str) -> dict[str, Any]:
    service = _get_service()
    await asyncio.to_thread(service.remove_marketplace, marketplace_id)
    return {"diagnostics": []}


@router.post("/marketplaces/{marketplace_id}/refresh", dependencies=[Depends(_org_admin_guard)])
async def refresh_marketplace(marketplace_id: str) -> dict[str, Any]:
    service = _get_service()
    try:
        _updated, diagnostics = await asyncio.to_thread(service.refresh_marketplace, marketplace_id)
    except Exception as error:
        raise _to_http_error(error) from error
    return {"diagnostics": [item.to_json() for item in diagnostics]}


@router.post("/marketplaces/validate", dependencies=[Depends(_org_admin_guard)])
async def validate_source(payload: ValidateSourceRequest) -> dict[str, Any]:
    service = _get_service()
    return await asyncio.to_thread(service.validate_source, payload.source)


# ---------------------------------------------------------------------------
# Install lifecycle
# ---------------------------------------------------------------------------


@router.post("/install", dependencies=[Depends(_org_admin_guard)])
async def install_plugin(payload: InstallPluginRequest) -> dict[str, Any]:
    service = _get_service()
    try:
        return await asyncio.to_thread(
            service.install_plugin, payload.marketplace, payload.pluginName, payload.scope
        )
    except Exception as error:
        raise _to_http_error(error) from error


@router.delete("/installed/{plugin_id:path}", dependencies=[Depends(_org_admin_guard)])
async def uninstall_plugin(
    plugin_id: str, removeCache: bool = Query(default=True)
) -> dict[str, Any]:
    service = _get_service()
    try:
        return await asyncio.to_thread(service.uninstall_plugin, plugin_id, removeCache)
    except Exception as error:
        raise _to_http_error(error) from error


@router.post("/installed/{plugin_id:path}/enabled", dependencies=[Depends(_org_admin_guard)])
async def set_plugin_enabled(plugin_id: str, payload: SetEnabledRequest) -> dict[str, Any]:
    service = _get_service()
    try:
        return await asyncio.to_thread(service.set_plugin_enabled, plugin_id, payload.enabled)
    except Exception as error:
        raise _to_http_error(error) from error


@router.post("/installed/{plugin_id:path}/update", dependencies=[Depends(_org_admin_guard)])
async def update_plugin(plugin_id: str) -> dict[str, Any]:
    service = _get_service()
    try:
        return await asyncio.to_thread(service.update_plugin, plugin_id)
    except Exception as error:
        raise _to_http_error(error) from error


@router.post("/installed/{plugin_id:path}/restore", dependencies=[Depends(_org_admin_guard)])
async def restore_builtin_plugin(plugin_id: str) -> dict[str, Any]:
    service = _get_service()
    try:
        return await asyncio.to_thread(service.restore_builtin_plugin, plugin_id)
    except Exception as error:
        raise _to_http_error(error) from error


@router.post("/installed/{plugin_id:path}/configure", dependencies=[Depends(_org_admin_guard)])
async def configure_plugin(plugin_id: str, payload: ConfigurePluginRequest) -> dict[str, Any]:
    service = _get_service()
    try:
        return await asyncio.to_thread(
            service.configure_plugin, plugin_id, payload.options, payload.clearOptionKeys
        )
    except Exception as error:
        raise _to_http_error(error) from error


@router.post("/installed/{plugin_id:path}/reset-config", dependencies=[Depends(_org_admin_guard)])
async def reset_plugin_config(plugin_id: str) -> dict[str, Any]:
    service = _get_service()
    return await asyncio.to_thread(service.reset_plugin_config, plugin_id)
