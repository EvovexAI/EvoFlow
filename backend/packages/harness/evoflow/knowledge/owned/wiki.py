"""Wiki pages + G1 link graph (Phase B)."""

from __future__ import annotations

import json
import re
from typing import Any

from evoflow.knowledge.owned.db import db
from evoflow.knowledge.owned.ids import new_id, utc_now

_WIKILINK_RE = re.compile(r"\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|([^\]]+))?\]\]")
_MD_WIKI_LINK_RE = re.compile(r"\[([^\]]+)\]\(wiki:([^)\s]+)\)")


def _loads(raw: str | None, default: Any) -> Any:
    try:
        return json.loads(raw or "") if raw else default
    except Exception:
        return default


def _row_page(row: Any) -> dict[str, Any]:
    d = dict(row)
    return {
        "id": d["id"],
        "kbId": d["kb_id"],
        "slug": d["slug"],
        "title": d["title"],
        "pageType": d["page_type"],
        "status": d["status"],
        "folderId": d.get("folder_id") or "",
        "bodyMd": d.get("body_md") or "",
        "summary": d.get("summary") or "",
        "aliases": _loads(d.get("aliases_json"), []),
        "sourceRefs": _loads(d.get("source_refs_json"), []),
        "chunkRefs": _loads(d.get("chunk_refs_json"), []),
        "inLinks": _loads(d.get("in_links_json"), []),
        "outLinks": _loads(d.get("out_links_json"), []),
        "version": d.get("version") or 1,
        "lastEditSource": d.get("last_edit_source") or "",
        "createdAt": d.get("created_at"),
        "updatedAt": d.get("updated_at"),
    }


def list_pages(kb_id: str, *, page_type: str | None = None) -> list[dict[str, Any]]:
    with db() as conn:
        if page_type:
            rows = conn.execute(
                """
                SELECT * FROM wiki_pages
                WHERE kb_id=? AND deleted_at IS NULL AND page_type=?
                ORDER BY title ASC
                """,
                (kb_id, page_type),
            ).fetchall()
        else:
            rows = conn.execute(
                """
                SELECT * FROM wiki_pages
                WHERE kb_id=? AND deleted_at IS NULL
                ORDER BY page_type ASC, title ASC
                """,
                (kb_id,),
            ).fetchall()
    return [_row_page(r) for r in rows]


def get_page(kb_id: str, slug: str) -> dict[str, Any] | None:
    with db() as conn:
        row = conn.execute(
            """
            SELECT * FROM wiki_pages
            WHERE kb_id=? AND slug=? AND deleted_at IS NULL
            """,
            (kb_id, slug),
        ).fetchone()
    return _row_page(row) if row else None


def get_page_by_id(page_id: str) -> dict[str, Any] | None:
    with db() as conn:
        row = conn.execute(
            "SELECT * FROM wiki_pages WHERE id=? AND deleted_at IS NULL",
            (page_id,),
        ).fetchone()
    return _row_page(row) if row else None


def extract_out_links(body_md: str) -> list[str]:
    slugs: list[str] = []
    seen: set[str] = set()
    for rx in (_WIKILINK_RE, _MD_WIKI_LINK_RE):
        for m in rx.finditer(body_md or ""):
            slug = (m.group(1) if rx is _WIKILINK_RE else m.group(2)).strip()
            slug = slug.replace("\\", "/").strip("/")
            if not slug or slug in seen:
                continue
            seen.add(slug)
            slugs.append(slug)
    return slugs


def upsert_page(
    *,
    kb_id: str,
    slug: str,
    title: str,
    page_type: str,
    body_md: str,
    summary: str = "",
    source_refs: list[str] | None = None,
    chunk_refs: list[str] | None = None,
    aliases: list[str] | None = None,
    edit_source: str = "pipeline",
    editor_id: str = "",
    status: str = "published",
    folder_id: str = "",
) -> dict[str, Any]:
    now = utc_now()
    slug = str(slug or "").strip().replace("\\", "/").strip("/")
    if not slug:
        raise ValueError("slug required")
    out_links = extract_out_links(body_md)
    with db() as conn:
        existing = conn.execute(
            "SELECT * FROM wiki_pages WHERE kb_id=? AND slug=? AND deleted_at IS NULL",
            (kb_id, slug),
        ).fetchone()
        if existing:
            page_id = existing["id"]
            version = int(existing["version"] or 1) + 1
            # revision snapshot of previous
            conn.execute(
                """
                INSERT OR IGNORE INTO wiki_page_revisions(
                  id, page_id, version, title, body_md, summary, page_type, status,
                  aliases_json, edit_source, editor_id, created_at
                ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
                """,
                (
                    new_id("wrev_"),
                    page_id,
                    int(existing["version"] or 1),
                    existing["title"],
                    existing["body_md"],
                    existing["summary"] or "",
                    existing["page_type"],
                    existing["status"],
                    existing["aliases_json"] or "[]",
                    existing["last_edit_source"] or "pipeline",
                    existing["last_editor_id"] or "",
                    now,
                ),
            )
            conn.execute(
                """
                UPDATE wiki_pages SET
                  title=?, page_type=?, status=?, folder_id=?, body_md=?, summary=?,
                  aliases_json=?, source_refs_json=?, chunk_refs_json=?,
                  out_links_json=?, version=?, last_edit_source=?, last_editor_id=?,
                  updated_at=?
                WHERE id=?
                """,
                (
                    title,
                    page_type,
                    status,
                    folder_id,
                    body_md,
                    summary or "",
                    json.dumps(aliases or _loads(existing["aliases_json"], []), ensure_ascii=False),
                    json.dumps(source_refs if source_refs is not None else _loads(existing["source_refs_json"], []), ensure_ascii=False),
                    json.dumps(chunk_refs if chunk_refs is not None else _loads(existing["chunk_refs_json"], []), ensure_ascii=False),
                    json.dumps(out_links, ensure_ascii=False),
                    version,
                    edit_source,
                    editor_id,
                    now,
                    page_id,
                ),
            )
        else:
            page_id = new_id("wpg_")
            conn.execute(
                """
                INSERT INTO wiki_pages(
                  id, kb_id, slug, title, page_type, status, folder_id, body_md, summary,
                  aliases_json, source_refs_json, chunk_refs_json, in_links_json, out_links_json,
                  version, last_edit_source, last_editor_id, created_at, updated_at
                ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
                """,
                (
                    page_id,
                    kb_id,
                    slug,
                    title,
                    page_type,
                    status,
                    folder_id,
                    body_md,
                    summary or "",
                    json.dumps(aliases or [], ensure_ascii=False),
                    json.dumps(source_refs or [], ensure_ascii=False),
                    json.dumps(chunk_refs or [], ensure_ascii=False),
                    "[]",
                    json.dumps(out_links, ensure_ascii=False),
                    1,
                    edit_source,
                    editor_id,
                    now,
                    now,
                ),
            )
    return get_page(kb_id, slug)  # type: ignore[return-value]


def rebuild_link_index(kb_id: str) -> dict[str, Any]:
    """Finalize: recompute out_links from body and invert to in_links."""
    pages = list_pages(kb_id)
    outs: dict[str, list[str]] = {}
    ins: dict[str, list[str]] = {p["slug"]: [] for p in pages}
    for p in pages:
        links = extract_out_links(p.get("bodyMd") or "")
        # Keep only links that resolve to existing pages
        resolved = [s for s in links if s in ins]
        outs[p["slug"]] = resolved
        for target in resolved:
            if p["slug"] not in ins[target]:
                ins[target].append(p["slug"])
    now = utc_now()
    with db() as conn:
        for p in pages:
            slug = p["slug"]
            conn.execute(
                """
                UPDATE wiki_pages
                SET out_links_json=?, in_links_json=?, updated_at=?
                WHERE kb_id=? AND slug=? AND deleted_at IS NULL
                """,
                (
                    json.dumps(outs.get(slug) or [], ensure_ascii=False),
                    json.dumps(ins.get(slug) or [], ensure_ascii=False),
                    now,
                    kb_id,
                    slug,
                ),
            )
    return {"pageCount": len(pages), "edgeCount": sum(len(v) for v in outs.values())}


def graph_payload(
    kb_id: str,
    *,
    center_slug: str | None = None,
    depth: int = 1,
) -> dict[str, Any]:
    pages = list_pages(kb_id)
    by_slug = {p["slug"]: p for p in pages}
    depth = max(1, min(int(depth or 1), 3))

    if center_slug and center_slug in by_slug:
        keep: set[str] = {center_slug}
        frontier = {center_slug}
        for _ in range(depth):
            nxt: set[str] = set()
            for s in frontier:
                p = by_slug.get(s)
                if not p:
                    continue
                for t in (p.get("outLinks") or []) + (p.get("inLinks") or []):
                    if t not in keep and t in by_slug:
                        nxt.add(t)
            keep |= nxt
            frontier = nxt
        pages = [by_slug[s] for s in keep if s in by_slug]

    nodes = []
    edges = []
    seen_edge: set[tuple[str, str]] = set()
    for p in pages:
        nodes.append(
            {
                "id": p["slug"],
                "label": p["title"],
                "path": p["slug"],
                "category": p["pageType"],
                "pageType": p["pageType"],
            }
        )
        for t in p.get("outLinks") or []:
            key = (p["slug"], t)
            if key in seen_edge:
                continue
            if center_slug and t not in {n["id"] for n in nodes} and t not in by_slug:
                continue
            if any(n["id"] == t for n in nodes) or t in by_slug:
                if not any(n["id"] == t for n in nodes) and t in by_slug:
                    tp = by_slug[t]
                    nodes.append(
                        {
                            "id": tp["slug"],
                            "label": tp["title"],
                            "path": tp["slug"],
                            "category": tp["pageType"],
                            "pageType": tp["pageType"],
                        }
                    )
                edges.append({"source": p["slug"], "target": t, "type": "wiki"})
                seen_edge.add(key)
    # Filter edges to nodes present
    node_ids = {n["id"] for n in nodes}
    edges = [e for e in edges if e["source"] in node_ids and e["target"] in node_ids]
    return {
        "kbId": kb_id,
        "center": center_slug,
        "depth": depth,
        "nodes": nodes,
        "edges": edges,
        "nodeCount": len(nodes),
        "edgeCount": len(edges),
    }


def ensure_folder(kb_id: str, path: str, name: str | None = None) -> dict[str, Any]:
    path = str(path or "").strip("/").replace("\\", "/")
    if not path:
        raise ValueError("folder path required")
    now = utc_now()
    with db() as conn:
        row = conn.execute(
            "SELECT * FROM wiki_folders WHERE kb_id=? AND path=? AND deleted_at IS NULL",
            (kb_id, path),
        ).fetchone()
        if row:
            return dict(row)
        fid = new_id("wfd_")
        parent = "/".join(path.split("/")[:-1])
        parent_id = ""
        if parent:
            prow = conn.execute(
                "SELECT id FROM wiki_folders WHERE kb_id=? AND path=? AND deleted_at IS NULL",
                (kb_id, parent),
            ).fetchone()
            parent_id = prow["id"] if prow else ""
        conn.execute(
            """
            INSERT INTO wiki_folders(id, kb_id, parent_id, name, path, sort_order, created_at, updated_at)
            VALUES (?,?,?,?,?,0,?,?)
            """,
            (fid, kb_id, parent_id, name or path.split("/")[-1], path, now, now),
        )
        row = conn.execute("SELECT * FROM wiki_folders WHERE id=?", (fid,)).fetchone()
    return dict(row)


def list_folders(kb_id: str) -> list[dict[str, Any]]:
    with db() as conn:
        rows = conn.execute(
            """
            SELECT * FROM wiki_folders
            WHERE kb_id=? AND deleted_at IS NULL
            ORDER BY path ASC
            """,
            (kb_id,),
        ).fetchall()
    return [
        {
            "id": r["id"],
            "kbId": r["kb_id"],
            "parentId": r["parent_id"],
            "name": r["name"],
            "path": r["path"],
            "sortOrder": r["sort_order"],
        }
        for r in rows
    ]
