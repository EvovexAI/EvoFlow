"""Memory namespace graph: payload, expand, rebuild enqueue.

See internal design docs (not published in this repository) §13.3.
"""

from __future__ import annotations

import logging
from typing import Any

from evoflow.knowledge.owned import kg
from evoflow.knowledge.owned.db import db
from evoflow.memory import store as mem_store
from evoflow.memory.kg_extract import mem_kb_id

logger = logging.getLogger(__name__)


def get_graph(namespace_id: str, *, center: str | None = None, limit: int = 80) -> dict[str, Any]:
    ns = mem_store.ensure_namespace(namespace_id)
    kb_id = mem_kb_id(ns)
    payload = kg.graph_payload(kb_id, center=center, limit=limit)
    payload["namespace"] = ns
    payload["expand_hops_default"] = _configured_expand_hops()
    return payload


def _configured_expand_hops() -> int:
    try:
        from evoflow.config.memory_config import get_memory_config

        return int(get_memory_config().graph.expand_hops)
    except Exception:
        return 0


def atoms_for_node(node_id: str, *, limit: int = 40) -> list[dict[str, Any]]:
    """Live atoms linked to a kg node via mem_atom_entities."""
    nid = (node_id or "").strip()
    if not nid:
        return []
    with db() as conn:
        rows = conn.execute(
            """
            SELECT DISTINCT e.atom_id, e.role
            FROM mem_atom_entities e
            JOIN mem_atoms a ON a.id = e.atom_id AND a.deleted_at IS NULL
            WHERE e.node_id=?
            LIMIT ?
            """,
            (nid, max(1, min(int(limit), 200))),
        ).fetchall()
    out: list[dict[str, Any]] = []
    for r in rows:
        atom = mem_store.get_atom(r["atom_id"])
        if not atom:
            continue
        item = dict(atom)
        item["entity_role"] = r["role"]
        out.append(item)
    return out


def neighbor_atom_ids(seed_atom_ids: list[str], *, hops: int = 1, limit: int = 40) -> list[str]:
    """Expand from seed atoms → entities → (optional hops) → neighbor atoms."""
    seeds = [a for a in seed_atom_ids if a]
    if not seeds or hops <= 0:
        return []
    with db() as conn:
        ph = ",".join("?" * len(seeds))
        entity_rows = conn.execute(
            f"""
            SELECT DISTINCT node_id, kb_id FROM mem_atom_entities
            WHERE atom_id IN ({ph})
            """,
            seeds,
        ).fetchall()
        if not entity_rows:
            return []
        node_ids = [r["node_id"] for r in entity_rows]
        kb_id = str(entity_rows[0]["kb_id"] or "")
        expand_ids = set(node_ids)
        if hops >= 1 and kb_id and node_ids:
            nph = ",".join("?" * len(node_ids))
            nbrs = conn.execute(
                f"""
                SELECT DISTINCT CASE
                  WHEN src_node_id IN ({nph}) THEN dst_node_id
                  ELSE src_node_id
                END AS nid
                FROM kg_edges
                WHERE kb_id=? AND (src_node_id IN ({nph}) OR dst_node_id IN ({nph}))
                """,
                [*node_ids, kb_id, *node_ids, *node_ids],
            ).fetchall()
            for r in nbrs:
                if r["nid"]:
                    expand_ids.add(r["nid"])
        if not expand_ids:
            return []
        eph = ",".join("?" * len(expand_ids))
        atom_rows = conn.execute(
            f"""
            SELECT DISTINCT e.atom_id
            FROM mem_atom_entities e
            JOIN mem_atoms a ON a.id = e.atom_id AND a.deleted_at IS NULL
            WHERE e.node_id IN ({eph})
            LIMIT ?
            """,
            [*expand_ids, max(1, min(int(limit), 200))],
        ).fetchall()
    seed_set = set(seeds)
    return [r["atom_id"] for r in atom_rows if r["atom_id"] not in seed_set]


def expand_recall_atoms(
    seed_atoms: list[dict[str, Any]],
    *,
    hops: int | None = None,
    limit: int = 24,
) -> list[dict[str, Any]]:
    """Return neighbor atoms for graph-augmented recall (empty when hops=0)."""
    h = _configured_expand_hops() if hops is None else int(hops)
    if h <= 0 or not seed_atoms:
        return []
    seed_ids = [str(a.get("id") or "") for a in seed_atoms if a.get("id")]
    nbr_ids = neighbor_atom_ids(seed_ids, hops=h, limit=limit)
    out: list[dict[str, Any]] = []
    for aid in nbr_ids:
        atom = mem_store.get_atom(aid)
        if atom:
            atom = dict(atom)
            atom["source_channel"] = "graph_expand"
            out.append(atom)
    return out


def rebuild_graph(namespace_id: str, *, clear: bool = True) -> dict[str, Any]:
    """Clear graph (optional) and schedule **batch** LLM extract for active atoms."""
    from evoflow.memory.kg_extract import (
        enqueue_mem_kg_batch,
        mark_atoms_kg_dirty,
        mem_kb_id,
    )

    ns = mem_store.ensure_namespace(namespace_id)
    kb_id = mem_kb_id(ns)
    if clear:
        with db() as conn:
            conn.execute("DELETE FROM mem_atom_entities WHERE kb_id=?", (kb_id,))
        kg.delete_by_kb(kb_id)
    atoms = mem_store.list_namespace_atoms(ns, limit=2000)
    mark_atoms_kg_dirty(ns, [str(a["id"]) for a in atoms if a.get("id")])
    job = enqueue_mem_kg_batch(ns, debounce_seconds=0, priority=180)
    return {
        "namespace": ns,
        "kb_id": kb_id,
        "atoms": len(atoms),
        "queued": 1 if job else 0,
        "mode": "batch",
        "cleared": bool(clear),
    }
