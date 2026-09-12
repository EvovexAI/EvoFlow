"""Knowledge base API router.

Provides CRUD for knowledge bases, file upload, chunk listing, semantic
search, and processing status endpoints.
"""

from __future__ import annotations

import logging
import os
from pathlib import Path

from fastapi import APIRouter, BackgroundTasks, Depends, File, Form, HTTPException, Query, Request, UploadFile
from pydantic import BaseModel, Field

from evoflow.knowledge import service as kb_service

logger = logging.getLogger(__name__)

from evoflow.authz.http_guard import require_org_admin


def _org_admin_dep(request: Request) -> None:
    require_org_admin(request)


router = APIRouter(
    prefix="/api/knowledge",
    tags=["knowledge"],
    dependencies=[Depends(_org_admin_dep)],
)


# ---------------------------------------------------------------------------
# Request / Response models
# ---------------------------------------------------------------------------

class CreateDatasetRequest(BaseModel):
    name: str = Field(..., min_length=1, max_length=200)
    description: str = Field(default="", max_length=2000)
    embedding_model: str = Field(default="")
    # None = auto-detect from the configured embedding model (probe or known map).
    # Set explicitly only when you want to override auto-detection.
    embedding_dim: int | None = Field(default=None, ge=1, le=8192)
    chunk_size: int = Field(default=512, ge=50, le=4096)
    chunk_overlap: int = Field(default=50, ge=0, le=500)
    top_k: int = Field(default=5, ge=1, le=50)
    score_threshold: float = Field(default=0.3, ge=0.0, le=1.0)
    local_source_path: str = Field(default="", max_length=4096)
    llm_index_enabled: bool = Field(default=True)


class UpdateDatasetRequest(BaseModel):
    name: str | None = Field(default=None, max_length=200)
    description: str | None = Field(default=None, max_length=2000)
    chunk_size: int | None = Field(default=None, ge=50, le=4096)
    chunk_overlap: int | None = Field(default=None, ge=0, le=500)
    top_k: int | None = Field(default=None, ge=1, le=50)
    score_threshold: float | None = Field(default=None, ge=0.0, le=1.0)
    local_source_path: str | None = Field(default=None, max_length=4096)
    llm_index_enabled: bool | None = Field(default=None)


class SyncLocalRequest(BaseModel):
    force: bool = Field(default=False)


class CreateFolderRequest(BaseModel):
    name: str = Field(..., min_length=1, max_length=200)
    parent_id: str | None = Field(default=None)


class RenameFolderRequest(BaseModel):
    name: str = Field(..., min_length=1, max_length=200)


class SearchRequest(BaseModel):
    query: str = Field(..., min_length=1)
    top_k: int = Field(default=5, ge=1, le=50)
    score_threshold: float = Field(default=0.0, ge=0.0, le=1.0)


# ---------------------------------------------------------------------------
# Dataset endpoints
# ---------------------------------------------------------------------------

@router.get("")
@router.get("/")
async def list_knowledge_bases():
    """List all knowledge bases."""
    return {"items": kb_service.list_datasets()}


@router.post("")
@router.post("/")
async def create_knowledge_base(req: CreateDatasetRequest, background_tasks: BackgroundTasks):
    """Create a new knowledge base."""
    try:
        ds = await kb_service.create_dataset(
            req.name,
            description=req.description,
            embedding_model=req.embedding_model,
            embedding_dim=req.embedding_dim,
            chunk_size=req.chunk_size,
            chunk_overlap=req.chunk_overlap,
            top_k=req.top_k,
            score_threshold=req.score_threshold,
            local_source_path=req.local_source_path,
            llm_index_enabled=req.llm_index_enabled,
        )
        if str(req.local_source_path or "").strip():
            background_tasks.add_task(kb_service.sync_local_source, ds["dataset_id"])
        return ds
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    except Exception as e:
        logger.error("Failed to create dataset: %s", e)
        raise HTTPException(status_code=500, detail=str(e)) from e


@router.get("/{dataset_id}")
async def get_knowledge_base(dataset_id: str):
    """Get knowledge base details."""
    ds = kb_service.get_dataset(dataset_id)
    if ds is None:
        raise HTTPException(status_code=404, detail="Knowledge base not found")
    return ds


@router.put("/{dataset_id}")
async def update_knowledge_base(dataset_id: str, req: UpdateDatasetRequest):
    """Update knowledge base settings."""
    ds = kb_service.update_dataset(
        dataset_id,
        name=req.name,
        description=req.description,
        chunk_size=req.chunk_size,
        chunk_overlap=req.chunk_overlap,
        top_k=req.top_k,
        score_threshold=req.score_threshold,
        llm_index_enabled=req.llm_index_enabled,
        local_source_path=req.local_source_path,
    )
    if ds is None:
        raise HTTPException(status_code=404, detail="Knowledge base not found")
    return ds


@router.delete("/{dataset_id}")
async def delete_knowledge_base(dataset_id: str):
    """Delete a knowledge base and all its files, chunks, and vectors."""
    if kb_service.get_dataset(dataset_id) is None:
        raise HTTPException(status_code=404, detail="Knowledge base not found")
    kb_service.delete_dataset(dataset_id)
    return {"success": True, "dataset_id": dataset_id}


@router.post("/{dataset_id}/sync-local")
@router.post("/{dataset_id}/sync-local/")
async def sync_local_source(dataset_id: str, req: SyncLocalRequest | None = None):
    """Re-scan the bound local folder and index new/changed files."""
    if kb_service.get_dataset(dataset_id) is None:
        raise HTTPException(status_code=404, detail="Knowledge base not found")
    force = bool(req.force) if req else False
    try:
        stats = await kb_service.sync_local_source(dataset_id, force=force)
        return {"success": True, "dataset_id": dataset_id, **stats}
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    except Exception as e:
        logger.error("Local sync failed: %s", e)
        raise HTTPException(status_code=500, detail=str(e)) from e


# ---------------------------------------------------------------------------
# File endpoints
# ---------------------------------------------------------------------------

@router.post("/{dataset_id}/upload")
async def upload_file(
    dataset_id: str,
    file: UploadFile = File(...),
    folder_id: str | None = Form(default=None),
    relative_path: str = Form(default=""),
):
    """Upload a file to a knowledge base folder for automatic indexing."""
    if kb_service.get_dataset(dataset_id) is None:
        raise HTTPException(status_code=404, detail="Knowledge base not found")

    content = await file.read()
    if not content:
        raise HTTPException(status_code=400, detail="Empty file")

    save_dir = Path(os.getenv("EVOFLOW_KB_UPLOAD_DIR", "")) or Path.home() / ".evoflow" / "kb_uploads"
    save_dir = save_dir / dataset_id

    try:
        file_id = await kb_service.upload_file(
            dataset_id,
            file.filename or "unnamed",
            content,
            save_dir,
            folder_id=folder_id,
            relative_path=relative_path or (file.filename or ""),
        )
        return {"success": True, "file_id": file_id, "filename": file.filename}
    except Exception as e:
        logger.error("Upload failed: %s", e)
        raise HTTPException(status_code=500, detail=str(e)) from e


@router.get("/{dataset_id}/folders")
@router.get("/{dataset_id}/folders/")
async def list_folders(dataset_id: str):
    if kb_service.get_dataset(dataset_id) is None:
        raise HTTPException(status_code=404, detail="Knowledge base not found")
    return {"items": kb_service.list_folders(dataset_id)}


@router.post("/{dataset_id}/folders")
@router.post("/{dataset_id}/folders/")
@router.post("/{dataset_id}/folder")
async def create_folder(dataset_id: str, req: CreateFolderRequest):
    if kb_service.get_dataset(dataset_id) is None:
        raise HTTPException(status_code=404, detail="Knowledge base not found")
    try:
        folder = kb_service.create_folder(dataset_id, req.name, parent_id=req.parent_id)
        return folder
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e


@router.put("/{dataset_id}/folders/{folder_id}")
async def rename_folder(dataset_id: str, folder_id: str, req: RenameFolderRequest):
    if kb_service.get_dataset(dataset_id) is None:
        raise HTTPException(status_code=404, detail="Knowledge base not found")
    try:
        folder = kb_service.rename_folder(folder_id, req.name)
        if folder is None or folder.get("dataset_id") != dataset_id:
            raise HTTPException(status_code=404, detail="Folder not found")
        return folder
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e


@router.delete("/{dataset_id}/folders/{folder_id}")
async def delete_folder(dataset_id: str, folder_id: str):
    if kb_service.get_dataset(dataset_id) is None:
        raise HTTPException(status_code=404, detail="Knowledge base not found")
    try:
        folder = kb_service.list_folders(dataset_id)
        if not any(f.get("folder_id") == folder_id for f in folder):
            raise HTTPException(status_code=404, detail="Folder not found")
        kb_service.delete_folder(folder_id)
        return {"success": True, "folder_id": folder_id}
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e


@router.get("/{dataset_id}/files")
async def list_files(dataset_id: str, folder_id: str | None = Query(default=None)):
    """List source files in a knowledge base, optionally scoped to a folder."""
    if kb_service.get_dataset(dataset_id) is None:
        raise HTTPException(status_code=404, detail="Knowledge base not found")
    return {"items": kb_service.list_files(dataset_id, folder_id=folder_id)}


@router.delete("/{dataset_id}/files/{file_id}")
async def delete_file(dataset_id: str, file_id: str):
    """Delete a source file and its chunks/vectors."""
    if kb_service.get_dataset(dataset_id) is None:
        raise HTTPException(status_code=404, detail="Knowledge base not found")
    if not kb_service.delete_file(dataset_id, file_id):
        raise HTTPException(status_code=404, detail="File not found")
    return {"success": True, "file_id": file_id}


# ---------------------------------------------------------------------------
# Chunk endpoints
# ---------------------------------------------------------------------------

@router.get("/{dataset_id}/chunks")
async def list_chunks(
    dataset_id: str,
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=50, ge=1, le=200),
):
    """List chunks in a knowledge base (paginated)."""
    if kb_service.get_dataset(dataset_id) is None:
        raise HTTPException(status_code=404, detail="Knowledge base not found")
    return kb_service.list_chunks(dataset_id, page=page, page_size=page_size)


# ---------------------------------------------------------------------------
# Search endpoint
# ---------------------------------------------------------------------------

@router.post("/{dataset_id}/search")
async def search(dataset_id: str, req: SearchRequest):
    """Semantic search across a knowledge base."""
    if kb_service.get_dataset(dataset_id) is None:
        raise HTTPException(status_code=404, detail="Knowledge base not found")
    try:
        results = await kb_service.search(
            dataset_id,
            req.query,
            top_k=req.top_k,
            score_threshold=req.score_threshold,
        )
        return {"query": req.query, "total": len(results), "items": results}
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e)) from e
    except Exception as e:
        logger.error("Search failed: %s", e)
        raise HTTPException(status_code=500, detail=str(e)) from e


# ---------------------------------------------------------------------------
# Status endpoint
# ---------------------------------------------------------------------------

@router.get("/{dataset_id}/status")
async def get_status(dataset_id: str):
    """Get processing status for a knowledge base."""
    if kb_service.get_dataset(dataset_id) is None:
        raise HTTPException(status_code=404, detail="Knowledge base not found")
    return kb_service.get_status(dataset_id)


# ---------------------------------------------------------------------------
# Global search endpoint (no dataset_id required)
# ---------------------------------------------------------------------------

class GlobalSearchRequest(BaseModel):
    query: str = Field(..., min_length=1)
    knowledge_base: str | None = Field(default=None, description="Optional: limit to one KB by name or id")
    top_k: int = Field(default=5, ge=1, le=50)
    score_threshold: float = Field(default=0.0, ge=0.0, le=1.0)


@router.post("/search")
async def global_search(req: GlobalSearchRequest):
    """Semantic search across all knowledge bases (or a specific one)."""
    try:
        results = await kb_service.search_knowledge_bases(
            req.query,
            knowledge_base=req.knowledge_base,
            top_k=req.top_k,
            score_threshold=req.score_threshold,
        )
        return {"query": req.query, "total": len(results), "items": results}
    except Exception as e:
        logger.error("Global search failed: %s", e)
        raise HTTPException(status_code=500, detail=str(e)) from e


# ---------------------------------------------------------------------------
# Embed endpoint (text → vector)
# ---------------------------------------------------------------------------

class EmbedRequest(BaseModel):
    text: str = Field(..., min_length=1)
    dataset_id: str | None = Field(default=None, description="Optional: use this KB's embedding model/dim")
    store: bool = Field(default=False, description="If True, store the embedding in sqlite-vec (requires dataset_id)")


@router.post("/embed")
async def embed_text(req: EmbedRequest):
    """Compute embedding for a text string. Optionally store it in sqlite-vec."""
    try:
        from evoflow.knowledge.embedding import get_embedding, resolve_embedding_model_config

        # Resolve embedding config
        mc = None
        dim = None
        if req.dataset_id:
            ds = kb_service.get_dataset(req.dataset_id)
            if ds is None:
                raise HTTPException(status_code=404, detail=f"Dataset {req.dataset_id} not found")
            mc = resolve_embedding_model_config(str(ds.get("embedding_model") or "")) or None
            dim = int(ds["embedding_dim"])

        # Compute embedding
        embedding = await get_embedding(req.text, mc, expected_dim=dim)

        # Optionally store in sqlite-vec
        chunk_id = None
        if req.store:
            if not req.dataset_id:
                raise HTTPException(status_code=400, detail="dataset_id is required when store=True")
            from evoflow.knowledge.vector.sqlite_vec import VectorStore
            vs = VectorStore(req.dataset_id, dim=dim)
            # Generate a stable chunk_id for ad-hoc embeddings
            import hashlib
            chunk_id = f"embed_{hashlib.sha256(req.text.encode()).hexdigest()[:16]}"
            vs.insert(chunk_id, embedding)

        return {
            "text": req.text,
            "embedding": embedding,
            "dim": len(embedding),
            "chunk_id": chunk_id,
        }
    except HTTPException:
        raise
    except Exception as e:
        logger.error("Embed failed: %s", e)
        raise HTTPException(status_code=500, detail=str(e)) from e
