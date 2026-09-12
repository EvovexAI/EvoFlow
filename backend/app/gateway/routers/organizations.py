"""Organization Pack / 资源包 Gateway API — Phase 1."""

from __future__ import annotations

from typing import Any, Literal

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field

from evoflow.organizations.installer import (
    OrganizationInstallError,
    install_organization,
    preflight_organization,
    uninstall_organization,
)
from evoflow.organizations.export import OrganizationExportError, export_organization
from evoflow.organizations.registry import get_org_instance, list_org_instances

router = APIRouter(prefix="/api/organizations", tags=["organizations"])


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


@router.get("/market/catalog")
async def api_market_catalog() -> dict[str, Any]:
    """Return GitHub catalog.json (default public market, or EVOFLOW_RESOURCE_MARKET_CATALOG_URL)."""
    import json
    import urllib.request

    from evoflow.organizations.fetch import market_catalog_url

    url = market_catalog_url()
    empty = {
        "schema": 1,
        "marketId": "evoflow-resource-market",
        "packs": [],
        "updatedAt": None,
        "source": url or None,
        "configured": bool(url),
    }
    if not url:
        return empty
    try:
        with urllib.request.urlopen(url, timeout=15) as resp:  # noqa: S310 — operator-configured URL
            raw = resp.read().decode("utf-8", errors="replace")
        data = json.loads(raw)
        if not isinstance(data, dict):
            raise ValueError("catalog must be a JSON object")
        data.setdefault("schema", 1)
        data["source"] = url
        data["configured"] = True
        if not isinstance(data.get("packs"), list):
            data["packs"] = []
        return data
    except Exception as e:
        raise HTTPException(
            status_code=502,
            detail=f"Failed to fetch market catalog: {e}",
        ) from e


@router.get("/{org_instance_id}")
async def api_get(org_instance_id: str) -> dict[str, Any]:
    if org_instance_id in ("market",):
        raise HTTPException(status_code=404, detail="Not found")
    inst = get_org_instance(org_instance_id)
    if not inst:
        raise HTTPException(status_code=404, detail=f"Organization not found: {org_instance_id}")
    return inst


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
