"""Build document summary + per-chunk index strings (rule-based, no user config)."""

from __future__ import annotations

import json
import re


def build_document_summary(text: str, *, file_name: str = "") -> tuple[str, str]:
    """Return ``(summary_text, summary_index)`` for a whole document."""
    raw = (text or "").strip()
    if not raw:
        return "", file_name or "空文档"

    title = file_name or "文档"
    first_block = re.split(r"\n\n+", raw, maxsplit=1)[0].strip()
    first_line = first_block.split("\n", 1)[0].strip()
    if first_line.startswith("#"):
        title = first_line.lstrip("#").strip() or title

    summary_parts: list[str] = [title]
    body_preview = first_block[:600].strip()
    if body_preview and body_preview != title:
        summary_parts.append(body_preview)

    summary_text = "\n\n".join(summary_parts)[:1200]
    keywords = _extract_keywords(raw, limit=12)
    summary_index = " · ".join([title, *keywords[:8]]) if keywords else title
    return summary_text, summary_index


def enrich_chunk_indexes(chunks: list[dict], *, file_name: str = "") -> list[dict]:
    """Attach ``index_text`` and ``metadata_json`` to each chunk dict."""
    out: list[dict] = []
    for i, chunk in enumerate(chunks):
        heading = str(chunk.get("heading_path") or chunk.get("title") or file_name or f"段落 {i + 1}")
        keywords = _extract_keywords(chunk.get("content") or "", limit=6)
        index_text = " · ".join([heading, *keywords]) if keywords else heading
        meta = {
            "heading_path": heading,
            "index_text": index_text,
            "title": chunk.get("title") or "",
            "kind": "section",
        }
        enriched = dict(chunk)
        enriched["index_text"] = index_text
        enriched["metadata_json"] = json.dumps(meta, ensure_ascii=False)
        out.append(enriched)
    return out


def embedding_text_for_chunk(chunk: dict) -> str:
    """Text fed to the embedding model: index line + body."""
    index_text = str(chunk.get("index_text") or "").strip()
    content = str(chunk.get("content") or "").strip()
    if index_text and index_text not in content:
        return f"{index_text}\n\n{content}"
    return content


def summary_vector_chunk_id(file_id: str) -> str:
    return f"summary_{file_id}"


def _extract_keywords(text: str, *, limit: int = 8) -> list[str]:
    tokens = re.findall(r"[\u4e00-\u9fff]{2,}|[A-Za-z][A-Za-z0-9_-]{2,}", text or "")
    seen: set[str] = set()
    out: list[str] = []
    for tok in tokens:
        key = tok.lower()
        if key in seen:
            continue
        seen.add(key)
        out.append(tok)
        if len(out) >= limit:
            break
    return out
