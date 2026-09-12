"""Text chunker for the evoflow knowledge base.

Splits plain text into overlapping chunks that respect paragraph boundaries
(``\\n\\n``). The default chunk size is 512 tokens with 50 tokens of overlap,
matching FastGPT's ``text2Chunks`` strategy.

Token counting uses a lightweight heuristic: ``len(text) / 4`` as an
approximation (1 token ≈ 4 chars for English). This avoids a hard dependency
on ``tiktoken`` while keeping chunk sizes reasonable. When ``tiktoken`` is
available, it is used for accurate counts.
"""

from __future__ import annotations

import logging
import re

logger = logging.getLogger(__name__)

# Try to use tiktoken for accurate token counting; fall back to char-based heuristic
_tiktoken_enc = None
try:
    import tiktoken

    _tiktoken_enc = tiktoken.get_encoding("cl100k_base")
except Exception:
    pass


def _count_tokens(text: str) -> int:
    """Count tokens in text. Uses tiktoken if available, else char/4 heuristic."""
    if _tiktoken_enc is not None:
        return len(_tiktoken_enc.encode(text))
    return max(1, len(text) // 4)


def chunk_text(
    text: str,
    chunk_size: int = 512,
    overlap: int = 50,
) -> list[dict]:
    """Split text into overlapping chunks that respect paragraph boundaries.

    The algorithm:
    1. Split text into paragraphs (separated by ``\\n\\n``).
    2. Greedily pack paragraphs into chunks until ``chunk_size`` tokens is
       reached.
    3. If a single paragraph exceeds ``chunk_size``, it is hard-split.
    4. Each new chunk starts with the last ``overlap`` tokens of the previous
       chunk (if available) to preserve context continuity.

    Args:
        text: The input text to chunk.
        chunk_size: Target maximum token count per chunk (default 512).
        overlap: Number of tokens to overlap between consecutive chunks (default 50).

    Returns:
        A list of chunk dicts, each containing:
        - ``content``: The chunk text.
        - ``token_count``: Approximate token count.
        - ``char_start``: Start character offset in the original text.
        - ``char_end``: End character offset in the original text.
    """
    if not text or not text.strip():
        return []

    chunk_size = max(1, chunk_size)
    overlap = max(0, min(overlap, chunk_size - 1))

    # Split into paragraphs, preserving position info
    paragraphs = _split_paragraphs(text)
    if not paragraphs:
        return []

    chunks: list[dict] = []
    current_parts: list[str] = []
    current_tokens = 0
    current_start = paragraphs[0]["start"]
    overlap_text = ""

    for para in paragraphs:
        para_text = para["text"]
        para_tokens = _count_tokens(para_text)

        # If a single paragraph exceeds chunk_size, hard-split it
        if para_tokens > chunk_size:
            # Flush current buffer first
            if current_parts:
                chunks.append(_make_chunk(current_parts, current_start, para["start"]))
                current_parts = []
                current_tokens = 0
                overlap_text = chunks[-1]["content"][-(overlap * 4):] if overlap > 0 else ""

            # Hard-split the large paragraph
            sub_chunks = _hard_split(para_text, chunk_size, overlap)
            for sc in sub_chunks:
                chunks.append(sc)
            if chunks and overlap > 0:
                overlap_text = chunks[-1]["content"][-(overlap * 4):]
            continue

        # Check if adding this paragraph would exceed chunk_size
        if current_tokens + para_tokens > chunk_size and current_parts:
            # Flush current chunk
            chunks.append(_make_chunk(current_parts, current_start, para["start"]))
            current_parts = []
            current_tokens = 0
            # Start new chunk with overlap from previous
            if overlap > 0 and overlap_text:
                current_parts.append(overlap_text)
                current_tokens = _count_tokens(overlap_text)
                current_start = para["start"]  # approximate
            else:
                current_start = para["start"]

        # Add paragraph to current chunk
        current_parts.append(para_text)
        current_tokens += para_tokens

    # Flush remaining
    if current_parts:
        end_pos = paragraphs[-1]["end"]
        chunks.append(_make_chunk(current_parts, current_start, end_pos))

    return chunks


def _split_paragraphs(text: str) -> list[dict]:
    """Split text into paragraphs, tracking char positions.

    Returns list of ``{"text": str, "start": int, "end": int}``.
    """
    result: list[dict] = []
    # Split on double newline, but keep track of positions
    pos = 0
    parts = re.split(r"(\n\n+)", text)

    current_start = 0
    for i, part in enumerate(parts):
        if i % 2 == 0:  # text part
            stripped = part.strip()
            if stripped:
                start = text.index(stripped, current_start) if current_start < len(text) else current_start
                result.append({
                    "text": stripped,
                    "start": start,
                    "end": start + len(part),
                })
        current_start += len(part)

    return result if result else [{"text": text.strip(), "start": 0, "end": len(text)}]


def _make_chunk(parts: list[str], char_start: int, char_end: int) -> dict:
    """Create a chunk dict from accumulated paragraph parts."""
    content = "\n\n".join(parts)
    return {
        "content": content,
        "token_count": _count_tokens(content),
        "char_start": char_start,
        "char_end": char_end,
    }


def _hard_split(text: str, chunk_size: int, overlap: int) -> list[dict]:
    """Hard-split a paragraph that exceeds chunk_size into smaller pieces.

    Splits by sentences first, then by character count if sentences are too long.
    """
    chunks: list[dict] = []
    # Try sentence-level split
    sentences = re.split(r"(?<=[.!?。！？])\s+", text)

    current = ""
    current_tokens = 0
    pos = 0

    for sent in sentences:
        sent_tokens = _count_tokens(sent)
        if current_tokens + sent_tokens > chunk_size and current:
            chunks.append({
                "content": current,
                "token_count": _count_tokens(current),
                "char_start": pos,
                "char_end": pos + len(current),
            })
            pos += len(current)
            # Overlap: keep last N chars
            if overlap > 0:
                current = current[-(overlap * 4):] + " " + sent
            else:
                current = sent
            current_tokens = _count_tokens(current)
        else:
            current = (current + " " + sent).strip() if current else sent
            current_tokens += sent_tokens

    if current:
        chunks.append({
            "content": current,
            "token_count": _count_tokens(current),
            "char_start": pos,
            "char_end": pos + len(current),
        })

    return chunks
