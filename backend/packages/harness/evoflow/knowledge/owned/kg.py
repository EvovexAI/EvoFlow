"""G2 entity graph store (SQLite, no Neo4j)."""

from __future__ import annotations

import json
import re
from typing import Any

from evoflow.knowledge.owned.db import db
from evoflow.knowledge.owned.ids import new_id, utc_now


def _loads(raw: str | None, default: Any) -> Any:
    try:
        return json.loads(raw or "") if raw else default
    except Exception:
        return default


def _norm_name(name: str) -> str:
    return re.sub(r"\s+", " ", str(name or "").strip())[:120]


def upsert_node(
    kb_id: str,
    name: str,
    *,
    chunk_id: str | None = None,
    attrs: list[Any] | None = None,
) -> dict[str, Any]:
    name = _norm_name(name)
    if not name:
        raise ValueError("entity name required")
    now = utc_now()
    with db() as conn:
        row = conn.execute(
            "SELECT * FROM kg_nodes WHERE kb_id=? AND name=?",
            (kb_id, name),
        ).fetchone()
        if row:
            chunks = _loads(row["chunk_ids_json"], [])
            if chunk_id and chunk_id not in chunks:
                chunks.append(chunk_id)
            attr_list = _loads(row["attrs_json"], [])
            if attrs:
                for a in attrs:
                    if a not in attr_list:
                        attr_list.append(a)
            conn.execute(
                """
                UPDATE kg_nodes SET chunk_ids_json=?, attrs_json=?, updated_at=?
                WHERE id=?
                """,
                (
                    json.dumps(chunks, ensure_ascii=False),
                    json.dumps(attr_list, ensure_ascii=False),
                    now,
                    row["id"],
                ),
            )
            nid = row["id"]
        else:
            nid = new_id("kgn_")
            conn.execute(
                """
                INSERT INTO kg_nodes(id, kb_id, name, attrs_json, chunk_ids_json, created_at, updated_at)
                VALUES (?,?,?,?,?,?,?)
                """,
                (
                    nid,
                    kb_id,
                    name,
                    json.dumps(attrs or [], ensure_ascii=False),
                    json.dumps([chunk_id] if chunk_id else [], ensure_ascii=False),
                    now,
                    now,
                ),
            )
        row = conn.execute("SELECT * FROM kg_nodes WHERE id=?", (nid,)).fetchone()
    return {
        "id": row["id"],
        "kbId": row["kb_id"],
        "name": row["name"],
        "attrs": _loads(row["attrs_json"], []),
        "chunkIds": _loads(row["chunk_ids_json"], []),
    }


def upsert_edge(kb_id: str, src_id: str, dst_id: str, rel_type: str) -> dict[str, Any]:
    rel = _norm_name(rel_type) or "related_to"
    if src_id == dst_id:
        raise ValueError("self-edge not allowed")
    now = utc_now()
    with db() as conn:
        existing = conn.execute(
            """
            SELECT * FROM kg_edges
            WHERE kb_id=? AND src_node_id=? AND dst_node_id=? AND rel_type=?
            """,
            (kb_id, src_id, dst_id, rel),
        ).fetchone()
        if existing:
            return {
                "id": existing["id"],
                "kbId": kb_id,
                "srcNodeId": src_id,
                "dstNodeId": dst_id,
                "relType": rel,
            }
        eid = new_id("kge_")
        conn.execute(
            """
            INSERT INTO kg_edges(id, kb_id, src_node_id, dst_node_id, rel_type, created_at)
            VALUES (?,?,?,?,?,?)
            """,
            (eid, kb_id, src_id, dst_id, rel, now),
        )
    return {
        "id": eid,
        "kbId": kb_id,
        "srcNodeId": src_id,
        "dstNodeId": dst_id,
        "relType": rel,
    }


def add_triples(
    kb_id: str,
    triples: list[tuple[str, str, str]],
    *,
    chunk_id: str | None = None,
) -> dict[str, int]:
    """Add (src, rel, dst) triples; returns counts."""
    nodes = 0
    edges = 0
    for src, rel, dst in triples:
        src_n = _norm_name(src)
        dst_n = _norm_name(dst)
        if not src_n or not dst_n or src_n == dst_n:
            continue
        s = upsert_node(kb_id, src_n, chunk_id=chunk_id)
        d = upsert_node(kb_id, dst_n, chunk_id=chunk_id)
        nodes += 2
        upsert_edge(kb_id, s["id"], d["id"], rel)
        edges += 1
    return {"nodesTouched": nodes, "edgesAdded": edges}


def find_nodes_by_query(kb_id: str, query: str, *, limit: int = 8) -> list[dict[str, Any]]:
    q = _norm_name(query)
    if not q:
        return []
    like = f"%{q}%"
    with db() as conn:
        rows = conn.execute(
            """
            SELECT * FROM kg_nodes
            WHERE kb_id=? AND name LIKE ?
            ORDER BY length(name) ASC
            LIMIT ?
            """,
            (kb_id, like, limit),
        ).fetchall()
        if not rows:
            # tokenized fallback: any token match
            tokens = [t for t in re.split(r"[\s,，。；;、]+", q) if len(t) >= 2][:5]
            seen: set[str] = set()
            out_rows = []
            for t in tokens:
                for r in conn.execute(
                    "SELECT * FROM kg_nodes WHERE kb_id=? AND name LIKE ? LIMIT ?",
                    (kb_id, f"%{t}%", limit),
                ).fetchall():
                    if r["id"] not in seen:
                        seen.add(r["id"])
                        out_rows.append(r)
            rows = out_rows[:limit]
    return [
        {
            "id": r["id"],
            "name": r["name"],
            "chunkIds": _loads(r["chunk_ids_json"], []),
            "attrs": _loads(r["attrs_json"], []),
        }
        for r in rows
    ]


def neighbor_chunk_ids(kb_id: str, node_ids: list[str], *, limit: int = 40) -> list[str]:
    """One-hop neighbor entities' chunk ids (incl. seed nodes)."""
    if not node_ids:
        return []
    chunk_ids: list[str] = []
    seen: set[str] = set()
    with db() as conn:
        placeholders = ",".join("?" * len(node_ids))
        seeds = conn.execute(
            f"SELECT chunk_ids_json FROM kg_nodes WHERE kb_id=? AND id IN ({placeholders})",
            [kb_id, *node_ids],
        ).fetchall()
        for r in seeds:
            for cid in _loads(r["chunk_ids_json"], []):
                if cid not in seen:
                    seen.add(cid)
                    chunk_ids.append(cid)
        # neighbors via edges
        nbrs = conn.execute(
            f"""
            SELECT DISTINCT CASE WHEN src_node_id IN ({placeholders}) THEN dst_node_id ELSE src_node_id END AS nid
            FROM kg_edges
            WHERE kb_id=? AND (src_node_id IN ({placeholders}) OR dst_node_id IN ({placeholders}))
            """,
            [*node_ids, kb_id, *node_ids, *node_ids],
        ).fetchall()
        nbr_ids = [r["nid"] for r in nbrs if r["nid"]]
        if nbr_ids:
            ph2 = ",".join("?" * len(nbr_ids))
            for r in conn.execute(
                f"SELECT chunk_ids_json FROM kg_nodes WHERE kb_id=? AND id IN ({ph2})",
                [kb_id, *nbr_ids],
            ).fetchall():
                for cid in _loads(r["chunk_ids_json"], []):
                    if cid not in seen:
                        seen.add(cid)
                        chunk_ids.append(cid)
                    if len(chunk_ids) >= limit:
                        return chunk_ids[:limit]
    return chunk_ids[:limit]


def search_graph_chunks(kb_id: str, query: str, *, top_k: int = 20) -> list[dict[str, Any]]:
    """Resolve query entities → one-hop chunks as retrieval hits."""
    nodes = find_nodes_by_query(kb_id, query, limit=6)
    if not nodes:
        return []
    cids = neighbor_chunk_ids(kb_id, [n["id"] for n in nodes], limit=top_k * 2)
    if not cids:
        return []
    hits: list[dict[str, Any]] = []
    with db() as conn:
        for i, cid in enumerate(cids[:top_k]):
            row = conn.execute(
                "SELECT id, doc_id, content FROM kb_chunks WHERE id=? AND enabled=1",
                (cid,),
            ).fetchone()
            if not row:
                continue
            hits.append(
                {
                    "chunk_id": row["id"],
                    "doc_id": row["doc_id"],
                    "content": row["content"],
                    "rank": i + 1,
                    "source": "kg",
                }
            )
    return hits


def list_nodes(kb_id: str, *, limit: int = 200) -> list[dict[str, Any]]:
    with db() as conn:
        rows = conn.execute(
            "SELECT * FROM kg_nodes WHERE kb_id=? ORDER BY name ASC LIMIT ?",
            (kb_id, limit),
        ).fetchall()
    return [
        {
            "id": r["id"],
            "name": r["name"],
            "chunkIds": _loads(r["chunk_ids_json"], []),
            "attrs": _loads(r["attrs_json"], []),
        }
        for r in rows
    ]


def graph_payload(kb_id: str, *, center: str | None = None, limit: int = 80) -> dict[str, Any]:
    """Entity graph for force layout (G2)."""
    nodes_raw = list_nodes(kb_id, limit=limit)
    by_id = {n["id"]: n for n in nodes_raw}
    if center:
        # Prefer center by name or id
        center_node = next((n for n in nodes_raw if n["name"] == center or n["id"] == center), None)
        if center_node:
            keep = {center_node["id"]}
            with db() as conn:
                for r in conn.execute(
                    """
                    SELECT src_node_id, dst_node_id FROM kg_edges
                    WHERE kb_id=? AND (src_node_id=? OR dst_node_id=?)
                    """,
                    (kb_id, center_node["id"], center_node["id"]),
                ).fetchall():
                    keep.add(r["src_node_id"])
                    keep.add(r["dst_node_id"])
            nodes_raw = [by_id[i] for i in keep if i in by_id]

    node_ids = {n["id"] for n in nodes_raw}
    with db() as conn:
        if not node_ids:
            edges_rows = []
        else:
            ph = ",".join("?" * len(node_ids))
            edges_rows = conn.execute(
                f"""
                SELECT * FROM kg_edges
                WHERE kb_id=? AND src_node_id IN ({ph}) AND dst_node_id IN ({ph})
                LIMIT ?
                """,
                [kb_id, *node_ids, *node_ids, limit * 3],
            ).fetchall()

    nodes = [
        {
            "id": n["id"],
            "label": n["name"],
            "path": n["name"],
            "category": "entity",
            "pageType": "entity",
        }
        for n in nodes_raw
    ]
    edges = [
        {
            "source": r["src_node_id"],
            "target": r["dst_node_id"],
            "type": r["rel_type"],
            "label": r["rel_type"],
        }
        for r in edges_rows
    ]
    return {
        "kbId": kb_id,
        "kind": "entity",
        "center": center,
        "nodes": nodes,
        "edges": edges,
        "nodeCount": len(nodes),
        "edgeCount": len(edges),
    }


def delete_by_kb(kb_id: str) -> None:
    with db() as conn:
        conn.execute("DELETE FROM kg_edges WHERE kb_id=?", (kb_id,))
        conn.execute("DELETE FROM kg_nodes WHERE kb_id=?", (kb_id,))


def stats(kb_id: str) -> dict[str, int]:
    with db() as conn:
        n = conn.execute("SELECT COUNT(*) AS c FROM kg_nodes WHERE kb_id=?", (kb_id,)).fetchone()["c"]
        e = conn.execute("SELECT COUNT(*) AS c FROM kg_edges WHERE kb_id=?", (kb_id,)).fetchone()["c"]
    return {"nodeCount": int(n), "edgeCount": int(e)}
