"""Owned knowledge base Gateway API — local-first RAG (spec: owned-knowledge-base-spec.md)."""

from __future__ import annotations

import logging
from typing import Any, Literal

from fastapi import APIRouter, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from evoflow.authz.http_guard import (
    require_kb_visible,
    require_org_admin,
    require_owned_doc_visible,
    require_owned_job_visible,
    resolve_authz_from_request,
)
from evoflow.authz.resource_visibility import stamp_kwargs_from_request
from evoflow.knowledge.owned import service as owned_service
from evoflow.knowledge.owned.assets import get_asset
from evoflow.knowledge.owned import blob_store
from evoflow.knowledge.owned.worker import ensure_owned_kb_worker_started

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/knowledge/owned", tags=["knowledge-owned"])


class CreateBaseBody(BaseModel):
    name: str = Field(..., min_length=1, max_length=200)
    description: str = ""
    chunkSize: int = Field(512, ge=64, le=8192)
    chunkOverlap: int = Field(80, ge=0, le=4096)
    chunkStrategy: str = "recursive"
    embeddingModelRef: str = ""
    # Legacy fields (deprecated): prefer embeddingModelRef from Settings → 向量模型
    embeddingMode: Literal["local", "cloud"] = "local"
    embeddingModel: str = ""
    embeddingBaseUrl: str = ""
    embeddingApiKey: str = ""
    summaryEnabled: bool = True
    imageCaptionEnabled: bool = False


class UpdateBaseBody(BaseModel):
    name: str | None = Field(None, min_length=1, max_length=200)
    description: str | None = None
    chunkSize: int | None = Field(None, ge=64, le=8192)
    chunkOverlap: int | None = Field(None, ge=0, le=4096)
    chunkStrategy: str | None = None
    embeddingModelRef: str | None = None
    embeddingMode: Literal["local", "cloud"] | None = None
    embeddingModel: str | None = None
    embeddingBaseUrl: str | None = None
    embeddingApiKey: str | None = None
    summaryEnabled: bool | None = None
    imageCaptionEnabled: bool | None = None


class ManualDocBody(BaseModel):
    title: str = Field(..., min_length=1, max_length=500)
    content: str = Field(..., min_length=1)
    folderPath: str = ""


class ImportFolderBody(BaseModel):
    path: str = Field(..., min_length=1)
    upsert: bool = True
    pruneMissing: bool = False
    folderPrefix: str = ""


class SearchBody(BaseModel):
    query: str = Field(..., min_length=1)
    mode: Literal["hybrid", "keyword", "semantic", "vector", "fulltext", "title"] = "hybrid"
    topK: int = Field(8, ge=1, le=50)
    tags: list[str] = Field(default_factory=list)


class AskBody(BaseModel):
    query: str = Field(..., min_length=1)
    docId: str | None = None
    topK: int = Field(6, ge=1, le=20)


class SummaryBody(BaseModel):
    force: bool = False


class UpdateContentBody(BaseModel):
    content: str = Field(..., min_length=0)
    title: str | None = None


class ImportVaultBody(BaseModel):
    vaultId: str = Field(..., min_length=1)
    upsert: bool = True
    pruneMissing: bool = False
    folderPrefix: str | None = None


class ResyncBody(BaseModel):
    pruneMissing: bool = False


class PrimaryBody(BaseModel):
    primary: Literal["owned", "vault", "auto"] | None = None
    defaultEmbeddingModel: str | None = None


class CreateFolderBody(BaseModel):
    path: str = Field(..., min_length=1)
    parentPath: str = ""


class RenameFolderBody(BaseModel):
    fromPath: str = Field(..., min_length=1)
    toPath: str | None = None
    parentPath: str | None = None


class MoveDocumentBody(BaseModel):
    folderPath: str | None = None
    beforeDocId: str | None = None
    sortOrder: int | None = None


@router.get("/bases")
async def list_bases(request: Request) -> dict[str, Any]:
    ensure_owned_kb_worker_started()
    authz = resolve_authz_from_request(request)
    items = owned_service.list_bases(
        is_admin=bool(authz.get("is_admin")),
        personal_scope=authz.get("personal_scope"),
        org_scope=authz.get("org_scope"),
        principal=authz.get("principal"),
        filter_visibility=True,
    )
    return {"items": items}


@router.post("/bases")
async def create_base(request: Request, body: CreateBaseBody) -> dict[str, Any]:
    payload = body.model_dump(exclude_none=True)
    # Drop empty optional strings so resolve_create_binding can use global default
    if not str(payload.get("embeddingModelRef") or "").strip():
        payload.pop("embeddingModelRef", None)
    if not str(payload.get("embeddingModel") or "").strip():
        payload.pop("embeddingModel", None)
        # Without legacy model, ignore default embeddingMode=local so global default applies
        if not str(payload.get("embeddingApiKey") or "").strip() and not str(
            payload.get("embeddingBaseUrl") or ""
        ).strip():
            payload.pop("embeddingMode", None)
            payload.pop("embeddingApiKey", None)
            payload.pop("embeddingBaseUrl", None)
    try:
        created = owned_service.create_base(payload)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    stamp = stamp_kwargs_from_request(request)
    if stamp.get("owner_scope_id") and created.get("id"):
        owned_service.set_kb_owner_scope(
            str(created["id"]),
            org_id=str(stamp.get("org_id") or "local"),
            owner_scope_id=stamp["owner_scope_id"],
            created_by=stamp.get("created_by"),
        )
        refreshed = owned_service.get_base(str(created["id"]))
        if refreshed:
            return refreshed
    return created


@router.get("/bases/{kb_id}")
async def get_base(request: Request, kb_id: str) -> dict[str, Any]:
    require_kb_visible(request, kb_id)
    base = owned_service.get_base(kb_id)
    if not base:
        raise HTTPException(404, "knowledge base not found")
    return base


@router.patch("/bases/{kb_id}")
async def patch_base(request: Request, kb_id: str, body: UpdateBaseBody) -> dict[str, Any]:
    require_kb_visible(request, kb_id)
    payload = body.model_dump(exclude_unset=True)
    try:
        return owned_service.update_base(kb_id, payload)
    except ValueError as exc:
        msg = str(exc)
        code = 404 if "not found" in msg.lower() else 400
        raise HTTPException(code, msg) from exc


class ReindexBaseBody(BaseModel):
    """Optional rebind + force full vector rebuild for an existing base."""

    embeddingModelRef: str | None = None
    force: bool = True


@router.post("/bases/{kb_id}/reindex")
async def reindex_base(request: Request, kb_id: str, body: ReindexBaseBody | None = None) -> dict[str, Any]:
    require_kb_visible(request, kb_id)
    data = body.model_dump(exclude_unset=True) if body is not None else {}
    try:
        return owned_service.reindex_base(
            kb_id,
            embedding_model_ref=data.get("embeddingModelRef"),
            force=bool(data.get("force", True)),
        )
    except ValueError as exc:
        msg = str(exc)
        code = 404 if "not found" in msg.lower() else 400
        raise HTTPException(code, msg) from exc


@router.post("/bases/{kb_id}/requeue-orphans")
async def requeue_orphan_docs(request: Request, kb_id: str) -> dict[str, Any]:
    """Re-enqueue pending/processing docs that have no active index job."""
    require_kb_visible(request, kb_id)
    return owned_service.requeue_orphan_parse_docs(kb_id)


@router.delete("/bases/{kb_id}")
async def delete_base(request: Request, kb_id: str) -> dict[str, Any]:
    require_kb_visible(request, kb_id)
    try:
        owned_service.delete_base(kb_id)
    except ValueError as exc:
        msg = str(exc)
        code = 404 if "not found" in msg.lower() else 400
        raise HTTPException(code, msg) from exc
    return {"ok": True}


@router.get("/bases/{kb_id}/documents")
async def list_documents(request: Request, kb_id: str) -> dict[str, Any]:
    require_kb_visible(request, kb_id)
    if not owned_service.get_base(kb_id):
        raise HTTPException(404, "knowledge base not found")
    return {
        "items": owned_service.list_documents(kb_id),
        "folders": owned_service.list_folders(kb_id),
    }


@router.get("/bases/{kb_id}/folders")
async def list_folders(request: Request, kb_id: str) -> dict[str, Any]:
    require_kb_visible(request, kb_id)
    if not owned_service.get_base(kb_id):
        raise HTTPException(404, "knowledge base not found")
    return {"items": owned_service.list_folders(kb_id)}


@router.post("/bases/{kb_id}/folders")
async def create_folder(request: Request, kb_id: str, body: CreateFolderBody) -> dict[str, Any]:
    require_kb_visible(request, kb_id)
    if not owned_service.get_base(kb_id):
        raise HTTPException(404, "knowledge base not found")
    parent = (body.parentPath or "").strip().strip("/")
    name = (body.path or "").strip().strip("/")
    # allow path as full path, or parentPath + leaf name
    if "/" not in name and parent:
        full = f"{parent}/{name}"
    else:
        full = name
    try:
        return owned_service.create_folder(kb_id, full)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc


@router.patch("/bases/{kb_id}/folders")
async def rename_folder(request: Request, kb_id: str, body: RenameFolderBody) -> dict[str, Any]:
    require_kb_visible(request, kb_id)
    if not owned_service.get_base(kb_id):
        raise HTTPException(404, "knowledge base not found")
    try:
        if body.parentPath is not None and not body.toPath:
            return owned_service.move_folder(kb_id, body.fromPath, body.parentPath)
        if not body.toPath:
            raise HTTPException(400, "toPath or parentPath required")
        return owned_service.rename_folder(kb_id, body.fromPath, body.toPath)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc


@router.delete("/bases/{kb_id}/folders")
async def delete_folder(request: Request, kb_id: str, path: str, mode: str = "move_up") -> dict[str, Any]:
    require_kb_visible(request, kb_id)
    if not owned_service.get_base(kb_id):
        raise HTTPException(404, "knowledge base not found")
    try:
        return owned_service.delete_folder(kb_id, path, mode=mode)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc


@router.post("/bases/{kb_id}/documents")
async def upload_document(
    request: Request,
    kb_id: str,
    file: UploadFile = File(...),
    folderPath: str = Form(""),
) -> dict[str, Any]:
    require_kb_visible(request, kb_id)
    if not owned_service.get_base(kb_id):
        raise HTTPException(404, "knowledge base not found")
    data = await file.read()
    try:
        return owned_service.upload_bytes(
            kb_id,
            file_name=file.filename or "upload.bin",
            data=data,
            folder_path=folderPath,
        )
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc


@router.post("/bases/{kb_id}/documents/manual")
async def create_manual(request: Request, kb_id: str, body: ManualDocBody) -> dict[str, Any]:
    require_kb_visible(request, kb_id)
    if not owned_service.get_base(kb_id):
        raise HTTPException(404, "knowledge base not found")
    try:
        return owned_service.upload_manual_markdown(
            kb_id,
            title=body.title,
            content=body.content,
            folder_path=body.folderPath,
        )
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc


@router.post("/bases/{kb_id}/import-folder")
async def import_folder(request: Request, kb_id: str, body: ImportFolderBody) -> dict[str, Any]:
    require_kb_visible(request, kb_id)
    if not owned_service.get_base(kb_id):
        raise HTTPException(404, "knowledge base not found")
    try:
        return owned_service.import_local_folder(
            kb_id,
            body.path,
            upsert=body.upsert,
            prune_missing=body.pruneMissing,
            folder_prefix=body.folderPrefix or "",
        )
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc


@router.post("/bases/{kb_id}/import-vault")
async def import_vault(request: Request, kb_id: str, body: ImportVaultBody) -> dict[str, Any]:
    require_kb_visible(request, kb_id)
    """Copy notes from a connected Obsidian vault into the owned KB (upsert by path)."""
    if not owned_service.get_base(kb_id):
        raise HTTPException(404, "knowledge base not found")
    try:
        return owned_service.import_from_vault(
            kb_id,
            body.vaultId,
            upsert=body.upsert,
            prune_missing=body.pruneMissing,
            folder_prefix=body.folderPrefix,
        )
    except ValueError as exc:
        msg = str(exc)
        # Missing vault is a client/resource error, not a bad request body.
        status = 404 if "vault not found" in msg.lower() else 400
        raise HTTPException(status, msg) from exc


@router.post("/bases/{kb_id}/resync")
async def resync_base(request: Request, kb_id: str, body: ResyncBody = ResyncBody()) -> dict[str, Any]:
    require_kb_visible(request, kb_id)
    if not owned_service.get_base(kb_id):
        raise HTTPException(404, "knowledge base not found")
    try:
        return owned_service.resync_base(kb_id, prune_missing=body.pruneMissing)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc


@router.get("/settings")
async def get_owned_settings(request: Request) -> dict[str, Any]:
    require_org_admin(request)
    from evoflow.knowledge.owned import settings as owned_settings

    return owned_settings.settings_payload()


@router.put("/settings")
async def put_owned_settings(request: Request, body: PrimaryBody) -> dict[str, Any]:
    require_org_admin(request)
    from evoflow.knowledge.owned import settings as owned_settings

    data = body.model_dump(exclude_unset=True)
    try:
        if "primary" in data and data["primary"] is not None:
            owned_settings.set_primary(data["primary"])
        if "defaultEmbeddingModel" in data:
            owned_settings.set_default_embedding_model(data["defaultEmbeddingModel"])
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    return owned_settings.settings_payload()


@router.get("/documents/{doc_id}")
async def get_document(request: Request, doc_id: str) -> dict[str, Any]:
    require_owned_doc_visible(request, doc_id)
    doc = owned_service.get_document(doc_id)
    if not doc:
        raise HTTPException(404, "document not found")
    return doc


@router.get("/documents/{doc_id}/content")
async def get_document_content(request: Request, doc_id: str) -> dict[str, Any]:
    require_owned_doc_visible(request, doc_id)
    """Original / parsed body for the document reader (Lexiang-style page view)."""
    payload = owned_service.get_document_content(doc_id)
    if not payload:
        raise HTTPException(404, "document not found")
    return payload


@router.put("/documents/{doc_id}/content")
async def put_document_content(request: Request, doc_id: str, body: UpdateContentBody) -> dict[str, Any]:
    require_owned_doc_visible(request, doc_id)
    """Overwrite text/markdown body and re-index (panel editor save)."""
    try:
        return owned_service.replace_document_content(
            doc_id, body.content, title=body.title
        )
    except ValueError as exc:
        msg = str(exc)
        code = 404 if "not found" in msg else 400
        raise HTTPException(code, msg) from exc


@router.get("/documents/{doc_id}/file")
async def get_document_file(request: Request, doc_id: str):
    require_owned_doc_visible(request, doc_id)
    """Original blob for PDF / binary preview in the panel (inline, not attachment)."""
    resolved = owned_service.resolve_document_file(doc_id)
    if not resolved:
        raise HTTPException(404, "document file not found")
    return FileResponse(
        resolved["path"],
        media_type=resolved["mediaType"],
        filename=resolved["fileName"],
        content_disposition_type="inline",
    )


@router.post("/documents/{doc_id}/summary")
async def enqueue_document_summary(request: Request, doc_id: str, body: SummaryBody = SummaryBody()) -> dict[str, Any]:
    require_owned_doc_visible(request, doc_id)
    """Enqueue or return existing document summary (Lexiang-style overview)."""
    try:
        return owned_service.enqueue_document_summary(doc_id, force=bool(body.force))
    except ValueError as exc:
        msg = str(exc)
        code = 404 if "not found" in msg else 400
        raise HTTPException(code, msg) from exc


@router.delete("/documents/{doc_id}")
async def delete_document(request: Request, doc_id: str) -> dict[str, Any]:
    require_owned_doc_visible(request, doc_id)
    try:
        owned_service.delete_document(doc_id)
    except ValueError as exc:
        msg = str(exc)
        code = 404 if "not found" in msg.lower() else 400
        raise HTTPException(code, msg) from exc
    return {"ok": True}


@router.patch("/documents/{doc_id}/folder")
async def move_document(request: Request, doc_id: str, body: MoveDocumentBody) -> dict[str, Any]:
    require_owned_doc_visible(request, doc_id)
    try:
        return owned_service.move_document(
            doc_id,
            body.folderPath,
            before_doc_id=body.beforeDocId,
            sort_order=body.sortOrder,
        )
    except ValueError as exc:
        msg = str(exc)
        code = 404 if "not found" in msg else 400
        raise HTTPException(code, msg) from exc


@router.get("/documents/{doc_id}/chunks")
async def list_chunks(request: Request, doc_id: str) -> dict[str, Any]:
    require_owned_doc_visible(request, doc_id)
    if not owned_service.get_document(doc_id):
        raise HTTPException(404, "document not found")
    return {"items": owned_service.list_chunks(doc_id)}


@router.get("/documents/{doc_id}/links")
async def document_links(request: Request, doc_id: str) -> dict[str, Any]:
    require_owned_doc_visible(request, doc_id)
    payload = owned_service.get_document_links(doc_id)
    if not payload:
        raise HTTPException(404, "document not found")
    return payload


@router.post("/bases/{kb_id}/search")
async def search(request: Request, kb_id: str, body: SearchBody) -> dict[str, Any]:
    require_kb_visible(request, kb_id)
    try:
        return await owned_service.search(
            kb_id,
            body.query,
            mode=body.mode,
            top_k=body.topK,
            tags=body.tags,
        )
    except ValueError as exc:
        raise HTTPException(404, str(exc)) from exc


@router.get("/bases/{kb_id}/tags")
async def list_tags(request: Request, kb_id: str) -> dict[str, Any]:
    require_kb_visible(request, kb_id)
    if not owned_service.get_base(kb_id):
        raise HTTPException(404, "knowledge base not found")
    return {"items": owned_service.list_tags(kb_id)}


@router.get("/bases/{kb_id}/doc-graph")
async def document_graph(request: Request, 
    kb_id: str, center: str | None = None, depth: int = 1
) -> dict[str, Any]:
    require_kb_visible(request, kb_id)
    if not owned_service.get_base(kb_id):
        raise HTTPException(404, "knowledge base not found")
    return owned_service.doc_graph(kb_id, center_doc_id=center, depth=depth)


@router.post("/bases/{kb_id}/ask")
async def ask(request: Request, kb_id: str, body: AskBody) -> dict[str, Any]:
    require_kb_visible(request, kb_id)
    """In-panel RAG Q&A with citations (non-streaming)."""
    try:
        return await owned_service.ask(
            kb_id,
            body.query,
            doc_id=body.docId,
            top_k=body.topK,
        )
    except ValueError as exc:
        msg = str(exc)
        code = 404 if "not found" in msg else 400
        raise HTTPException(code, msg) from exc


@router.get("/jobs/{job_id}")
async def get_job(request: Request, job_id: str) -> dict[str, Any]:
    require_owned_job_visible(request, job_id)
    job = owned_service.get_job(job_id)
    if not job:
        raise HTTPException(404, "job not found")
    return job


@router.get("/activities")
async def list_activities_global(request: Request, limit: int = 50, before: str | None = None) -> dict[str, Any]:
    require_org_admin(request)
    ensure_owned_kb_worker_started()
    return {
        "items": owned_service.list_activities(limit=limit, before=before),
    }


@router.get("/bases/{kb_id}/activities")
async def list_activities_for_base(request: Request, 
    kb_id: str,
    docId: str | None = None,
    limit: int = 50,
    before: str | None = None,
) -> dict[str, Any]:
    require_kb_visible(request, kb_id)
    if not owned_service.get_base(kb_id):
        raise HTTPException(404, "knowledge base not found")
    return {
        "items": owned_service.list_activities(
            kb_id=kb_id, doc_id=docId, limit=limit, before=before
        ),
    }


@router.get("/bases/{kb_id}/jobs")
async def list_jobs(request: Request, kb_id: str, limit: int = 40, activeOnly: bool = False) -> dict[str, Any]:
    require_kb_visible(request, kb_id)
    if not owned_service.get_base(kb_id):
        raise HTTPException(404, "knowledge base not found")
    states = ["queued", "running"] if activeOnly else None
    return {
        "items": owned_service.list_jobs(kb_id, limit=limit, states=states),
        "stats": owned_service.job_stats(kb_id),
    }


@router.get("/assets/{asset_id}")
async def get_asset_file(request: Request, asset_id: str):
    from evoflow.knowledge.owned.assets import get_asset as _get_asset
    _asset = _get_asset(asset_id)
    if not _asset:
        raise HTTPException(404, "asset not found")
    require_kb_visible(request, str(_asset.get("kbId") or _asset.get("kb_id") or ""))
    asset = get_asset(asset_id)
    if not asset:
        raise HTTPException(404, "asset not found")
    try:
        path = blob_store.resolve_blob(asset["blobPath"])
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    if not path.is_file():
        raise HTTPException(404, "asset blob missing")
    media = "image/png"
    suffix = path.suffix.lower()
    media_map = {
        ".png": "image/png",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".gif": "image/gif",
        ".webp": "image/webp",
        ".svg": "image/svg+xml",
        ".bmp": "image/bmp",
    }
    media = media_map.get(suffix, "application/octet-stream")
    return FileResponse(path, media_type=media, filename=path.name)


class WikiPageUpdateBody(BaseModel):
    title: str | None = None
    bodyMd: str | None = None
    summary: str | None = None
    status: str | None = None


@router.get("/bases/{kb_id}/wiki/pages")
async def wiki_list_pages(request: Request, kb_id: str, pageType: str | None = None) -> dict[str, Any]:
    require_kb_visible(request, kb_id)
    if not owned_service.get_base(kb_id):
        raise HTTPException(404, "knowledge base not found")
    from evoflow.knowledge.owned import wiki as wiki_mod

    return {"items": wiki_mod.list_pages(kb_id, page_type=pageType)}


@router.get("/bases/{kb_id}/wiki/pages/{slug:path}")
async def wiki_get_page(request: Request, kb_id: str, slug: str) -> dict[str, Any]:
    require_kb_visible(request, kb_id)
    if not owned_service.get_base(kb_id):
        raise HTTPException(404, "knowledge base not found")
    from evoflow.knowledge.owned import wiki as wiki_mod

    page = wiki_mod.get_page(kb_id, slug)
    if not page:
        raise HTTPException(404, "wiki page not found")
    return page


@router.put("/bases/{kb_id}/wiki/pages/{slug:path}")
async def wiki_update_page(
    request: Request, kb_id: str, slug: str, body: WikiPageUpdateBody
) -> dict[str, Any]:
    require_kb_visible(request, kb_id)
    if not owned_service.get_base(kb_id):
        raise HTTPException(404, "knowledge base not found")
    from evoflow.knowledge.owned import wiki as wiki_mod

    existing = wiki_mod.get_page(kb_id, slug)
    if not existing:
        raise HTTPException(404, "wiki page not found")
    page = wiki_mod.upsert_page(
        kb_id=kb_id,
        slug=slug,
        title=body.title if body.title is not None else existing["title"],
        page_type=existing["pageType"],
        body_md=body.bodyMd if body.bodyMd is not None else existing["bodyMd"],
        summary=body.summary if body.summary is not None else existing.get("summary") or "",
        status=body.status if body.status is not None else existing["status"],
        source_refs=existing.get("sourceRefs"),
        chunk_refs=existing.get("chunkRefs"),
        aliases=existing.get("aliases"),
        edit_source="user",
    )
    wiki_mod.rebuild_link_index(kb_id)
    return page


@router.get("/bases/{kb_id}/wiki/folders")
async def wiki_list_folders(request: Request, kb_id: str) -> dict[str, Any]:
    require_kb_visible(request, kb_id)
    if not owned_service.get_base(kb_id):
        raise HTTPException(404, "knowledge base not found")
    from evoflow.knowledge.owned import wiki as wiki_mod

    return {"items": wiki_mod.list_folders(kb_id)}


@router.get("/bases/{kb_id}/wiki/graph")
async def wiki_graph(request: Request, kb_id: str, center: str | None = None, depth: int = 2) -> dict[str, Any]:
    require_kb_visible(request, kb_id)
    if not owned_service.get_base(kb_id):
        raise HTTPException(404, "knowledge base not found")
    from evoflow.knowledge.owned import wiki as wiki_mod

    return wiki_mod.graph_payload(kb_id, center_slug=center, depth=depth)


@router.post("/bases/{kb_id}/wiki/rebuild")
async def wiki_rebuild(request: Request, kb_id: str) -> dict[str, Any]:
    require_kb_visible(request, kb_id)
    if not owned_service.get_base(kb_id):
        raise HTTPException(404, "knowledge base not found")
    from evoflow.knowledge.owned import activity as owned_activity
    from evoflow.knowledge.owned.wiki_pipeline import enqueue_wiki_rebuild
    from evoflow.knowledge.owned.worker import ensure_owned_kb_worker_started

    ensure_owned_kb_worker_started()
    job = enqueue_wiki_rebuild(kb_id)
    owned_activity.record(kb_id, "wiki.rebuild", title="重建 Wiki", detail={"jobId": job.get("id")})
    return {"ok": True, "job": job}


@router.get("/bases/{kb_id}/kg/graph")
async def kg_graph(request: Request, kb_id: str, center: str | None = None) -> dict[str, Any]:
    require_kb_visible(request, kb_id)
    if not owned_service.get_base(kb_id):
        raise HTTPException(404, "knowledge base not found")
    from evoflow.knowledge.owned import kg as kg_mod

    return kg_mod.graph_payload(kb_id, center=center)


@router.get("/bases/{kb_id}/kg/stats")
async def kg_stats(request: Request, kb_id: str) -> dict[str, Any]:
    require_kb_visible(request, kb_id)
    if not owned_service.get_base(kb_id):
        raise HTTPException(404, "knowledge base not found")
    from evoflow.knowledge.owned import kg as kg_mod

    return kg_mod.stats(kb_id)


@router.post("/bases/{kb_id}/kg/rebuild")
async def kg_rebuild(request: Request, kb_id: str, heuristicOnly: bool = False) -> dict[str, Any]:
    require_kb_visible(request, kb_id)
    if not owned_service.get_base(kb_id):
        raise HTTPException(404, "knowledge base not found")
    from evoflow.knowledge.owned import activity as owned_activity
    from evoflow.knowledge.owned.kg_pipeline import enqueue_kg_extract
    from evoflow.knowledge.owned.worker import ensure_owned_kb_worker_started

    ensure_owned_kb_worker_started()
    job = enqueue_kg_extract(kb_id, heuristic_only=heuristicOnly)
    owned_activity.record(
        kb_id,
        "kg.rebuild",
        title="重建图谱",
        detail={"jobId": job.get("id"), "heuristicOnly": bool(heuristicOnly)},
    )
    return {"ok": True, "job": job}
