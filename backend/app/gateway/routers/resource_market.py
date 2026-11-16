"""Local resource-market host + market source management APIs."""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, Header, HTTPException, Query, Request
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from evoflow.organizations import market_host as host
from evoflow.organizations import market_sources as sources
from evoflow.webui.auth import is_local_request

router = APIRouter(tags=["resource-market"])
logger = logging.getLogger(__name__)


def _require_local(request: Request) -> None:
    client = request.client
    if not client or not is_local_request(client.host):
        raise HTTPException(status_code=403, detail="Local-only endpoint")


def _extract_token(
    request: Request,
    *,
    authorization: str | None = None,
    token_q: str | None = None,
) -> str:
    if token_q and str(token_q).strip():
        return str(token_q).strip()
    auth = authorization or request.headers.get("authorization") or ""
    if auth.lower().startswith("bearer "):
        return auth[7:].strip()
    return str(request.query_params.get("token") or "").strip()


def _request_base(request: Request) -> str:
    # Prefer proxy headers when present
    proto = (request.headers.get("x-forwarded-proto") or request.url.scheme or "http").split(",")[0].strip()
    host_hdr = (request.headers.get("x-forwarded-host") or request.headers.get("host") or "").split(",")[0].strip()
    if host_hdr:
        return f"{proto}://{host_hdr}".rstrip("/")
    return str(request.base_url).rstrip("/")


def _gateway_port(request: Request) -> int | None:
    try:
        return int(request.url.port or 0) or None
    except Exception:
        return None


# ── Public host (LAN share) ─────────────────────────────────────────────


@router.get("/api/resource-market/catalog.json")
@router.get("/api/resource-market/catalog")
async def public_catalog(
    request: Request,
    token: str | None = Query(None),
    authorization: str | None = Header(None),
) -> dict[str, Any]:
    if not host.is_host_enabled():
        raise HTTPException(status_code=404, detail="Local resource market host is disabled")
    provided = _extract_token(request, authorization=authorization, token_q=token)
    if not host.check_host_token(provided):
        raise HTTPException(status_code=401, detail="Invalid or missing market token")
    return host.public_catalog(base_url=_request_base(request))


@router.get("/api/resource-market/packs/{pack_id}.zip")
async def public_pack_zip(
    pack_id: str,
    request: Request,
    token: str | None = Query(None),
    authorization: str | None = Header(None),
):
    if not host.is_host_enabled():
        raise HTTPException(status_code=404, detail="Local resource market host is disabled")
    provided = _extract_token(request, authorization=authorization, token_q=token)
    if not host.check_host_token(provided):
        raise HTTPException(status_code=401, detail="Invalid or missing market token")
    path = host.resolve_pack_zip(pack_id)
    if not path:
        raise HTTPException(status_code=404, detail=f"Pack zip not found: {pack_id}")
    return FileResponse(
        path,
        media_type="application/zip",
        filename=f"{pack_id}.zip",
    )


# ── Host management (local) ─────────────────────────────────────────────


class HostEnableBody(BaseModel):
    enabled: bool = True
    name: str | None = None
    generate_token: bool = False
    token: str | None = None
    clear_token: bool = False


class PublishBody(BaseModel):
    path: str = Field(..., description="Pack directory or .zip absolute path")
    id: str | None = None
    name: str | None = None
    version: str | None = None
    description: str | None = None
    kind: str | None = None
    tags: list[str] = Field(default_factory=list)
    author: str | None = None


class SourceAddBody(BaseModel):
    catalog_url: str
    name: str = ""
    id: str = ""
    token: str = ""
    enabled: bool = True


class SourceEnableBody(BaseModel):
    enabled: bool = True


@router.get("/api/resource-market/host/status")
async def host_status(request: Request) -> dict[str, Any]:
    _require_local(request)
    return host.host_status(gateway_port=_gateway_port(request), request_base=_request_base(request))


@router.post("/api/resource-market/host/enable")
async def host_enable(request: Request, body: HostEnableBody) -> dict[str, Any]:
    _require_local(request)
    host.set_host_enabled(bool(body.enabled))
    if body.name is not None:
        host.set_host_name(body.name)
    if body.clear_token:
        host.set_host_token("")
    elif body.generate_token:
        host.set_host_token(None)
    elif body.token is not None:
        host.set_host_token(body.token)
    return {
        "ok": True,
        **host.host_status(gateway_port=_gateway_port(request), request_base=_request_base(request)),
    }


@router.post("/api/resource-market/host/publish")
async def host_publish(request: Request, body: PublishBody) -> dict[str, Any]:
    _require_local(request)
    meta = {
        "id": body.id,
        "name": body.name,
        "version": body.version,
        "description": body.description,
        "kind": body.kind,
        "tags": body.tags,
        "author": body.author,
    }
    try:
        result = host.publish_pack(source_path=body.path, pack_meta=meta)
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e)) from e
    status = host.host_status(gateway_port=_gateway_port(request), request_base=_request_base(request))
    return {**result, "share_urls": status.get("share_urls") or []}


@router.delete("/api/resource-market/host/packs/{pack_id}")
async def host_unpublish(request: Request, pack_id: str) -> dict[str, Any]:
    _require_local(request)
    try:
        return host.unpublish_pack(pack_id)
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e)) from e


# ── Consumer: market sources ────────────────────────────────────────────


@router.get("/api/resource-market/sources")
async def list_market_sources(request: Request) -> dict[str, Any]:
    _require_local(request)
    return {"ok": True, "sources": sources.list_sources()}


@router.post("/api/resource-market/sources")
async def add_market_source(request: Request, body: SourceAddBody) -> dict[str, Any]:
    _require_local(request)
    try:
        row = sources.add_source(
            catalog_url=body.catalog_url,
            name=body.name,
            source_id=body.id,
            token=body.token,
            enabled=body.enabled,
        )
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e)) from e
    return {"ok": True, "source": row, "sources": sources.list_sources()}


@router.delete("/api/resource-market/sources/{source_id}")
async def remove_market_source(request: Request, source_id: str) -> dict[str, Any]:
    _require_local(request)
    try:
        rows = sources.remove_source(source_id)
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e)) from e
    return {"ok": True, "sources": rows}


@router.put("/api/resource-market/sources/{source_id}/enabled")
async def enable_market_source(request: Request, source_id: str, body: SourceEnableBody) -> dict[str, Any]:
    _require_local(request)
    try:
        row = sources.set_source_enabled(source_id, body.enabled)
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e)) from e
    return {"ok": True, "source": row, "sources": sources.list_sources()}
