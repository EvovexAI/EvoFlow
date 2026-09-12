"""Note-level wikilinks / backlinks for owned source documents (not Wiki pages)."""

from __future__ import annotations

import json
from typing import Any

from evoflow.knowledge.owned.db import db
from evoflow.knowledge.owned.ids import new_id, utc_now
from evoflow.knowledge.owned.metadata import extract_wikilinks


def _norm_key(value: str) -> str:
    s = (value or "").replace("\\", "/").strip().strip("/")
    if s.lower().endswith(".md"):
        s = s[: -len(".md")]
    return s.lower()


def _build_resolver(kb_id: str) -> dict[str, str]:
    """Map normalized title / stem / rel-path → doc_id."""
    mapping: dict[str, str] = {}
    with db() as conn:
        rows = conn.execute(
            """
            SELECT id, title, file_name, folder_path, source_rel_path
            FROM kb_documents
            WHERE kb_id=? AND deleted_at IS NULL
            """,
            (kb_id,),
        ).fetchall()
    for r in rows:
        doc_id = r["id"]
        title = str(r["title"] or "").strip()
        file_name = str(r["file_name"] or "")
        folder = str(r["folder_path"] or "").strip("/")
        stem = file_name.rsplit(".", 1)[0] if file_name else ""
        rel = str(r["source_rel_path"] or "").strip("/")
        if not rel:
            rel = f"{folder}/{file_name}".strip("/") if folder else file_name
        for key in (title, stem, rel, rel.rsplit(".", 1)[0] if rel else ""):
            nk = _norm_key(key)
            if nk and nk not in mapping:
                mapping[nk] = doc_id
        if folder and stem:
            nk = _norm_key(f"{folder}/{stem}")
            if nk not in mapping:
                mapping[nk] = doc_id
    return mapping


def rebuild_doc_links(kb_id: str, doc_id: str, text: str) -> list[str]:
    """Replace outbound links for a document from source markdown."""
    targets = extract_wikilinks(text)
    resolver = _build_resolver(kb_id)
    now = utc_now()
    with db() as conn:
        conn.execute("DELETE FROM kb_doc_links WHERE src_doc_id=?", (doc_id,))
        for target in targets:
            dst = resolver.get(_norm_key(target))
            conn.execute(
                """
                INSERT INTO kb_doc_links(
                  id, kb_id, src_doc_id, target_raw, target_doc_id, created_at
                ) VALUES (?,?,?,?,?,?)
                """,
                (new_id("dlk_"), kb_id, doc_id, target, dst, now),
            )
    return targets


def get_document_links(doc_id: str) -> dict[str, Any] | None:
    with db() as conn:
        doc = conn.execute(
            "SELECT id, kb_id, title, file_name FROM kb_documents WHERE id=? AND deleted_at IS NULL",
            (doc_id,),
        ).fetchone()
        if not doc:
            return None
        out_rows = conn.execute(
            """
            SELECT l.target_raw, l.target_doc_id, d.title, d.file_name, d.folder_path
            FROM kb_doc_links l
            LEFT JOIN kb_documents d ON d.id = l.target_doc_id AND d.deleted_at IS NULL
            WHERE l.src_doc_id=?
            ORDER BY l.target_raw ASC
            """,
            (doc_id,),
        ).fetchall()
        in_rows = conn.execute(
            """
            SELECT l.src_doc_id, l.target_raw, d.title, d.file_name, d.folder_path
            FROM kb_doc_links l
            JOIN kb_documents d ON d.id = l.src_doc_id AND d.deleted_at IS NULL
            WHERE l.target_doc_id=?
            ORDER BY d.title ASC
            """,
            (doc_id,),
        ).fetchall()

    def _out(r: Any) -> dict[str, Any]:
        return {
            "targetRaw": r["target_raw"],
            "docId": r["target_doc_id"] or "",
            "title": (r["title"] or r["file_name"] or r["target_raw"] or ""),
            "folderPath": r["folder_path"] or "",
            "resolved": bool(r["target_doc_id"]),
        }

    def _inn(r: Any) -> dict[str, Any]:
        return {
            "docId": r["src_doc_id"],
            "title": (r["title"] or r["file_name"] or r["src_doc_id"]),
            "folderPath": r["folder_path"] or "",
            "targetRaw": r["target_raw"],
        }

    return {
        "docId": doc_id,
        "kbId": doc["kb_id"],
        "outLinks": [_out(r) for r in out_rows],
        "inLinks": [_inn(r) for r in in_rows],
    }


def doc_graph_payload(kb_id: str, *, center_doc_id: str | None = None, depth: int = 1) -> dict[str, Any]:
    """Force-graph payload from note-level links."""
    depth = max(1, min(int(depth or 1), 3))
    with db() as conn:
        docs = conn.execute(
            """
            SELECT id, title, file_name, folder_path FROM kb_documents
            WHERE kb_id=? AND deleted_at IS NULL
            """,
            (kb_id,),
        ).fetchall()
        links = conn.execute(
            """
            SELECT src_doc_id, target_doc_id, target_raw FROM kb_doc_links
            WHERE kb_id=? AND target_doc_id IS NOT NULL AND target_doc_id != ''
            """,
            (kb_id,),
        ).fetchall()

    doc_map = {r["id"]: r for r in docs}
    if center_doc_id and center_doc_id in doc_map:
        keep = {center_doc_id}
        frontier = {center_doc_id}
        for _ in range(depth):
            nxt: set[str] = set()
            for edge in links:
                src, dst = edge["src_doc_id"], edge["target_doc_id"]
                if src in frontier and dst in doc_map:
                    nxt.add(dst)
                if dst in frontier and src in doc_map:
                    nxt.add(src)
            keep |= nxt
            frontier = nxt
        doc_map = {k: v for k, v in doc_map.items() if k in keep}
        links = [e for e in links if e["src_doc_id"] in keep and e["target_doc_id"] in keep]

    nodes = [
        {
            "id": r["id"],
            "label": r["title"] or r["file_name"] or r["id"],
            "type": "document",
            "folderPath": r["folder_path"] or "",
        }
        for r in doc_map.values()
    ]
    edges = [
        {
            "id": f"{e['src_doc_id']}->{e['target_doc_id']}",
            "source": e["src_doc_id"],
            "target": e["target_doc_id"],
            "label": e["target_raw"] or "link",
            "type": "wikilink",
        }
        for e in links
        if e["src_doc_id"] in doc_map and e["target_doc_id"] in doc_map
    ]
    return {"nodes": nodes, "edges": edges, "kind": "documents"}


def update_document_metadata(
    doc_id: str,
    *,
    tags: list[str],
    frontmatter: dict[str, Any],
) -> None:
    with db() as conn:
        conn.execute(
            """
            UPDATE kb_documents
            SET tags_json=?, frontmatter_json=?, updated_at=?
            WHERE id=?
            """,
            (json.dumps(tags, ensure_ascii=False), json.dumps(frontmatter, ensure_ascii=False), utc_now(), doc_id),
        )
