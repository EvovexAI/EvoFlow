"""Knowledge Vault (Obsidian) Gateway API — separate from document RAG datasets."""

from __future__ import annotations

import logging
from typing import Literal

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from evoflow.authz.http_guard import require_vault_visible, resolve_authz_from_request
from evoflow.authz.resource_visibility import stamp_kwargs_from_request
from evoflow.knowledge.vault import service as vault_service
from evoflow.knowledge.vault.errors import KnowledgeError, VaultNotFoundError, map_exception

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/knowledge/vaults", tags=["knowledge-vault"])


class CreateVaultBody(BaseModel):
    id: str | None = None
    name: str = Field(..., min_length=1, max_length=200)
    vaultPath: str = Field(..., min_length=1)
    enabled: bool = True
    accessMode: Literal["read_only", "read_write"] = "read_write"
    launchMode: Literal["managed_stdio", "external_http"] = "managed_stdio"
    searchServerUrl: str = ""
    writeServerUrl: str = ""
    allowRemoteHttp: bool = False
    allowedReadPaths: list[str] = Field(default_factory=lambda: ["*"])
    allowedWritePaths: list[str] = Field(default_factory=lambda: ["*"])
    defaultInboxPath: str = "00-Inbox"
    embeddingMode: Literal["local", "openai_compatible"] = "local"
    embeddingBaseUrl: str = ""
    embeddingModel: str = ""
    obsidianBaseUrl: str = "http://127.0.0.1:27123"
    ignorePatterns: str = ".obsidian/**,templates/**,*.canvas"
    respectGitignore: bool = True
    autoReindex: bool = True
    # Secrets — accepted once, never echoed back
    obsidianApiKey: str | None = None
    embeddingApiKey: str | None = None


class UpdateVaultBody(BaseModel):
    name: str | None = None
    vaultPath: str | None = None
    enabled: bool | None = None
    accessMode: Literal["read_only", "read_write"] | None = None
    launchMode: Literal["managed_stdio", "external_http"] | None = None
    searchServerUrl: str | None = None
    writeServerUrl: str | None = None
    allowRemoteHttp: bool | None = None
    allowedReadPaths: list[str] | None = None
    allowedWritePaths: list[str] | None = None
    defaultInboxPath: str | None = None
    embeddingMode: Literal["local", "openai_compatible"] | None = None
    embeddingBaseUrl: str | None = None
    embeddingModel: str | None = None
    obsidianBaseUrl: str | None = None
    ignorePatterns: str | None = None
    respectGitignore: bool | None = None
    autoReindex: bool | None = None
    obsidianApiKey: str | None = None
    embeddingApiKey: str | None = None
    clearObsidianApiKey: bool = False


class SearchBody(BaseModel):
    query: str = Field(..., min_length=1)
    mode: Literal["hybrid", "semantic", "fulltext", "title"] = "hybrid"
    topK: int = Field(default=8, ge=1, le=20)
    tags: list[str] = Field(default_factory=list)
    scopes: list[str] = Field(default_factory=list)
    threshold: float | None = None
    rerank: bool = False


class ReadBody(BaseModel):
    paths: list[str] = Field(..., min_length=1)
    maxContentChars: int | None = Field(default=12000, ge=100, le=100000)


class SaveBody(BaseModel):
    path: str = Field(..., min_length=1)
    content: str = ""


class GraphBody(BaseModel):
    path: str = Field(..., min_length=1)
    depth: int = Field(default=1, ge=1, le=3)
    direction: Literal["outgoing", "backlinks", "both"] = "both"


class IngestBody(BaseModel):
    title: str = Field(..., min_length=1)
    content: str = Field(..., min_length=1)
    summary: str = ""
    source: str = "evoflow"
    sourceDescription: str = ""
    confidence: float = Field(default=0.7, ge=0.0, le=1.0)
    tags: list[str] = Field(default_factory=list)
    relatedPaths: list[str] = Field(default_factory=list)
    inboxPath: str | None = None


class ReindexBody(BaseModel):
    path: str | None = None
    force: bool = True
    wait: bool = False


class OpenBody(BaseModel):
    path: str = Field(..., min_length=1)


def _http_error(exc: BaseException) -> HTTPException:
    if isinstance(exc, VaultNotFoundError):
        return HTTPException(status_code=404, detail=exc.to_dict())
    if isinstance(exc, KnowledgeError):
        code = 400
        if exc.code in {"provider_unavailable", "search_provider_unavailable", "write_provider_unavailable", "obsidian_not_running"}:
            code = 503
        if exc.code == "write_disabled":
            code = 403
        return HTTPException(status_code=code, detail=exc.to_dict())
    if isinstance(exc, ValueError):
        return HTTPException(status_code=400, detail={"error": "invalid_request", "message": str(exc)})
    mapped = map_exception(exc)
    return HTTPException(status_code=500, detail=mapped.to_dict())


@router.get("")
@router.get("/")
async def list_vaults(request: Request):
    authz = resolve_authz_from_request(request)
    return {
        "items": vault_service.list_vaults(
            is_admin=bool(authz.get("is_admin")),
            personal_scope=authz.get("personal_scope"),
            org_scope=authz.get("org_scope"),
            principal=authz.get("principal"),
            filter_visibility=True,
        )
    }


@router.post("")
@router.post("/")
async def create_vault(request: Request, body: CreateVaultBody):
    try:
        data = body.model_dump(exclude={"obsidianApiKey", "embeddingApiKey"})
        stamp = stamp_kwargs_from_request(request)
        return vault_service.create_vault(
            data,
            obsidian_api_key=body.obsidianApiKey,
            embedding_api_key=body.embeddingApiKey,
            org_id=stamp.get("org_id"),
            owner_scope_id=stamp.get("owner_scope_id"),
            created_by=stamp.get("created_by"),
        )
    except Exception as exc:
        raise _http_error(exc) from exc


@router.get("/{vault_id}")
async def get_vault(request: Request, vault_id: str):
    require_vault_visible(request, vault_id)
    try:
        return vault_service.get_vault(vault_id)
    except Exception as exc:
        raise _http_error(exc) from exc


@router.put("/{vault_id}")
async def update_vault(request: Request, vault_id: str, body: UpdateVaultBody):
    require_vault_visible(request, vault_id)
    try:
        payload = {k: v for k, v in body.model_dump(exclude_unset=True).items() if k not in ("obsidianApiKey", "embeddingApiKey", "clearObsidianApiKey")}
        return vault_service.update_vault(
            vault_id,
            payload,
            obsidian_api_key=body.obsidianApiKey,
            embedding_api_key=body.embeddingApiKey,
            clear_obsidian_api_key=body.clearObsidianApiKey,
        )
    except Exception as exc:
        raise _http_error(exc) from exc


@router.delete("/{vault_id}")
async def delete_vault(request: Request, vault_id: str):
    require_vault_visible(request, vault_id)
    try:
        return await vault_service.delete_vault(vault_id)
    except Exception as exc:
        raise _http_error(exc) from exc


@router.post("/{vault_id}/test")
async def test_vault(request: Request, vault_id: str):
    require_vault_visible(request, vault_id)
    try:
        return await vault_service.test_vault(vault_id)
    except Exception as exc:
        raise _http_error(exc) from exc


@router.get("/{vault_id}/status")
async def vault_status(request: Request, vault_id: str):
    require_vault_visible(request, vault_id)
    try:
        return await vault_service.vault_status(vault_id)
    except Exception as exc:
        raise _http_error(exc) from exc


@router.get("/{vault_id}/notes")
async def list_notes(request: Request, vault_id: str, limit: int = 80, prefix: str = ""):
    require_vault_visible(request, vault_id)
    try:
        return vault_service.list_notes(vault_id, limit=limit, prefix=prefix)
    except Exception as exc:
        raise _http_error(exc) from exc


@router.post("/{vault_id}/install")
async def install_vault(request: Request, vault_id: str):
    require_vault_visible(request, vault_id)
    try:
        return await vault_service.install_vault(vault_id)
    except Exception as exc:
        raise _http_error(exc) from exc


@router.get("/{vault_id}/graph")
async def full_graph(
    request: Request, vault_id: str, max_nodes: int | None = None, max_edges: int | None = None
):
    require_vault_visible(request, vault_id)
    try:
        return await vault_service.full_graph_vault(
            vault_id,
            max_nodes=max_nodes,
            max_edges=max_edges,
        )
    except Exception as exc:
        raise _http_error(exc) from exc


@router.post("/{vault_id}/reindex")
async def reindex_vault(request: Request, vault_id: str, body: ReindexBody | None = None):
    require_vault_visible(request, vault_id)
    try:
        body = body or ReindexBody()
        return await vault_service.reindex_vault(
            vault_id,
            path=body.path,
            force=bool(body.force),
            wait=bool(body.wait),
        )
    except Exception as exc:
        raise _http_error(exc) from exc


@router.get("/{vault_id}/reindex/job")
async def reindex_job(request: Request, vault_id: str):
    require_vault_visible(request, vault_id)
    try:
        return await vault_service.reindex_job_status(vault_id)
    except Exception as exc:
        raise _http_error(exc) from exc


@router.post("/{vault_id}/search")
async def search_vault(request: Request, vault_id: str, body: SearchBody):
    require_vault_visible(request, vault_id)
    try:
        return await vault_service.search_vault(vault_id, body.model_dump())
    except Exception as exc:
        raise _http_error(exc) from exc


@router.post("/{vault_id}/read")
async def read_vault(request: Request, vault_id: str, body: ReadBody):
    require_vault_visible(request, vault_id)
    try:
        return await vault_service.read_vault(vault_id, body.model_dump())
    except Exception as exc:
        raise _http_error(exc) from exc


@router.post("/{vault_id}/save")
async def save_vault(request: Request, vault_id: str, body: SaveBody):
    require_vault_visible(request, vault_id)
    try:
        return await vault_service.save_vault(vault_id, body.model_dump())
    except Exception as exc:
        raise _http_error(exc) from exc


@router.post("/{vault_id}/graph")
async def graph_vault(request: Request, vault_id: str, body: GraphBody):
    require_vault_visible(request, vault_id)
    try:
        return await vault_service.graph_vault(vault_id, body.model_dump())
    except Exception as exc:
        raise _http_error(exc) from exc


@router.post("/{vault_id}/ingest")
async def ingest_vault(request: Request, vault_id: str, body: IngestBody):
    require_vault_visible(request, vault_id)
    try:
        return await vault_service.ingest_vault(vault_id, body.model_dump())
    except Exception as exc:
        raise _http_error(exc) from exc


@router.post("/{vault_id}/open")
async def open_in_obsidian(request: Request, vault_id: str, body: OpenBody):
    require_vault_visible(request, vault_id)
    try:
        return vault_service.open_in_obsidian(vault_id, body.path)
    except Exception as exc:
        raise _http_error(exc) from exc
