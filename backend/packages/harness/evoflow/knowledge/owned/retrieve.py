"""Hybrid retrieval: FTS5 + embedding blob cosine + RRF."""

from __future__ import annotations

import logging
import math
import struct
from typing import Any

from evoflow.knowledge.owned.assets import assets_for_chunks
from evoflow.knowledge.owned.db import db

logger = logging.getLogger(__name__)

RRF_K = 60


def pack_embedding(values: list[float]) -> bytes:
    return struct.pack(f"{len(values)}f", *values)


def unpack_embedding(blob: bytes, dim: int) -> list[float]:
    return list(struct.unpack(f"{dim}f", blob))


def cosine(a: list[float], b: list[float]) -> float:
    if not a or not b or len(a) != len(b):
        return 0.0
    dot = 0.0
    na = 0.0
    nb = 0.0
    for x, y in zip(a, b, strict=True):
        dot += x * y
        na += x * x
        nb += y * y
    if na <= 0 or nb <= 0:
        return 0.0
    return dot / (math.sqrt(na) * math.sqrt(nb))


def index_fts(conn: Any, *, chunk_id: str, kb_id: str, doc_id: str, content: str) -> None:
    try:
        conn.execute("DELETE FROM kb_chunks_fts WHERE chunk_id=?", (chunk_id,))
        conn.execute(
            "INSERT INTO kb_chunks_fts(chunk_id, kb_id, doc_id, content) VALUES (?,?,?,?)",
            (chunk_id, kb_id, doc_id, content),
        )
    except Exception as exc:
        logger.debug("FTS index skip: %s", exc)


def delete_fts_for_doc(conn: Any, doc_id: str) -> None:
    try:
        conn.execute("DELETE FROM kb_chunks_fts WHERE doc_id=?", (doc_id,))
    except Exception:
        pass


def purge_document_index(conn: Any, doc_id: str) -> None:
    """Remove FTS, embeddings, chunks, and asset rows for a document (soft-delete cleanup)."""
    delete_fts_for_doc(conn, doc_id)
    old_ids = [
        r["id"]
        for r in conn.execute("SELECT id FROM kb_chunks WHERE doc_id=?", (doc_id,)).fetchall()
    ]
    if old_ids:
        placeholders = ",".join("?" * len(old_ids))
        conn.execute(
            f"DELETE FROM kb_chunk_embeddings WHERE chunk_id IN ({placeholders})",
            old_ids,
        )
    conn.execute("DELETE FROM kb_chunks WHERE doc_id=?", (doc_id,))
    try:
        conn.execute("DELETE FROM kb_assets WHERE doc_id=?", (doc_id,))
    except Exception:
        pass


def search_keyword(kb_id: str, query: str, *, top_k: int = 20) -> list[dict[str, Any]]:
    q = (query or "").strip()
    if not q:
        return []
    # Escape FTS5 special chars lightly
    safe = q.replace('"', " ").replace("'", " ")
    tokens = [t for t in safe.split() if t]
    if not tokens:
        match = f'"{safe}"' if safe else ""
    else:
        match = " OR ".join(f'"{t}"' for t in tokens)
    if not match:
        return []
    hits: list[dict[str, Any]] = []
    with db() as conn:
        rows = []
        try:
            rows = conn.execute(
                """
                SELECT f.chunk_id, f.doc_id, f.content, bm25(kb_chunks_fts) AS rank
                FROM kb_chunks_fts f
                JOIN kb_chunks c ON c.id = f.chunk_id
                WHERE f.kb_id = ? AND c.enabled = 1 AND kb_chunks_fts MATCH ?
                ORDER BY rank
                LIMIT ?
                """,
                (kb_id, match, top_k),
            ).fetchall()
        except Exception as exc:
            logger.warning("FTS search failed: %s", exc)
            rows = []
        # CJK / short queries often need LIKE when FTS tokenizer splits poorly
        if not rows:
            like = f"%{q}%"
            rows = conn.execute(
                """
                SELECT id AS chunk_id, doc_id, content, 0 AS rank
                FROM kb_chunks
                WHERE kb_id=? AND enabled=1 AND content LIKE ?
                LIMIT ?
                """,
                (kb_id, like, top_k),
            ).fetchall()
        for i, row in enumerate(rows):
            hits.append(
                {
                    "chunk_id": row["chunk_id"],
                    "doc_id": row["doc_id"],
                    "content": row["content"],
                    "rank": i + 1,
                    "source": "keyword",
                }
            )
    return hits


def search_vector(
    kb_id: str,
    query_vec: list[float],
    *,
    top_k: int = 20,
) -> list[dict[str, Any]]:
    if not query_vec:
        return []
    scored: list[tuple[float, dict[str, Any]]] = []
    with db() as conn:
        rows = conn.execute(
            """
            SELECT e.chunk_id, e.doc_id, e.dim, e.embedding, c.content, c.context_header
            FROM kb_chunk_embeddings e
            JOIN kb_chunks c ON c.id = e.chunk_id
            WHERE e.kb_id=? AND c.enabled=1
            """,
            (kb_id,),
        ).fetchall()
        for row in rows:
            dim = int(row["dim"])
            if dim != len(query_vec):
                continue
            vec = unpack_embedding(bytes(row["embedding"]), dim)
            score = cosine(query_vec, vec)
            scored.append(
                (
                    score,
                    {
                        "chunk_id": row["chunk_id"],
                        "doc_id": row["doc_id"],
                        "content": row["content"],
                        "context_header": row["context_header"] or "",
                        "score": score,
                        "source": "vector",
                    },
                )
            )
    scored.sort(key=lambda x: x[0], reverse=True)
    hits: list[dict[str, Any]] = []
    for i, (_s, hit) in enumerate(scored[:top_k]):
        hit["rank"] = i + 1
        hits.append(hit)
    return hits


def rrf_fuse(
    keyword_hits: list[dict[str, Any]],
    vector_hits: list[dict[str, Any]],
    *,
    top_k: int = 8,
    k: int = RRF_K,
    w_kw: float = 1.0,
    w_vec: float = 1.0,
) -> list[dict[str, Any]]:
    scores: dict[str, float] = {}
    meta: dict[str, dict[str, Any]] = {}
    for hit in keyword_hits:
        cid = hit["chunk_id"]
        scores[cid] = scores.get(cid, 0.0) + w_kw * (1.0 / (k + int(hit["rank"])))
        meta[cid] = {**meta.get(cid, {}), **hit}
    for hit in vector_hits:
        cid = hit["chunk_id"]
        scores[cid] = scores.get(cid, 0.0) + w_vec * (1.0 / (k + int(hit["rank"])))
        meta[cid] = {**meta.get(cid, {}), **hit}
    ordered = sorted(scores.items(), key=lambda x: x[1], reverse=True)[:top_k]
    out: list[dict[str, Any]] = []
    for cid, score in ordered:
        item = dict(meta.get(cid) or {})
        item["chunk_id"] = cid
        item["rrf_score"] = score
        out.append(item)
    return out


def enrich_hits(hits: list[dict[str, Any]]) -> list[dict[str, Any]]:
    if not hits:
        return []
    chunk_ids = [h["chunk_id"] for h in hits]
    placeholders = ",".join("?" * len(chunk_ids))
    with db() as conn:
        rows = conn.execute(
            f"""
            SELECT c.*, d.title, d.file_name, d.folder_path, d.blob_path, d.tags_json
            FROM kb_chunks c
            JOIN kb_documents d ON d.id = c.doc_id
            WHERE c.id IN ({placeholders})
            """,
            chunk_ids,
        ).fetchall()
        by_id = {r["id"]: r for r in rows}
    asset_map = assets_for_chunks(chunk_ids)
    enriched: list[dict[str, Any]] = []
    for h in hits:
        row = by_id.get(h["chunk_id"])
        if not row:
            continue
        tags = []
        try:
            import json

            tags = json.loads(row["tags_json"] or "[]") or []
            if not isinstance(tags, list):
                tags = []
        except Exception:
            tags = []
        enriched.append(
            {
                "chunkId": row["id"],
                "docId": row["doc_id"],
                "kbId": row["kb_id"],
                "content": row["content"],
                "contextHeader": row["context_header"] or "",
                "chunkKind": row["chunk_kind"],
                "title": row["title"],
                "fileName": row["file_name"],
                "folderPath": row["folder_path"],
                "tags": [str(t) for t in tags],
                "rrfScore": h.get("rrf_score"),
                "vectorScore": h.get("score"),
                "source": h.get("source"),
                "assets": asset_map.get(row["id"]) or [],
            }
        )
    return enriched


def search_title(kb_id: str, query: str, *, top_k: int = 20) -> list[dict[str, Any]]:
    q = (query or "").strip()
    if not q:
        return []
    like = f"%{q}%"
    with db() as conn:
        docs = conn.execute(
            """
            SELECT id FROM kb_documents
            WHERE kb_id=? AND deleted_at IS NULL
              AND (title LIKE ? OR file_name LIKE ? OR folder_path LIKE ?
                   OR IFNULL(summary_text,'') LIKE ?)
            ORDER BY updated_at DESC
            LIMIT ?
            """,
            (kb_id, like, like, like, like, top_k),
        ).fetchall()
        hits: list[dict[str, Any]] = []
        for i, d in enumerate(docs):
            row = conn.execute(
                """
                SELECT id, doc_id, content FROM kb_chunks
                WHERE doc_id=? AND enabled=1
                ORDER BY ordinal LIMIT 1
                """,
                (d["id"],),
            ).fetchone()
            if not row:
                continue
            hits.append(
                {
                    "chunk_id": row["id"],
                    "doc_id": row["doc_id"],
                    "content": row["content"],
                    "rank": i + 1,
                    "source": "title",
                }
            )
    return hits
