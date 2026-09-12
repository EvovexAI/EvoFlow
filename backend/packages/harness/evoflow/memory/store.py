"""Low-level mem_* persistence on owned.sqlite."""

from __future__ import annotations

import json
import logging
import math
import re
import uuid
from typing import Any

from evoflow.knowledge.owned.db import db
from evoflow.knowledge.owned.retrieve import cosine, pack_embedding, unpack_embedding
from evoflow.memory.namespaces import parse_namespace
from evoflow.timeutil import utc_now_iso_z

logger = logging.getLogger(__name__)

_VALID_LAYERS = frozenset({"episodic", "semantic", "procedural", "journal", "semantic_self"})
_LAYER_ALIASES = {
    "journal": "episodic",
    "semantic_self": "semantic",
    "fact": "semantic",
    "episode": "episodic",
    "howto": "procedural",
}

# Latin / digit tokens and contiguous CJK runs for keyword search.
_LATIN_TOKEN_RE = re.compile(r"[A-Za-z0-9_]{2,}")
_CJK_RUN_RE = re.compile(r"[\u4e00-\u9fff]{2,}")


def _keyword_search_terms(query: str) -> list[str]:
    """Build FTS/LIKE terms: latin tokens + CJK runs + char bigrams."""
    q = (query or "").strip()
    if not q:
        return []
    terms: list[str] = []
    seen: set[str] = set()

    def _add(t: str) -> None:
        t = t.strip()
        if len(t) < 2 or t in seen:
            return
        seen.add(t)
        terms.append(t)

    safe = q.replace('"', " ").replace("'", " ")
    for tok in safe.split():
        _add(tok)
    for m in _LATIN_TOKEN_RE.finditer(safe):
        _add(m.group(0))
    for m in _CJK_RUN_RE.finditer(safe):
        run = m.group(0)
        _add(run)
        if len(run) >= 2:
            for i in range(len(run) - 1):
                _add(run[i : i + 2])
    if not terms:
        _add(safe)
    # Prefer longer / more specific terms first for LIKE scoring
    terms.sort(key=lambda t: (-len(t), t))
    return terms[:24]


def _dumps(obj: Any) -> str:
    return json.dumps(obj, ensure_ascii=False, separators=(",", ":"))


def _loads_obj(raw: str | None, default: Any) -> Any:
    if not raw:
        return default
    try:
        return json.loads(raw)
    except Exception:
        return default


def _norm_layer(layer: str) -> str:
    raw = (layer or "semantic").strip().lower()
    mapped = _LAYER_ALIASES.get(raw, raw)
    return mapped if mapped in {"episodic", "semantic", "procedural"} else "semantic"


def ensure_namespace(
    ns_id: str,
    *,
    title: str = "",
    org_id: str | None = None,
    owner_scope_id: str | None = None,
    created_by: str | None = None,
) -> str:
    kind, owner = parse_namespace(ns_id)
    nid = f"{kind}:{owner}" if kind and owner else ns_id
    now = utc_now_iso_z()
    with db() as conn:
        cols = {str(r[1]) for r in conn.execute("PRAGMA table_info(mem_namespaces)").fetchall()}
        row = conn.execute("SELECT id FROM mem_namespaces WHERE id=?", (nid,)).fetchone()
        if row:
            conn.execute(
                "UPDATE mem_namespaces SET updated_at=?, title=CASE WHEN ?!='' THEN ? ELSE title END WHERE id=?",
                (now, title, title, nid),
            )
            # Backfill empty ownership once if provided
            if "owner_scope_id" in cols and owner_scope_id:
                conn.execute(
                    """
                    UPDATE mem_namespaces
                    SET org_id = COALESCE(NULLIF(org_id, ''), ?),
                        owner_scope_id = COALESCE(NULLIF(owner_scope_id, ''), ?),
                        created_by = COALESCE(NULLIF(created_by, ''), ?)
                    WHERE id = ?
                    """,
                    (org_id or "", owner_scope_id or "", created_by or "", nid),
                )
            return nid
        if "owner_scope_id" in cols:
            conn.execute(
                """
                INSERT INTO mem_namespaces(
                    id, kind, owner_ref, title, created_at, updated_at,
                    org_id, owner_scope_id, created_by
                )
                VALUES (?,?,?,?,?,?,?,?,?)
                """,
                (
                    nid,
                    kind or "user",
                    owner or "default",
                    title or nid,
                    now,
                    now,
                    org_id or "",
                    owner_scope_id or "",
                    created_by or "",
                ),
            )
        else:
            conn.execute(
                """
                INSERT INTO mem_namespaces(id, kind, owner_ref, title, created_at, updated_at)
                VALUES (?,?,?,?,?,?)
                """,
                (nid, kind or "user", owner or "default", title or nid, now, now),
            )
    return nid


def _row_to_atom(row: Any) -> dict[str, Any]:
    d = {k: row[k] for k in row.keys()}
    d["evidence"] = _loads_obj(d.pop("evidence_json", None), {})
    d["tags"] = _loads_obj(d.pop("tags_json", None), [])
    d["pin"] = bool(int(d.get("pin") or 0))
    emb = d.get("embedding")
    dim = d.get("embedding_dim")
    if emb is not None and dim:
        try:
            d["embedding_vec"] = unpack_embedding(bytes(emb), int(dim))
        except Exception:
            d["embedding_vec"] = None
    else:
        d["embedding_vec"] = None
    d.pop("embedding", None)
    return d


def _index_fts(conn: Any, *, atom_id: str, namespace_id: str, content: str) -> None:
    try:
        conn.execute("DELETE FROM mem_atoms_fts WHERE atom_id=?", (atom_id,))
        conn.execute(
            "INSERT INTO mem_atoms_fts(atom_id, namespace_id, content) VALUES (?,?,?)",
            (atom_id, namespace_id, content),
        )
    except Exception as exc:
        logger.debug("mem FTS index skip: %s", exc)


def upsert_atom(
    *,
    namespace_id: str,
    content: str,
    layer: str = "semantic",
    kind: str = "fact",
    summary: str = "",
    importance: float = 0.5,
    confidence: float = 0.7,
    vitality: float = 1.0,
    subject_key: str = "",
    evidence: dict[str, Any] | None = None,
    tags: list[Any] | None = None,
    source: str = "",
    pin: bool = False,
    atom_id: str | None = None,
    embedding: list[float] | None = None,
    replace_subject: bool = True,
) -> str | None:
    text = " ".join(str(content or "").strip().split())
    if not text:
        return None
    ns = ensure_namespace(namespace_id)
    now = utc_now_iso_z()
    layer_n = _norm_layer(layer)
    sk = (subject_key or "").strip()
    aid = (atom_id or "").strip() or str(uuid.uuid4())

    with db() as conn:
        if replace_subject and sk:
            existing = conn.execute(
                """
                SELECT id, revision FROM mem_atoms
                WHERE namespace_id=? AND subject_key=? AND deleted_at IS NULL
                ORDER BY updated_at DESC LIMIT 1
                """,
                (ns, sk),
            ).fetchone()
            if existing:
                aid = existing["id"]
                rev = int(existing["revision"] or 1) + 1
                emb_blob = None
                emb_dim = None
                if embedding:
                    emb_blob = pack_embedding(embedding)
                    emb_dim = len(embedding)
                conn.execute(
                    """
                    UPDATE mem_atoms SET
                      layer=?, kind=?, content=?, summary=?, importance=?, confidence=?,
                      vitality=?, evidence_json=?, tags_json=?, source=?, revision=?,
                      pin=?, updated_at=?,
                      embedding=COALESCE(?, embedding),
                      embedding_dim=COALESCE(?, embedding_dim)
                    WHERE id=?
                    """,
                    (
                        layer_n,
                        kind or "fact",
                        text,
                        summary or "",
                        float(importance),
                        float(confidence),
                        float(vitality),
                        _dumps(evidence or {}),
                        _dumps(tags or []),
                        source or "",
                        rev,
                        1 if pin else 0,
                        now,
                        emb_blob,
                        emb_dim,
                        aid,
                    ),
                )
                _index_fts(conn, atom_id=aid, namespace_id=ns, content=text)
                return aid

        emb_blob = pack_embedding(embedding) if embedding else None
        emb_dim = len(embedding) if embedding else None
        conn.execute(
            """
            INSERT INTO mem_atoms(
              id, namespace_id, layer, kind, content, summary, importance, confidence,
              vitality, subject_key, evidence_json, tags_json, source, revision, pin,
              created_at, updated_at, embedding, embedding_dim
            ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
            """,
            (
                aid,
                ns,
                layer_n,
                kind or "fact",
                text,
                summary or "",
                float(importance),
                float(confidence),
                float(vitality),
                sk,
                _dumps(evidence or {}),
                _dumps(tags or []),
                source or "",
                1,
                1 if pin else 0,
                now,
                now,
                emb_blob,
                emb_dim,
            ),
        )
        _index_fts(conn, atom_id=aid, namespace_id=ns, content=text)
    return aid


def soft_delete_atom(atom_id: str, *, source: str | None = None) -> bool:
    aid = (atom_id or "").strip()
    if not aid:
        return False
    now = utc_now_iso_z()
    with db() as conn:
        if source:
            cur = conn.execute(
                """
                UPDATE mem_atoms SET deleted_at=?, updated_at=?, source=?
                WHERE id=? AND deleted_at IS NULL
                """,
                (now, now, source, aid),
            )
        else:
            cur = conn.execute(
                "UPDATE mem_atoms SET deleted_at=?, updated_at=? WHERE id=? AND deleted_at IS NULL",
                (now, now, aid),
            )
        try:
            conn.execute("DELETE FROM mem_atoms_fts WHERE atom_id=?", (aid,))
        except Exception:
            pass
        try:
            conn.execute("DELETE FROM mem_atom_entities WHERE atom_id=?", (aid,))
        except Exception:
            pass
        return cur.rowcount > 0


def supersede_atom(atom_id: str, keeper_id: str, *, source: str = "consolidate") -> bool:
    """Mark atom superseded + soft-delete. Pin atoms may still be superseded by caller policy."""
    aid = (atom_id or "").strip()
    kid = (keeper_id or "").strip()
    if not aid or not kid or aid == kid:
        return False
    now = utc_now_iso_z()
    with db() as conn:
        cur = conn.execute(
            """
            UPDATE mem_atoms
            SET superseded_by=?, deleted_at=?, updated_at=?, source=?
            WHERE id=? AND deleted_at IS NULL
            """,
            (kid, now, now, source, aid),
        )
        try:
            conn.execute("DELETE FROM mem_atoms_fts WHERE atom_id=?", (aid,))
        except Exception:
            pass
        try:
            conn.execute("DELETE FROM mem_atom_entities WHERE atom_id=?", (aid,))
        except Exception:
            pass
        return cur.rowcount > 0


def update_atom_fields(
    atom_id: str,
    *,
    content: str | None = None,
    summary: str | None = None,
    importance: float | None = None,
    confidence: float | None = None,
    vitality: float | None = None,
    source: str | None = None,
    source_path: str | None = None,
) -> bool:
    aid = (atom_id or "").strip()
    if not aid:
        return False
    now = utc_now_iso_z()
    sets: list[str] = ["updated_at=?"]
    args: list[Any] = [now]
    if content is not None:
        text = " ".join(str(content).strip().split())
        sets.append("content=?")
        args.append(text)
    if summary is not None:
        sets.append("summary=?")
        args.append(summary)
    if importance is not None:
        sets.append("importance=?")
        args.append(float(importance))
    if confidence is not None:
        sets.append("confidence=?")
        args.append(float(confidence))
    if vitality is not None:
        sets.append("vitality=?")
        args.append(clamp01(float(vitality), 1.0))
    if source is not None:
        sets.append("source=?")
        args.append(source)
    if source_path is not None:
        sets.append("source_path=?")
        args.append(str(source_path or ""))
    args.append(aid)
    with db() as conn:
        cur = conn.execute(
            f"UPDATE mem_atoms SET {', '.join(sets)} WHERE id=? AND deleted_at IS NULL",
            args,
        )
        if content is not None and cur.rowcount > 0:
            row = conn.execute(
                "SELECT namespace_id, content FROM mem_atoms WHERE id=?",
                (aid,),
            ).fetchone()
            if row:
                _index_fts(
                    conn,
                    atom_id=aid,
                    namespace_id=row["namespace_id"],
                    content=row["content"],
                )
        return cur.rowcount > 0


def count_active_atoms(namespace_id: str) -> int:
    ns = ensure_namespace(namespace_id)
    with db() as conn:
        row = conn.execute(
            "SELECT COUNT(*) AS c FROM mem_atoms WHERE namespace_id=? AND deleted_at IS NULL",
            (ns,),
        ).fetchone()
        return int(row["c"] if row else 0)


def set_pin(atom_id: str, pin: bool) -> bool:
    aid = (atom_id or "").strip()
    if not aid:
        return False
    now = utc_now_iso_z()
    with db() as conn:
        cur = conn.execute(
            "UPDATE mem_atoms SET pin=?, updated_at=? WHERE id=? AND deleted_at IS NULL",
            (1 if pin else 0, now, aid),
        )
        return cur.rowcount > 0


def clear_namespace(namespace_id: str) -> int:
    ns = ensure_namespace(namespace_id)
    now = utc_now_iso_z()
    with db() as conn:
        rows = conn.execute(
            "SELECT id FROM mem_atoms WHERE namespace_id=? AND deleted_at IS NULL",
            (ns,),
        ).fetchall()
        ids = [r["id"] for r in rows]
        if not ids:
            return 0
        conn.execute(
            "UPDATE mem_atoms SET deleted_at=?, updated_at=? WHERE namespace_id=? AND deleted_at IS NULL",
            (now, now, ns),
        )
        for aid in ids:
            try:
                conn.execute("DELETE FROM mem_atoms_fts WHERE atom_id=?", (aid,))
            except Exception:
                pass
        return len(ids)


def get_atom(atom_id: str) -> dict[str, Any] | None:
    with db() as conn:
        row = conn.execute(
            "SELECT * FROM mem_atoms WHERE id=? AND deleted_at IS NULL",
            (atom_id,),
        ).fetchone()
        return _row_to_atom(row) if row else None


def mark_atom_stale(atom_id: str, *, reason: str = "", source_ref: str = "") -> bool:
    """Tag an atom as stale (do not delete). Lowers vitality for recall demotion."""
    aid = (atom_id or "").strip()
    if not aid:
        return False
    atom = get_atom(aid)
    if not atom:
        return False
    tags = list(atom.get("tags") or [])
    if "stale" not in {str(t).strip().lower() for t in tags}:
        tags.append("stale")
    evidence = dict(atom.get("evidence") or {}) if isinstance(atom.get("evidence"), dict) else {}
    now = utc_now_iso_z()
    evidence["stale_at"] = now
    if reason:
        evidence["stale_reason"] = str(reason)[:500]
    if source_ref:
        evidence["stale_source_ref"] = str(source_ref)[:200]
    vitality = min(float(atom.get("vitality") or 1.0), 0.2)
    with db() as conn:
        cur = conn.execute(
            """
            UPDATE mem_atoms
            SET tags_json=?, evidence_json=?, vitality=?, updated_at=?
            WHERE id=? AND deleted_at IS NULL
            """,
            (_dumps(tags), _dumps(evidence), vitality, now, aid),
        )
        return cur.rowcount > 0


def list_namespace_atoms(
    namespace_id: str,
    *,
    layers: list[str] | None = None,
    pinned_only: bool = False,
    limit: int = 200,
) -> list[dict[str, Any]]:
    ns = ensure_namespace(namespace_id)
    clauses = ["namespace_id=?", "deleted_at IS NULL"]
    args: list[Any] = [ns]
    if pinned_only:
        clauses.append("pin=1")
    if layers:
        norms = [_norm_layer(x) for x in layers]
        placeholders = ",".join("?" * len(norms))
        clauses.append(f"layer IN ({placeholders})")
        args.extend(norms)
    args.append(max(1, min(int(limit), 2000)))
    sql = f"""
        SELECT * FROM mem_atoms
        WHERE {' AND '.join(clauses)}
        ORDER BY pin DESC, importance DESC, updated_at DESC
        LIMIT ?
    """
    with db() as conn:
        rows = conn.execute(sql, args).fetchall()
        return [_row_to_atom(r) for r in rows]


def touch_accessed(atom_ids: list[str]) -> None:
    ids = [a for a in atom_ids if a]
    if not ids:
        return
    now = utc_now_iso_z()
    with db() as conn:
        for aid in ids:
            conn.execute(
                "UPDATE mem_atoms SET last_accessed_at=? WHERE id=?",
                (now, aid),
            )


def search_keyword_ns(
    namespace_ids: list[str],
    query: str,
    *,
    top_k: int = 20,
    layers: list[str] | None = None,
) -> list[dict[str, Any]]:
    q = (query or "").strip()
    if not q or not namespace_ids:
        return []
    ns_list = [ensure_namespace(n) for n in namespace_ids]
    ns_ph = ",".join("?" * len(ns_list))
    layer_clause = ""
    args: list[Any] = list(ns_list)
    if layers:
        norms = [_norm_layer(x) for x in layers]
        layer_clause = f" AND a.layer IN ({','.join('?' * len(norms))})"
        args.extend(norms)

    terms = _keyword_search_terms(q)
    # FTS5: OR of quoted terms (CJK bigrams help when unicode61 keeps runs whole)
    match = " OR ".join(f'"{t}"' for t in terms) if terms else f'"{q.replace(chr(34), " ")}"'
    hits: list[dict[str, Any]] = []
    with db() as conn:
        rows = []
        try:
            fts_args = list(args) + [match, max(top_k * 3, 24)]
            rows = conn.execute(
                f"""
                SELECT a.*, bm25(mem_atoms_fts) AS rank
                FROM mem_atoms_fts f
                JOIN mem_atoms a ON a.id = f.atom_id
                WHERE f.namespace_id IN ({ns_ph})
                  AND a.deleted_at IS NULL
                  {layer_clause}
                  AND mem_atoms_fts MATCH ?
                ORDER BY rank
                LIMIT ?
                """,
                fts_args,
            ).fetchall()
        except Exception as exc:
            logger.debug("mem FTS failed: %s", exc)
            rows = []

        # Always merge LIKE hits for CJK / short queries (FTS tokenizer is weak on Chinese)
        like_terms = terms[:8] if terms else [q]
        scored: dict[str, tuple[int, Any]] = {}
        for i, row in enumerate(rows):
            aid = str(row["id"])
            scored[aid] = (1000 - i, row)  # FTS order as base score

        for term in like_terms:
            like = f"%{term}%"
            try:
                like_rows = conn.execute(
                    f"""
                    SELECT a.*, 0 AS rank FROM mem_atoms a
                    WHERE a.namespace_id IN ({ns_ph})
                      AND a.deleted_at IS NULL
                      {layer_clause}
                      AND (a.content LIKE ? OR IFNULL(a.summary,'') LIKE ?)
                    ORDER BY a.importance DESC, a.updated_at DESC
                    LIMIT ?
                    """,
                    list(args) + [like, like, max(top_k * 4, 40)],
                ).fetchall()
            except Exception as exc:
                logger.debug("mem LIKE failed: %s", exc)
                like_rows = []
            for row in like_rows:
                aid = str(row["id"])
                prev = scored.get(aid)
                bump = len(term)
                if prev:
                    scored[aid] = (prev[0] + bump, prev[1])
                else:
                    scored[aid] = (bump, row)

        ordered = sorted(scored.values(), key=lambda x: x[0], reverse=True)[:top_k]
        for i, (_score, row) in enumerate(ordered):
            atom = _row_to_atom(row)
            atom["rank"] = i + 1
            atom["source_channel"] = "keyword"
            hits.append(atom)
    return hits


def search_vector_ns(
    namespace_ids: list[str],
    query_vec: list[float],
    *,
    top_k: int = 20,
    layers: list[str] | None = None,
) -> list[dict[str, Any]]:
    if not query_vec or not namespace_ids:
        return []
    ns_list = [ensure_namespace(n) for n in namespace_ids]
    ns_ph = ",".join("?" * len(ns_list))
    layer_clause = ""
    args: list[Any] = list(ns_list)
    if layers:
        norms = [_norm_layer(x) for x in layers]
        layer_clause = f" AND layer IN ({','.join('?' * len(norms))})"
        args.extend(norms)
    scored: list[tuple[float, dict[str, Any]]] = []
    with db() as conn:
        rows = conn.execute(
            f"""
            SELECT * FROM mem_atoms
            WHERE namespace_id IN ({ns_ph})
              AND deleted_at IS NULL
              AND embedding IS NOT NULL
              {layer_clause}
            """,
            args,
        ).fetchall()
        for row in rows:
            dim = int(row["embedding_dim"] or 0)
            if dim != len(query_vec):
                continue
            try:
                vec = unpack_embedding(bytes(row["embedding"]), dim)
            except Exception:
                continue
            score = cosine(query_vec, vec)
            atom = _row_to_atom(row)
            atom["score"] = score
            atom["source_channel"] = "vector"
            scored.append((score, atom))
    scored.sort(key=lambda x: x[0], reverse=True)
    out: list[dict[str, Any]] = []
    for i, (_s, atom) in enumerate(scored[:top_k]):
        atom["rank"] = i + 1
        out.append(atom)
    return out


def rrf_fuse_atoms(
    keyword_hits: list[dict[str, Any]],
    vector_hits: list[dict[str, Any]],
    *,
    top_k: int = 8,
    importance_w: float = 0.25,
    recency_w: float = 0.15,
) -> list[dict[str, Any]]:
    scores: dict[str, float] = {}
    meta: dict[str, dict[str, Any]] = {}
    k = 60
    for hit in keyword_hits:
        aid = hit["id"]
        scores[aid] = scores.get(aid, 0.0) + 1.0 / (k + int(hit.get("rank") or 1))
        meta[aid] = {**meta.get(aid, {}), **hit}
    for hit in vector_hits:
        aid = hit["id"]
        scores[aid] = scores.get(aid, 0.0) + 1.0 / (k + int(hit.get("rank") or 1))
        meta[aid] = {**meta.get(aid, {}), **hit}
    # Mild importance / vitality boost
    for aid, base in list(scores.items()):
        atom = meta.get(aid) or {}
        imp = float(atom.get("importance") or 0.5)
        vit = float(atom.get("vitality") or 1.0)
        scores[aid] = base + importance_w * imp * 0.01 + recency_w * vit * 0.01
    ordered = sorted(scores.items(), key=lambda x: x[1], reverse=True)[:top_k]
    out: list[dict[str, Any]] = []
    for aid, score in ordered:
        item = dict(meta.get(aid) or {})
        item["id"] = aid
        item["rrf_score"] = score
        out.append(item)
    return out


def namespace_has_atoms(namespace_id: str) -> bool:
    ns = ensure_namespace(namespace_id)
    with db() as conn:
        row = conn.execute(
            "SELECT 1 FROM mem_atoms WHERE namespace_id=? AND deleted_at IS NULL LIMIT 1",
            (ns,),
        ).fetchone()
        return row is not None


def migration_flag(key: str) -> str | None:
    with db() as conn:
        row = conn.execute(
            "SELECT value FROM kb_schema_meta WHERE key=?",
            (key,),
        ).fetchone()
        return str(row["value"]) if row else None


def set_migration_flag(key: str, value: str) -> None:
    with db() as conn:
        conn.execute(
            """
            INSERT INTO kb_schema_meta(key, value) VALUES (?,?)
            ON CONFLICT(key) DO UPDATE SET value=excluded.value
            """,
            (key, value),
        )


def clamp01(v: float, default: float = 0.5) -> float:
    try:
        x = float(v)
    except (TypeError, ValueError):
        return default
    if not math.isfinite(x):
        return default
    return max(0.0, min(1.0, x))
