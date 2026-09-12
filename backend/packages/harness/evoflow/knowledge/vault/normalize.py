"""Normalize heterogeneous MCP provider payloads into Knowledge domain models."""

from __future__ import annotations

import json
import re
from typing import Any
from urllib.parse import quote

from evoflow.knowledge.vault.constants import MAX_GRAPH_EDGES, MAX_GRAPH_NODES
from evoflow.knowledge.vault.models import (
    KnowledgeCitation,
    KnowledgeGraph,
    KnowledgeGraphEdge,
    KnowledgeGraphNode,
    KnowledgeNote,
    KnowledgeSearchResult,
)

_WIKILINK_RE = re.compile(r"\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|[^\]]+)?\]\]")
_TAG_RE = re.compile(r"(?<!\w)#([A-Za-z0-9_/\-]+)")


def make_citation(vault_id: str, path: str, heading: str | None = None) -> KnowledgeCitation:
    encoded = quote(path, safe="/")
    return KnowledgeCitation(
        uri=f"vault://{vault_id}/{encoded}",
        path=path,
        heading=heading,
    )


def _try_parse_json(text: str) -> Any | None:
    raw = (text or "").strip()
    if not raw:
        return None
    # Strip UTF-8 BOM / zero-width chars that break json.loads
    raw = raw.lstrip("\ufeff\u200b")
    # Strip common markdown fences
    if raw.startswith("```"):
        lines = raw.splitlines()
        if lines:
            lines = lines[1:]
        if lines and lines[-1].strip() == "```":
            lines = lines[:-1]
        raw = "\n".join(lines).strip()
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        pass
    # Extract first JSON object/array embedded in prose
    for opener, closer in (("{", "}"), ("[", "]")):
        start = raw.find(opener)
        end = raw.rfind(closer)
        if start >= 0 and end > start:
            try:
                return json.loads(raw[start : end + 1])
            except json.JSONDecodeError:
                continue
    return None


def _unwrap_mcp_content_blocks(payload: Any) -> Any:
    """Unwrap MCP tool results shaped like ``{content:[{type:text,text:'...'}]}``."""
    if payload is None:
        return None
    # LangChain ToolMessage / content attribute
    if not isinstance(payload, (dict, list, str, bytes, int, float, bool)):
        content = getattr(payload, "content", None)
        if content is not None and content is not payload:
            return _unwrap_mcp_content_blocks(content)
        artifact = getattr(payload, "artifact", None)
        if isinstance(artifact, dict) and "structured_content" in artifact:
            return artifact["structured_content"]
        # Some adapters expose structuredContent as attribute
        for attr in ("structuredContent", "structured_content"):
            val = getattr(payload, attr, None)
            if val is not None:
                return _unwrap_mcp_content_blocks(val)
        return payload

    if isinstance(payload, list):
        # Pure text-block list from MCP
        if payload and all(isinstance(b, dict) and ("text" in b or b.get("type") == "text") for b in payload):
            joined = "\n".join(str(b.get("text") or "") for b in payload if isinstance(b, dict))
            parsed = _try_parse_json(joined)
            return parsed if parsed is not None else joined
        # List of JSON strings
        if len(payload) == 1 and isinstance(payload[0], str):
            parsed = _try_parse_json(payload[0])
            return parsed if parsed is not None else payload[0]
        return payload

    if isinstance(payload, dict):
        # structuredContent / structured_content first
        for key in ("structuredContent", "structured_content"):
            if key in payload and payload[key] is not None:
                return _unwrap_mcp_content_blocks(payload[key])
        blocks = payload.get("content")
        if isinstance(blocks, str):
            parsed = _try_parse_json(blocks)
            if parsed is not None:
                return parsed
        if isinstance(blocks, list) and blocks and all(
            isinstance(b, dict) and ("text" in b or b.get("type") == "text") for b in blocks
        ):
            texts: list[str] = []
            for b in blocks:
                if isinstance(b, dict):
                    texts.append(str(b.get("text") or ""))
            joined = "\n".join(t for t in texts if t)
            if not joined.strip():
                return payload
            parsed = _try_parse_json(joined)
            return parsed if parsed is not None else joined
        # List of plain strings (some MCP adapters)
        if isinstance(blocks, list) and blocks and all(isinstance(b, str) for b in blocks):
            joined = "\n".join(blocks)
            parsed = _try_parse_json(joined)
            if parsed is not None:
                return parsed
        # Nested content that is itself a stringified JSON blob under "text"
        if "text" in payload and isinstance(payload.get("text"), str):
            parsed = _try_parse_json(payload["text"])
            if parsed is not None:
                return parsed
        # Already a results payload
        if any(k in payload for k in ("results", "items", "hits", "notes", "documents")):
            return payload
    return payload


def _as_dict(payload: Any) -> Any:
    payload = _unwrap_mcp_content_blocks(payload)
    if payload is None:
        return None
    if isinstance(payload, (dict, list)):
        return payload
    if isinstance(payload, str):
        parsed = _try_parse_json(payload)
        return parsed if parsed is not None else payload
    if isinstance(payload, (bytes, bytearray)):
        try:
            return _as_dict(payload.decode("utf-8"))
        except UnicodeDecodeError:
            return payload
    content = getattr(payload, "content", None)
    if content is not None and content is not payload:
        return _as_dict(content)
    return payload


def _title_from_path(path: str) -> str:
    name = path.replace("\\", "/").rsplit("/", 1)[-1]
    if name.lower().endswith(".md"):
        name = name[:-3]
    return name or path


def extract_wikilinks(text: str) -> list[str]:
    links: list[str] = []
    seen: set[str] = set()
    for m in _WIKILINK_RE.finditer(text or ""):
        target = str(m.group(1) or "").strip()
        if not target or target in seen:
            continue
        seen.add(target)
        links.append(target)
    return links


def extract_tags(text: str, frontmatter: dict[str, Any] | None = None) -> list[str]:
    tags: list[str] = []
    seen: set[str] = set()
    fm = frontmatter or {}
    raw_fm = fm.get("tags")
    if isinstance(raw_fm, list):
        for t in raw_fm:
            s = str(t).strip().lstrip("#")
            if s and s not in seen:
                seen.add(s)
                tags.append(s)
    elif isinstance(raw_fm, str) and raw_fm.strip():
        for part in raw_fm.split(","):
            s = part.strip().lstrip("#")
            if s and s not in seen:
                seen.add(s)
                tags.append(s)
    for m in _TAG_RE.finditer(text or ""):
        s = str(m.group(1) or "").strip()
        if s and s not in seen:
            seen.add(s)
            tags.append(s)
    return tags


def normalize_search_results(
    vault_id: str,
    payload: Any,
    *,
    provider: str = "obsidian-hybrid-search",
) -> list[KnowledgeSearchResult]:
    data = _as_dict(payload)
    items: list[Any] = []
    if isinstance(data, list):
        items = data
    elif isinstance(data, dict):
        for key in ("results", "items", "hits", "documents", "notes"):
            if isinstance(data.get(key), list):
                items = data[key]
                break
        if not items and ("path" in data or "file" in data or "title" in data):
            items = [data]
    elif isinstance(data, str) and data.strip():
        # Last-chance: string payload that looks like search JSON
        parsed = _try_parse_json(data)
        if isinstance(parsed, (dict, list)):
            return normalize_search_results(vault_id, parsed, provider=provider)
        return [
            KnowledgeSearchResult(
                vaultId=vault_id,
                path="",
                title="",
                snippet=data[:500],
                provider=provider,
            )
        ]

    out: list[KnowledgeSearchResult] = []
    for row in items:
        if not isinstance(row, dict):
            continue
        path = str(row.get("path") or row.get("file") or row.get("filepath") or row.get("note") or "").strip()
        title = str(row.get("title") or row.get("name") or _title_from_path(path) or "").strip()
        score_raw = row.get("score") or row.get("relevance") or row.get("rank")
        score: float | None
        try:
            score = float(score_raw) if score_raw is not None else None
        except (TypeError, ValueError):
            score = None
        snippet = str(
            row.get("snippet")
            or row.get("excerpt")
            or row.get("preview")
            or row.get("content")
            or row.get("text")
            or ""
        )
        if len(snippet) > 800:
            snippet = snippet[:797] + "..."
        tags = row.get("tags") if isinstance(row.get("tags"), list) else []
        aliases = row.get("aliases") if isinstance(row.get("aliases"), list) else []
        links = row.get("links") if isinstance(row.get("links"), list) else []
        backlinks = row.get("backlinks") if isinstance(row.get("backlinks"), list) else []
        out.append(
            KnowledgeSearchResult(
                vaultId=vault_id,
                path=path,
                title=title,
                score=score,
                snippet=snippet,
                tags=[str(t) for t in tags],
                aliases=[str(a) for a in aliases],
                links=[str(x) for x in links],
                backlinks=[str(x) for x in backlinks],
                provider=provider,
                citation=make_citation(vault_id, path) if path else None,
            )
        )
    return out


def normalize_notes(vault_id: str, payload: Any) -> list[KnowledgeNote]:
    data = _as_dict(payload)
    items: list[Any] = []
    if isinstance(data, list):
        items = data
    elif isinstance(data, dict):
        for key in ("notes", "results", "items", "documents"):
            if isinstance(data.get(key), list):
                items = data[key]
                break
        if not items:
            items = [data]
    elif isinstance(data, str):
        return [
            KnowledgeNote(
                vaultId=vault_id,
                path="",
                title="",
                content=data,
            )
        ]

    out: list[KnowledgeNote] = []
    for row in items:
        if isinstance(row, str):
            out.append(KnowledgeNote(vaultId=vault_id, path="", content=row))
            continue
        if not isinstance(row, dict):
            continue
        path = str(row.get("path") or row.get("file") or row.get("filepath") or "").strip()
        content = str(row.get("content") or row.get("text") or row.get("body") or "")
        fm = row.get("frontmatter") if isinstance(row.get("frontmatter"), dict) else {}
        if not fm and isinstance(row.get("frontMatter"), dict):
            fm = row["frontMatter"]
        title = str(row.get("title") or fm.get("title") or _title_from_path(path) or "").strip()
        tags = row.get("tags") if isinstance(row.get("tags"), list) else extract_tags(content, fm)
        aliases = row.get("aliases") if isinstance(row.get("aliases"), list) else []
        if not aliases and isinstance(fm.get("aliases"), list):
            aliases = fm["aliases"]
        links = row.get("links") if isinstance(row.get("links"), list) else extract_wikilinks(content)
        backlinks = row.get("backlinks") if isinstance(row.get("backlinks"), list) else []
        out.append(
            KnowledgeNote(
                vaultId=vault_id,
                path=path,
                title=title,
                content=content,
                frontmatter=dict(fm),
                tags=[str(t) for t in tags],
                aliases=[str(a) for a in aliases],
                links=[str(x) for x in links],
                backlinks=[str(x) for x in backlinks],
                modifiedAt=str(row.get("modifiedAt") or row.get("mtime") or row.get("modified") or "") or None,
                citation=make_citation(vault_id, path) if path else None,
            )
        )
    return out


def _related_items(payload: Any) -> list[dict[str, Any]]:
    data = _as_dict(payload)
    items: list[Any] = []
    if isinstance(data, list):
        items = data
    elif isinstance(data, dict):
        for key in ("results", "items", "hits", "related", "notes"):
            if isinstance(data.get(key), list):
                items = data[key]
                break
        if not items and ("path" in data or "file" in data):
            items = [data]
    return [x for x in items if isinstance(x, dict)]


def build_graph_from_related_search(
    vault_id: str,
    center_path: str,
    payload: Any,
    *,
    depth: int = 1,
    direction: str = "both",
    max_nodes: int = MAX_GRAPH_NODES,
    max_edges: int = MAX_GRAPH_EDGES,
) -> KnowledgeGraph:
    """Build a graph from OHS related-search results.

    Depth field semantics: ``0`` center, positive = outgoing hops, negative = backlinks.
    Does **not** use semantic search for edge creation.
    """
    items = _related_items(payload)
    nodes: dict[str, KnowledgeGraphNode] = {}
    edges: list[KnowledgeGraphEdge] = []
    unresolved: list[str] = []
    truncated = False
    visited: set[str] = set()

    def add_node(path: str, title: str = "", tags: list[str] | None = None) -> bool:
        nonlocal truncated
        key = (path or title or "").strip()
        if not key:
            return False
        if key in nodes:
            return True
        if len(nodes) >= max_nodes:
            truncated = True
            return False
        nodes[key] = KnowledgeGraphNode(
            id=key,
            path=path or key,
            title=title or _title_from_path(path or key),
            tags=list(tags or []),
        )
        return True

    # Seed center
    add_node(center_path, _title_from_path(center_path))
    visited.add(center_path)

    # Index by path and collect depth info
    by_path: dict[str, dict[str, Any]] = {}
    for row in items:
        path = str(row.get("path") or row.get("file") or row.get("filepath") or "").strip()
        if not path:
            continue
        by_path[path] = row
        title = str(row.get("title") or row.get("name") or _title_from_path(path))
        tags = row.get("tags") if isinstance(row.get("tags"), list) else []
        depth_raw = row.get("depth")
        try:
            d = int(depth_raw) if depth_raw is not None else 0
        except (TypeError, ValueError):
            d = 0
        # Filter by requested direction
        if d > 0 and direction == "backlinks":
            continue
        if d < 0 and direction == "outgoing":
            continue
        if abs(d) > depth and d != 0:
            continue
        if not add_node(path, title, [str(t) for t in tags]):
            break
        visited.add(path)

    # Build edges from parent/source fields or adjacent depth hops
    for path, row in by_path.items():
        if truncated or len(edges) >= max_edges:
            truncated = True
            break
        depth_raw = row.get("depth")
        try:
            d = int(depth_raw) if depth_raw is not None else 0
        except (TypeError, ValueError):
            d = 0
        if d == 0:
            continue
        if d > 0 and direction == "backlinks":
            continue
        if d < 0 and direction == "outgoing":
            continue
        if abs(d) > depth:
            continue

        parent = str(
            row.get("parent")
            or row.get("from")
            or row.get("source")
            or row.get("via")
            or ""
        ).strip()
        if not parent:
            # Heuristic: depth ±1 connects to center; deeper needs parent
            if abs(d) == 1:
                parent = center_path
            else:
                continue

        if d > 0:
            src, tgt, etype = parent, path, "wikilink"
        else:
            src, tgt, etype = path, parent, "backlink"

        if src not in nodes:
            if not add_node(src, _title_from_path(src)):
                unresolved.append(src)
                continue
        if tgt not in nodes:
            if not add_node(tgt, _title_from_path(tgt)):
                unresolved.append(tgt)
                continue
        if len(edges) >= max_edges:
            truncated = True
            break
        edges.append(KnowledgeGraphEdge(source=src, target=tgt, type=etype))  # type: ignore[arg-type]

    # Collect link targets mentioned but not resolved into nodes
    for path, row in by_path.items():
        for key in ("links", "outgoing", "backlinks"):
            vals = row.get(key)
            if not isinstance(vals, list):
                continue
            for t in vals:
                target = str(t or "").strip()
                if not target:
                    continue
                if target not in nodes and target not in unresolved:
                    unresolved.append(target)

    # Dedupe edges
    seen_e: set[tuple[str, str, str]] = set()
    unique_edges: list[KnowledgeGraphEdge] = []
    for e in edges:
        key = (e.source, e.target, e.type)
        if key in seen_e:
            continue
        seen_e.add(key)
        unique_edges.append(e)

    # Dedupe unresolved
    seen_u: set[str] = set()
    unique_unresolved: list[str] = []
    for u in unresolved:
        if u in nodes or u in seen_u:
            continue
        seen_u.add(u)
        unique_unresolved.append(u)

    return KnowledgeGraph(
        centerPath=center_path,
        depth=depth,
        nodes=list(nodes.values()),
        edges=unique_edges,
        unresolved=unique_unresolved,
        truncated=truncated,
    )


def build_graph_from_note(
    vault_id: str,
    note: KnowledgeNote,
    *,
    depth: int = 1,
    direction: str = "both",
    neighbor_notes: list[KnowledgeNote] | None = None,
    max_nodes: int = 80,
) -> KnowledgeGraph:
    """Build a local graph from a center note (+ optional neighbors). Fallback path."""
    nodes: dict[str, KnowledgeGraphNode] = {}
    edges: list[KnowledgeGraphEdge] = []
    unresolved: list[str] = []
    truncated = False

    def add_node(path: str, title: str = "", tags: list[str] | None = None) -> None:
        nonlocal truncated
        key = path or title
        if not key:
            return
        if key in nodes:
            return
        if len(nodes) >= max_nodes:
            truncated = True
            return
        nodes[key] = KnowledgeGraphNode(
            id=key,
            path=path or key,
            title=title or _title_from_path(path or key),
            tags=list(tags or []),
        )

    center = note.path or note.title
    add_node(note.path, note.title, note.tags)

    outgoing = list(note.links or [])
    incoming = list(note.backlinks or [])

    if direction in ("outgoing", "both"):
        for target in outgoing:
            if truncated:
                unresolved.append(target)
                break
            before = len(nodes)
            add_node(target if "/" in target or target.endswith(".md") else target, _title_from_path(target))
            if target not in nodes and len(nodes) == before:
                unresolved.append(target)
            elif note.path and target:
                edges.append(KnowledgeGraphEdge(source=note.path, target=target, type="wikilink"))

    if direction in ("backlinks", "both"):
        for src in incoming:
            if truncated:
                unresolved.append(src)
                break
            add_node(src, _title_from_path(src))
            if note.path and src:
                edges.append(KnowledgeGraphEdge(source=src, target=note.path, type="backlink"))

    if depth > 1 and neighbor_notes:
        for n in neighbor_notes:
            if truncated:
                break
            add_node(n.path, n.title, n.tags)
            if direction in ("outgoing", "both"):
                for target in n.links or []:
                    if truncated:
                        break
                    add_node(target, _title_from_path(target))
                    if n.path:
                        edges.append(KnowledgeGraphEdge(source=n.path, target=target, type="wikilink"))
            if direction in ("backlinks", "both"):
                for src in n.backlinks or []:
                    if truncated:
                        break
                    add_node(src, _title_from_path(src))
                    if n.path:
                        edges.append(KnowledgeGraphEdge(source=src, target=n.path, type="backlink"))

    seen_e: set[tuple[str, str, str]] = set()
    unique_edges: list[KnowledgeGraphEdge] = []
    for e in edges:
        key = (e.source, e.target, e.type)
        if key in seen_e:
            continue
        seen_e.add(key)
        unique_edges.append(e)

    return KnowledgeGraph(
        centerPath=center,
        depth=depth,
        nodes=list(nodes.values()),
        edges=unique_edges,
        unresolved=unresolved,
        truncated=truncated,
    )
