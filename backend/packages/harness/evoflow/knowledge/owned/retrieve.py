"""Hybrid retrieval: FTS5 + embedding blob cosine + RRF."""

from __future__ import annotations

import heapq
import logging
import math
import struct
from typing import Any

from evoflow.knowledge.owned.assets import assets_for_chunks
from evoflow.knowledge.owned.kb_conn import db_for_kb
from evoflow.knowledge.owned import vector_index

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
    old_ids = [r["id"] for r in conn.execute("SELECT id FROM kb_chunks WHERE doc_id=?", (doc_id,)).fetchall()]
    if old_ids:
        vector_index.delete_chunk_ids(conn, old_ids)
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


def _cjk_overlap(query: str, text: str) -> float:
    """Cheap bigram overlap for unbroken CJK queries (e.g. 工作流怎么发布 vs 工作流发布)."""
    q = str(query or "").strip()
    t = str(text or "")
    if len(q) < 2 or not t:
        return 0.0
    grams = {q[i : i + 2] for i in range(len(q) - 1)}
    if not grams:
        return 0.0
    hit = sum(1 for g in grams if g in t)
    return hit / len(grams)


def _keyword_relevance(content: str, query: str, *, bm25_raw: float, order_i: int) -> float:
    """Higher-is-better keyword score (CORE-KB-01)."""
    text = str(content or "")
    q = str(query or "").strip()
    q_cf = q.casefold()
    text_cf = text.casefold()
    density = (text_cf.count(q_cf) / max(len(text_cf), 1)) if q_cf else 0.0
    # Phrase / substring boost — critical for CJK queries with no whitespace tokens.
    phrase = 0.0
    if q_cf and q_cf in text_cf:
        phrase = 0.55 + min(0.35, density * 50.0)
    else:
        overlap = _cjk_overlap(q_cf, text_cf)
        if overlap >= 0.35:
            phrase = 0.25 + 0.45 * overlap
    try:
        bm25_abs = abs(float(bm25_raw))
    except (TypeError, ValueError):
        bm25_abs = 0.0
    # No lexical evidence → tiny tie-breaker only (must stay below any phrase hit).
    if bm25_abs == 0.0 and phrase == 0.0 and density == 0.0:
        return 0.01 / (order_i + 2)
    bm25_term = 1.0 / (1.0 + bm25_abs + order_i * 0.001) if bm25_abs else 0.0
    return phrase + density * 8.0 + bm25_term


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
    by_id: dict[str, dict[str, Any]] = {}
    with db_for_kb(kb_id) as conn:
        rows = []
        try:
            rows = conn.execute(
                """
                SELECT f.chunk_id, f.doc_id, f.content, bm25(kb_chunks_fts) AS rank
                FROM kb_chunks_fts f
                JOIN kb_chunks c ON c.id = f.chunk_id
                JOIN kb_documents d ON d.id = f.doc_id AND d.deleted_at IS NULL
                WHERE f.kb_id = ? AND c.enabled = 1 AND d.parse_status = 'completed'
                  AND kb_chunks_fts MATCH ?
                ORDER BY rank
                LIMIT ?
                """,
                (kb_id, match, max(top_k * 3, 40)),
            ).fetchall()
        except Exception as exc:
            logger.warning("FTS search failed: %s", exc)
            rows = []
        for i, row in enumerate(rows):
            try:
                bm25_raw = float(row["rank"])
            except (TypeError, ValueError, KeyError):
                bm25_raw = float(i)
            content = str(row["content"] or "")
            cid = str(row["chunk_id"])
            relevance = _keyword_relevance(content, q, bm25_raw=bm25_raw, order_i=i)
            by_id[cid] = {
                "chunk_id": cid,
                "kb_id": kb_id,
                "doc_id": row["doc_id"],
                "content": content,
                "score": relevance,
                "keyword_score": relevance,
                "source": "keyword",
            }
        # Always supplement with LIKE for CJK / unbroken phrases (CORE-KB-01/02).
        like = f"%{q}%"
        try:
            like_rows = conn.execute(
                """
                SELECT c.id AS chunk_id, c.doc_id, c.content, 0 AS rank
                FROM kb_chunks c
                JOIN kb_documents d ON d.id = c.doc_id AND d.deleted_at IS NULL
                WHERE c.kb_id=? AND c.enabled=1 AND d.parse_status='completed' AND c.content LIKE ?
                LIMIT ?
                """,
                (kb_id, like, max(top_k * 3, 40)),
            ).fetchall()
        except Exception:
            like_rows = []
        for i, row in enumerate(like_rows):
            cid = str(row["chunk_id"])
            content = str(row["content"] or "")
            relevance = _keyword_relevance(content, q, bm25_raw=0.0, order_i=i)
            prev = by_id.get(cid)
            if prev is None or relevance > float(prev.get("score") or 0):
                by_id[cid] = {
                    "chunk_id": cid,
                    "kb_id": kb_id,
                    "doc_id": row["doc_id"],
                    "content": content,
                    "score": relevance,
                    "keyword_score": relevance,
                    "source": "keyword",
                }
    hits = sorted(by_id.values(), key=lambda h: float(h.get("score") or 0), reverse=True)[:top_k]
    for i, h in enumerate(hits):
        h["rank"] = i + 1
    return hits


def search_vector(
    kb_id: str,
    query_vec: list[float],
    *,
    top_k: int = 20,
    model: str = "",
) -> list[dict[str, Any]]:
    if not query_vec:
        return []
    candidate_limit = max(int(top_k or 20), 1)
    with db_for_kb(kb_id) as conn:
        dim = len(query_vec)
        vec_hits = vector_index.recall_ids(
            conn,
            kb_id=kb_id,
            dim=dim,
            model=model,
            query_vec=query_vec,
            top_k=candidate_limit,
        )
        if vec_hits is not None:
            ids = [chunk_id for chunk_id, _distance in vec_hits]
            if not ids:
                return []
            placeholders = ",".join("?" * len(ids))
            rows = conn.execute(
                f"""
                SELECT e.chunk_id, e.doc_id, e.dim, e.embedding, c.content, c.context_header
                FROM kb_chunk_embeddings e
                JOIN kb_chunks c ON c.id=e.chunk_id
                JOIN kb_documents d ON d.id=e.doc_id AND d.deleted_at IS NULL
                WHERE e.chunk_id IN ({placeholders}) AND e.dim=?
                  AND (? = '' OR e.model = ?)
                  AND c.enabled=1 AND d.parse_status='completed'
                """,
                [*ids, dim, str(model or ""), str(model or "")],
            ).fetchall()
            by_id = {str(row["chunk_id"]): row for row in rows}
            hits: list[dict[str, Any]] = []
            for rank, (chunk_id, distance) in enumerate(vec_hits, 1):
                row = by_id.get(chunk_id)
                if not row:
                    continue
                # Distance → bounded similarity in (0, 1]; avoid negative vectorScore (CORE-KB-02).
                try:
                    dist = max(float(distance), 0.0)
                except (TypeError, ValueError):
                    dist = 1.0
                similarity = 1.0 / (1.0 + dist)
                hits.append({
                    "chunk_id": chunk_id,
                    "kb_id": kb_id,
                    "doc_id": row["doc_id"],
                    "content": row["content"],
                    "context_header": row["context_header"] or "",
                    "score": similarity,
                    "vector_score": similarity,
                    "source": "vector",
                    "rank": rank,
                })
            return hits

        # Fallback for installations where sqlite-vec is unavailable.
        # Keep only the best candidates while scanning.
        scored: list[tuple[float, int, dict[str, Any]]] = []
        rows = conn.execute(
            """
            SELECT e.chunk_id, e.doc_id, e.dim, e.embedding, c.content, c.context_header
            FROM kb_chunk_embeddings e
            JOIN kb_chunks c ON c.id = e.chunk_id
            JOIN kb_documents d ON d.id = e.doc_id AND d.deleted_at IS NULL
            WHERE e.kb_id=? AND c.enabled=1 AND d.parse_status='completed'
              AND (? = '' OR e.model = ?)
            """,
            (kb_id, str(model or ""), str(model or "")),
        ).fetchall()
        for row in rows:
            dim = int(row["dim"])
            if dim != len(query_vec):
                continue
            vec = unpack_embedding(bytes(row["embedding"]), dim)
            score = cosine(query_vec, vec)
            hit = {
                "chunk_id": row["chunk_id"],
                "kb_id": kb_id,
                "doc_id": row["doc_id"],
                "content": row["content"],
                "context_header": row["context_header"] or "",
                "score": score,
                "source": "vector",
            }
            entry = (score, id(hit), hit)
            if len(scored) < candidate_limit:
                heapq.heappush(scored, entry)
            elif score > scored[0][0]:
                heapq.heapreplace(scored, entry)
    scored.sort(key=lambda x: x[0], reverse=True)
    hits: list[dict[str, Any]] = []
    for i, (_score, _tie, hit) in enumerate(scored[:top_k]):
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
    kw_scores: dict[str, float] = {}
    vec_scores: dict[str, float] = {}
    for hit in keyword_hits:
        cid = hit["chunk_id"]
        scores[cid] = scores.get(cid, 0.0) + w_kw * (1.0 / (k + int(hit["rank"])))
        # Prefer keyword relevance magnitude when available (exact phrase >> weak FTS).
        kw_rel = float(hit.get("keyword_score") or hit.get("score") or 0)
        scores[cid] += w_kw * 0.25 * kw_rel
        kw_scores[cid] = max(kw_scores.get(cid, 0.0), kw_rel)
        meta[cid] = {**meta.get(cid, {}), **hit, "source": "hybrid"}
    for hit in vector_hits:
        cid = hit["chunk_id"]
        scores[cid] = scores.get(cid, 0.0) + w_vec * (1.0 / (k + int(hit["rank"])))
        v_rel = float(hit.get("vector_score") or hit.get("score") or 0)
        vec_scores[cid] = max(vec_scores.get(cid, 0.0), v_rel)
        prev = meta.get(cid) or {}
        meta[cid] = {**prev, **hit, "source": "hybrid" if prev else "vector"}
    ordered = sorted(scores.items(), key=lambda x: x[1], reverse=True)[:top_k]
    out: list[dict[str, Any]] = []
    for cid, score in ordered:
        item = dict(meta.get(cid) or {})
        item["chunk_id"] = cid
        item["rrf_score"] = score
        if cid in kw_scores:
            item["keyword_score"] = kw_scores[cid]
        if cid in vec_scores:
            item["vector_score"] = vec_scores[cid]
            item["score"] = vec_scores[cid]
        elif cid in kw_scores:
            item["score"] = kw_scores[cid]
        out.append(item)
    return out


def enrich_hits(hits: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Attach document metadata to chunk hits.

    Hits carry ``kb_id`` from the index; group by KB so a cross-KB search reads
    each KB's own index DB exactly once.
    """
    if not hits:
        return []
    chunk_ids = [h["chunk_id"] for h in hits]
    by_kb: dict[str, list[str]] = {}
    for h in hits:
        kid = str(h.get("kb_id") or "").strip()
        if not kid:
            continue
        by_kb.setdefault(kid, []).append(h["chunk_id"])

    by_id: dict[str, Any] = {}
    for kid, ids in by_kb.items():
        placeholders = ",".join("?" * len(ids))
        try:
            with db_for_kb(kid) as conn:
                rows = conn.execute(
                    f"""
                    SELECT c.*, d.title, d.file_name, d.folder_path, d.blob_path, d.tags_json
                    FROM kb_chunks c
                    JOIN kb_documents d ON d.id = c.doc_id
                    WHERE c.id IN ({placeholders})
                    """,
                    ids,
                ).fetchall()
        except Exception:
            logger.debug("enrich skipped for kb=%s", kid, exc_info=True)
            continue
        for r in rows:
            by_id[r["id"]] = r
    asset_map = assets_for_chunks(chunk_ids, kb_id=next(iter(by_kb)) if len(by_kb) == 1 else None)
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
        vec = h.get("vector_score")
        if vec is None and h.get("source") == "vector":
            vec = h.get("score")
        kw = h.get("keyword_score")
        if kw is None and h.get("source") == "keyword":
            kw = h.get("score")
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
                "vectorScore": vec,
                "keywordScore": kw,
                "source": h.get("source"),
                "assets": asset_map.get(row["id"]) or [],
            }
        )
    return enriched


def rerank_by_query_match(items: list[dict[str, Any]], query: str) -> list[dict[str, Any]]:
    """Boost exact title/content hits above merely similar vector neighbors (CORE-KB-02)."""
    q = str(query or "").strip().casefold()
    if not q or not items:
        return items

    def _key(item: dict[str, Any]) -> tuple[float, float, float, float]:
        title = str(item.get("title") or item.get("fileName") or "").casefold()
        content = str(item.get("content") or "").casefold()
        title_hit = 3.0 if q in title else 0.0
        content_hit = 1.5 if q in content else 0.0
        # Partial CJK overlap when full phrase is absent.
        if title_hit == 0.0 and len(q) >= 4:
            title_hit = 2.0 * _cjk_overlap(q, title)
        if content_hit == 0.0 and len(q) >= 4:
            content_hit = 1.0 * _cjk_overlap(q, content)
        rrf = float(item.get("rrfScore") or item.get("rrf_score") or 0)
        kw = float(item.get("keywordScore") or item.get("keyword_score") or 0)
        vec = float(item.get("vectorScore") or item.get("vector_score") or 0)
        return (title_hit + content_hit, kw, rrf, max(vec, 0.0))

    return sorted(items, key=_key, reverse=True)


def search_title(kb_id: str, query: str, *, top_k: int = 20) -> list[dict[str, Any]]:
    q = (query or "").strip()
    if not q:
        return []
    like = f"%{q}%"
    with db_for_kb(kb_id) as conn:
        docs = conn.execute(
            """
            SELECT id FROM kb_documents
            WHERE kb_id=? AND deleted_at IS NULL AND parse_status='completed'
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
                    "kb_id": kb_id,
                    "doc_id": row["doc_id"],
                    "content": row["content"],
                    "rank": i + 1,
                    "source": "title",
                }
            )
    return hits
