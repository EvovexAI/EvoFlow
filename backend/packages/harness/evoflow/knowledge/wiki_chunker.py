"""Wiki-style automatic chunking: split by document structure, not user token size."""

from __future__ import annotations

import re

from evoflow.knowledge.chunker import _count_tokens, chunk_text

# Internal defaults — not exposed to users.
_MAX_SECTION_TOKENS = 900
_MIN_SECTION_TOKENS = 120

_HEADING_RE = re.compile(r"^(#{1,6})\s+(.+?)\s*$", re.MULTILINE)


def auto_chunk_document(text: str, *, file_name: str = "") -> list[dict]:
    """Split *text* into semantic sections (headings / paragraphs).

    Returns chunk dicts compatible with the legacy chunker:
    ``content``, ``token_count``, ``char_start``, ``char_end``, plus
    ``heading_path``, ``index_text``, ``title``.
    """
    raw = (text or "").strip()
    if not raw:
        return []

    is_markdown = file_name.lower().endswith(".md") or _HEADING_RE.search(raw) is not None
    if is_markdown:
        sections = _split_markdown_sections(raw)
    else:
        sections = _split_plain_sections(raw)

    merged = _merge_small_sections(sections)
    chunks: list[dict] = []
    for sec in merged:
        content = sec["content"].strip()
        if not content:
            continue
        chunks.append(
            {
                "content": content,
                "token_count": _count_tokens(content),
                "char_start": sec["start"],
                "char_end": sec["end"],
                "heading_path": sec.get("heading_path") or sec.get("title") or file_name or "正文",
                "title": sec.get("title") or "",
                "index_text": "",
            }
        )

    if chunks:
        return chunks

    # Fallback for edge cases
    legacy = chunk_text(raw, chunk_size=512, overlap=50)
    for item in legacy:
        item["heading_path"] = file_name or "正文"
        item["title"] = ""
        item["index_text"] = ""
    return legacy


def _split_markdown_sections(text: str) -> list[dict]:
    matches = list(_HEADING_RE.finditer(text))
    if not matches:
        return _split_plain_sections(text)

    sections: list[dict] = []
    heading_stack: list[tuple[int, str]] = []

    for i, match in enumerate(matches):
        level = len(match.group(1))
        title = match.group(2).strip()
        start = match.start()
        end = matches[i + 1].start() if i + 1 < len(matches) else len(text)

        while heading_stack and heading_stack[-1][0] >= level:
            heading_stack.pop()
        heading_stack.append((level, title))
        path = " / ".join(h for _, h in heading_stack)

        body = text[match.end() : end].strip()
        content = f"{match.group(0).strip()}\n\n{body}".strip() if body else match.group(0).strip()
        sections.append(
            {
                "start": start,
                "end": end,
                "title": title,
                "heading_path": path,
                "content": content,
                "tokens": _count_tokens(content),
            }
        )

    prefix = text[: matches[0].start()].strip()
    if prefix:
        sections.insert(
            0,
            {
                "start": 0,
                "end": matches[0].start(),
                "title": "概述",
                "heading_path": "概述",
                "content": prefix,
                "tokens": _count_tokens(prefix),
            },
        )
    return sections


def _split_plain_sections(text: str) -> list[dict]:
    parts = re.split(r"\n\n+", text)
    sections: list[dict] = []
    pos = 0
    for part in parts:
        stripped = part.strip()
        if not stripped:
            pos += len(part) + 2
            continue
        start = text.find(stripped, pos)
        end = start + len(stripped)
        sections.append(
            {
                "start": start,
                "end": end,
                "title": stripped.split("\n", 1)[0][:48],
                "heading_path": stripped.split("\n", 1)[0][:48],
                "content": stripped,
                "tokens": _count_tokens(stripped),
            }
        )
        pos = end
    return sections


def _merge_small_sections(sections: list[dict]) -> list[dict]:
    if not sections:
        return []

    merged: list[dict] = []
    buffer: dict | None = None

    def flush() -> None:
        nonlocal buffer
        if buffer:
            merged.append(buffer)
            buffer = None

    for sec in sections:
        tokens = int(sec.get("tokens") or _count_tokens(sec["content"]))
        if tokens > _MAX_SECTION_TOKENS:
            flush()
            merged.append(sec)
            continue

        if buffer is None:
            buffer = dict(sec)
            continue

        combined_tokens = int(buffer.get("tokens") or 0) + tokens
        if combined_tokens <= _MAX_SECTION_TOKENS:
            buffer["content"] = f"{buffer['content']}\n\n{sec['content']}".strip()
            buffer["end"] = sec["end"]
            buffer["tokens"] = combined_tokens
            if buffer.get("title") != sec.get("title") and sec.get("title"):
                buffer["heading_path"] = f"{buffer.get('heading_path', '')} / {sec.get('title', '')}".strip(" /")
        else:
            flush()
            buffer = dict(sec)

    flush()

    # Split oversized merged sections
    out: list[dict] = []
    for sec in merged:
        tokens = _count_tokens(sec["content"])
        if tokens <= _MAX_SECTION_TOKENS:
            out.append(sec)
            continue
        for piece in chunk_text(sec["content"], chunk_size=_MAX_SECTION_TOKENS, overlap=40):
            piece["heading_path"] = sec.get("heading_path") or sec.get("title") or "正文"
            piece["title"] = sec.get("title") or ""
            out.append(
                {
                    "start": piece["char_start"],
                    "end": piece["char_end"],
                    "title": piece["title"],
                    "heading_path": piece["heading_path"],
                    "content": piece["content"],
                    "tokens": piece["token_count"],
                }
            )
    return out
