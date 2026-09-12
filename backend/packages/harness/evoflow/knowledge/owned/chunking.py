"""Recursive chunker with protected spans (tables, images, fenced code)."""

from __future__ import annotations

import re
from dataclasses import dataclass

_FENCE_RE = re.compile(r"```[\s\S]*?```")
_IMAGE_RE = re.compile(r"!\[[^\]]*\]\([^)]+\)")
# Header + separator + following table rows
_TABLE_RE = re.compile(
    r"(?:^|\n)(\|[^\n]+\|\n\|(?:\s*:?-+:?\s*\|)+\s*\n(?:\|[^\n]+\|\n?)*)",
    re.MULTILINE,
)


@dataclass
class ChunkPiece:
    content: str
    context_header: str = ""
    heading_path: str = ""
    chunk_kind: str = "text"
    token_estimate: int = 0


def _estimate_tokens(text: str) -> int:
    # Spec uses character budgets for size; keep a rough token field for UI.
    return max(1, len(text) // 4) if text.strip() else 0


def _find_protected_spans(text: str) -> list[tuple[int, int]]:
    spans: list[tuple[int, int]] = []
    for rx in (_FENCE_RE, _IMAGE_RE, _TABLE_RE):
        for m in rx.finditer(text):
            spans.append((m.start(), m.end()))
    spans.sort()
    merged: list[tuple[int, int]] = []
    for s, e in spans:
        if merged and s <= merged[-1][1]:
            merged[-1] = (merged[-1][0], max(merged[-1][1], e))
        else:
            merged.append((s, e))
    return merged


def _is_inside(spans: list[tuple[int, int]], pos: int) -> bool:
    for s, e in spans:
        if s < pos < e:
            return True
        if pos < s:
            return False
    return False


def _split_separators(text: str, separators: list[str]) -> list[str]:
    if not separators:
        return [text] if text else []
    sep = separators[0]
    rest = separators[1:]
    # Python str.split("") raises; treat empty sep as character-level split.
    if sep == "":
        return list(text) if text else []
    if sep not in text:
        return _split_separators(text, rest) if rest else ([text] if text else [])
    parts = text.split(sep)
    out: list[str] = []
    for i, part in enumerate(parts):
        piece = part if i == len(parts) - 1 else part + sep
        if not piece:
            continue
        if rest and len(piece) > 0:
            out.extend(_split_separators(piece, rest))
        else:
            out.append(piece)
    return out


def _kind_for(text: str) -> str:
    has_table = "|" in text and re.search(r"\|(?:\s*:?-+:?\s*\|)", text) is not None
    has_img = "![" in text
    if has_table and has_img:
        return "mixed"
    if has_table:
        return "table"
    if has_img:
        return "mixed"
    return "text"


def _split_recursive(
    text: str,
    *,
    chunk_size: int = 512,
    chunk_overlap: int = 80,
    context_header: str = "",
    heading_path: str = "",
) -> list[ChunkPiece]:
    """Split by character budget with protected spans (spec §7.2)."""
    text = (text or "").strip()
    if not text:
        return []

    chunk_size = max(64, int(chunk_size))
    chunk_overlap = max(0, min(int(chunk_overlap), chunk_size // 2))
    protected = _find_protected_spans(text)

    # Extract protected blocks as atomic units interleaved with free text.
    units: list[str] = []
    cursor = 0
    for s, e in protected:
        if cursor < s:
            units.append(text[cursor:s])
        units.append(text[s:e])
        cursor = e
    if cursor < len(text):
        units.append(text[cursor:])

    # Further split free-text units; keep protected units whole.
    seps = ["\n\n", "\n", "。", "；", " ", ""]
    atoms: list[str] = []
    for unit in units:
        if not unit:
            continue
        # Protected if unit matches a protected span content approximately
        is_prot = False
        for s, e in protected:
            if text[s:e] == unit:
                is_prot = True
                break
        if is_prot or len(unit) <= chunk_size:
            atoms.append(unit)
        else:
            atoms.extend(_split_separators(unit, seps))

    chunks: list[ChunkPiece] = []
    buf = ""
    for atom in atoms:
        if not atom:
            continue
        if len(atom) > chunk_size * 2:
            # Hard split oversized atom (e.g. huge table) by lines.
            lines = atom.splitlines(keepends=True)
            cur = ""
            header = ""
            if lines and lines[0].strip().startswith("|") and len(lines) > 1:
                header = lines[0] + (lines[1] if re.search(r":?-+:?", lines[1] or "") else "")
            for line in lines:
                if cur and len(cur) + len(line) > chunk_size:
                    chunks.append(
                        ChunkPiece(
                            content=cur.strip(),
                            context_header=context_header,
                            heading_path=heading_path,
                            chunk_kind=_kind_for(cur),
                            token_estimate=_estimate_tokens(cur),
                        )
                    )
                    cur = header + line if header else line
                else:
                    cur += line
            if cur.strip():
                chunks.append(
                    ChunkPiece(
                        content=cur.strip(),
                        context_header=context_header,
                        heading_path=heading_path,
                        chunk_kind=_kind_for(cur),
                        token_estimate=_estimate_tokens(cur),
                    )
                )
            buf = ""
            continue

        if buf and len(buf) + len(atom) > chunk_size:
            chunks.append(
                ChunkPiece(
                    content=buf.strip(),
                    context_header=context_header,
                    heading_path=heading_path,
                    chunk_kind=_kind_for(buf),
                    token_estimate=_estimate_tokens(buf),
                )
            )
            # overlap
            if chunk_overlap > 0 and len(buf) > chunk_overlap:
                buf = buf[-chunk_overlap:] + atom
            else:
                buf = atom
        else:
            buf += atom

    if buf.strip():
        chunks.append(
            ChunkPiece(
                content=buf.strip(),
                context_header=context_header,
                heading_path=heading_path,
                chunk_kind=_kind_for(buf),
                token_estimate=_estimate_tokens(buf),
            )
        )
    return chunks


_HEADING_LINE_RE = re.compile(r"^(#{1,6})\s+(.+?)\s*$", re.MULTILINE)


def _split_by_heading(
    text: str,
    *,
    chunk_size: int = 512,
    chunk_overlap: int = 80,
) -> list[ChunkPiece]:
    """Split on ATX headings; oversized sections fall back to recursive."""
    text = (text or "").strip()
    if not text:
        return []
    matches = list(_HEADING_LINE_RE.finditer(text))
    if not matches:
        return _split_recursive(text, chunk_size=chunk_size, chunk_overlap=chunk_overlap)

    sections: list[tuple[str, str, str]] = []  # (heading_path, header_line, body)
    if matches[0].start() > 0:
        preface = text[: matches[0].start()].strip()
        if preface:
            sections.append(("", "", preface))
    for i, m in enumerate(matches):
        level = len(m.group(1))
        title = m.group(2).strip()
        start = m.start()
        end = matches[i + 1].start() if i + 1 < len(matches) else len(text)
        block = text[start:end].strip()
        # breadcrumb of open headings of lower/equal level — simple stack rebuild
        path_parts = [title]
        for prev in reversed(matches[:i]):
            if len(prev.group(1)) < level:
                path_parts.insert(0, prev.group(2).strip())
                level = len(prev.group(1))
        heading_path = " / ".join(path_parts)
        sections.append((heading_path, m.group(0), block))

    out: list[ChunkPiece] = []
    for heading_path, _header, block in sections:
        ctx = heading_path
        if len(block) <= chunk_size:
            out.append(
                ChunkPiece(
                    content=block,
                    context_header=ctx,
                    heading_path=heading_path,
                    chunk_kind=_kind_for(block),
                    token_estimate=_estimate_tokens(block),
                )
            )
        else:
            out.extend(
                _split_recursive(
                    block,
                    chunk_size=chunk_size,
                    chunk_overlap=chunk_overlap,
                    context_header=ctx,
                    heading_path=heading_path,
                )
            )
    return out


def split_text(
    text: str,
    *,
    chunk_size: int = 512,
    chunk_overlap: int = 80,
    strategy: str = "recursive",
) -> list[ChunkPiece]:
    """Split text using recursive | heading | auto strategies."""
    strategy = (strategy or "recursive").strip().lower()
    if strategy == "auto":
        headings = len(_HEADING_LINE_RE.findall(text or ""))
        strategy = (
            "heading"
            if headings >= 2 and len(text or "") > max(128, int(chunk_size))
            else "recursive"
        )
    if strategy == "heading":
        return _split_by_heading(text, chunk_size=chunk_size, chunk_overlap=chunk_overlap)
    return _split_recursive(text, chunk_size=chunk_size, chunk_overlap=chunk_overlap)
