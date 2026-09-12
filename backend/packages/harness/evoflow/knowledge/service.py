"""Knowledge base service layer — business logic for CRUD, file upload, search.

All DB operations go through the shared evoflow SQLite connection
(``evoflow.persistence.db.get_db`` / ``db_connection_lock``).
"""

from __future__ import annotations

import json
import logging
import uuid
from pathlib import Path
from typing import Any

from evoflow.knowledge.embedding import get_embedding
from evoflow.knowledge.folders import (
    create_folder as folders_create,
    delete_folder as folders_delete,
    ensure_root_folder,
    list_folders as folders_list,
    normalize_folder_id,
    rename_folder as folders_rename,
)
from evoflow.knowledge.processor import process_file, public_file_status
from evoflow.knowledge.vector.sqlite_vec import VectorStore
from evoflow.persistence.db import db_connection_lock, get_db

logger = logging.getLogger(__name__)


def _enrich_dataset(row: dict[str, Any]) -> dict[str, Any]:
    """Attach common metadata fields for API consumers."""
    try:
        meta = json.loads(str(row.get("metadata_json") or "{}"))
    except json.JSONDecodeError:
        meta = {}
    if not isinstance(meta, dict):
        meta = {}
    out = dict(row)
    out["local_source_path"] = str(meta.get("local_source_path") or "").strip()
    out["llm_index_enabled"] = bool(meta.get("llm_index_enabled", True))
    return out


def dataset_llm_index_enabled(dataset_id: str) -> bool:
    meta = get_dataset_settings(dataset_id)
    if "llm_index_enabled" in meta:
        return bool(meta["llm_index_enabled"])
    from evoflow.knowledge.llm_indexer import kb_llm_enabled

    return kb_llm_enabled()


# ---------------------------------------------------------------------------
# Dataset CRUD
# ---------------------------------------------------------------------------

def list_datasets() -> list[dict[str, Any]]:
    """List all knowledge bases with aggregate stats."""
    with db_connection_lock():
        conn = get_db()
        rows = conn.execute(
            """
            SELECT
                d.dataset_id, d.name, d.embedding_model, d.embedding_dim,
                d.description, d.metadata_json, d.created_at, d.updated_at,
                (SELECT COUNT(*) FROM evoflow_kb_source_file f WHERE f.dataset_id = d.dataset_id) AS file_count,
                (SELECT COUNT(*) FROM evoflow_kb_chunk c WHERE c.dataset_id = d.dataset_id) AS chunk_count,
                (SELECT CASE
                    WHEN EXISTS(
                        SELECT 1 FROM evoflow_kb_source_file f
                        WHERE f.dataset_id = d.dataset_id
                          AND f.status IN ('pending', 'parsing', 'chunking', 'embedding')
                    ) THEN 'processing'
                    WHEN EXISTS(
                        SELECT 1 FROM evoflow_kb_source_file f
                        WHERE f.dataset_id = d.dataset_id AND f.status = 'error'
                    ) THEN 'error'
                    ELSE 'ready'
                END) AS status
            FROM evoflow_kb_dataset d
            ORDER BY d.created_at DESC
            """
        ).fetchall()
    return [_enrich_dataset(dict(r)) for r in rows]


def get_dataset(dataset_id: str) -> dict[str, Any] | None:
    """Get a single dataset with stats."""
    with db_connection_lock():
        conn = get_db()
        row = conn.execute(
            """
            SELECT
                d.dataset_id, d.name, d.embedding_model, d.embedding_dim,
                d.description, d.metadata_json, d.created_at, d.updated_at,
                (SELECT COUNT(*) FROM evoflow_kb_source_file f WHERE f.dataset_id = d.dataset_id) AS file_count,
                (SELECT COUNT(*) FROM evoflow_kb_chunk c WHERE c.dataset_id = d.dataset_id) AS chunk_count,
                (SELECT CASE
                    WHEN EXISTS(
                        SELECT 1 FROM evoflow_kb_source_file f
                        WHERE f.dataset_id = d.dataset_id
                          AND f.status IN ('pending', 'parsing', 'chunking', 'embedding')
                    ) THEN 'processing'
                    WHEN EXISTS(
                        SELECT 1 FROM evoflow_kb_source_file f
                        WHERE f.dataset_id = d.dataset_id AND f.status = 'error'
                    ) THEN 'error'
                    ELSE 'ready'
                END) AS status
            FROM evoflow_kb_dataset d
            WHERE d.dataset_id = ?
            """,
            (dataset_id,),
        ).fetchone()
    return _enrich_dataset(dict(row)) if row else None


async def create_dataset(
    name: str,
    *,
    description: str = "",
    embedding_model: str = "",
    embedding_dim: int | None = None,
    chunk_size: int = 512,
    chunk_overlap: int = 50,
    top_k: int = 5,
    score_threshold: float = 0.3,
    local_source_path: str = "",
    llm_index_enabled: bool = True,
) -> dict[str, Any]:
    """Create a new knowledge base dataset.

    When ``embedding_dim`` is ``None`` (the default), it is auto-detected from
    the active embedding model — either via a known-model lookup table (fast,
    no API call) or by probing the model with a short string. This lets users
    create a KB without knowing the dimension in advance, and avoids
    mismatches when switching between cloud (1536-dim) and local (e.g.
    bge-small-zh 512-dim) embedding models.
    """
    from evoflow.knowledge.embedding import detect_embedding_dim, get_embedding_config, resolve_embedding_model_config

    dataset_id = f"ds_{uuid.uuid4().hex[:16]}"
    mc = resolve_embedding_model_config(embedding_model) if embedding_model else None
    if mc is not None:
        embedding_model = str(getattr(mc, "name", "") or getattr(mc, "model", "") or embedding_model)
    elif not embedding_model:
        try:
            mc = get_embedding_config()
            embedding_model = getattr(mc, "model", "") or "text-embedding-3-small"
        except Exception:
            embedding_model = "text-embedding-3-small"

    # Auto-detect dimension when not explicitly provided.
    if embedding_dim is None:
        try:
            embedding_dim = await detect_embedding_dim(mc)
        except Exception as e:
            logger.warning("Embedding dim auto-detect failed, using default 1536: %s", e)
            embedding_dim = 1536

    # Store settings in metadata_json
    import json
    settings = json.dumps({
        "chunk_size": chunk_size,
        "chunk_overlap": chunk_overlap,
        "top_k": top_k,
        "score_threshold": score_threshold,
        "llm_index_enabled": bool(llm_index_enabled),
        "local_source_path": str(local_source_path or "").strip(),
    })

    with db_connection_lock():
        conn = get_db()
        conn.execute(
            """
            INSERT INTO evoflow_kb_dataset
                (dataset_id, name, embedding_model, embedding_dim, description, metadata_json)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            (dataset_id, name, embedding_model, embedding_dim, description, settings),
        )
        conn.commit()

    # Initialize the VectorStore to create the vec0 table
    vs = VectorStore(dataset_id, dim=embedding_dim)
    vs.init(name=name, embedding_model=embedding_model)

    ensure_root_folder(dataset_id)

    return get_dataset(dataset_id)  # type: ignore[return-value]


def update_dataset(
    dataset_id: str,
    *,
    name: str | None = None,
    description: str | None = None,
    chunk_size: int | None = None,
    chunk_overlap: int | None = None,
    top_k: int | None = None,
    score_threshold: float | None = None,
    llm_index_enabled: bool | None = None,
    local_source_path: str | None = None,
) -> dict[str, Any] | None:
    """Update dataset settings."""
    import json

    with db_connection_lock():
        conn = get_db()
        row = conn.execute(
            "SELECT name, description, metadata_json FROM evoflow_kb_dataset WHERE dataset_id = ?",
            (dataset_id,),
        ).fetchone()
        if row is None:
            return None

        new_name = name or row["name"]
        new_desc = description if description is not None else row["description"]
        meta = json.loads(row["metadata_json"] or "{}")
        if chunk_size is not None:
            meta["chunk_size"] = chunk_size
        if chunk_overlap is not None:
            meta["chunk_overlap"] = chunk_overlap
        if top_k is not None:
            meta["top_k"] = top_k
        if score_threshold is not None:
            meta["score_threshold"] = score_threshold
        if llm_index_enabled is not None:
            meta["llm_index_enabled"] = bool(llm_index_enabled)
        if local_source_path is not None:
            meta["local_source_path"] = str(local_source_path).strip()

        conn.execute(
            "UPDATE evoflow_kb_dataset SET name = ?, description = ?, metadata_json = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE dataset_id = ?",
            (new_name, new_desc, json.dumps(meta), dataset_id),
        )
        conn.commit()

    return get_dataset(dataset_id)


def delete_dataset(dataset_id: str) -> bool:
    """Delete a dataset and cascade-delete its files, chunks, and vectors."""
    # First, collect chunk_ids for vector cleanup
    with db_connection_lock():
        conn = get_db()
        chunk_ids = [
            r["chunk_id"]
            for r in conn.execute(
                "SELECT chunk_id FROM evoflow_kb_chunk WHERE dataset_id = ?",
                (dataset_id,),
            ).fetchall()
        ]

    # Delete vectors from vec0 table
    if chunk_ids:
        try:
            vs = VectorStore(dataset_id)
            vs.delete_many(chunk_ids)
        except Exception as e:
            logger.warning("Failed to clean vectors for dataset %s: %s", dataset_id, e)

    # Explicitly delete chunks — SQLite defaults to PRAGMA foreign_keys=OFF,
    # so FK CASCADE (source_file → chunk) does NOT fire. Delete in the correct
    # order: chunks first (vectors already cleaned above), then source_files,
    # then the dataset row itself.
    with db_connection_lock():
        conn = get_db()
        conn.execute("DELETE FROM evoflow_kb_chunk WHERE dataset_id = ?", (dataset_id,))
        conn.execute("DELETE FROM evoflow_kb_source_file WHERE dataset_id = ?", (dataset_id,))
        conn.execute("DELETE FROM evoflow_kb_folder WHERE dataset_id = ?", (dataset_id,))
        conn.execute("DELETE FROM evoflow_kb_dataset WHERE dataset_id = ?", (dataset_id,))
        conn.commit()

    return True


def get_dataset_settings(dataset_id: str) -> dict[str, Any]:
    """Extract settings from dataset metadata_json."""
    import json
    with db_connection_lock():
        conn = get_db()
        row = conn.execute(
            "SELECT metadata_json FROM evoflow_kb_dataset WHERE dataset_id = ?",
            (dataset_id,),
        ).fetchone()
    if row is None:
        return {}
    return json.loads(row["metadata_json"] or "{}")


# ---------------------------------------------------------------------------
# Source files
# ---------------------------------------------------------------------------

def list_files(dataset_id: str, *, folder_id: str | None = None) -> list[dict[str, Any]]:
    """List source files for a dataset, optionally filtered by folder."""
    target_folder = normalize_folder_id(dataset_id, folder_id) if folder_id is not None else None
    with db_connection_lock():
        conn = get_db()
        if target_folder:
            rows = conn.execute(
                """
                SELECT file_id, dataset_id, path, name, content_hash, size_bytes, chunk_count,
                       status, metadata_json, created_at, updated_at, folder_id,
                       summary_text, summary_index, relative_path
                FROM evoflow_kb_source_file
                WHERE dataset_id = ? AND COALESCE(folder_id, ?) = ?
                ORDER BY created_at DESC
                """,
                (dataset_id, target_folder, target_folder),
            ).fetchall()
        else:
            rows = conn.execute(
                """
                SELECT file_id, dataset_id, path, name, content_hash, size_bytes, chunk_count,
                       status, metadata_json, created_at, updated_at, folder_id,
                       summary_text, summary_index, relative_path
                FROM evoflow_kb_source_file
                WHERE dataset_id = ?
                ORDER BY created_at DESC
                """,
                (dataset_id,),
            ).fetchall()
    items = []
    for row in rows:
        item = dict(row)
        item["status"] = public_file_status(str(item.get("status") or "ready"))
        items.append(item)
    return items


def delete_file(dataset_id: str, file_id: str) -> bool:
    """Delete a source file and its chunks + vectors.

    Returns False when the file is missing or not in ``dataset_id``.
    """
    with db_connection_lock():
        conn = get_db()
        row = conn.execute(
            "SELECT file_id FROM evoflow_kb_source_file WHERE file_id = ? AND dataset_id = ?",
            (file_id, dataset_id),
        ).fetchone()
        if not row:
            return False
        chunk_ids = [
            r["chunk_id"]
            for r in conn.execute(
                "SELECT chunk_id FROM evoflow_kb_chunk WHERE file_id = ?",
                (file_id,),
            ).fetchall()
        ]

    # Delete vectors
    if chunk_ids:
        try:
            vs = VectorStore(dataset_id)
            vs.delete_many(chunk_ids)
        except Exception as e:
            logger.warning("Failed to clean vectors for file %s: %s", file_id, e)

    # Delete chunks + source_file (FK CASCADE handles chunks)
    with db_connection_lock():
        conn = get_db()
        conn.execute("DELETE FROM evoflow_kb_chunk WHERE file_id = ?", (file_id,))
        conn.execute("DELETE FROM evoflow_kb_source_file WHERE file_id = ?", (file_id,))
        conn.commit()

    return True


async def upload_file(
    dataset_id: str,
    file_name: str,
    file_content: bytes,
    save_dir: Path,
    *,
    folder_id: str | None = None,
    relative_path: str = "",
) -> str:
    """Save uploaded file and run automatic indexing pipeline."""
    save_dir.mkdir(parents=True, exist_ok=True)
    file_path = save_dir / f"{uuid.uuid4().hex[:8]}_{Path(file_name).name}"
    file_path.write_bytes(file_content)

    file_id = await process_file(
        dataset_id,
        file_path,
        folder_id=folder_id,
        relative_path=relative_path or file_name,
        llm_index=dataset_llm_index_enabled(dataset_id),
    )
    if file_id is None:
        raise RuntimeError("upload produced no file_id")
    return file_id


async def sync_local_source(dataset_id: str, *, force: bool = False) -> dict[str, Any]:
    """Scan bound local directory and index files in place."""
    from evoflow.knowledge.local_source import sync_local_source as _sync

    if get_dataset(dataset_id) is None:
        raise ValueError("Knowledge base not found")
    return await _sync(dataset_id, force=force)


# ---------------------------------------------------------------------------
# Chunks
# ---------------------------------------------------------------------------

def list_chunks(dataset_id: str, *, page: int = 1, page_size: int = 50) -> dict[str, Any]:
    """List chunks for a dataset with pagination."""
    offset = (page - 1) * page_size
    with db_connection_lock():
        conn = get_db()
        total = conn.execute(
            "SELECT COUNT(*) AS c FROM evoflow_kb_chunk WHERE dataset_id = ?",
            (dataset_id,),
        ).fetchone()["c"]
        rows = conn.execute(
            """
            SELECT c.chunk_id, c.dataset_id, c.file_id, c.seq, c.content,
                   c.token_count, c.char_start, c.char_end, c.created_at,
                   f.name AS file_name
            FROM evoflow_kb_chunk c
            LEFT JOIN evoflow_kb_source_file f ON c.file_id = f.file_id
            WHERE c.dataset_id = ?
            ORDER BY c.created_at DESC, c.seq ASC
            LIMIT ? OFFSET ?
            """,
            (dataset_id, page_size, offset),
        ).fetchall()
    return {
        "total": total,
        "page": page,
        "page_size": page_size,
        "items": [dict(r) for r in rows],
    }


# ---------------------------------------------------------------------------
# Search
# ---------------------------------------------------------------------------

def _file_id_from_summary_chunk_id(chunk_id: str) -> str | None:
    if str(chunk_id or "").startswith("summary_"):
        return str(chunk_id)[len("summary_") :]
    return None


def _rerank_search_hits(
    hits: list[Any],
    chunk_map: dict[str, dict[str, Any]],
    *,
    top_k: int,
) -> list[tuple[Any, dict[str, Any], float]]:
    """Two-level fusion: document summaries boost sections from the same file."""
    summary_scores: dict[str, float] = {}
    section_hits: list[Any] = []
    summary_hits: list[Any] = []

    for hit in hits:
        fid = _file_id_from_summary_chunk_id(hit.chunk_id)
        if fid:
            summary_scores[fid] = max(summary_scores.get(fid, 0.0), float(hit.score))
            summary_hits.append(hit)
        else:
            section_hits.append(hit)

    ranked: list[tuple[Any, dict[str, Any], float]] = []
    for hit in section_hits:
        row = chunk_map.get(hit.chunk_id)
        if not row:
            continue
        fid = str(row.get("file_id") or "")
        bonus = summary_scores.get(fid, 0.0) * 0.25
        ranked.append((hit, row, float(hit.score) + bonus))

    ranked.sort(key=lambda item: item[2], reverse=True)

    if ranked:
        return ranked[:top_k]

    # Fall back to summary rows when no section matched
    fallback: list[tuple[Any, dict[str, Any], float]] = []
    for hit in summary_hits:
        row = chunk_map.get(hit.chunk_id)
        if row:
            fallback.append((hit, row, float(hit.score)))
    fallback.sort(key=lambda item: item[2], reverse=True)
    return fallback[:top_k]


def find_dataset_by_name(name: str) -> dict[str, Any] | None:
    needle = str(name or "").strip().lower()
    if not needle:
        return None
    for row in list_datasets():
        if str(row.get("name") or "").strip().lower() == needle:
            return row
        if str(row.get("dataset_id") or "").strip().lower() == needle:
            return row
    return None


async def search(
    dataset_id: str,
    query: str,
    *,
    top_k: int = 5,
    score_threshold: float = 0.0,
) -> list[dict[str, Any]]:
    """Two-level semantic search: document summaries + section chunks."""
    ds = get_dataset(dataset_id)
    if ds is None:
        raise ValueError(f"Dataset {dataset_id} not found")
    dim = int(ds["embedding_dim"])

    from evoflow.knowledge.embedding import get_embedding, resolve_embedding_model_config

    mc = resolve_embedding_model_config(str(ds.get("embedding_model") or "")) or None
    query_vec = await get_embedding(query, mc, expected_dim=dim)

    vs = VectorStore(dataset_id, dim=dim)
    recall_k = max(top_k * 5, 12)
    hits = vs.recall(query_vec, top_k=recall_k)
    if not hits:
        return []

    chunk_ids = [h.chunk_id for h in hits]
    placeholder = ",".join("?" * len(chunk_ids))
    with db_connection_lock():
        conn = get_db()
        rows = conn.execute(
            f"""
            SELECT c.chunk_id, c.content, c.token_count, c.seq, c.metadata_json,
                   f.name AS file_name, f.file_id, f.summary_index
            FROM evoflow_kb_chunk c
            LEFT JOIN evoflow_kb_source_file f ON c.file_id = f.file_id
            WHERE c.chunk_id IN ({placeholder})
            """,
            chunk_ids,
        ).fetchall()

    chunk_map = {str(r["chunk_id"]): dict(r) for r in rows}
    ranked = _rerank_search_hits(hits, chunk_map, top_k=top_k)

    results: list[dict[str, Any]] = []
    for hit, chunk_data, fused_score in ranked:
        if fused_score < score_threshold:
            continue
        meta = {}
        try:
            meta = json.loads(chunk_data.get("metadata_json") or "{}")
        except Exception:
            meta = {}
        kind = str(meta.get("kind") or ("summary" if hit.chunk_id.startswith("summary_") else "section"))
        results.append({
            "chunk_id": hit.chunk_id,
            "content": chunk_data["content"],
            "score": round(fused_score, 4),
            "distance": round(hit.distance, 4),
            "file_name": chunk_data.get("file_name", ""),
            "file_id": chunk_data.get("file_id", ""),
            "seq": chunk_data.get("seq", 0),
            "token_count": chunk_data.get("token_count", 0),
            "index_text": meta.get("index_text") or chunk_data.get("summary_index") or "",
            "heading_path": meta.get("heading_path") or "",
            "match_kind": kind,
            "dataset_id": dataset_id,
            "dataset_name": ds.get("name") or dataset_id,
        })

    return results


async def search_knowledge_bases(
    query: str,
    *,
    knowledge_base: str | None = None,
    top_k: int = 5,
    score_threshold: float = 0.0,
) -> list[dict[str, Any]]:
    """Search one or all configured knowledge bases."""
    q = str(query or "").strip()
    if not q:
        return []

    targets: list[dict[str, Any]] = []
    if knowledge_base:
        row = find_dataset_by_name(knowledge_base)
        if row:
            targets = [row]
    else:
        targets = list_datasets()

    merged: list[dict[str, Any]] = []
    per_kb = max(2, top_k)
    for ds in targets:
        did = str(ds.get("dataset_id") or "")
        if not did:
            continue
        try:
            items = await search(did, q, top_k=per_kb, score_threshold=score_threshold)
            merged.extend(items)
        except Exception as e:
            logger.warning("KB search failed for %s: %s", did, e)

    merged.sort(key=lambda r: float(r.get("score") or 0), reverse=True)
    return merged[:top_k]


# ---------------------------------------------------------------------------
# Status
# ---------------------------------------------------------------------------

def get_status(dataset_id: str) -> dict[str, Any]:
    """Get processing status for a dataset."""
    with db_connection_lock():
        conn = get_db()
        files = conn.execute(
            "SELECT file_id, name, status, chunk_count, updated_at FROM evoflow_kb_source_file WHERE dataset_id = ? ORDER BY updated_at DESC",
            (dataset_id,),
        ).fetchall()
    return {
        "dataset_id": dataset_id,
        "files": [
            {**dict(f), "status": public_file_status(str(f["status"] or "ready"))}
            for f in files
        ],
        "processing": any(
            public_file_status(str(f["status"] or "ready")) == "processing" for f in files
        ),
    }


# ---------------------------------------------------------------------------
# Folders (Wiki TOC)
# ---------------------------------------------------------------------------

def list_folders(dataset_id: str) -> list[dict[str, Any]]:
    return folders_list(dataset_id)


def create_folder(dataset_id: str, name: str, *, parent_id: str | None = None) -> dict[str, Any]:
    return folders_create(dataset_id, name, parent_id=parent_id)


def rename_folder(folder_id: str, name: str) -> dict[str, Any] | None:
    return folders_rename(folder_id, name)


def delete_folder(folder_id: str) -> bool:
    return folders_delete(folder_id)
