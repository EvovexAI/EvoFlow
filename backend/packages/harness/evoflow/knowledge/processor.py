"""Document processing pipeline for the evoflow knowledge base.

Orchestrates: parse → LLM/structure chunk → build indexes → embed → store.
Internal stages exist for logging; user-facing status is simplified to
``processing`` / ``ready`` / ``error``.
"""

from __future__ import annotations

import hashlib
import json
import logging
import uuid
from pathlib import Path
from typing import Any

from evoflow.knowledge.embedding import get_embeddings, get_embedding_config, resolve_embedding_model_config
from evoflow.knowledge.folders import normalize_folder_id
from evoflow.knowledge.index_builder import (
    embedding_text_for_chunk,
    summary_vector_chunk_id,
)
from evoflow.knowledge.llm_indexer import kb_llm_enabled, process_document_with_llm
from evoflow.knowledge.parser import parse_file
from evoflow.knowledge.vector.sqlite_vec import VectorStore
from evoflow.persistence.db import db_connection_lock, get_db

logger = logging.getLogger(__name__)

_EMBEDDING_BATCH_SIZE = 50


def public_file_status(status: str) -> str:
    if status in ("parsing", "chunking", "embedding", "pending"):
        return "processing"
    return status or "ready"


async def process_file(
    dataset_id: str,
    file_path: str | Path,
    *,
    folder_id: str | None = None,
    relative_path: str = "",
    llm_index: bool | None = None,
    stable_path_key: str | None = None,
    skip_if_unchanged: bool = True,
) -> str | None:
    """Process a single source file with automatic chunking and indexing."""
    p = Path(file_path).resolve()
    content_hash = _file_hash(p)
    target_folder = normalize_folder_id(dataset_id, folder_id)
    file_id = (
        _stable_file_id(dataset_id, stable_path_key)
        if stable_path_key
        else _make_file_id(dataset_id, p)
    )

    existing = _get_source_file(file_id)
    if skip_if_unchanged and existing:
        prev_hash = str(existing.get("content_hash") or "")
        prev_status = str(existing.get("status") or "")
        if prev_hash == content_hash and prev_status == "ready":
            return None

    if existing:
        _clear_file_vectors_and_chunks(dataset_id, file_id)

    _upsert_source_file(
        file_id,
        dataset_id,
        p,
        content_hash,
        folder_id=target_folder,
        relative_path=relative_path or p.name,
    )

    try:
        _update_source_file_status(file_id, "parsing")
        text = parse_file(p)
        logger.info("Parsed %s → %d chars", p.name, len(text))

        if not text.strip():
            _update_source_file_status(file_id, "error", error_msg="Empty content after parsing")
            raise RuntimeError(f"File {p.name} produced empty text")

        _update_source_file_status(file_id, "chunking")
        summary_text, summary_index, chunks = await process_document_with_llm(
            text, file_name=p.name, use_llm=llm_index
        )
        _save_file_summary(file_id, summary_text, summary_index)
        use_llm = llm_index if llm_index is not None else kb_llm_enabled()
        logger.info("Indexed %s → %d sections (llm=%s)", p.name, len(chunks), use_llm)

        if not chunks:
            _update_source_file_status(file_id, "error", error_msg="No chunks produced")
            raise RuntimeError(f"File {p.name} produced no chunks")

        _update_source_file_status(file_id, "embedding")
        ds_row = _get_dataset_embedding_meta(dataset_id)
        mc = resolve_embedding_model_config(ds_row["embedding_model"]) or get_embedding_config()
        dim = ds_row["embedding_dim"]
        vs = VectorStore(dataset_id, dim=dim)

        chunk_ids = _write_chunks(file_id, dataset_id, chunks)
        embed_texts = [embedding_text_for_chunk(c) for c in chunks]
        await _batch_embed_and_store(vs, chunk_ids, embed_texts, dim, mc)

        summary_id = summary_vector_chunk_id(file_id)
        summary_embed_text = f"{summary_index}\n\n{summary_text}".strip()
        _write_summary_chunk(file_id, dataset_id, summary_id, summary_text, summary_index)
        await _batch_embed_and_store(vs, [summary_id], [summary_embed_text], dim, mc)

        _update_source_file_status(file_id, "ready", chunk_count=len(chunks))
        logger.info("Processed %s: %d sections + summary indexed", p.name, len(chunks))

    except Exception as e:
        logger.error("Failed to process %s: %s", p.name, e)
        _update_source_file_status(file_id, "error", error_msg=str(e)[:500])
        raise

    return file_id


def _make_file_id(dataset_id: str, p: Path) -> str:
    return f"file_{uuid.uuid4().hex[:16]}"


def _file_hash(p: Path) -> str:
    h = hashlib.sha256()
    h.update(p.read_bytes())
    return h.hexdigest()[:32]


def _stable_file_id(dataset_id: str, stable_path_key: str) -> str:
    digest = hashlib.sha256(f"{dataset_id}:{stable_path_key}".encode()).hexdigest()
    return f"file_{digest[:16]}"


def _get_source_file(file_id: str) -> dict[str, Any] | None:
    with db_connection_lock():
        conn = get_db()
        row = conn.execute(
            """
            SELECT file_id, content_hash, status
            FROM evoflow_kb_source_file WHERE file_id = ?
            """,
            (file_id,),
        ).fetchone()
    return dict(row) if row else None


def _clear_file_vectors_and_chunks(dataset_id: str, file_id: str) -> None:
    with db_connection_lock():
        conn = get_db()
        chunk_ids = [
            str(r["chunk_id"])
            for r in conn.execute(
                "SELECT chunk_id FROM evoflow_kb_chunk WHERE file_id = ?",
                (file_id,),
            ).fetchall()
        ]
    if chunk_ids:
        try:
            vs = VectorStore(dataset_id)
            vs.delete_many(chunk_ids)
        except Exception as e:
            logger.warning("Failed to clean vectors for file %s: %s", file_id, e)
    with db_connection_lock():
        conn = get_db()
        conn.execute("DELETE FROM evoflow_kb_chunk WHERE file_id = ?", (file_id,))
        conn.commit()


def _upsert_source_file(
    file_id: str,
    dataset_id: str,
    p: Path,
    content_hash: str,
    *,
    folder_id: str,
    relative_path: str,
) -> None:
    resolved = str(p.resolve())
    with db_connection_lock():
        conn = get_db()
        row = conn.execute(
            "SELECT file_id FROM evoflow_kb_source_file WHERE file_id = ?",
            (file_id,),
        ).fetchone()
        if row:
            conn.execute(
                """
                UPDATE evoflow_kb_source_file
                SET path = ?, name = ?, content_hash = ?, size_bytes = ?,
                    folder_id = ?, relative_path = ?, chunk_count = 0, status = 'pending',
                    summary_text = '', summary_index = ''
                WHERE file_id = ?
                """,
                (resolved, p.name, content_hash, p.stat().st_size, folder_id, relative_path, file_id),
            )
        else:
            conn.execute(
                """
                INSERT INTO evoflow_kb_source_file (
                    file_id, dataset_id, path, name, content_hash, size_bytes,
                    chunk_count, status, folder_id, relative_path
                ) VALUES (?, ?, ?, ?, ?, ?, 0, 'pending', ?, ?)
                """,
                (
                    file_id,
                    dataset_id,
                    resolved,
                    p.name,
                    content_hash,
                    p.stat().st_size,
                    folder_id,
                    relative_path,
                ),
            )
        conn.commit()


def _create_source_file(
    file_id: str,
    dataset_id: str,
    p: Path,
    content_hash: str,
    *,
    folder_id: str,
    relative_path: str,
) -> None:
    with db_connection_lock():
        conn = get_db()
        conn.execute(
            """
            INSERT INTO evoflow_kb_source_file (
                file_id, dataset_id, path, name, content_hash, size_bytes,
                chunk_count, status, folder_id, relative_path
            ) VALUES (?, ?, ?, ?, ?, ?, 0, 'pending', ?, ?)
            """,
            (
                file_id,
                dataset_id,
                str(p.resolve()),
                p.name,
                content_hash,
                p.stat().st_size,
                folder_id,
                relative_path,
            ),
        )
        conn.commit()


def _save_file_summary(file_id: str, summary_text: str, summary_index: str) -> None:
    with db_connection_lock():
        conn = get_db()
        conn.execute(
            """
            UPDATE evoflow_kb_source_file
            SET summary_text = ?, summary_index = ?
            WHERE file_id = ?
            """,
            (summary_text, summary_index, file_id),
        )
        conn.commit()


def _update_source_file_status(
    file_id: str, status: str, *, chunk_count: int | None = None, error_msg: str | None = None
) -> None:
    with db_connection_lock():
        conn = get_db()
        if error_msg:
            conn.execute(
                "UPDATE evoflow_kb_source_file SET status = ?, metadata_json = ? WHERE file_id = ?",
                (status, json.dumps({"error": error_msg}, ensure_ascii=False), file_id),
            )
        elif chunk_count is not None:
            conn.execute(
                "UPDATE evoflow_kb_source_file SET status = ?, chunk_count = ? WHERE file_id = ?",
                (status, chunk_count, file_id),
            )
        else:
            conn.execute(
                "UPDATE evoflow_kb_source_file SET status = ? WHERE file_id = ?",
                (status, file_id),
            )
        conn.commit()


def _get_dataset_embedding_meta(dataset_id: str) -> dict[str, Any]:
    with db_connection_lock():
        conn = get_db()
        row = conn.execute(
            "SELECT embedding_dim, embedding_model FROM evoflow_kb_dataset WHERE dataset_id = ?",
            (dataset_id,),
        ).fetchone()
    if row is None:
        return {"embedding_dim": 1536, "embedding_model": ""}
    return {
        "embedding_dim": int(row["embedding_dim"]),
        "embedding_model": str(row["embedding_model"] or ""),
    }


def _write_chunks(file_id: str, dataset_id: str, chunks: list[dict]) -> list[str]:
    chunk_ids: list[str] = []
    rows: list[tuple] = []

    for seq, chunk in enumerate(chunks):
        cid = f"chunk_{uuid.uuid4().hex[:16]}"
        chunk_ids.append(cid)
        meta = chunk.get("metadata_json") or json.dumps(
            {
                "heading_path": chunk.get("heading_path") or "",
                "index_text": chunk.get("index_text") or "",
                "title": chunk.get("title") or "",
                "kind": "section",
            },
            ensure_ascii=False,
        )
        rows.append(
            (
                cid,
                dataset_id,
                file_id,
                seq,
                chunk["content"],
                chunk["token_count"],
                chunk["char_start"],
                chunk["char_end"],
                meta,
            )
        )

    with db_connection_lock():
        conn = get_db()
        conn.executemany(
            """
            INSERT INTO evoflow_kb_chunk (
                chunk_id, dataset_id, file_id, seq, content, token_count,
                char_start, char_end, metadata_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            rows,
        )
        conn.commit()

    return chunk_ids


def _write_summary_chunk(
    file_id: str,
    dataset_id: str,
    summary_id: str,
    summary_text: str,
    summary_index: str,
) -> None:
    meta = json.dumps(
        {"kind": "summary", "index_text": summary_index, "heading_path": "文档摘要"},
        ensure_ascii=False,
    )
    with db_connection_lock():
        conn = get_db()
        conn.execute(
            """
            INSERT INTO evoflow_kb_chunk (
                chunk_id, dataset_id, file_id, seq, content, token_count,
                char_start, char_end, metadata_json
            ) VALUES (?, ?, ?, -1, ?, ?, 0, 0, ?)
            """,
            (summary_id, dataset_id, file_id, summary_text, max(1, len(summary_text) // 4), meta),
        )
        conn.commit()


async def _batch_embed_and_store(
    vs: VectorStore,
    chunk_ids: list[str],
    chunk_texts: list[str],
    expected_dim: int,
    model_config,
) -> None:
    total = len(chunk_texts)
    for i in range(0, total, _EMBEDDING_BATCH_SIZE):
        batch_ids = chunk_ids[i : i + _EMBEDDING_BATCH_SIZE]
        batch_texts = chunk_texts[i : i + _EMBEDDING_BATCH_SIZE]
        embeddings = await get_embeddings(
            batch_texts,
            model_config,
            expected_dim=expected_dim,
            batch_size=_EMBEDDING_BATCH_SIZE,
        )
        vs.insert_many(list(zip(batch_ids, embeddings, strict=True)))

    logger.info("Embedded and stored %d vectors", total)
